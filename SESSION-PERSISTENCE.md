# 세션 상태 영속화 — 인수인계 스펙 (2026-08-11)

다른 도구(Codex 등)로 이어서 작업하기 위한 인수인계 문서. 아래 내용만으로 작업을 시작할 수 있도록
문제 상황·구현 범위·주의사항을 전부 담았다.

## 배경 (왜 필요한가)

`server/index.js`의 `let sessionState = stateMachine.createInitialState();`는 평범한 JS 변수라
**Node 프로세스가 살아있는 동안에만** 메모리에 존재한다. `data/settings.json`/`stats.json`처럼
파일로 저장되지 않는다. 서버가 재시작되면(코드 배포, pm2 watch-mode 재시작, 정전, 프로세스 크래시
등 원인 불문) 이 변수는 완전히 사라지고 코드가 다시 실행되며 항상 `createInitialState()`(빈 IDLE
상태)로 리셋된다.

`server/tokPayment.js`의 `activePolls`(모듈 스코프 `Map`, sessionId → 그 세션이 기다리는 TOK2026
주문의 docId + setInterval 핸들 저장)도 똑같이 메모리 전용이라 마찬가지로 사라진다.

### 실제로 벌어진 사고 (2026-08-11)

1. 손님이 촬영 시작 → 인쇄 선택 → 결제화면에서 "현금" 선택 → 확인 클릭
2. 이 순간 `tokPayment.js`가 TOK2026 Firestore에 주문(`paymentStatus:"unpaid"`)을 생성하고,
   4초마다 그 주문 상태를 확인하는 폴링 타이머를 `activePolls`에 등록
3. 그 사이 서버가 재시작됨(이번 경우엔 코드 수정 → pm2 watch-mode) → `sessionState`,
   `activePolls` 둘 다 초기화
4. 직원이 TOK2026 관리자 화면에서 결제확인을 눌러 Firestore엔 `paymentStatus:"paid"`로 정상
   반영됐지만, 그걸 지켜보던 폴링 타이머 자체가 이미 사라진 뒤라 아무도 그 변화를 감지하지 못함
   → 로컬 photobooth 화면이 영원히 다음 단계(촬영)로 안 넘어감

Firestore를 직접 조회해 주문 자체는 정상 생성·정상 확정됐음을 확인함(금액·항목 전부 일치,
`paymentStatus:"paid"`) — 서버 로직 버그가 아니라 **재시작으로 인한 상태 유실**이 원인.

## 목표

서버가 어떤 이유로 재시작되든, 진행 중이던 세션(특히 결제 대기 중인 세션 — 돈이 걸려 있어 가장
중요)을 최대한 안전하게 복원한다. "파일에 상태만 저장"하는 것으로는 **절반만** 고쳐진다 — 폴링
재개 로직이 반드시 같이 있어야 완전한 수정이다.

## 구현 범위 (3단계, 전부 필요)

### 1. `server/store.js`에 세션 상태 저장/로드 추가

기존 `readSettings`/`writeSettings`/`readStats`/`writeStats` 패턴을 그대로 따른다
(`readJsonFile`/`writeJsonFile` 재사용, `DATA_DIR`에 `session.json` 신설).

```js
const SESSION_FILE = path.join(DATA_DIR, 'session.json');

function readSession() {
  // 기본값은 null — 없으면 "저장된 세션 없음"으로 처리 (createInitialState()로 새로 시작하는 것과
  // 구분해야 함. readJsonFile의 기본값 인자로 null을 못 쓰면 별도 existsSync 체크로 처리).
}

function writeSession(sessionState) {
  writeJsonFile(SESSION_FILE, sessionState);
}
```

주의: `readSettings`/`readStats`는 파일이 없으면 기본값을 즉시 파일로도 써버리는데(`writeJsonFile`
호출), 세션은 그러면 안 된다 — 파일이 없다는 것 자체가 유의미한 정보(저장된 세션 없음)라서 굳이
빈 세션을 디스크에 미리 써둘 필요 없다. `readJsonFile`을 그대로 쓰지 말고, 파일 존재 여부만 보는
별도의 얇은 함수를 만들 것.

### 2. `server/index.js` — 매 dispatch마다 저장 + 시작 시 복원

**저장**: `dispatch()` 안, `broadcastState()` 직후에 `store.writeSession(sessionState);` 추가.
매 액션마다 디스크에 쓰는 건 이 앱 규모(부스 하나, 세션 하나)에서는 부하 걱정할 수준이 아니다.

**복원**: 모듈 최상단, `let sessionState = stateMachine.createInitialState();` 대신:

```js
const savedSession = store.readSession();
let sessionState = savedSession
  ? reconcileRestoredSession(savedSession)  // 아래 3번 참고 — phase별 안전 처리
  : stateMachine.createInitialState();
```

`reconcileRestoredSession`은 새 함수(index.js 안에 두거나 state.js에 export) — 저장된 상태를
그대로 쓰지 않고 phase별로 안전하게 다듬는다(아래 3번).

**폴링 재개**: `tokPayment.init({ dispatch, getState })` 호출 직후, 복원된 상태가
`phase === PHASES.PAYMENT && paymentMethod`이면 `tokPayment.resumePollForSession(sessionState)`
같은 새 함수를 호출해야 한다(3번 참고, tokPayment.js 쪽 작업).

### 3. Phase별 안전 복원 규칙

모든 phase를 무조건 그대로 복원하면 안 된다 — 서버가 돌리던 타이머(카운트다운 등)는 재시작하면
무조건 끊기므로, 그 타이머에 의존하는 phase는 복원 시 안전한 지점으로 되돌려야 한다.

| Phase | 복원 방식 |
|---|---|
| IDLE | 그대로 (할 것 없음) |
| CONSENT / FORMAT / THEME / QUANTITY | 그대로 복원 — 서버 타이머 없음, 안전 |
| **PAYMENT** | 그대로 복원 + **tokPayment.js 폴링 재개 필요** (아래) |
| **CAPTURE** | 그대로 복원하되 `countdown: null`로 리셋 (진행 중이던 카운트다운은 무조건 끊겼으므로 "다시 셔터를 눌러야 하는 상태"로) — 이미 찍은 사진(`photos` 배열)은 그대로 유지 가능 |
| SELECT / FILTER | 그대로 복원 — 서버 타이머 없음, 안전 |
| QR | 그대로 복원 — `qrTimeoutSec` 유휴 스윕이 어차피 주기적으로 돌며 처리하므로 복원 자체는 안전 |

### 4. `server/tokPayment.js` — 폴링 재개 로직 (신규 함수 필요)

현재 `activePolls`는 `startOrderForSession`이 주문을 **생성한 직후**에만 채워진다. 재시작 후
복원된 세션은 이미 주문이 생성돼 있으므로, "생성"이 아니라 "기존 주문을 다시 찾아서 폴링만 재개"하는
경로가 새로 필요하다.

```js
async function resumePollForSession(sessionState) {
  if (!isEnabled()) return;
  const db = getDb();
  if (!db) return;
  // sessionId로 그 세션의 미확정 주문을 다시 찾는다 — docId를 몰라도 sessionId 필드로 조회 가능
  // (startOrderForSession이 docData.sessionId = nextState.sessionId로 써두므로).
  const snap = await expOrdersCollection(db)
    .where('sessionId', '==', sessionState.sessionId)
    .where('paymentStatus', '==', 'unpaid')
    .limit(1)
    .get();
  if (snap.empty) return; // 이미 결제완료됐거나(다음 폴링에서 처리 안 해도 됨—어차피 못 찾음) 주문 자체가 없었음
  const doc = snap.docs[0];
  const remotePaymentMethod = sessionState.paymentMethod === 'cash' ? 'cash' : 'card';
  const intervalId = setInterval(() => {
    pollOnce(sessionState.sessionId).catch(() => {});
  }, POLL_INTERVAL_MS);
  activePolls.set(sessionState.sessionId, {
    docId: doc.id,
    sessionId: sessionState.sessionId,
    remotePaymentMethod,
    localPaymentMethod: mapToLocalPaymentMethod(remotePaymentMethod),
    intervalId,
  });
  // 재개 즉시 한 번 확인 — 재시작 사이에 이미 paid로 바뀌어 있었을 수도 있으므로 4초씩이나
  // 기다리지 말고 바로 pollOnce를 한 번 돌려준다.
  pollOnce(sessionState.sessionId).catch(() => {});
}
```

`.where('sessionId', ...).where('paymentStatus', ...)`는 Firestore 복합 인덱스가 필요할 수
있다 — TOK2026 프로젝트의 기존 함정(`firestore.indexes.json` 없음, `where+orderBy` 조합에서
당했던 것과 같은 종류)이니 배포 전 실제 쿼리로 인덱스 필요 여부 확인할 것(`orderBy` 없이
`where` 두 개만 쓰는 건 보통 단일 필드 인덱스로 되지만, Firestore가 실행 시점에 인덱스 생성 링크를
에러 메시지로 던져주니 그걸로 확인).

`module.exports`에 `resumePollForSession` 추가 필요.

## 관련 파일

- `server/store.js` — `readSession`/`writeSession` 추가 (기존 패턴 참고: `readSettings`/`writeSettings`, 39번째 줄 근처)
- `server/index.js` — 모듈 최상단 `sessionState` 초기화 부분(28번째 줄 근처), `dispatch()` 함수(38-47번째 줄), `tokPayment.init(...)` 호출부(123번째 줄 근처)
- `server/tokPayment.js` — `resumePollForSession` 신규 함수, `activePolls`/`expOrdersCollection`/`pollOnce`/`mapToLocalPaymentMethod` 기존 함수 재사용
- `server/state.js` — `PHASES` export 재사용, `reconcileRestoredSession`을 여기 둘지 index.js에 둘지는 구현자 판단(state.js에 두는 게 "순수 상태 변환 로직은 state.js에" 라는 기존 관례에 더 맞음)

## 테스트

- `test/store.test.js`: `readSession`(파일 없을 때 null, 저장 후 읽기), `writeSession` 케이스 추가
- `test/state.test.js` 또는 신규 `test/sessionRestore.test.js`: `reconcileRestoredSession`이 phase별로 올바르게 처리하는지(PAYMENT는 그대로, CAPTURE는 countdown만 null로) 단위 테스트
- `test/tokPayment.test.js`: `resumePollForSession`이 (a) 기존 미결제 주문을 찾아 폴링을 재개하는지, (b) 주문이 없으면(이미 결제완료돼 사라졌거나애초에 없었으면) no-op인지, (c) 재개 직후 즉시 한 번 폴링해서 이미 paid였던 경우 바로 dispatch하는지

## 검증 시나리오 (수동)

1. 결제화면에서 카드/현금 선택 → 확인 클릭 (대기 상태 진입)
2. `pm2 restart photobooth` (또는 강제 프로세스 재시작)
3. 서버 재기동 후 control.js를 새로고침 — 여전히 "결제 대기 중" 화면이 보이는지 확인
4. TOK2026 관리자 화면에서 그 주문을 결제확인 → photobooth가 자동으로 촬영 화면으로 넘어가는지 확인
5. 별도로: 촬영 중(카운트다운 진행 중)에 재시작 → 재기동 후 카운트다운 없이 "다시 셔터를 누를 수 있는" 정상 상태인지 확인, 이미 찍은 사진 수는 유지되는지 확인
