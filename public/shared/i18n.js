// Simple i18n helper shared across all pages. ES module.

const DICT = {
  ko: {
    appName: '인생네컷 포토부스',
    attractTitle: '인생네컷 포토부스',
    attractSubtitle: '화면을 눌러 시작하세요',
    startButton: '시작',
    consentTitle: '촬영 및 초상권 안내',
    consentBody:
      '촬영된 사진은 현장 프린트/다운로드 목적으로만 사용되며, 설정된 시간 이후 자동으로 삭제됩니다. 계속 진행하시면 촬영 및 사용에 동의하는 것으로 간주합니다.',
    agreeButton: '동의하고 시작',
    cancelButton: '취소',
    themeTitle: '프레임을 선택하세요',
    captureTitle: '촬영 중',
    shotsProgress: '{taken} / {total} 컷',
    shutterButton: '촬영',
    finishEarlyButton: '조기 종료',
    selectTitle: '마음에 드는 4장을 순서대로 선택하세요',
    selectProgress: '{count} / 4 선택됨',
    retakeButton: '재촬영',
    changeThemeButton: '프레임 변경',
    confirmPicksButton: '선택 완료',
    filterTitle: '필터를 선택하세요',
    confirmFinalButton: '완성',
    qrTitle: '완성되었습니다!',
    qrSubtitle: '아래 QR코드를 스캔해서 사진을 다운로드하세요',
    restartButton: '처음으로',
    qrPrintOrderButton: '사진 인화 주문하기',
    qrPrintQuantityLabel: '인화 매수를 선택하세요',
    qrPrintQuantityOf: '{quantity}장',
    qrPrintConfirmQuantityButton: '수량 확정',
    qrPrintCancelButton: '주문 취소',
    qrPrintAwaitingPayment: '카운터 직원에게 카드로 결제해주세요',
    qrPrintTotal: '총액: {total}',
    qrPrintConfirmPaymentButton: '결제 확인 (직원용)',
    remoteTitle: '리모컨',
    remoteWaiting: '촬영 준비 중...',
    remoteShots: '남은 컷: {remaining}',
    displayIdle: '인생네컷 포토부스',
    displayIdleSub: '태블릿에서 시작해주세요',
    displaySelecting: '선택 중...',
    displayFiltering: '필터 적용 중...',
    displayQr: '스캔해서 다운로드!',
    cameraStart: '카메라 시작',
    cameraWaiting: '대기 중',
    cameraMirror: '거울모드',
    cameraSelectLabel: '카메라 선택',
    cameraSelectDefault: '기본 카메라',
    downloadTitle: '내 사진',
    downloadButton: '다운로드',
    downloadPrivacy: '이 사진은 {hours}시간 후 자동 삭제됩니다.',
    notFoundTitle: '사진을 찾을 수 없습니다',
    notFoundBody: '사진을 찾을 수 없거나 만료되었습니다.',
    adminFrames: '프레임',
    adminSettings: '설정',
    adminStats: '통계',
    adminUpload: '업로드',
    adminActive: '활성',
    adminInactive: '비활성',
    adminDelete: '삭제',
    adminMoveUp: '위로',
    adminMoveDown: '아래로',
    adminSave: '저장',
    adminPrintSettings: '인화 설정',
    adminPrintQueue: '인쇄 대기열',
    adminPrintSettlement: '매출 정산',
    adminPrintRetry: '재시도',
    adminPrintCancel: '취소',
    adminPrintNoJobs: '대기 중인 작업이 없습니다',
    adminPrintTotalSold: '판매된 인화 매수',
    adminPrintTotalRevenue: '총 매출',
    adminPrintByDay: '일별 매출',
    adminPrintByHour: '시간대별 매출',
    adminPrintOrders: '주문 내역',
    adminCloud: '클라우드',
    adminCloudStatusEnabled: '사용 중',
    adminCloudStatusDisabled: '사용 안 함 (LAN URL만 사용)',
    adminCloudBucket: '버킷',
    adminCloudBucketNone: '설정 안 됨',
    adminCloudUploadTimeout: '업로드 제한시간(ms)',
    adminCloudDelivered: '클라우드로 전달된 사진',
    adminCloudLanFallback: 'LAN URL로 대체된 사진',
    filterNone: '필터 없음',
    filterWarm: '따뜻하게',
    filterCool: '시원하게',
    filterBw: '흑백',
    filterVintage: '빈티지',
    filterVivid: '선명하게',
    errorGeneric: '오류가 발생했습니다',
  },
  en: {
    appName: 'Photobooth',
    attractTitle: 'Photobooth',
    attractSubtitle: 'Tap the screen to start',
    startButton: 'Start',
    consentTitle: 'Photo & Portrait Rights Notice',
    consentBody:
      'Photos taken here are used only for on-site printing/download and will be automatically deleted after a set time. By continuing you agree to being photographed and to this usage.',
    agreeButton: 'Agree & Start',
    cancelButton: 'Cancel',
    themeTitle: 'Choose a frame',
    captureTitle: 'Taking photos',
    shotsProgress: '{taken} / {total} shots',
    shutterButton: 'Shutter',
    finishEarlyButton: 'Finish early',
    selectTitle: 'Pick your favorite 4, in order',
    selectProgress: '{count} / 4 selected',
    retakeButton: 'Retake',
    changeThemeButton: 'Change frame',
    confirmPicksButton: 'Confirm picks',
    filterTitle: 'Choose a filter',
    confirmFinalButton: 'Finish',
    qrTitle: 'All done!',
    qrSubtitle: 'Scan the QR code below to download your photos',
    restartButton: 'Start over',
    qrPrintOrderButton: 'Order prints',
    qrPrintQuantityLabel: 'Choose print quantity',
    qrPrintQuantityOf: '{quantity} prints',
    qrPrintConfirmQuantityButton: 'Confirm quantity',
    qrPrintCancelButton: 'Cancel order',
    qrPrintAwaitingPayment: 'Please pay by card at the counter',
    qrPrintTotal: 'Total: {total}',
    qrPrintConfirmPaymentButton: 'Confirm payment (staff)',
    remoteTitle: 'Remote',
    remoteWaiting: 'Waiting to start...',
    remoteShots: 'Shots remaining: {remaining}',
    displayIdle: 'Photobooth',
    displayIdleSub: 'Please start from the tablet',
    displaySelecting: 'Selecting...',
    displayFiltering: 'Applying filter...',
    displayQr: 'Scan to download!',
    cameraStart: 'Start Camera',
    cameraWaiting: 'Waiting',
    cameraMirror: 'Mirror',
    cameraSelectLabel: 'Select Camera',
    cameraSelectDefault: 'Default Camera',
    downloadTitle: 'My photo',
    downloadButton: 'Download',
    downloadPrivacy: 'This photo will be automatically deleted after {hours} hours.',
    notFoundTitle: 'Photo not found',
    notFoundBody: 'This photo could not be found or has expired.',
    adminFrames: 'Frames',
    adminSettings: 'Settings',
    adminStats: 'Stats',
    adminUpload: 'Upload',
    adminActive: 'Active',
    adminInactive: 'Inactive',
    adminDelete: 'Delete',
    adminMoveUp: 'Up',
    adminMoveDown: 'Down',
    adminSave: 'Save',
    adminPrintSettings: 'Print settings',
    adminPrintQueue: 'Print queue',
    adminPrintSettlement: 'Revenue settlement',
    adminPrintRetry: 'Retry',
    adminPrintCancel: 'Cancel',
    adminPrintNoJobs: 'No jobs queued',
    adminPrintTotalSold: 'Prints sold',
    adminPrintTotalRevenue: 'Total revenue',
    adminPrintByDay: 'Revenue by day',
    adminPrintByHour: 'Revenue by hour',
    adminPrintOrders: 'Order history',
    adminCloud: 'Cloud',
    adminCloudStatusEnabled: 'Enabled',
    adminCloudStatusDisabled: 'Disabled (LAN URL only)',
    adminCloudBucket: 'Bucket',
    adminCloudBucketNone: 'Not configured',
    adminCloudUploadTimeout: 'Upload timeout (ms)',
    adminCloudDelivered: 'Photos delivered via cloud',
    adminCloudLanFallback: 'Photos delivered via LAN URL',
    filterNone: 'None',
    filterWarm: 'Warm',
    filterCool: 'Cool',
    filterBw: 'B&W',
    filterVintage: 'Vintage',
    filterVivid: 'Vivid',
    errorGeneric: 'Something went wrong',
  },
};

const STORAGE_KEY = 'photobooth.lang';

export function getLang() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'ko' || stored === 'en') return stored;
  return 'ko';
}

export function setLang(lang) {
  if (lang !== 'ko' && lang !== 'en') return;
  localStorage.setItem(STORAGE_KEY, lang);
}

export function t(key, vars = {}) {
  const lang = getLang();
  const dict = DICT[lang] || DICT.ko;
  let str = dict[key] || DICT.ko[key] || key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(`{${k}}`, v);
  }
  return str;
}

/**
 * Creates a small floating language toggle button, appended to `container`.
 * Calls `onChange(lang)` (and re-renders) whenever the language changes.
 */
export function mountLangToggle(container, onChange) {
  const btn = document.createElement('button');
  btn.className = 'lang-toggle';
  const render = () => {
    btn.textContent = getLang() === 'ko' ? 'EN' : '한국어';
  };
  render();
  btn.addEventListener('click', () => {
    setLang(getLang() === 'ko' ? 'en' : 'ko');
    render();
    if (typeof onChange === 'function') onChange(getLang());
  });
  container.appendChild(btn);
  return btn;
}
