/* 집중ON 화면 로직
 *  0) 로그인 / 회원가입
 *  1) 영상 불러오기: 유튜브 링크 또는 내 영상 파일
 *  2) 학습 시작 전에는 영상 재생 잠금
 *  3) 영상이 재생되는 동안 일정 간격으로 집중 미션 → 실패 누적 시 강제 종료
 *  4) 학습이 끝나면 등록된 요약 + OX 퀴즈 → 틀린 문제는 오답 노트에 저장
 *  5) 다음 학습을 시작할 때 오답이 있으면 경고창
 *  6) 퀴즈 관리: 영상별 요약과 OX 문제 만들기·고치기·지우기
 */
const $ = (id) => document.getElementById(id);

const SETTINGS_KEY = 'jipjungon_settings_v2';
const PHRASES = ['집중해서 배우기', '지금 영상에 집중', '배운 것은 내 것', '끝까지 해내기', '천천히 정확하게', '오늘도 한 걸음', '눈을 뜨고 집중'];

const state = {
  user: null,
  ytReady: false,
  source: 'yt',          // 'yt' 유튜브 | 'file' 내 영상 파일
  video: null,           // { key, title, kind }
  session: null,         // { watchSec, nextAt, missions, success, fail }
  mission: null,
  ticker: null,
  pack: null,
  answers: {},
  graded: false,
};

/* ---------- 공통 도구 ---------- */
// 예전에는 서버에 요청했지만, 이제는 기기 저장소(localdb.js)가 대신 처리한다
async function api(path, opts = {}) {
  try {
    return await window.localApi(path, opts);
  } catch (err) {
    if (err.status === 401 && !path.startsWith('/api/auth/')) showAuth();
    throw err;
  }
}
const fmt = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function setStatus(text, kind = '') { $('sessionStatus').textContent = text; $('sessionStatus').className = 'status ' + kind; }
function setNotice(text, kind = '') { $('sessionNotice').textContent = text; $('sessionNotice').className = 'notice mt ' + kind; }

// 유튜브 주소에서 영상 ID 뽑기
function extractId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be' || u.hostname.endsWith('.youtu.be')) return u.pathname.split('/').filter(Boolean)[0] || '';
    if (u.hostname.includes('youtube.com')) {
      if (u.pathname === '/watch') return u.searchParams.get('v') || '';
      const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/);
      return m ? m[1] : '';
    }
  } catch { /* 잘못된 주소 */ }
  return '';
}

// 내 영상 파일 구분용 열쇠: 파일 이름 + 크기로 만든 짧은 코드 (같은 파일이면 항상 같은 코드)
function fileKey(file) {
  const s = file.name + '|' + file.size;
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return 'file_' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
const stripExt = (name) => name.replace(/\.[^.]+$/, '');

/* ---------- 설정 ---------- */
const settings = (() => {
  const d = { interval: 180, timeLimit: 10, maxFails: 3, pause: true, sound: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return d; }
})();
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* 저장 불가 시 무시 */ } }
function bindSettings() {
  const map = { setInterval: 'interval', setTimeLimit: 'timeLimit', setMaxFails: 'maxFails' };
  for (const [id, key] of Object.entries(map)) {
    $(id).value = String(settings[key]);
    $(id).addEventListener('change', () => { settings[key] = Number($(id).value); saveSettings(); updateSessionUI(); });
  }
  $('setPause').checked = settings.pause;
  $('setSound').checked = settings.sound;
  $('setPause').addEventListener('change', () => { settings.pause = $('setPause').checked; saveSettings(); });
  $('setSound').addEventListener('change', () => { settings.sound = $('setSound').checked; saveSettings(); });
}

/* ---------- 소리 ---------- */
function audioCtx() { return beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)()); }
function beep(freq = 880, ms = 180) {
  if (!settings.sound) return;
  try {
    const ctx = audioCtx();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = freq; g.gain.value = 0.12;
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + ms / 1000);
  } catch { /* 소리 재생 불가 시 무시 */ }
}
// 스마트폰은 화면을 누른 순간에만 소리를 켤 수 있어서, 터치할 때 미리 준비해 둔다
document.addEventListener('pointerdown', () => { try { const c = audioCtx(); if (c.state === 'suspended') c.resume(); } catch { /* 무시 */ } }, { passive: true });

/* =====================================================
 *  0. 로그인 / 회원가입
 * ===================================================== */
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  $('tabLogin').classList.toggle('on', mode === 'login');
  $('tabSignup').classList.toggle('on', mode === 'signup');
  $('nameRow').hidden = mode === 'login';
  $('authSubmit').textContent = mode === 'login' ? '로그인' : '회원가입하고 시작';
  $('authPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('authError').textContent = '';
}
$('tabLogin').addEventListener('click', () => setAuthMode('login'));
$('tabSignup').addEventListener('click', () => setAuthMode('signup'));

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('authUser').value.trim();
  const password = $('authPass').value;
  const name = $('authName').value.trim();
  if (!username || !password || (authMode === 'signup' && !name)) { $('authError').textContent = '빈 칸을 모두 채워 줘.'; return; }
  $('authSubmit').disabled = true;
  try {
    const r = await api(authMode === 'login' ? '/api/auth/login' : '/api/auth/signup', {
      method: 'POST', body: { username, password, name },
    });
    $('authPass').value = '';
    enterApp(r.user);
  } catch (err) {
    $('authError').textContent = err.code === 'BAD_LOGIN'
      ? '아이디 또는 비밀번호가 맞지 않아. 이 기기에서 처음 쓰는 거라면 위쪽 [회원가입] 탭을 눌러 먼저 가입해 줘.'
      : err.message;
  } finally {
    $('authSubmit').disabled = false;
  }
});

$('logoutBtn').addEventListener('click', async () => {
  if (state.session) { setNotice('학습 중에는 로그아웃할 수 없어. 먼저 학습을 끝내 줘.', 'warn'); return; }
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* 무시 */ }
  location.reload();
});

function showAuth() {
  $('appView').hidden = true;
  $('authView').hidden = false;
  setAuthMode('login');
  setTimeout(() => $('authUser').focus(), 50);
}

function enterApp(user) {
  state.user = user;
  $('userTag').textContent = `${user.name}님`;
  $('authView').hidden = true;
  $('appView').hidden = false;
  showView('study');
  refreshReview();
  refreshHistory();
  window.flushSheet?.();
}

/* ---------- 화면 전환: 학습하기 / 퀴즈 관리 ---------- */
function showView(name) {
  if (name !== 'study' && state.session) { setNotice('학습 중에는 다른 화면으로 갈 수 없어. 먼저 학습을 끝내 줘.', 'warn'); return; }
  $('studyView').hidden = name !== 'study';
  $('manageView').hidden = name !== 'manage';
  $('reportView').hidden = name !== 'report';
  $('navStudy').classList.toggle('on', name === 'study');
  $('navManage').classList.toggle('on', name === 'manage');
  $('navReport').classList.toggle('on', name === 'report');
  if (name === 'manage') refreshPacks();
  if (name === 'report') refreshReport();
  if (name === 'study') refreshRecommend();
}
$('navStudy').addEventListener('click', () => showView('study'));
$('navManage').addEventListener('click', () => showView('manage'));
$('navReport').addEventListener('click', () => showView('report'));

/* =====================================================
 *  1. 영상 플레이어 (유튜브 / 내 영상 파일을 같은 방식으로 다룸)
 * ===================================================== */
const video = $('localVideo');
let yt = null;
let fileUrl = '';

const player = {
  isPlaying() {
    if (state.video?.kind === 'file') return !video.paused && !video.ended;
    return !!yt && yt.getPlayerState?.() === YT.PlayerState.PLAYING;
  },
  play() { try { state.video?.kind === 'file' ? video.play().catch(() => {}) : yt?.playVideo(); } catch { /* 무시 */ } },
  pause() { try { state.video?.kind === 'file' ? video.pause() : yt?.pauseVideo(); } catch { /* 무시 */ } },
  stop() {
    try {
      if (state.video?.kind === 'file') { video.pause(); video.currentTime = 0; } else yt?.stopVideo();
    } catch { /* 무시 */ }
  },
};

// 2. 학습 시작 전 재생 잠금: 영상 위를 가리고, 조작 버튼도 숨긴다
function setLocked(locked) {
  $('lockCover').hidden = !(locked && state.video);
  video.controls = !locked;
}
// 미션 중(일시정지 설정)이거나 학습 중이 아니면 재생을 허용하지 않음
const playBlocked = () => !state.session || (state.mission && !state.mission.done && settings.pause);

window.onYouTubeIframeAPIReady = () => { state.ytReady = true; if (state.video?.kind === 'yt') createYt(state.video.key); };

function createYt(id) {
  if (!state.ytReady) return;
  if (yt) { yt.cueVideoById(id); return; }
  yt = new YT.Player('player', {
    videoId: id,
    playerVars: { rel: 0, playsinline: 1, modestbranding: 1 },
    events: {
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.PLAYING && playBlocked()) yt.pauseVideo();
        if (e.data === YT.PlayerState.ENDED && state.session) endSession('완주');
      },
      onError: () => { $('videoError').textContent = '이 영상은 외부 재생이 막혀 있거나 찾을 수 없어. 다른 영상을 골라 줘.'; },
    },
  });
}

video.addEventListener('play', () => { if (playBlocked()) video.pause(); });
video.addEventListener('ended', () => { if (state.session) endSession('완주'); });
video.addEventListener('error', () => { if (state.video?.kind === 'file') $('videoError').textContent = '이 파일은 재생할 수 없는 형식이야. mp4 영상을 골라 줘.'; });

function setSource(src) {
  if (state.session) return;
  state.source = src;
  $('srcYt').classList.toggle('on', src === 'yt');
  $('srcFile').classList.toggle('on', src === 'file');
  $('videoForm').hidden = src !== 'yt';
  $('fileBox').hidden = src !== 'file';
  $('videoError').textContent = '';
}
$('srcYt').addEventListener('click', () => setSource('yt'));
$('srcFile').addEventListener('click', () => setSource('file'));

function showPlayer(kind) {
  $('playerEmpty').hidden = true;
  $('ytHost').hidden = kind !== 'yt';
  video.hidden = kind !== 'file';
  if (kind === 'yt') video.pause(); else { try { yt?.pauseVideo(); } catch { /* 무시 */ } }
}

function videoReady(v) {
  state.video = v;
  resetQuiz();
  $('videoTitle').textContent = v.title;
  $('startBtn').disabled = false;
  setLocked(true);
  setStatus('영상 준비 완료', 'good');
}

$('videoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.session) return;
  const id = extractId($('videoUrl').value.trim());
  if (!/^[\w-]{11}$/.test(id)) { $('videoError').textContent = '유효한 유튜브 영상 주소를 입력해 줘.'; return; }
  $('videoError').textContent = '';
  showPlayer('yt');
  if (state.ytReady) createYt(id); else $('videoError').textContent = '유튜브 플레이어를 준비하는 중이야. 잠시만 기다려 줘.';
  $('videoTitle').textContent = '제목 불러오는 중…';
  let title = '유튜브 영상 ' + id;
  try { title = (await api('/api/video/' + id)).title; } catch { /* 기본 제목 사용 */ }
  videoReady({ key: id, title, kind: 'yt' });
});

$('videoFile').addEventListener('change', () => {
  const f = $('videoFile').files[0];
  if (!f || state.session) return;
  if (!f.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v|ogv)$/i.test(f.name)) { $('videoError').textContent = '영상 파일만 고를 수 있어.'; return; }
  $('videoError').textContent = '';
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = URL.createObjectURL(f);
  video.src = fileUrl;
  showPlayer('file');
  videoReady({ key: fileKey(f), title: stripExt(f.name), kind: 'file' });
  $('videoFile').value = '';
});

/* =====================================================
 *  5. 학습 시작 전 오답 경고
 * ===================================================== */
$('startBtn').addEventListener('click', async () => {
  if (!state.video || state.session) return;
  let wrong = [];
  try { wrong = (await api('/api/wrong')).items; } catch { /* 서버 오류 시 그냥 시작 */ }
  if (wrong.length) showReviewWarning(wrong); else beginSession();
});

function showReviewWarning(items) {
  beep(520, 250);
  $('reviewCount').textContent = items.length;
  const list = $('reviewModalList');
  list.innerHTML = '';
  let remaining = items.length;
  $('doneReviewBtn').disabled = true;
  items.forEach((w) => {
    const box = el('div', 'review-item');
    box.append(el('small', '', w.videoTitle || '이전 학습'), el('p', '', w.question), el('p', 'answer-line', `정답: ${w.answer}  ·  내 답: ${w.userAnswer}`));
    if (w.explanation) box.append(el('p', 'muted small', w.explanation));
    const btn = el('button', 'secondary btn-sm', '이해했어요');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await api(`/api/wrong/${w.id}/review`, { method: 'POST' }); } catch { /* 다음에 다시 표시됨 */ }
      box.classList.add('done'); btn.textContent = '복습 완료 ✓';
      if (--remaining === 0) $('doneReviewBtn').disabled = false;
    });
    box.append(btn);
    list.append(box);
  });
  $('reviewOverlay').hidden = false;
}
$('doneReviewBtn').addEventListener('click', () => { $('reviewOverlay').hidden = true; refreshReview(); beginSession(); });
$('skipReviewBtn').addEventListener('click', () => { $('reviewOverlay').hidden = true; refreshReview(); beginSession(); });

/* =====================================================
 *  3. 학습 세션 + 집중 미션
 * ===================================================== */
const nextInterval = () => Math.round(settings.interval * (0.7 + Math.random() * 0.6)); // 예측하기 어렵게 ±30%

function lockControls(on) {
  $('startBtn').disabled = on; $('endBtn').disabled = !on;
  $('loadBtn').disabled = on; $('videoUrl').disabled = on;
  $('srcYt').disabled = on; $('srcFile').disabled = on; $('videoFile').disabled = on;
}

function beginSession() {
  resetQuiz();
  state.session = { watchSec: 0, nextAt: nextInterval(), missions: 0, success: 0, fail: 0 };
  lockControls(true);
  setLocked(false);
  setStatus('학습 중', 'good');
  setNotice('학습을 시작했어. 영상이 재생되는 동안 집중 미션이 불쑥 나타날 거야.');
  updateSessionUI();
  player.play();
  clearInterval(state.ticker);
  state.ticker = setInterval(tick, 1000);
}

function tick() {
  const s = state.session;
  if (!s || state.mission) return;
  if (player.isPlaying()) {
    s.watchSec++;
    if (s.watchSec >= s.nextAt) startMission();
  }
  updateSessionUI();
}

function updateSessionUI() {
  const s = state.session;
  $('watchTime').textContent = fmt(s ? s.watchSec : 0);
  $('nextMission').textContent = s ? fmt(Math.max(0, s.nextAt - s.watchSec)) : '--:--';
  $('successCount').textContent = s ? s.success : 0;
  if (s) {
    const left = Math.max(0, settings.maxFails - s.fail);
    $('lives').textContent = '♥'.repeat(left) + '♡'.repeat(Math.max(0, settings.maxFails - left));
  } else {
    $('lives').textContent = '-';
  }
}

function startMission() {
  const s = state.session;
  s.missions++;
  const m = { type: pick(['click', 'type', 'math']), timeLeft: settings.timeLimit, total: settings.timeLimit, done: false };
  state.mission = m;
  if (settings.pause) player.pause();

  const area = $('missionArea');
  area.innerHTML = '';
  $('missionMsg').textContent = ''; $('missionMsg').className = 'mission-msg';
  $('missionLabel').textContent = `집중 미션 #${s.missions}`;

  if (m.type === 'click') {
    m.target = 3; m.count = 0;
    $('missionPrompt').textContent = '움직이는 버튼을 3번 눌러!';
    const box = el('div', 'click-area');
    const btn = el('button', 'primary', '누르기 (0/3)');
    btn.type = 'button';
    const move = () => {
      const w = box.clientWidth - 120, h = box.clientHeight - 48;
      btn.style.left = rand(8, Math.max(8, w)) + 'px';
      btn.style.top = rand(8, Math.max(8, h)) + 'px';
    };
    btn.addEventListener('click', () => {
      if (m.done) return;
      m.count++;
      btn.textContent = `누르기 (${m.count}/3)`;
      if (m.count >= m.target) finishMission(true); else move();
    });
    box.append(btn); area.append(box);
    requestAnimationFrame(move);
  } else {
    if (m.type === 'type') {
      m.answer = pick(PHRASES);
      $('missionPrompt').textContent = `아래 문구를 ${m.total}초 안에 똑같이 입력해!`;
      area.append(el('div', 'phrase', m.answer));
    } else {
      const a = rand(3, 19), b = rand(2, 9), plus = Math.random() < 0.6;
      m.answer = String(plus ? a + b : a * b);
      $('missionPrompt').textContent = `계산해서 숫자로 입력해!  ${a} ${plus ? '+' : '×'} ${b} = ?`;
    }
    const inp = el('input');
    inp.id = 'missionInput'; inp.autocomplete = 'off';
    inp.placeholder = m.type === 'math' ? '숫자 입력 후 확인' : '문구 입력 후 확인';
    if (m.type === 'math') inp.inputMode = 'numeric';
    // 복사·붙여넣기로 통과하지 못하게 막기
    ['paste', 'drop'].forEach((ev) => inp.addEventListener(ev, (e) => { e.preventDefault(); showMissionMsg('붙여넣기는 안 돼. 직접 입력해 줘!', 'bad'); }));
    const submit = el('button', 'primary full mt', '확인');
    const check = () => {
      if (m.done) return;
      const v = inp.value.replace(/\s+/g, ' ').trim();
      if (!v) return;
      if (v === m.answer) finishMission(true);
      else { showMissionMsg('틀렸어. 다시 확인해 봐!', 'bad'); inp.select(); }
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) check(); });
    submit.addEventListener('click', check);
    area.append(inp, submit);
    setTimeout(() => inp.focus(), 50);
  }

  renderMissionTimer();
  $('missionOverlay').hidden = false;
  beep();
  m.timer = setInterval(() => {
    m.timeLeft--;
    renderMissionTimer();
    if (m.timeLeft <= 3 && m.timeLeft > 0) beep(1200, 80);
    if (m.timeLeft <= 0) finishMission(false);
  }, 1000);
}

function renderMissionTimer() {
  const m = state.mission; if (!m) return;
  $('missionTimer').textContent = Math.max(0, m.timeLeft);
  $('missionTimer').classList.toggle('hurry', m.timeLeft <= 3);
  $('timebar').style.width = (Math.max(0, m.timeLeft) / m.total * 100) + '%';
}
function showMissionMsg(t, kind) { $('missionMsg').textContent = t; $('missionMsg').className = 'mission-msg ' + kind; }

function finishMission(ok) {
  const m = state.mission, s = state.session;
  if (!m || m.done) return;
  m.done = true;
  clearInterval(m.timer);

  if (ok) {
    s.success++;
    s.nextAt = s.watchSec + nextInterval();
    showMissionMsg('미션 성공! 계속 집중해 보자.', 'good');
    setNotice(`미션 ${s.missions}번 성공! 잘하고 있어.`, 'good');
    // 스마트폰은 화면을 누른 그 순간에만 영상을 다시 재생할 수 있어서 바로 재생한다
    if (settings.pause) player.play();
    closeMission(900, false);
  } else {
    s.fail++;
    s.nextAt = s.watchSec + Math.max(10, Math.round(nextInterval() / 2)); // 실패하면 다음 미션을 더 빨리
    updateSessionUI();
    if (s.fail >= settings.maxFails) {
      showMissionMsg('시간 초과!', 'bad');
      setTimeout(() => { $('missionOverlay').hidden = true; state.mission = null; forceQuit(); }, 900);
      return;
    }
    const left = settings.maxFails - s.fail;
    const warnText = left === 1 ? '⚠ 시간 초과! 한 번만 더 놓치면 학습이 강제 종료돼.' : `시간 초과! 남은 기회는 ${left}번이야.`;
    showMissionMsg(warnText, 'bad');
    setNotice(warnText, left === 1 ? 'bad' : 'warn');
    beep(300, 400);
    closeMission(2200, true);
  }
}

function closeMission(delay, resume) {
  setTimeout(() => {
    $('missionOverlay').hidden = true;
    state.mission = null;
    updateSessionUI();
    if (resume && state.session && settings.pause) player.play();
  }, delay);
}

/* 실패 누적 → 강제 종료 */
function forceQuit() {
  const s = state.session;
  clearInterval(state.ticker);
  player.stop();
  saveSession('강제 종료');
  state.session = null;
  setLocked(true);
  setStatus('강제 종료', 'bad');
  setNotice('집중 미션을 계속 놓쳐서 학습이 강제 종료됐어.', 'bad');
  $('startBtn').disabled = true; $('endBtn').disabled = true;

  $('quitFails').textContent = s.fail;
  $('quitHomeBtn').hidden = true;
  $('quitOverlay').hidden = false;
  beep(220, 700);
  let n = 5;
  $('quitCount').textContent = n;
  const t = setInterval(() => {
    n--;
    $('quitCount').textContent = n;
    if (n <= 0) {
      clearInterval(t);
      $('quitText').textContent = '학습이 종료됐어. 물 한 잔 마시고, 잠깐 스트레칭한 다음 다시 시작하자.';
      $('quitHomeBtn').hidden = false;
      window.close(); // 설치형 앱으로 감쌌을 때만 실제로 창이 닫힘
    }
  }, 1000);
}
$('quitHomeBtn').addEventListener('click', () => location.reload());

/* 정상 종료 (영상 끝 / 학습 끝내기 버튼) */
$('endBtn').addEventListener('click', () => { if (state.session) endSession('중간 종료'); });

function endSession(result) {
  clearInterval(state.ticker);
  if (state.mission) { clearInterval(state.mission.timer); state.mission = null; $('missionOverlay').hidden = true; }
  saveSession(result);
  const s = state.session;
  state.session = null;
  player.pause();
  lockControls(false);
  setLocked(true);
  setStatus(result === '완주' ? '영상 완주!' : '학습 종료', 'good');
  setNotice(`수고했어! 시청 ${fmt(s.watchSec)}, 미션 ${s.success}/${s.missions} 성공. 아래 퀴즈로 복습해 보자.`, 'good');
  updateSessionUI();
  $('quizCard').hidden = false;
  $('quizCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  loadPack();
}

function saveSession(result) {
  const s = state.session; if (!s) return;
  api('/api/sessions', {
    method: 'POST',
    body: { videoId: state.video.key, videoTitle: state.video.title, watchSec: s.watchSec, missions: s.missions, success: s.success, fail: s.fail, result },
  }).then(() => { refreshHistory(); refreshRecommend(); }).catch(() => {});
}

/* =====================================================
 *  4. 요약 + OX 퀴즈 풀기
 * ===================================================== */
function resetQuiz() {
  state.pack = null; state.answers = {}; state.graded = false;
  $('quizCard').hidden = true;
  $('summaryBox').hidden = true; $('noPackBox').hidden = true; $('quizLoading').hidden = true;
  $('editPackBtn').hidden = true;
  $('quizResult').innerHTML = '';
}

async function loadPack() {
  $('quizLoading').hidden = false; $('noPackBox').hidden = true; $('summaryBox').hidden = true;
  await new Promise((r) => setTimeout(r, 900));
  try {
    state.pack = await api('/api/pack/' + state.video.key);
    renderPack();
  } catch {
    await renderPickList();
    $('noPackBox').hidden = false;
  } finally {
    $('quizLoading').hidden = true;
  }
}

// 이 영상과 연결된 퀴즈가 없을 때: 등록된 퀴즈 목록에서 직접 골라 풀기
async function renderPickList() {
  const root = $('pickList');
  root.innerHTML = '';
  let items = [];
  try { items = (await api('/api/packs')).items; } catch { /* 목록 없음 */ }
  if (!items.length) {
    root.append(el('p', 'muted small', '이 기기에 등록된 퀴즈가 없어. 퀴즈 관리에서 퀴즈 파일 가져오기를 하거나, 아래 버튼으로 새로 만들어 줘.'));
    return;
  }
  items.forEach((p) => {
    const row = el('div', 'pack');
    const info = el('div', 'info');
    const meta = el('small');
    meta.append(el('span', 'chip' + (p.type === 'file' ? ' file' : ''), p.type === 'file' ? '내 파일' : '유튜브'));
    meta.append(document.createTextNode(`OX ${p.count}문제`));
    info.append(el('b', '', p.title), meta);
    const go = el('button', 'primary btn-sm', '이 퀴즈 풀기');
    go.type = 'button';
    go.addEventListener('click', async () => {
      try {
        state.pack = await api('/api/pack/' + p.key);
        renderPack();
        $('summaryBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (e) { root.append(el('p', 'error', e.message)); }
    });
    row.append(info, go);
    root.append(row);
  });
}
$('makePackBtn').addEventListener('click', () => openEditor(state.video, null, (pack) => { state.pack = pack; renderPack(); }));
$('editPackBtn').addEventListener('click', () => openEditor(state.video, state.pack, (pack) => { state.pack = pack; renderPack(); }));

function renderPack() {
  const p = state.pack;
  state.answers = {}; state.graded = false;
  $('noPackBox').hidden = true;
  $('summaryText').textContent = p.summary || '(등록된 요약이 없어.)';
  $('keyPoints').innerHTML = '';
  p.keyPoints.forEach((k) => $('keyPoints').append(el('li', '', k)));
  const list = $('quizList');
  list.innerHTML = '';
  p.quiz.forEach((q, i) => {
    const box = el('div', 'quizq'); box.id = 'q' + i;
    const choices = el('div', 'choice');
    ['O', 'X'].forEach((v) => {
      const b = el('button', 'secondary', v); b.type = 'button';
      b.addEventListener('click', () => {
        if (state.graded) return;
        state.answers[i] = v;
        [...choices.children].forEach((x) => x.classList.remove('picked'));
        b.classList.add('picked');
      });
      choices.append(b);
    });
    box.append(el('p', '', `${i + 1}. ${q.question}`), choices);
    list.append(box);
  });
  $('gradeBtn').disabled = false;
  $('quizResult').innerHTML = '';
  $('summaryBox').hidden = false;
  $('editPackBtn').hidden = false;
}

$('gradeBtn').addEventListener('click', async () => {
  const p = state.pack; if (!p || state.graded) return;
  if (Object.keys(state.answers).length < p.quiz.length) {
    $('quizResult').className = 'notice warn mt';
    $('quizResult').textContent = '아직 안 푼 문제가 있어. 모든 문제에 O 또는 X를 골라 줘.';
    return;
  }
  state.graded = true;
  $('gradeBtn').disabled = true;
  let correct = 0;
  const wrong = [];
  p.quiz.forEach((q, i) => {
    const mine = state.answers[i];
    const ok = mine === q.answer;
    if (ok) correct++;
    else wrong.push({ question: q.question, answer: q.answer, userAnswer: mine, explanation: q.explanation, videoId: state.video.key, videoTitle: state.video.title });
    const box = $('q' + i);
    box.classList.add(ok ? 'correct' : 'wrong');
    const ex = el('p', 'explain');
    ex.append(el('b', '', ok ? `⭕ 정답 (${q.answer}) ` : `❌ 오답 · 정답은 ${q.answer} `), document.createTextNode(q.explanation || ''));
    box.append(ex);
  });
  if (wrong.length) {
    try { await api('/api/wrong', { method: 'POST', body: { items: wrong } }); } catch { /* 저장 실패 */ }
    refreshReview();
  }
  try { await api('/api/quizlog', { method: 'POST', body: { videoId: state.video.key, videoTitle: state.video.title, total: p.quiz.length, correct } }); } catch { /* 저장 실패 */ }
  refreshRecommend();
  $('quizResult').className = 'notice mt ' + (wrong.length ? 'warn' : 'good');
  $('quizResult').textContent = wrong.length
    ? `${p.quiz.length}문제 중 ${correct}개 맞혔어. 틀린 ${wrong.length}문제는 다음 학습을 시작할 때 다시 보여 줄게.`
    : `${p.quiz.length}문제 모두 정답! 완벽해.`;
});

/* =====================================================
 *  6. 요약·퀴즈 편집 창 (학습 화면과 퀴즈 관리에서 함께 사용)
 * ===================================================== */
let editing = null; // { video, onSaved }
let draft = [];

// 편집 중인 내용을 이 기기에 임시 저장 (연결이 끊겨도 다시 열면 그대로 나옴)
const DRAFT_KEY = (key) => 'jipjungon_draft_' + key;
function saveDraftLocal() {
  if (!editing) return;
  try {
    localStorage.setItem(DRAFT_KEY(editing.video.key), JSON.stringify({
      title: $('edTitle').value, summary: $('edSummary').value, points: $('edPoints').value, quiz: draft,
    }));
  } catch { /* 저장 공간 없음 */ }
}
function loadDraftLocal(key) { try { return JSON.parse(localStorage.getItem(DRAFT_KEY(key)) || 'null'); } catch { return null; } }
function clearDraftLocal(key) { try { localStorage.removeItem(DRAFT_KEY(key)); } catch { /* 무시 */ } }
['edTitle', 'edSummary', 'edPoints', 'edQuestions'].forEach((id) => $(id).addEventListener('input', saveDraftLocal));
$('edQuestions').addEventListener('click', () => setTimeout(saveDraftLocal, 0));

function openEditor(v, pack, onSaved) {
  editing = { video: v, onSaved };
  $('editorTitle').textContent = pack ? '요약과 퀴즈 고치기' : '요약과 퀴즈 만들기';
  $('editorVideo').textContent = (v.kind === 'file' ? '내 영상 파일 · ' : '유튜브 · ') + v.title;
  $('edTitle').value = pack?.title || v.title;
  $('edSummary').value = pack?.summary || '';
  $('edPoints').value = pack ? pack.keyPoints.join('\n') : '';
  draft = pack ? pack.quiz.map((q) => ({ ...q })) : [{ question: '', answer: 'O', explanation: '' }, { question: '', answer: 'X', explanation: '' }];
  $('editorError').textContent = '';
  const saved = loadDraftLocal(v.key);
  if (saved) {
    $('edTitle').value = saved.title; $('edSummary').value = saved.summary; $('edPoints').value = saved.points;
    draft = Array.isArray(saved.quiz) && saved.quiz.length ? saved.quiz : draft;
    $('editorError').textContent = '저장하지 못했던 내용을 불러왔어. 확인하고 저장을 눌러 줘.';
  }
  renderDraft();
  $('editorOverlay').hidden = false;
  setTimeout(() => $('edSummary').focus(), 50);
}
function closeEditor() { $('editorOverlay').hidden = true; editing = null; }
$('closeEditorBtn').addEventListener('click', closeEditor);

function renderDraft() {
  const root = $('edQuestions');
  root.innerHTML = '';
  draft.forEach((q, i) => {
    const box = el('div', 'edq');
    const qIn = el('input'); qIn.id = 'edq' + i; qIn.placeholder = `문제 ${i + 1} (예: 광합성은 뿌리에서 일어난다.)`; qIn.value = q.question;
    qIn.addEventListener('input', () => { q.question = qIn.value; });
    const row = el('div', 'row');
    const ox = el('div', 'ox');
    ['O', 'X'].forEach((v) => {
      const b = el('button', 'secondary btn-sm' + (q.answer === v ? ' on' : ''), v); b.type = 'button';
      b.setAttribute('aria-label', '정답 ' + v);
      b.addEventListener('click', () => { q.answer = v; [...ox.children].forEach((x) => x.classList.toggle('on', x === b)); });
      ox.append(b);
    });
    const exIn = el('input', 'grow'); exIn.id = 'edx' + i; exIn.placeholder = '정답 이유 (선택)'; exIn.value = q.explanation;
    exIn.addEventListener('input', () => { q.explanation = exIn.value; });
    const del = el('button', 'danger btn-sm', '삭제'); del.type = 'button';
    del.addEventListener('click', () => { draft.splice(i, 1); renderDraft(); saveDraftLocal(); });
    row.append(el('span', 'muted small', '정답'), ox, exIn, del);
    box.append(qIn, row);
    root.append(box);
  });
}
$('addQBtn').addEventListener('click', () => {
  if (draft.length >= 10) { $('editorError').textContent = '문제는 10개까지 만들 수 있어.'; return; }
  draft.push({ question: '', answer: 'O', explanation: '' });
  renderDraft();
  $('edq' + (draft.length - 1)).focus();
});
$('savePackBtn').addEventListener('click', async () => {
  if (!editing) return;
  const quiz = draft.filter((q) => q.question.trim());
  if (!quiz.length) { $('editorError').textContent = 'OX 문제를 한 개 이상 입력해 줘.'; return; }
  $('savePackBtn').disabled = true;
  try {
    const pack = await api('/api/pack/' + editing.video.key, {
      method: 'PUT',
      body: { title: $('edTitle').value, summary: $('edSummary').value, keyPoints: $('edPoints').value.split('\n'), quiz },
    });
    const done = editing.onSaved;
    clearDraftLocal(editing.video.key);
    closeEditor();
    done?.(pack);
  } catch (e) {
    $('editorError').textContent = e.message;
  } finally {
    $('savePackBtn').disabled = false;
  }
});

/* ---------- 퀴즈 관리 화면 ---------- */
async function refreshPacks() {
  let items = [];
  try { items = (await api('/api/packs')).items; } catch { return; }
  $('packCount').textContent = items.length + '개';
  const root = $('packList');
  root.innerHTML = '';
  if (!items.length) { root.append(el('p', 'muted small', '아직 등록된 퀴즈가 없어. 오른쪽에서 새로 만들어 봐.')); return; }
  items.forEach((p) => {
    const row = el('div', 'pack');
    const info = el('div', 'info');
    const meta = el('small');
    meta.append(el('span', 'chip' + (p.type === 'file' ? ' file' : ''), p.type === 'file' ? '내 파일' : '유튜브'));
    if (p.builtIn) meta.append(el('span', 'chip base', '기본'));
    const d = new Date(p.updatedAt);
    meta.append(document.createTextNode(`OX ${p.count}문제 · ${d.getMonth() + 1}/${d.getDate()} ${p.updatedBy ? p.updatedBy + ' 수정' : ''}`));
    info.append(el('b', '', p.title), meta);
    const btns = el('div', 'btns');
    const edit = el('button', 'secondary btn-sm', '고치기');
    edit.addEventListener('click', async () => {
      try {
        const full = await api('/api/pack/' + p.key);
        openEditor({ key: p.key, title: full.title, kind: p.type === 'file' ? 'file' : 'yt' }, full, refreshPacks);
      } catch (e) { $('newError').textContent = e.message; }
    });
    const del = el('button', 'danger btn-sm', '지우기');
    let armed = false;
    del.addEventListener('click', async () => {
      if (!armed) { armed = true; del.textContent = '정말 지울까?'; setTimeout(() => { armed = false; del.textContent = '지우기'; }, 3000); return; }
      try { await api('/api/pack/' + p.key, { method: 'DELETE' }); } catch { /* 무시 */ }
      refreshPacks();
    });
    btns.append(edit, del);
    row.append(info, btns);
    root.append(row);
  });
}

async function openNewOrExisting(v) {
  $('newError').textContent = '';
  let existing = null;
  try { existing = await api('/api/pack/' + v.key); } catch { /* 새로 만들기 */ }
  openEditor(v, existing, refreshPacks);
}
$('newYtForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = extractId($('newUrl').value.trim());
  if (!/^[\w-]{11}$/.test(id)) { $('newError').textContent = '유효한 유튜브 영상 주소를 입력해 줘.'; return; }
  let title = '유튜브 영상 ' + id;
  try { title = (await api('/api/video/' + id)).title; } catch { /* 기본 제목 */ }
  $('newUrl').value = '';
  openNewOrExisting({ key: id, title, kind: 'yt' });
});
$('newFile').addEventListener('change', () => {
  const f = $('newFile').files[0];
  if (!f) return;
  openNewOrExisting({ key: fileKey(f), title: stripExt(f.name), kind: 'file' });
  $('newFile').value = '';
});

/* ---------- 퀴즈 옮기기: 파일로 내보내기 / 가져오기 ---------- */
function moveMsg(text, kind = '') { $('moveMsg').hidden = false; $('moveMsg').className = 'notice mt ' + kind; $('moveMsg').textContent = text; }
$('exportBtn').addEventListener('click', async () => {
  try {
    const data = await window.quizFile.exportPacks();
    const n = Object.keys(data.packs).length;
    if (!n) { moveMsg('내보낼 퀴즈가 없어. 먼저 퀴즈를 만들어 줘.', 'warn'); return; }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'quizzes.json';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    moveMsg(`퀴즈 ${n}개를 quizzes.json 파일로 저장했어. 다른 기기에서 가져오기를 하거나, 깃허브에 올리면 모든 기기에서 기본 퀴즈로 보여.`, 'good');
  } catch (e) { moveMsg(e.message, 'bad'); }
});
$('importFile').addEventListener('change', async () => {
  const f = $('importFile').files[0];
  $('importFile').value = '';
  if (!f) return;
  try {
    const n = window.quizFile.importPacks(JSON.parse(await f.text()), state.user?.name || '');
    moveMsg(`퀴즈 ${n}개를 가져왔어. 같은 영상의 퀴즈는 가져온 내용으로 바뀌었어.`, 'good');
    refreshPacks();
  } catch (e) {
    moveMsg(e instanceof SyntaxError ? '파일을 읽지 못했어. 집중ON에서 내보낸 quizzes.json 파일을 골라 줘.' : e.message, 'bad');
  }
});

/* =====================================================
 *  7. 추천 영상 (기록을 바탕으로 점수를 매겨 보여 주는 모델)
 * ===================================================== */
async function refreshRecommend() {
  let items = [];
  try { items = (await api('/api/recommend')).items; } catch { return; }
  const root = $('recoList');
  root.innerHTML = '';
  if (!items.length) { root.append(el('p', 'muted small', '추천할 영상이 아직 없어. 퀴즈 관리에서 영상을 등록해 줘.')); return; }
  items.forEach((r, i) => {
    const box = el('div', 'reco');
    const top = el('div', 'top');
    top.append(el('b', '', `${i + 1}. ${r.title}`), el('span', 'score', `추천도 ${r.score}%`));
    const meter = el('div', 'meter'); const fill = el('i'); fill.style.width = r.score + '%'; meter.append(fill);
    const ul = el('ul'); r.reasons.slice(0, 2).forEach((t) => ul.append(el('li', '', t)));
    const go = el('button', 'secondary btn-sm', r.type === 'file' ? '이 영상 파일로 학습하기' : '이 영상 학습하기');
    go.type = 'button';
    go.addEventListener('click', () => {
      if (state.session) { setNotice('학습 중이야. 지금 학습을 끝낸 다음 골라 줘.', 'warn'); return; }
      if (r.type === 'file') {
        setSource('file');
        $('videoError').textContent = `"${r.title}" 영상 파일을 골라 줘.`;
        $('fileBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      setSource('yt');
      $('videoUrl').value = 'https://www.youtube.com/watch?v=' + r.key;
      $('videoForm').requestSubmit();
      $('videoForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    box.append(top, meter, ul, go);
    root.append(box);
  });
}

/* =====================================================
 *  8. 학습 현황 + 보호자 연결(구글 시트)
 * ===================================================== */
const minText = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)}시간 ${Math.round((sec % 3600) / 60)}분` : `${Math.round(sec / 60)}분`);
const rateText = (v) => (v == null ? '-' : v + '%');
const shortDate = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

function reportComment(t) {
  if (!t.count) return '아직 학습 기록이 없어. 영상을 보고 퀴즈를 풀면 여기에 현황이 쌓여.';
  const parts = [];
  if (t.focusRate != null) parts.push(t.focusRate >= 80 ? '집중 미션을 잘 해내고 있어요.' : t.focusRate >= 50 ? '집중 미션 성공률이 보통이에요.' : '집중 미션을 자주 놓치고 있어요. 짧은 영상부터 시작해 보세요.');
  if (t.quit) parts.push(`강제 종료가 ${t.quit}번 있었어요.`);
  if (t.quizRate != null) parts.push(t.quizRate >= 80 ? '퀴즈 이해도가 높아요.' : '퀴즈 정답률을 높이려면 오답 복습이 필요해요.');
  if (t.wrongOpen) parts.push(`아직 복습하지 않은 오답이 ${t.wrongOpen}개 있어요.`);
  return parts.join(' ');
}

async function refreshReport() {
  let r;
  try { r = await api('/api/report'); } catch { return; }
  const t = r.totals;
  $('rpMade').textContent = `${r.name} · ${shortDate(r.madeAt)} 기준`;
  const tiles = [
    ['총 학습 시간', minText(t.watchSec), `${t.count}번 학습`],
    ['집중 미션 성공률', rateText(t.focusRate), `${t.success}/${t.missions}회 성공`],
    ['퀴즈 정답률', rateText(t.quizRate), `${t.quizCount}번 채점`],
    ['영상 완주', `${t.done}번`, '끝까지 본 횟수'],
    ['강제 종료', `${t.quit}번`, '미션 실패 누적'],
    ['남은 오답', `${t.wrongOpen}개`, `지금까지 틀린 문제 ${t.wrongTotal}개`],
  ];
  $('rpTiles').innerHTML = '';
  tiles.forEach(([a, b, c]) => { const d = el('div', 'tile'); d.append(el('span', '', a), el('strong', '', b), el('small', '', c)); $('rpTiles').append(d); });
  $('rpComment').textContent = reportComment(t);

  const max = Math.max(1, ...r.days.map((d) => d.min));
  $('rpDays').innerHTML = '';
  r.days.forEach((d) => {
    const b = el('div', 'bar');
    const i = el('i', d.min ? '' : 'zero'); i.style.height = (d.min ? Math.max(4, (d.min / max) * 100) : 2) + '%';
    b.append(el('b', '', d.min + '분'), i, el('span', '', d.label));
    $('rpDays').append(b);
  });

  const list = (root, rows, empty, make) => {
    $(root).innerHTML = '';
    if (!rows.length) { $(root).append(el('p', 'muted small', empty)); return; }
    rows.forEach((x) => $(root).append(make(x)));
  };
  list('rpRecent', r.recent, '아직 학습 기록이 없어.', (x) => {
    const row = el('div', 'hist'); const left = el('div', 't');
    left.append(el('div', '', x.t), el('small', 'muted', `${shortDate(x.at)} · ${minText(x.sec)} · 미션 ${x.ok}/${x.m}`));
    row.append(left, el('span', 'status ' + (x.r === '강제 종료' ? 'bad' : x.r === '완주' ? 'good' : ''), x.r));
    return row;
  });
  list('rpQuiz', r.quizRecent, '아직 채점한 퀴즈가 없어.', (x) => {
    const row = el('div', 'hist'); const left = el('div', 't');
    left.append(el('div', '', x.t), el('small', 'muted', shortDate(x.at)));
    const sc = x.n ? Math.round((x.c / x.n) * 100) : 0;
    row.append(left, el('span', 'status ' + (sc >= 80 ? 'good' : sc < 50 ? 'bad' : 'warn'), `${x.c}/${x.n} 정답`));
    return row;
  });
  list('rpWrong', r.wrongOpen, '복습할 오답이 없어.', (x) => {
    const box = el('div', 'review-item');
    box.append(el('small', '', x.t || '이전 학습'), el('p', '', x.q), el('p', 'answer-line', '정답: ' + x.a));
    return box;
  });

  // 보호자 연결
  $('guardianCode').textContent = r.code;
  if (document.activeElement !== $('sheetUrlInput')) $('sheetUrlInput').value = r.sheetUrl;
  if (r.sheetUrl) {
    $('guardianLink').value = `${r.sheetUrl}?id=${encodeURIComponent(r.username)}&code=${r.code}`;
    $('sheetState').textContent = r.pending ? `연결됨 · 보낼 기록 ${r.pending}개` : '연결됨';
    $('sheetState').className = 'status ' + (r.pending ? 'warn' : 'good');
  } else {
    $('guardianLink').value = '';
    $('guardianLink').placeholder = '아래 구글 시트 설정에서 연결 주소를 먼저 넣어 줘';
    $('sheetState').textContent = '연결 안 됨';
    $('sheetState').className = 'status';
  }
}

function msg(id, text, kind = '') { $(id).hidden = false; $(id).className = 'notice mt ' + kind; $(id).textContent = text; }
$('copyLinkBtn').addEventListener('click', async () => {
  const link = $('guardianLink').value;
  if (!link) { msg('linkMsg', '구글 시트를 먼저 연결해 줘.', 'warn'); return; }
  try { await navigator.clipboard.writeText(link); msg('linkMsg', '보호자 링크를 복사했어. 카카오톡이나 문자에 붙여 넣어 보내 줘.', 'good'); }
  catch { $('guardianLink').select(); msg('linkMsg', '링크를 길게 눌러 복사해 줘.', 'warn'); }
});
$('shareLinkBtn').addEventListener('click', async () => {
  const link = $('guardianLink').value;
  if (!link) { msg('linkMsg', '구글 시트를 먼저 연결해 줘.', 'warn'); return; }
  if (navigator.share) {
    try { await navigator.share({ title: '집중ON 학습 현황', text: `${state.user?.name || ''} 학생의 집중ON 학습 현황이에요.`, url: link }); } catch { /* 취소 */ }
  } else {
    $('copyLinkBtn').click();
  }
});
$('saveSheetBtn').addEventListener('click', async () => {
  try {
    await api('/api/sheet/url', { method: 'POST', body: { url: $('sheetUrlInput').value } });
    msg('sheetMsg', $('sheetUrlInput').value.trim() ? '저장했어. 이제 학습 기록이 구글 시트로 자동 전송돼.' : '연결을 해제했어.', 'good');
    refreshReport();
  } catch (e) { msg('sheetMsg', e.message, 'bad'); }
});
$('resendBtn').addEventListener('click', async () => {
  try {
    const r = await api('/api/sheet/resend', { method: 'POST' });
    if (!$('sheetUrlInput').value.trim()) { msg('sheetMsg', '구글 시트 연결 주소를 먼저 저장해 줘.', 'warn'); return; }
    msg('sheetMsg', r.sent ? `기록 ${r.count}개를 구글 시트로 보냈어. 이미 있는 기록은 시트에서 한 번만 저장돼.` : '보내지 못했어. 인터넷 연결을 확인하고 다시 눌러 줘.', r.sent ? 'good' : 'warn');
    refreshReport();
  } catch (e) { msg('sheetMsg', e.message, 'bad'); }
});

/* ---------- 사이드바: 오답 / 기록 ---------- */
async function refreshReview() {
  let items = [];
  try { items = (await api('/api/wrong')).items; } catch { return; }
  $('reviewBadge').textContent = items.length + '개';
  const root = $('reviewList');
  root.innerHTML = '';
  if (!items.length) { root.append(el('p', 'muted small', '복습할 오답이 없어. 잘했어!')); return; }
  items.forEach((w) => {
    const box = el('div', 'review-item');
    box.append(el('small', '', w.videoTitle || '이전 학습'), el('p', '', w.question), el('p', 'answer-line', `정답: ${w.answer} · 내 답: ${w.userAnswer}`));
    const b = el('button', 'secondary btn-sm', '복습 완료');
    b.addEventListener('click', async () => { b.disabled = true; try { await api(`/api/wrong/${w.id}/review`, { method: 'POST' }); } catch { /* 무시 */ } refreshReview(); });
    box.append(b);
    root.append(box);
  });
}

async function refreshHistory() {
  let items = [];
  try { items = (await api('/api/sessions')).items; } catch { return; }
  const root = $('historyList');
  root.innerHTML = '';
  if (!items.length) { root.append(el('p', 'muted small', '아직 기록이 없어.')); return; }
  items.forEach((h) => {
    const row = el('div', 'hist');
    const left = el('div', 't');
    const d = new Date(h.endedAt);
    left.append(el('div', '', h.videoTitle || h.videoId), el('small', 'muted', `${d.getMonth() + 1}/${d.getDate()} · ${fmt(h.watchSec)} · 미션 ${h.success}/${h.missions}`));
    const kind = h.result === '강제 종료' ? 'bad' : h.result === '완주' ? 'good' : '';
    row.append(left, el('span', 'status ' + kind, h.result));
    root.append(row);
  });
}

/* ---------- 시작 ---------- */
bindSettings();
updateSessionUI();
setLocked(true);
api('/api/auth/me').then((r) => enterApp(r.user)).catch(showAuth);
