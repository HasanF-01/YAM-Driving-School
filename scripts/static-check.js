#!/usr/bin/env node
// static-check.js — checks the GitHub Pages path: the published file set, and
// exam-client.js running a whole exam in the browser with no API behind it.
// No dependencies:  node scripts/static-check.js
//
// serve.js with YAM_STATIC=1 stands in for Pages: no /api, banks downloadable.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STATIC_PORT = Number(process.env.STATIC_PORT || 8779);
const SERVER_PORT = STATIC_PORT + 1; // its own port, so the two phases cannot overlap
const CLIENT = path.join(ROOT, 'exam-client.js');

const nodeFetch = globalThis.fetch;

// exam-client.js asks for relative URLs ("questions.json", "api/exam/start"),
// the way the browser would. This is what they are resolved against.
let baseUrl = `http://127.0.0.1:${STATIC_PORT}`;

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'ok     ' : 'FAILED '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
function section(name) {
  console.log(`\n== ${name}`);
}

/* ------------------------------------------------ constants stay in step */

function constant(file, name) {
  const m = fs.readFileSync(path.join(ROOT, file), 'utf8').match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
}

function checkConstants() {
  section('Exam rules match on both backends');
  for (const name of ['TAKE_COUNT', 'PASS_MARK']) {
    const server = constant('serve.js', name);
    const client = constant('exam-client.js', name);
    check(
      `${name} — serve.js vs exam-client.js`,
      server !== null && server === client,
      `${server} vs ${client}`
    );
  }
}

/* ---------------------------------------------------- the published files */

function checkBuild() {
  section('Published site (scripts/build-pages.js)');

  const { build, FILES, DIRS, MUST_NOT_SHIP } = require('./build-pages.js');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'yam-pages-'));

  try {
    build(dest);

    for (const entry of [...FILES, ...DIRS]) {
      check(`_site/${entry}`, fs.existsSync(path.join(dest, entry)));
    }

    for (const unwanted of MUST_NOT_SHIP) {
      check(`_site has no ${unwanted}`, !fs.existsSync(path.join(dest, unwanted)));
    }

    const signs = path.join(dest, 'assets', 'signs');
    const count = fs.existsSync(signs) ? fs.readdirSync(signs).length : 0;
    check('_site/assets/signs is populated', count > 0, `${count} images`);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------ the servers */

function startServer(port, staticMode) {
  const env = { ...process.env, PORT: String(port) };
  if (staticMode) env.YAM_STATIC = '1';
  else delete env.YAM_STATIC;

  return spawn(process.execPath, [path.join(ROOT, 'serve.js')], { env, stdio: 'ignore' });
}

async function waitForServer(base, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      await nodeFetch(`${base}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`no server on ${base}`);
}

async function checkHosting(banks) {
  section('A static host serves what the browser needs');

  const home = await nodeFetch(`${baseUrl}/`);
  check('GET /', home.status === 200, `status ${home.status}`);

  for (const bank of banks) {
    const res = await nodeFetch(`${baseUrl}/${bank}`);
    const list = res.ok ? await res.json() : null;
    check(`GET /${bank}`, res.status === 200 && Array.isArray(list) && list.length >= 30, `status ${res.status}`);
  }

  for (const asset of ['/exam-client.js', '/quiz.js', '/style.css']) {
    const res = await nodeFetch(`${baseUrl}${asset}`);
    check(`GET ${asset}`, res.status === 200, `status ${res.status}`);
  }

  // What makes the client fall back: a POST answered with a page, not with JSON
  const api = await nodeFetch(`${baseUrl}/api/exam/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"bank":"questions.json"}',
  });
  let isJson = true;
  try {
    await api.json();
  } catch {
    isJson = false;
  }
  check('POST /api/exam/start → 404, not JSON', api.status === 404 && !isJson, `status ${api.status}`);
}

/* --------------------------------------------- exam-client.js under Node */

// A fresh copy each time: the mode is decided once per load, on purpose
function loadExamClient() {
  delete require.cache[require.resolve(CLIENT)];
  delete globalThis.ExamClient;

  globalThis.fetch = (url, opts) => nodeFetch(new URL(String(url), `${baseUrl}/`), opts);
  require(CLIENT);

  return globalThis.ExamClient;
}

async function checkLocalExam(bank) {
  section(`Full exam with no API — ${bank}`);

  const client = loadExamClient();
  const started = await client.start(bank);
  const questions = started.questions || [];

  check('falls back to static mode', client.mode === 'static', client.mode);
  check(
    `deals ${client.TAKE_COUNT} questions`,
    questions.length === client.TAKE_COUNT && started.total === client.TAKE_COUNT,
    `${questions.length} questions`
  );

  const leaks = questions.filter((q) => 'correctIndex' in q || 'id' in q).length;
  check('the interface never sees the answer key', leaks === 0, `${leaks} leaking question(s)`);

  const noChoices = questions.filter((q) => !Array.isArray(q.choices) || q.choices.length < 2).length;
  check('every question carries its choices', noChoices === 0, `${noChoices} bad question(s)`);

  // Answer all but the last, always the first choice, and count what comes back
  let expected = 0;
  let shapeOk = true;
  for (let i = 0; i < questions.length - 1; i++) {
    const res = await client.answer(i, 0);
    if (res.correct) expected++;
    if (res.chosenIndex !== 0 || !Number.isInteger(res.correctIndex)) shapeOk = false;
  }
  check('every answer comes back marked', shapeOk);

  // Confirming is final: a second answer must not overwrite the first
  const repeat = await client.answer(0, 1);
  check('the first confirmed answer stands', repeat.chosenIndex === 0, `got ${repeat.chosenIndex}`);

  const final = await client.finish();
  const results = Array.isArray(final.results) ? final.results : [];

  check('score matches the confirmed answers', final.score === expected, `${final.score} vs ${expected}`);
  check('result covers every question', results.length === questions.length, `${results.length} results`);
  check('the skipped question stays unanswered', results.length > 0 && results[results.length - 1].chosenIndex === null);
  check('pass mark applied', final.passed === (final.score >= final.passMark), `${final.score}/${final.passMark}`);

  // Two exams in a row must not deal the same paper
  const other = await client.start(bank);
  const identical = other.questions.every((q, i) => q.question === questions[i].question);
  check('a new exam reshuffles', !identical);
}

/* ------------------ the fallback must not hijack a server that is working */

async function checkServerModeWins() {
  section('With an API present the server still deals the exam');

  baseUrl = `http://127.0.0.1:${SERVER_PORT}`;
  const server = startServer(SERVER_PORT, false);

  try {
    await waitForServer(baseUrl);

    const client = loadExamClient();
    const started = await client.start('questions.json');

    check('uses server mode', client.mode === 'server', client.mode);
    check('the server issued an examId', typeof started.examId === 'string' && started.examId !== '');

    const answered = await client.answer(0, 0);
    check('answering goes through the API', Number.isInteger(answered.correctIndex));

    const final = await client.finish();
    check(
      'the server marks the exam',
      Number.isInteger(final.score) && (final.results || []).length === started.total,
      `score ${final.score}`
    );

    // A real server error must surface, not silently drop to static mode
    let message = '';
    try {
      await loadExamClient().start('../serve.js');
    } catch (e) {
      message = e.message;
    }
    check('a rejected bank is reported, not worked around', message !== '', message);
  } finally {
    server.kill();
  }
}

/* --------------------------------------------------------------------- run */

(async () => {
  const banks = [];
  for (const page of fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'))) {
    const m = fs.readFileSync(path.join(ROOT, page), 'utf8').match(/data-questions\s*=\s*["']([^"']+)["']/i);
    if (m && !banks.includes(m[1].trim())) banks.push(m[1].trim());
  }
  banks.sort();

  checkConstants();
  checkBuild();

  const staticServer = startServer(STATIC_PORT, true);
  try {
    await waitForServer(baseUrl);
    await checkHosting(banks);
    for (const bank of banks) await checkLocalExam(bank);
  } catch (e) {
    check('static run', false, e.message);
  } finally {
    staticServer.kill();
  }

  try {
    await checkServerModeWins();
  } catch (e) {
    check('server run', false, e.message);
  }

  console.log(`\n  ${failures} failure(s)`);
  process.exit(failures > 0 ? 1 : 0);
})();
