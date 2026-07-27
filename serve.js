// خادم YAM — يخدم الصفحات + يدير الاختبار.
// الأسئلة والأجوبة الصحيحة تبقى على الخادم: المتصفّح لا يستلم الجواب الصحيح
// إلا بعد تأكيد السؤال، والمفتاح الكامل إلا بعد إنهاء الاختبار.
//   node serve.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8777;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;

const TAKE_COUNT = 30; // عدد الأسئلة في كل اختبار
const PASS_MARK = 24;  // 24 / 30 للنجاح

const EXAM_TTL_MS = 3 * 60 * 60 * 1000; // الاختبار غير المكتمل يُحذف بعد 3 ساعات
const MAX_EXAMS = 5000;                 // سقف للذاكرة
const MAX_BODY = 4 * 1024;

// بنوك الأسئلة — تُقرأ على الخادم فقط ولا تُخدَم كملفات
const BANKS = ['questions.json', 'car_questions.json', 'red_questions.json'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

/* ---------------------------------------------------
   بنوك الأسئلة
--------------------------------------------------- */

const bankCache = new Map();

// يُعاد التحميل تلقائياً عند تعديل ملف JSON، بدون إعادة تشغيل الخادم
function loadBank(name) {
  if (!BANKS.includes(name)) return null;

  const file = path.join(ROOT, name);
  let mtime;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }

  const hit = bankCache.get(name);
  if (hit && hit.mtime === mtime) return hit.list;

  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  bankCache.set(name, { mtime, list });
  return list;
}

/* ---------------------------------------------------
   جلسات الاختبار (في الذاكرة)
--------------------------------------------------- */

const exams = new Map();

function sweepExams() {
  const now = Date.now();
  for (const [id, exam] of exams) {
    if (now - exam.createdAt > EXAM_TTL_MS) exams.delete(id);
  }
  // Map يحفظ ترتيب الإدخال، فالأقدم يخرج أولاً
  while (exams.size >= MAX_EXAMS) exams.delete(exams.keys().next().value);
}

function pickIndexes(total, count) {
  const idx = Array.from({ length: total }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, Math.min(count, idx.length));
}

// النسخة التي يراها المتصفّح: بلا id وبلا correctIndex
function publicQuestion(q) {
  const out = { question: typeof q.question === 'string' ? q.question : '', choices: q.choices || [] };
  if (q.image && String(q.image).trim() !== '') out.image = String(q.image).trim();
  return out;
}

/* ---------------------------------------------------
   أدوات HTTP
--------------------------------------------------- */

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('الطلب كبير جداً'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve({});
      try {
        const data = JSON.parse(raw);
        resolve(data && typeof data === 'object' ? data : {});
      } catch {
        reject(new Error('صيغة الطلب غير صحيحة'));
      }
    });

    req.on('error', reject);
  });
}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/* ---------------------------------------------------
   واجهة الاختبار
--------------------------------------------------- */

function startExam(body) {
  const bank = typeof body.bank === 'string' ? body.bank.trim() : '';
  const list = loadBank(bank);
  if (!list) return { status: 400, payload: { error: 'بنك أسئلة غير معروف' } };
  if (!Array.isArray(list) || list.length === 0) {
    return { status: 500, payload: { error: 'بنك الأسئلة فارغ' } };
  }

  sweepExams();

  const picks = pickIndexes(list.length, TAKE_COUNT);
  const id = crypto.randomUUID();

  exams.set(id, {
    bank,
    picks,
    correct: picks.map((i) => list[i].correctIndex),
    answers: picks.map(() => null),
    finished: false,
    createdAt: Date.now(),
  });

  return {
    status: 200,
    payload: {
      examId: id,
      total: picks.length,
      passMark: PASS_MARK,
      questions: picks.map((i) => publicQuestion(list[i])),
    },
  };
}

function getExam(body) {
  const id = typeof body.examId === 'string' ? body.examId : '';
  const exam = exams.get(id);
  if (!exam || Date.now() - exam.createdAt > EXAM_TTL_MS) {
    exams.delete(id);
    return null;
  }
  return exam;
}

function answerQuestion(body) {
  const exam = getExam(body);
  if (!exam) return { status: 404, payload: { error: 'انتهت صلاحية الاختبار، ابدأ اختباراً جديداً' } };
  if (exam.finished) return { status: 409, payload: { error: 'الاختبار انتهى' } };

  const { index, chosenIndex } = body;
  if (!isInt(index) || index < 0 || index >= exam.picks.length) {
    return { status: 400, payload: { error: 'رقم سؤال غير صحيح' } };
  }

  const list = loadBank(exam.bank) || [];
  const q = list[exam.picks[index]] || { choices: [] };
  const choiceCount = Array.isArray(q.choices) ? q.choices.length : 0;

  if (!isInt(chosenIndex) || chosenIndex < 0 || chosenIndex >= choiceCount) {
    return { status: 400, payload: { error: 'إجابة غير صحيحة' } };
  }

  // التأكيد لا يُلغى: أول جواب هو المعتمد، وإعادة الطلب تُرجع النتيجة نفسها
  if (exam.answers[index] === null) exam.answers[index] = chosenIndex;

  const correctIndex = exam.correct[index];
  return {
    status: 200,
    payload: {
      chosenIndex: exam.answers[index],
      correctIndex,
      correct: exam.answers[index] === correctIndex,
    },
  };
}

function finishExam(body) {
  const exam = getExam(body);
  if (!exam) return { status: 404, payload: { error: 'انتهت صلاحية الاختبار، ابدأ اختباراً جديداً' } };

  exam.finished = true;

  let score = 0;
  const results = exam.answers.map((chosen, i) => {
    const correctIndex = exam.correct[i];
    if (chosen !== null && chosen === correctIndex) score += 1;
    return { chosenIndex: chosen, correctIndex };
  });

  return {
    status: 200,
    payload: { score, total: exam.picks.length, passMark: PASS_MARK, passed: score >= PASS_MARK, results },
  };
}

const ROUTES = {
  '/api/exam/start': startExam,
  '/api/exam/answer': answerQuestion,
  '/api/exam/finish': finishExam,
};

async function handleApi(req, res, urlPath) {
  const route = ROUTES[urlPath];
  if (!route) return sendJson(res, 404, { error: 'مسار غير معروف' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'الطريقة غير مسموحة' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }

  try {
    const { status, payload } = route(body);
    sendJson(res, status, payload);
  } catch (e) {
    console.error(`${urlPath}:`, e);
    sendJson(res, 500, { error: 'خطأ في الخادم' });
  }
}

/* ---------------------------------------------------
   الملفات الساكنة
--------------------------------------------------- */

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');

  // بنوك الأسئلة لا تُنزَّل أبداً — الوصول إليها عبر /api فقط
  if (BANKS.includes(rel)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('403 Forbidden');
    return;
  }

  const file = path.join(ROOT, rel);

  // امنع الخروج خارج مجلد المشروع
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (urlPath.startsWith('/api/')) {
    handleApi(req, res, urlPath);
    return;
  }

  serveStatic(req, res, urlPath);
}).listen(PORT, HOST, () => {
  console.log(`YAM → http://localhost:${PORT}`);
});
