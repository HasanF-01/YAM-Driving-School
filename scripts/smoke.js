#!/usr/bin/env node
// smoke.js — boots serve.js and requests every page and question bank.
// No dependencies:  node scripts/smoke.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.SMOKE_PORT || 8778;
const BASE = `http://127.0.0.1:${PORT}`;

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}${urlPath}`, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

function post(urlPath, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request(
      `${BASE}${urlPath}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch { /* asserted by the caller */ }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.end(body);
  });
}

async function waitForServer(attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      await get('/');
      return;
    } catch {
      await new Promise(r => setTimeout(r, 250));
    }
  }
  throw new Error('server did not come up');
}

(async () => {
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });

  let failures = 0;
  const check = (name, ok, detail) => {
    console.log(`  ${ok ? 'ok     ' : 'FAILED '} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
  };

  try {
    await waitForServer();

    const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).sort();
    const banks = new Set();

    for (const page of pages) {
      const res = await get(`/${page}`);
      const html = res.body.toString('utf8');
      check(`GET /${page}`, res.status === 200 && html.includes('<html'), `status ${res.status}`);

      const m = html.match(/data-questions\s*=\s*["']([^"']+)["']/i);
      if (m) banks.add(m[1].trim());
    }

    // "/" must serve the landing page, the same way GitHub Pages resolves it.
    const root = await get('/');
    check('GET /', root.status === 200 && root.body.toString('utf8').includes('landing-hero'), `status ${root.status}`);

    // The whole point of the API: the banks themselves must not be downloadable.
    for (const bank of [...banks].sort()) {
      const res = await get(`/${bank}`);
      check(`GET /${bank} → 403`, res.status === 403, `status ${res.status}`);
    }

    for (const bank of [...banks].sort()) {
      const started = await post('/api/exam/start', { bank });
      const exam = started.json || {};
      const questions = exam.questions || [];

      check(
        `POST /api/exam/start (${bank})`,
        started.status === 200 && typeof exam.examId === 'string' && questions.length === exam.total,
        `status ${started.status}, ${questions.length} questions`
      );

      const leaks = questions.filter(q => 'correctIndex' in q || 'id' in q).length;
      check(`${bank}: questions carry no answer`, leaks === 0, `${leaks} leaking question(s)`);

      const answered = await post('/api/exam/answer', { examId: exam.examId, index: 0, chosenIndex: 0 });
      check(
        `POST /api/exam/answer (${bank})`,
        answered.status === 200 && Number.isInteger(answered.json && answered.json.correctIndex),
        `status ${answered.status}`
      );

      const finished = await post('/api/exam/finish', { examId: exam.examId });
      const result = finished.json || {};
      check(
        `POST /api/exam/finish (${bank})`,
        finished.status === 200 &&
          Number.isInteger(result.score) &&
          Array.isArray(result.results) &&
          result.results.length === questions.length,
        `status ${finished.status}, score ${result.score}`
      );

      const expired = await post('/api/exam/answer', { examId: 'no-such-exam', index: 0, chosenIndex: 0 });
      check(`POST /api/exam/answer (unknown exam) → 404`, expired.status === 404, `status ${expired.status}`);
    }

    const badBank = await post('/api/exam/start', { bank: '../serve.js' });
    check('POST /api/exam/start (unknown bank) → 400', badBank.status === 400, `status ${badBank.status}`);

    for (const asset of ['/quiz.js', '/style.css']) {
      const res = await get(asset);
      check(`GET ${asset}`, res.status === 200 && res.body.length > 0, `status ${res.status}`);
    }

    const missing = await get('/no-such-file.html');
    check('GET /no-such-file.html → 404', missing.status === 404, `status ${missing.status}`);
  } catch (e) {
    check('smoke run', false, e.message);
  } finally {
    server.kill();
  }

  console.log(`\n  ${failures} failure(s)`);
  process.exit(failures > 0 ? 1 : 0);
})();
