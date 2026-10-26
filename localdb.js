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
      };
    } catch {
      return { users: [], current: null, packs: {}, hidden: [], wrong: [], sessions: [] };
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
        const u = { id: uid(), username, name, salt, hash: await hash(salt + password), createdAt: now() };
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
      save(db);
      return { ok: true };
    }

    throw fail(404, 'NOT_FOUND', '알 수 없는 요청이야.');
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
  window.quizFile = { exportPacks, importPacks };
})();
