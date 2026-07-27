// exam-client.js — one exam interface, two backends.
//
//   server mode  the Node server (serve.js / Docker) deals the exam and keeps the
//                answer key; the browser never downloads a question bank.
//   static mode  no API is reachable (GitHub Pages), so the same rules run here in
//                the browser and the bank JSON is fetched directly.
//
// The mode is decided once, by the first `start()` call: if POST api/exam/start
// answers with JSON we stay on the server, anything that is not an API talking
// back (network error, or an HTML 404 page like the one Pages serves) switches
// to static mode for the rest of the session.
//
// The numbers below MUST match TAKE_COUNT / PASS_MARK in serve.js —
// scripts/static-check.js fails the build if they drift apart.

(function (root) {
  'use strict';

  const TAKE_COUNT = 30; // questions per exam
  const PASS_MARK = 24;  // 24 / 30 to pass

  // Relative on purpose, so the app also works under a sub-path (user.github.io/repo/)
  const API_START = 'api/exam/start';
  const API_ANSWER = 'api/exam/answer';
  const API_FINISH = 'api/exam/finish';

  const MODE_KEY = 'yam.examMode';

  let mode = 'unknown'; // 'unknown' | 'server' | 'static'
  let confirmed = false; // a server call has actually succeeded in this page load
  let examId = null;

  /* ---------------------------------------------------
     Mode memory (skips the probe on later page loads)
  --------------------------------------------------- */

  function rememberedMode() {
    try {
      const v = root.sessionStorage && root.sessionStorage.getItem(MODE_KEY);
      return v === 'server' || v === 'static' ? v : 'unknown';
    } catch (_) {
      return 'unknown'; // private mode / storage disabled
    }
  }

  function setMode(next) {
    mode = next;
    try {
      if (root.sessionStorage) root.sessionStorage.setItem(MODE_KEY, next);
    } catch (_) {
      /* not worth failing the exam over */
    }
  }

  function forgetMode() {
    mode = 'unknown';
    try {
      if (root.sessionStorage) root.sessionStorage.removeItem(MODE_KEY);
    } catch (_) {
      /* same */
    }
  }

  /* ---------------------------------------------------
     Server backend
  --------------------------------------------------- */

  // Thrown when the response proves there is no exam API at this origin.
  // Only the probe is allowed to act on it; once the mode is settled it is a
  // plain failure like any other.
  function noApiError() {
    const err = new Error('تعذّر الاتصال بالخادم');
    err.yamNoApi = true;
    return err;
  }

  async function postJson(url, payload) {
    let res;
    try {
      res = await root.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
      });
    } catch (_) {
      throw noApiError(); // offline, or nothing listening
    }

    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      /* asserted right below */
    }

    // A static host answers a POST with an HTML 404 page, never with JSON
    if (data === null || typeof data !== 'object') throw noApiError();

    if (!res.ok) throw new Error(data.error || `تعذّر الاتصال بالخادم (${res.status})`);
    return data;
  }

  /* ---------------------------------------------------
     Static backend — the same rules as serve.js, in the browser
  --------------------------------------------------- */

  const bankCache = new Map();
  let local = null;

  async function loadBank(name) {
    if (bankCache.has(name)) return bankCache.get(name);

    const res = await root.fetch(name);
    if (!res.ok) throw new Error(`تعذّر تحميل بنك الأسئلة (${res.status})`);

    let list;
    try {
      list = await res.json();
    } catch (_) {
      throw new Error('بنك الأسئلة غير صالح');
    }

    if (!Array.isArray(list) || list.length === 0) throw new Error('بنك الأسئلة فارغ');

    bankCache.set(name, list);
    return list;
  }

  // Uniform in [0, max) — rejection sampling, so the modulo does not bias the draw
  function randomInt(max) {
    const c = root.crypto;
    if (c && typeof c.getRandomValues === 'function') {
      const limit = Math.floor(4294967296 / max) * max;
      const buf = new Uint32Array(1);
      let v;
      do {
        c.getRandomValues(buf);
        v = buf[0];
      } while (v >= limit);
      return v % max;
    }
    return Math.floor(Math.random() * max); // very old browsers
  }

  function pickIndexes(total, count) {
    const idx = Array.from({ length: total }, (_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return idx.slice(0, Math.min(count, idx.length));
  }

  // What the UI is handed: no id, no correctIndex. The key stays in `local`,
  // which is not reachable from outside this file.
  function publicQuestion(q) {
    const out = {
      question: typeof q.question === 'string' ? q.question : '',
      choices: q.choices || [],
    };
    if (q.image && String(q.image).trim() !== '') out.image = String(q.image).trim();
    return out;
  }

  function isInt(v) {
    return typeof v === 'number' && Number.isInteger(v);
  }

  async function localStart(bank) {
    const list = await loadBank(bank);
    const picks = pickIndexes(list.length, TAKE_COUNT);

    local = {
      bank,
      list,
      picks,
      correct: picks.map((i) => list[i].correctIndex),
      answers: picks.map(() => null),
      finished: false,
    };

    return {
      examId: null,
      total: picks.length,
      passMark: PASS_MARK,
      questions: picks.map((i) => publicQuestion(list[i])),
    };
  }

  function localAnswer(index, chosenIndex) {
    if (!local) throw new Error('ابدأ اختباراً جديداً');
    if (local.finished) throw new Error('الاختبار انتهى');

    if (!isInt(index) || index < 0 || index >= local.picks.length) {
      throw new Error('رقم سؤال غير صحيح');
    }

    const q = local.list[local.picks[index]] || { choices: [] };
    const choiceCount = Array.isArray(q.choices) ? q.choices.length : 0;
    if (!isInt(chosenIndex) || chosenIndex < 0 || chosenIndex >= choiceCount) {
      throw new Error('إجابة غير صحيحة');
    }

    // Confirming is final: the first answer stands
    if (local.answers[index] === null) local.answers[index] = chosenIndex;

    const correctIndex = local.correct[index];
    return {
      chosenIndex: local.answers[index],
      correctIndex,
      correct: local.answers[index] === correctIndex,
    };
  }

  function localFinish() {
    if (!local) throw new Error('ابدأ اختباراً جديداً');
    local.finished = true;

    let score = 0;
    const results = local.answers.map((chosen, i) => {
      const correctIndex = local.correct[i];
      if (chosen !== null && chosen === correctIndex) score += 1;
      return { chosenIndex: chosen, correctIndex };
    });

    return {
      score,
      total: local.picks.length,
      passMark: PASS_MARK,
      passed: score >= PASS_MARK,
      results,
    };
  }

  /* ---------------------------------------------------
     Public interface
  --------------------------------------------------- */

  async function start(bank) {
    // A remembered mode is a hint that saves the probe, not a commitment: the
    // same origin can be served differently than it was last time.
    const remembered = mode === 'unknown' ? rememberedMode() : mode;
    mode = remembered;

    if (mode !== 'static') {
      try {
        const data = await postJson(API_START, { bank });
        setMode('server');
        confirmed = true;
        examId = data.examId;
        return data;
      } catch (err) {
        // Once a server has answered, its errors are reported as they are.
        // Before that — probe or remembered hint — a silent API means static.
        if (confirmed || !err || !err.yamNoApi) throw err;
        setMode('static');
      }
    }

    examId = null;
    try {
      return await localStart(bank);
    } catch (err) {
      // Remembered static, but the banks are not downloadable here after all
      // (a server answers this origin now, and it keeps them to itself).
      if (remembered !== 'static') throw err;
      forgetMode();
      return start(bank);
    }
  }

  async function answer(index, chosenIndex) {
    if (mode === 'static') return localAnswer(index, chosenIndex);
    return postJson(API_ANSWER, { examId, index, chosenIndex });
  }

  async function finish() {
    if (mode === 'static') return localFinish();
    return postJson(API_FINISH, { examId });
  }

  root.ExamClient = {
    TAKE_COUNT,
    PASS_MARK,
    start,
    answer,
    finish,
    get mode() {
      return mode;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
