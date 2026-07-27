#!/usr/bin/env node
// validate.js — checks the question banks and every local file reference.
// No dependencies:  node scripts/validate.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let errors = 0;
let warnings = 0;

function fail(msg) { errors++; console.log(`  ERROR   ${msg}`); }
function warn(msg) { warnings++; console.log(`  warning ${msg}`); }
function section(name) { console.log(`\n== ${name}`); }

// GitHub Pages runs on a case-sensitive filesystem, Windows does not.
// Walk the real directory entries so "Logo.png" vs "logo.png" is caught here
// instead of turning into a 404 after deploy.
function existsExactCase(relPath) {
  const parts = relPath.split('/').filter(p => p !== '' && p !== '.');
  let dir = ROOT;
  for (let i = 0; i < parts.length; i++) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return false;
    }
    if (!entries.includes(parts[i])) return false;
    dir = path.join(dir, parts[i]);
  }
  return true;
}

// ---------------------------------------------------------------- questions

// Keep the pool-size rule tied to the server (it deals the exam) instead of a
// copy of the number.
function takeCount() {
  const src = fs.readFileSync(path.join(ROOT, 'serve.js'), 'utf8');
  const m = src.match(/TAKE_COUNT\s*=\s*(\d+)/);
  return m ? Number(m[1]) : 30;
}

function validateBank(file, minQuestions) {
  console.log(`\n-- ${file}`);
  const before = errors;

  let raw;
  try {
    raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    fail(`${file}: file is missing`);
    return;
  }

  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    fail(`${file}: invalid JSON — ${e.message}`);
    return;
  }

  if (!Array.isArray(list)) {
    fail(`${file}: expected an array of questions`);
    return;
  }

  if (list.length < minQuestions) {
    fail(`${file}: only ${list.length} questions, the quiz draws ${minQuestions}`);
  }

  const seenIds = new Map();
  const seenText = new Map();

  list.forEach((q, i) => {
    const at = `${file}[${i}]`;

    if (q === null || typeof q !== 'object' || Array.isArray(q)) {
      fail(`${at}: not an object`);
      return;
    }

    if (typeof q.id !== 'number' || !Number.isInteger(q.id)) {
      fail(`${at}: "id" must be an integer`);
    } else if (seenIds.has(q.id)) {
      fail(`${at}: duplicate id ${q.id} (also at index ${seenIds.get(q.id)})`);
    } else {
      seenIds.set(q.id, i);
    }

    const hasImage = q.image !== undefined && String(q.image).trim() !== '';
    if (typeof q.question !== 'string') {
      fail(`${at}: "question" must be a string`);
    } else if (q.question.trim() === '' && !hasImage) {
      // Sign questions are image-only on purpose; text-only questions are not.
      fail(`${at}: empty "question" with no image — nothing to show`);
    }

    if (!Array.isArray(q.choices) || q.choices.length < 2) {
      fail(`${at}: "choices" must be an array of at least 2 options`);
    } else {
      q.choices.forEach((c, ci) => {
        if (typeof c !== 'string' || c.trim() === '') {
          fail(`${at}: choice ${ci} is empty`);
        }
      });
      if (typeof q.correctIndex !== 'number' || !Number.isInteger(q.correctIndex)) {
        fail(`${at}: "correctIndex" must be an integer`);
      } else if (q.correctIndex < 0 || q.correctIndex >= q.choices.length) {
        fail(`${at}: correctIndex ${q.correctIndex} is outside 0..${q.choices.length - 1}`);
      }

      // The same stem with different choices is a normal variant, so a duplicate
      // only counts when the wording and the whole choice set match.
      const key = JSON.stringify([
        String(q.question || '').trim(),
        String(q.image || '').trim(),
        q.choices.map(c => String(c).trim()),
      ]);
      if (seenText.has(key)) warn(`${at}: identical to index ${seenText.get(key)}`);
      else seenText.set(key, i);
    }

    if (hasImage && !existsExactCase(String(q.image).trim())) {
      fail(`${at}: image not found — ${String(q.image).trim()}`);
    }
  });

  if (errors === before) {
    console.log(`  ok      ${list.length} questions, ${list.filter(q => q.image).length} with an image`);
  }
}

// ------------------------------------------------------------- local links

const SKIP_REF = /^(https?:)?\/\/|^(data|tel|mailto|javascript|sms):|^#/i;

function checkRef(ref, from, optional) {
  const clean = ref.split('#')[0].split('?')[0].trim();
  if (clean === '' || SKIP_REF.test(clean)) return;

  const target = clean.startsWith('/')
    ? clean.slice(1)
    : path.posix.join(path.posix.dirname(from.replace(/\\/g, '/')), clean);

  if (existsExactCase(target)) return;

  // A tag carrying its own onerror fallback is allowed to point at a file that
  // is not committed yet (assets/logo.png), so it is only worth a warning.
  if (optional) warn(`${from}: missing (has onerror fallback) — ${clean}`);
  else fail(`${from}: missing — ${clean}`);
}

function checkHtml(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const tags = src.match(/<[a-zA-Z][^>]*>/g) || [];

  for (const tag of tags) {
    const optional = /\sonerror\s*=/i.test(tag);
    const attrs = tag.match(/\b(?:src|href|data-questions)\s*=\s*["']([^"']+)["']/gi) || [];
    for (const attr of attrs) {
      const value = attr.match(/["']([^"']+)["']/)[1];
      checkRef(value, file, optional);
    }
  }
}

function checkCss(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const urls = src.match(/url\(\s*["']?([^"')]+)["']?\s*\)/gi) || [];
  for (const u of urls) {
    checkRef(u.replace(/^url\(\s*["']?/i, '').replace(/["']?\s*\)$/, ''), file, false);
  }
}

// --------------------------------------------------------------------- run

const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).sort();
const styles = fs.readdirSync(ROOT).filter(f => f.endsWith('.css')).sort();

section('Question banks');
const banks = new Set();
for (const page of pages) {
  const m = fs.readFileSync(path.join(ROOT, page), 'utf8').match(/data-questions\s*=\s*["']([^"']+)["']/i);
  if (m) banks.add(m[1].trim());
}
if (banks.size === 0) {
  fail('no page declares data-questions — nothing to validate');
} else {
  const min = takeCount();
  for (const bank of [...banks].sort()) validateBank(bank, min);
}

section('Local references');
const errorsBeforeRefs = errors;
for (const file of pages) checkHtml(file);
for (const file of styles) checkCss(file);
if (errors === errorsBeforeRefs) {
  console.log(`  ok      ${pages.length} pages and ${styles.length} stylesheets resolve`);
}

section('Result');
console.log(`  ${errors} error(s), ${warnings} warning(s)`);
process.exit(errors > 0 ? 1 : 0);
