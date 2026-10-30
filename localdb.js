/* 집중ON 기기 저장소 (서버 대신)
 * 예전에는 Node.js 서버가 하던 일(회원, 퀴즈, 오답, 학습 기록 저장)을
 * 이제 브라우저 저장소(localStorage)에서 처리한다.
 * 그래서 웹 호스팅(깃허브 페이지)에 파일만 올려 두면 서버 없이 돌아간다.
 *
 * - 데이터는 기기(브라우저)마다 따로 저장된다.
 * - quizzes.json 파일에 넣어 둔 퀴즈는 모든 기기에서 기본으로 보인다.
 */
(function () {
  const DB_KEY = 'jipjungon_db_v1';
  const VIDEO_KEY = /^(?:[\w-]{11}|file_[0-9a-f]{8,16})$/;
  const now = () => new Date().toISOString();
  const str = (v, max = 600) => String(v ?? '').slice(0, max);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  let defaults = {};     // quizzes.json 에서 불러온 기본 퀴즈
  let defaultsLoaded = null;

  function fail(status, code, message) {
    const e = new Error(message);
    e.status = status; e.code = code;
    return e;
  }

  function load() {
    try {
      const db = JSON.parse(localStorage.getItem(DB_KEY) || '{}');
      return {
        users: db.users || [],
        current: db.current || null,
        packs: db.packs || {},
        hidden: db.hidden || [],      // 지운 기본 퀴즈
        wrong: db.wrong || [],
        sessions: db.sessions || [],
        quizlog: db.quizlog || [],    // 퀴즈 채점 기록 (정답률 계산용)
        outbox: db.outbox || [],      // 구글 시트로 아직 못 보낸 기록
      };
    } catch {
      return { users: [], current: null, packs: {}, hidden: [], wrong: [], sessions: [], quizlog: [], outbox: [] };
    }
  }
  function save(db) {
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(db));
    } catch {
      throw fail(500, 'STORAGE', '이 기기에 저장할 수 없어. 시크릿(사생활 보호) 모드라면 끄고 다시 해 줘.');
    }
  }

  // 비밀번호는 그대로 저장하지 않고 암호화(해시)해서 저장
  async function hash(text) {
    if (crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
    return 'f' + h.toString(16);
  }
  // 보호자 코드: 보호자 링크에 들어가는 6자리 코드 (헷갈리는 글자 0,O,1,I 제외)
  function newCode() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c = '';
    for (let i = 0; i < 6; i++) c += abc[Math.floor(Math.random() * abc.length)];
    return c;
  }
  const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name });

  async function loadDefaults() {
    if (!defaultsLoaded) {
      defaultsLoaded = fetch('quizzes.json', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : {}))
        .then((d) => { defaults = d && typeof d === 'object' && !Array.isArray(d) ? (d.packs || d) : {}; })
        .catch(() => { defaults = {}; });
    }
    return defaultsLoaded;
  }

  function allPacks(db) {
    const out = {};
    for (const [k, p] of Object.entries(defaults)) if (VIDEO_KEY.test(k) && !db.hidden.includes(k)) out[k] = { ...p, builtIn: true };
    for (const [k, p] of Object.entries(db.packs)) out[k] = p;
    return out;
  }

  function cleanPack(key, pack, userName) {
    const quiz = (Array.isArray(pack.quiz) ? pack.quiz : [])
      .map((q) => ({ question: str(q.question, 300).trim(), answer: q.answer === 'X' ? 'X' : 'O', explanation: str(q.explanation, 400).trim() }))
      .filter((q) => q.question)
      .slice(0, 10);
    if (!quiz.length) return null;
    return {
      title: str(pack.title, 200).trim() || key,
      type: key.startsWith('file_') ? 'file' : 'youtube',
      summary: str(pack.summary, 2000).trim(),
      keyPoints: (Array.isArray(pack.keyPoints) ? pack.keyPoints : []).map((k) => str(k, 200).trim()).filter(Boolean).slice(0, 8),
      quiz,
      updatedAt: pack.updatedAt || now(),
      updatedBy: str(userName, 40),
    };
  }

  async function videoTitle(id) {
    try {
      const url = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id);
      const r = await fetch(url);
      if (r.ok) { const d = await r.json(); if (d.title) return { title: d.title, channel: d.author_name || '' }; }
    } catch { /* 제목을 못 가져와도 괜찮음 */ }
    return { title: '유튜브 영상 ' + id, channel: '' };
  }

  // 화면(app.js)이 예전 서버 주소 그대로 요청하면, 여기서 대신 처리해 준다
  async function localApi(path, opts = {}) {
    await loadDefaults();
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body || {};
    const db = load();
    const seg = path.replace(/^\/api\//, '').split('/');
    const me = db.users.find((u) => u.id === db.current) || null;

    /* ----- 로그인 ----- */
    if (seg[0] === 'status') return { ok: true };
    if (seg[0] === 'auth') {
      if (seg[1] === 'me') { if (!me) throw fail(401, 'LOGIN_REQUIRED', '로그인이 필요해.'); return { user: publicUser(me) }; }
      if (seg[1] === 'logout') { db.current = null; save(db); return { ok: true }; }
      if (seg[1] === 'signup') {
        const username = str(body.username, 40).trim();
        const name = str(body.name, 40).trim();
        const password = String(body.password || '');
        if (!/^[A-Za-z0-9_]{2,20}$/.test(username)) throw fail(400, 'BAD_USERNAME', '아이디는 2~20자의 영문과 숫자로 만들어 줘. (한글은 쓸 수 없어)');
        if (!name || name.length > 20) throw fail(400, 'BAD_NAME', '이름을 1~20자로 입력해 줘.');
        if (password.length < 4) throw fail(400, 'BAD_PASSWORD', '비밀번호는 4자 이상으로 만들어 줘.');
        if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) throw fail(409, 'TAKEN', '이미 있는 아이디야. 다른 아이디를 써 줘.');
        const salt = uid();
        const u = { id: uid(), username, name, salt, hash: await hash(salt + password), code: newCode(), createdAt: now() };
        db.users.push(u); db.current = u.id; save(db);
        return { user: publicUser(u) };
      }
      if (seg[1] === 'login') {
        const u = db.users.find((x) => x.username.toLowerCase() === str(body.username, 40).trim().toLowerCase());
        if (!u || (await hash(u.salt + String(body.password || ''))) !== u.hash) throw fail(401, 'BAD_LOGIN', '아이디 또는 비밀번호가 맞지 않아. (회원 정보는 이 기기에만 저장돼서, 다른 기기에서 가입했다면 여기서 새로 가입해 줘.)');
        db.current = u.id; save(db);
        return { user: publicUser(u) };
      }
    }

    /* ----- 여기부터는 로그인해야 사용 가능 ----- */
    if (!me) throw fail(401, 'LOGIN_REQUIRED', '로그인이 필요해.');

    if (seg[0] === 'video') return videoTitle(seg[1]);

    if (seg[0] === 'packs') {
      const items = Object.entries(allPacks(db))
        .map(([key, p]) => ({ key, title: p.title, type: p.type, count: p.quiz.length, updatedAt: p.updatedAt || '', updatedBy: p.updatedBy || '', builtIn: !!p.builtIn }))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return { items };
    }
    if (seg[0] === 'pack') {
      const key = decodeURIComponent(seg[1] || '');
      if (method === 'GET') {
        const p = allPacks(db)[key];
        if (!p) throw fail(404, 'NO_PACK', '이 영상에는 아직 등록된 퀴즈가 없어.');
        return p;
      }
      if (method === 'PUT') {
        if (!VIDEO_KEY.test(key)) throw fail(400, 'BAD_KEY', '영상 정보가 올바르지 않아.');
        const p = cleanPack(key, { ...body, updatedAt: now() }, me.name);
        if (!p) throw fail(400, 'NO_QUIZ', 'OX 문제를 한 개 이상 입력해 줘.');
        db.packs[key] = p; db.hidden = db.hidden.filter((k) => k !== key); save(db);
        return p;
      }
      if (method === 'DELETE') {
        const existed = db.packs[key] || defaults[key];
        if (!existed) throw fail(404, 'NOT_FOUND', '퀴즈를 찾지 못했어.');
        delete db.packs[key];
        if (defaults[key] && !db.hidden.includes(key)) db.hidden.push(key);
        save(db);
        return { ok: true };
      }
    }

    if (seg[0] === 'wrong') {
      if (method === 'GET') return { items: db.wrong.filter((w) => w.userId === me.id && !w.reviewed) };
      if (seg[2] === 'review') {
        const item = db.wrong.find((w) => w.id === seg[1] && w.userId === me.id);
        if (!item) throw fail(404, 'NOT_FOUND', '오답을 찾지 못했어.');
        item.reviewed = true; item.reviewedAt = now(); save(db);
        return { ok: true };
      }
      let added = 0;
      for (const it of Array.isArray(body.items) ? body.items : []) {
        const question = str(it.question);
        if (!question) continue;
        if (db.wrong.some((w) => w.userId === me.id && !w.reviewed && w.question === question && w.videoId === it.videoId)) continue;
        db.wrong.push({
          id: uid(), userId: me.id, question, answer: it.answer === 'X' ? 'X' : 'O', userAnswer: it.userAnswer === 'X' ? 'X' : 'O',
          explanation: str(it.explanation), videoId: str(it.videoId, 40), videoTitle: str(it.videoTitle, 200), reviewed: false, createdAt: now(),
        });
        added++;
      }
      db.wrong = db.wrong.slice(-500);
      save(db);
      return { added };
    }

    if (seg[0] === 'sessions') {
      if (method === 'GET') return { items: db.sessions.filter((s) => s.userId === me.id).slice(0, 10) };
      db.sessions.unshift({
        id: uid(), userId: me.id, videoId: str(body.videoId, 40), videoTitle: str(body.videoTitle, 200),
        watchSec: Number(body.watchSec) || 0, missions: Number(body.missions) || 0, success: Number(body.success) || 0, fail: Number(body.fail) || 0,
        result: ['완주', '중간 종료', '강제 종료'].includes(body.result) ? body.result : '중간 종료', endedAt: now(),
      });
      db.sessions = db.sessions.slice(0, 200);
      queueRow(db, me, sessionRow(db, me, db.sessions[0]));
      save(db);
      flushSheet();
      return { ok: true };
    }

    if (seg[0] === 'quizlog') {
      db.quizlog.unshift({
        id: uid(), userId: me.id, videoId: str(body.videoId, 40), videoTitle: str(body.videoTitle, 200),
        total: Number(body.total) || 0, correct: Number(body.correct) || 0, at: now(),
      });
      db.quizlog = db.quizlog.slice(0, 300);
      queueRow(db, me, quizRow(db, me, db.quizlog[0]));
      save(db);
      flushSheet();
      return { ok: true };
    }

    if (seg[0] === 'report') {
      if (!me.code) { me.code = newCode(); save(db); }
      return { ...buildReport(db, me), username: me.username, code: me.code, sheetUrl: sheetUrl(), pending: db.outbox.length };
    }
    if (seg[0] === 'sheet') {
      if (seg[1] === 'url') { setSheetUrl(String(body.url || '')); flushSheet(); return { sheetUrl: sheetUrl() }; }
      if (seg[1] === 'resend') {
        // 지금까지의 기록을 모두 다시 보냄 (시트에서 같은 기록ID는 한 번만 저장됨)
        if (!me.code) me.code = newCode();
        const rows = [
          ...db.sessions.filter((x) => x.userId === me.id).map((x) => sessionRow(db, me, x)),
          ...db.quizlog.filter((x) => x.userId === me.id && x.id).map((x) => quizRow(db, me, x)),
        ];
        rows.forEach((r) => queueRow(db, me, r));
        save(db);
        const sent = await flushSheet();
        return { count: rows.length, sent };
      }
    }
    if (seg[0] === 'recommend') return { items: buildRecommend(db, me) };

    throw fail(404, 'NOT_FOUND', '알 수 없는 요청이야.');
  }

  /* ----- 구글 시트로 기록 보내기 -----
   * 시트 주소(구글 앱스 스크립트 웹 앱 주소)는 config.js 에 적거나, 앱의 학습 현황 화면에서 넣는다.
   * 인터넷이 끊겨 못 보낸 기록은 outbox 에 모아 두었다가 다음에 다시 보낸다.
   */
  const SHEET_KEY = 'jipjungon_sheet_url';
  function sheetUrl() {
    const fromConfig = (window.JIPJUNG_CONFIG && window.JIPJUNG_CONFIG.sheetUrl) || '';
    if (fromConfig) return fromConfig;
    try { return localStorage.getItem(SHEET_KEY) || ''; } catch { return ''; }
  }
  function setSheetUrl(url) {
    url = url.trim();
    if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
      throw fail(400, 'BAD_URL', '구글 앱스 스크립트 웹 앱 주소가 아니야. https://script.google.com/macros/s/…/exec 모양의 주소를 넣어 줘.');
    }
    try { if (url) localStorage.setItem(SHEET_KEY, url); else localStorage.removeItem(SHEET_KEY); } catch { /* 무시 */ }
  }
  function openWrong(db, me) { return db.wrong.filter((w) => w.userId === me.id && !w.reviewed).length; }
  function sessionRow(db, me, x) {
    return { id: x.id, at: x.endedAt, kind: '학습', title: x.videoTitle, min: Math.round(x.watchSec / 6) / 10,
      success: x.success, missions: x.missions, result: x.result, correct: '', total: '', wrongOpen: openWrong(db, me) };
  }
  function quizRow(db, me, x) {
    return { id: x.id, at: x.at, kind: '퀴즈', title: x.videoTitle, min: '', success: '', missions: '', result: '',
      correct: x.correct, total: x.total, wrongOpen: openWrong(db, me) };
  }
  function queueRow(db, me, row) {
    if (db.outbox.some((r) => r.id === row.id)) return;
    db.outbox.push({ ...row, userId: me.username, name: me.name, code: me.code || '' });
    db.outbox = db.outbox.slice(-500);
  }
  let flushing = null;
  async function flushSheet() {
    const url = sheetUrl();
    if (!url) return 0;
    if (flushing) return flushing;
    flushing = (async () => {
      const db = load();
      if (!db.outbox.length) return 0;
      const rows = db.outbox.slice(0, 100);
      try {
        // 구글 앱스 스크립트는 다른 사이트의 요청에 답을 돌려주지 않아서 no-cors 로 보낸다
        await fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ rows }) });
      } catch {
        return 0; // 인터넷 연결 안 됨 → 다음에 다시 보냄
      }
      const fresh = load();
      const sentIds = new Set(rows.map((r) => r.id));
      fresh.outbox = fresh.outbox.filter((r) => !sentIds.has(r.id));
      save(fresh);
      return rows.length;
    })();
    try { return await flushing; } finally { flushing = null; }
  }

  /* ----- 학습 현황 보고서 ----- */
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
  function dayKey(d) { const x = new Date(d); return `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`; }

  function buildReport(db, me) {
    const sessions = db.sessions.filter((s) => s.userId === me.id);
    const quizzes = db.quizlog.filter((q) => q.userId === me.id);
    const wrongAll = db.wrong.filter((w) => w.userId === me.id);
    const open = wrongAll.filter((w) => !w.reviewed);
    const sum = (arr, f) => arr.reduce((a, x) => a + (Number(x[f]) || 0), 0);

    // 최근 7일 하루별 학습 시간(분)
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      const k = dayKey(d);
      const sec = sessions.filter((s) => dayKey(s.endedAt) === k).reduce((a, s) => a + s.watchSec, 0);
      days.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, min: Math.round(sec / 60) });
    }

    return {
      name: me.name,
      madeAt: now(),
      totals: {
        watchSec: sum(sessions, 'watchSec'),
        count: sessions.length,
        done: sessions.filter((s) => s.result === '완주').length,
        quit: sessions.filter((s) => s.result === '강제 종료').length,
        missions: sum(sessions, 'missions'),
        success: sum(sessions, 'success'),
        focusRate: pct(sum(sessions, 'success'), sum(sessions, 'missions')),
        quizCount: quizzes.length,
        quizRate: pct(sum(quizzes, 'correct'), sum(quizzes, 'total')),
        wrongTotal: wrongAll.length,
        wrongOpen: open.length,
      },
      days,
      recent: sessions.slice(0, 6).map((s) => ({ t: s.videoTitle, sec: s.watchSec, ok: s.success, m: s.missions, r: s.result, at: s.endedAt })),
      quizRecent: quizzes.slice(0, 6).map((q) => ({ t: q.videoTitle, c: q.correct, n: q.total, at: q.at })),
      wrongOpen: open.slice(0, 5).map((w) => ({ q: w.question, a: w.answer, t: w.videoTitle })),
    };
  }

  /* ----- 추천 영상 (보여주기용 점수 모델) -----
   * 실제 인공지능은 아니고, 학생 기록으로 점수를 매겨 순서를 정한다.
   *  기본 40점
   *  + 남은 오답 1개당 15점 (최대 30점)  : 복습이 필요한 영상
   *  + 아직 학습하지 않은 영상 20점
   *  + 지난번 강제 종료 / 미션 성공률 60% 미만 15점 : 집중이 부족했던 영상
   *  + 지난 퀴즈 점수 70% 미만 10점
   *  + 오답이 있는 영상과 제목 낱말이 겹치면 낱말당 5점 (최대 15점) : 비슷한 주제
   *  - 퀴즈 만점 25점 : 이미 잘 아는 영상
   */
  const words = (t) => String(t || '').replace(/[^0-9A-Za-z가-힣\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !/^\d+부?$/.test(w));

  function buildRecommend(db, me) {
    const packs = allPacks(db);
    const sessions = db.sessions.filter((s) => s.userId === me.id);
    const quizzes = db.quizlog.filter((q) => q.userId === me.id);
    const open = db.wrong.filter((w) => w.userId === me.id && !w.reviewed);
    const weakWords = new Set(open.flatMap((w) => words(w.videoTitle)));

    const out = [];
    for (const [key, p] of Object.entries(packs)) {
      let score = 40;
      const reasons = [];
      const wrongN = open.filter((w) => w.videoId === key).length;
      const last = sessions.find((s) => s.videoId === key);
      const lastQuiz = quizzes.find((q) => q.videoId === key);

      if (wrongN) { score += Math.min(30, wrongN * 15); reasons.push(`틀린 문제 ${wrongN}개가 남아 있어 복습이 필요해요`); }
      if (!last) { score += 20; reasons.push('아직 학습하지 않은 영상이에요'); }
      else if (last.result === '강제 종료' || (last.missions && last.success / last.missions < 0.6)) {
        score += 15; reasons.push('지난번 집중도가 낮았어요. 다시 집중해서 봐요');
      }
      if (lastQuiz && lastQuiz.total) {
        const r = lastQuiz.correct / lastQuiz.total;
        if (r < 0.7) { score += 10; reasons.push(`지난 퀴즈 점수가 ${Math.round(r * 100)}점이었어요`); }
        if (r === 1) { score -= 25; reasons.push('지난 퀴즈를 모두 맞혔어요'); }
      }
      if (!wrongN && weakWords.size) {
        const same = words(p.title).filter((w) => weakWords.has(w));
        if (same.length) { score += Math.min(15, same.length * 5); reasons.push(`어려워했던 주제와 비슷해요 (${[...new Set(same)].slice(0, 2).join(', ')})`); }
      }
      if (!reasons.length) reasons.push('꾸준히 복습하면 오래 기억해요');
      out.push({ key, title: p.title, type: p.type, score: Math.max(1, Math.min(99, score)), reasons });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 5);
  }

  /* ----- 퀴즈 파일 내보내기 / 가져오기 ----- */
  async function exportPacks() {
    await loadDefaults();
    const db = load();
    const packs = allPacks(db);
    for (const p of Object.values(packs)) delete p.builtIn;
    return { app: 'jipjung-on', version: 1, exportedAt: now(), packs };
  }
  function importPacks(data, userName) {
    const src = data && typeof data === 'object' ? (data.packs || data) : null;
    if (!src || Array.isArray(src)) throw fail(400, 'BAD_FILE', '집중ON 퀴즈 파일이 아니야.');
    const db = load();
    let count = 0;
    for (const [k, p] of Object.entries(src)) {
      if (!VIDEO_KEY.test(k) || !p) continue;
      const clean = cleanPack(k, p, p.updatedBy || userName);
      if (!clean) continue;
      db.packs[k] = clean; db.hidden = db.hidden.filter((x) => x !== k); count++;
    }
    if (!count) throw fail(400, 'EMPTY', '가져올 퀴즈가 없어. 집중ON에서 내보낸 파일인지 확인해 줘.');
    save(db);
    return count;
  }

  window.localApi = localApi;
  window.flushSheet = flushSheet;
  window.quizFile = { exportPacks, importPacks };
})();
