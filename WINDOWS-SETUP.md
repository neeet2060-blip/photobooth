# 새 메인 PC(Windows) 이전 가이드 — 2026-08-11

인생네컷 포토부스를 개발용 맥에서 실제 행사용 Windows PC로 옮기는 전체 절차. 그 PC 앞에서
순서대로 따라 하면 된다.

## 0. 미리 알아둘 것

- **인쇄는 이제 완전 자동**이다(이번에 `printMode: 'windows'` 추가함) — 결제 확인되면 직원이
  따로 인쇄 버튼 안 눌러도 프린터로 바로 나간다. 다만 **프린터 이름을 정확히 알아야** 설정 가능(6번).
- 코드는 비공개 GitHub 저장소(`https://github.com/neeet2060-blip/photobooth`, private)에
  올려뒀다 — git으로 그대로 받으면 된다.
- **비밀키 파일 2개(`secrets/` 폴더)는 git에 없다** — 절대 이메일/카카오톡 등으로 보내지 말고
  USB로 직접 옮길 것(4번).
- **카메라·프린터를 이 메인 PC 하나에 같이 연결해도 무관하다** — 이 앱은 역할별로 URL만 다를
  뿐(`/camera`, `/control`, `/display`, `/admin`) 전부 브라우저 접속 방식이라 한 PC 안에서 다
  돌려도 된다(7번 참고).

## 1. Node.js 설치

[nodejs.org](https://nodejs.org)에서 **LTS 버전**(24.x 이상) Windows 인스톨러 다운받아 설치.
설치 후 확인:

```powershell
node -v
npm -v
```

## 2. Git 설치 + 코드 받기

[git-scm.com](https://git-scm.com/download/win)에서 Git for Windows 설치. 이후 PowerShell(또는
Git Bash)에서:

```powershell
cd C:\
git clone https://github.com/neeet2060-blip/photobooth.git
cd photobooth
npm install
```

GitHub 계정 로그인 창이 뜨면(private repo라 인증 필요) `neeet2060-blip` 계정으로 로그인.

## 3. `data/settings.json` 초기 설정 확인

`npm start`로 한 번 실행해보면 `data/` 폴더와 기본 `settings.json`이 자동 생성된다(뒤에서 관리자
화면으로 값들을 채울 거라 지금은 그냥 실행만 확인). `Ctrl+C`로 종료.

## 4. 비밀키 파일 옮기기 (USB로, git 아님)

개발용 맥에 있는 이 두 파일을 **USB로 직접 복사**해서 새 PC의 같은 경로에 넣는다:

- `secrets/firebase-admin.json` (QR 사진 클라우드 배송용)
- `secrets/tok2026-firebase-admin.json` (TOK2026 결제 연동용)

그리고 새 PC에서 직접 만들어야 하는 파일 하나 더(2026-08-11 추가, 관리자 화면 비밀번호 보호):

- `secrets/admin-password.txt` — 한 줄짜리 평문 비밀번호 파일. 이게 없으면 `/admin` 화면과
  `/api/admin/*`가 전부 막힌다(비밀번호 미설정 시 열어주는 게 아니라 완전 차단하도록 일부러
  그렇게 만듦). 아무 편집기로 원하는 비밀번호 한 줄 적어서 저장하면 됨(줄바꿈 앞뒤 공백은
  자동으로 제거됨). 이 값을 `/admin` 화면 첫 접속 때 브라우저가 물어본다.

새 PC에서: `C:\photobooth\secrets\` 폴더 안에 위 두 파일을 그대로 넣으면 된다(폴더 자체는
이미 git에 `.gitkeep`으로 존재).

## 5. 프린터 연결·설정

1. 프린터를 USB로 연결하고, 제조사 드라이버를 설치해 Windows에 정상 인식되게 한다.
2. **Windows 설정 → 블루투스 및 장치 → 프린터 및 스캐너**에서 그 프린터를 클릭 →
   **인쇄 기본 설정**에서 용지 크기를 **4x6(10x15cm)** 로 맞춰둔다(이 앱은 이미 4x6 비율로
   사진을 만들어 보내므로, 프린터 자체 기본 용지 크기도 반드시 여기서 맞줘야 함).
3. 그 목록에 뜨는 **프린터 이름을 정확히 메모**해둔다(예: `DNP DS620` 또는 `Canon SELPHY CP1500`
   처럼 Windows가 표시하는 정확한 이름 — 철자·띄어쓰기까지 그대로).

프린터가 이 PC가 아니라 다른 기기/공유기에 연결된 네트워크 공유 프린터라도 괜찮다 — 이
PC의 Windows 설정에서 그 네트워크 프린터를 "추가"해서 목록에 뜨게만 하면, 그 이름으로 똑같이
된다.

## 6. pm2로 상시 실행 등록

macOS와 달리 Windows는 `pm2 startup`이 그대로 안 먹는다(systemd/launchd가 없어서) —
[pm2-installer](https://github.com/jessety/pm2-installer)라는 별도 도구를 쓴다.

```powershell
cd C:\photobooth
npx pm2 start ecosystem.config.cjs
npx pm2 save

# Windows 부팅 시 자동 시작 등록 (관리자 권한 PowerShell에서)
npm install -g pm2-windows-startup
pm2-startup install
```

이후 확인:

```powershell
npx pm2 list        # status가 online인지
npx pm2 logs photobooth --lines 30
```

## 7. 카메라·프린터를 같은 PC에서 쓸 때 추가로 필요한 것

pm2는 서버(Node 프로세스)만 자동으로 띄운다 — 카메라 화면은 사람이 직접 브라우저로 열어야
한다. 이 PC에 웹캠도 같이 연결해서 쓸 경우 아래 4가지가 필요하다(서버/코드 쪽엔 손 볼 거 없음,
전부 Windows 설정):

1. **카메라 브라우저 창을 직접 연다**: `https://localhost:3000/camera`를 브라우저로 열고
   전체화면(F11)으로 켜둔다. `localhost`로 열면 자체 서명 인증서 경고 없이 바로 신뢰된다(LAN
   IP로 열면 매번 경고가 뜬다).
2. **Windows 카메라 권한 허용**: 설정 → 개인정보 및 보안 → 카메라 → "카메라 액세스" 켜기,
   사용하는 브라우저(Chrome/Edge)가 허용 목록에 있는지 확인.
3. **화면 꺼짐/절전 끄기**: 설정 → 시스템 → 전원 및 절전 → 화면·절전 모드를 "안 함"으로.
   안 그러면 대기 중에 화면이 꺼져서 손님이 못 쓴다.
4. **(선택) 부팅 시 브라우저 자동 실행**: 완전 무인으로 두려면, 시작프로그램 폴더
   (`Win+R` → `shell:startup`)에 카메라 URL을 여는 브라우저 바로가기를 넣어두면 재부팅해도
   사람이 다시 안 켜도 된다.

## 8. 관리자 화면 접속·설정

브라우저에서 `https://localhost:3000/admin` 접속(자체 서명 인증서 경고는 "고급 → 계속 진행").

설정할 항목:

| 항목 | 값 |
|---|---|
| 인쇄 모드(printMode) | **windows** (folder/cups 아님) |
| 프린터 이름(printerName) | 5번에서 메모한 정확한 이름 |
| 인쇄 용지(printMedia) | `4x6` |
| QR 결제 필수(qrRequiresPayment) | 필요하면 켜기 |

저장 후 테스트 인쇄(관리자 화면에 테스트 인쇄 버튼이 있으면 그걸로, 없으면 실제 세션 한 번
돌려서) 실제 종이가 4x6 크기로 잘 나오는지 확인.

## 9. 로컬 고정 주소 (photobooth.local)

macOS는 `scutil`로 바로 됐지만 Windows는 mDNS 응답 기능이 기본 내장이 아니다. 둘 중 하나 선택:

**방법 A (추천) — Bonjour 설치**
[Apple에서 Bonjour Print Services for Windows](https://support.apple.com/kb/DL999) 다운받아
설치(iTunes 없이 이 부분만 설치 가능). 이후:

```powershell
# 관리자 권한 PowerShell
Rename-Computer -NewName "photobooth" -Restart
```

재부팅 후 `https://photobooth.local:3000`으로 다른 기기(태블릿·휴대폰)에서 접속되는지 확인.

**방법 B — 공유기에서 고정 IP 예약**
공유기 관리자 페이지에서 이 PC의 MAC 주소로 DHCP 고정 IP를 예약해두면, 매번 같은 IP를 쓰게
되어 IP가 안 바뀐다(방법 A가 안 될 때 대안).

## 10. `.env`/환경변수 확인

`ecosystem.config.cjs`에 `TOK2026_EVENT_ID: 'de-dietzenbach-2026'`가 이미 박혀 있음 — **8/15
하나우(Hanau) 행사로 넘어갈 때는 이 값을 그 이벤트의 실제 eventId로 바꿔야 한다**(TOK2026
총괄관리자 화면에서 확인 가능). 바꾼 뒤 `npx pm2 restart photobooth` 필요.

## 11. 최종 검증 체크리스트

- [ ] `https://<이 PC의 IP 또는 photobooth.local>:3000/control`이 다른 기기(참가자 태블릿)에서
      열리는지
- [ ] `/camera`에서 실제 웹캠으로 촬영이 되는지
- [ ] 결제화면에서 카드/현금 선택 → TOK2026 관리자에서 결제확인 → 자동으로 촬영 화면 넘어가는지
- [ ] 테스트 인쇄 1장 — 4x6 크기로 잘리지 않고 나오는지, Good Luck/TOK 기본 프레임 둘 다 확인
- [ ] `npx pm2 restart photobooth`로 강제 재시작 후에도, 결제 대기 중이던 세션이 안 끊기는지
      (이번에 추가한 세션 영속화 기능 — `SESSION-PERSISTENCE.md` 참고)
- [ ] PC를 실제로 재부팅해서 pm2가 자동으로 다시 떠 있는지(6번 설정 확인)
- [ ] 재부팅 후 화면 절전이 안 걸려있는지, 카메라 브라우저 창도 다시 켜져 있는지(7번)
