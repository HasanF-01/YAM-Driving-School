#!/usr/bin/env node
// build-pages.js — assembles the folder that gets published to GitHub Pages.
// No dependencies:  node scripts/build-pages.js  [dest]
//
// The list is explicit: only what the browser actually needs ships. serve.js,
// the Dockerfile, the scripts and the docs stay out of the published site.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// The origin the published site answers on — the custom domain, not the
// github.io project URL. Canonical links, og:image, the JSON-LD and sitemap.xml
// are all written against this one value, so changing origin is a single edit
// here (or SITE_URL=... in the environment): the build rewrites every absolute
// URL on its way into _site.
const DEFAULT_SITE_URL = 'https://www.yamdrivingschool.com';
const SITE_URL = (process.env.SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, '');

// Files copied as-is. Missing ones are a build error.
const FILES = [
  '.nojekyll',       // stops Pages running the site through Jekyll
  'index.html',
  'quiz.html',
  'car_quiz.html',
  'red_quiz.html',
  '404.html',        // Pages serves this for any unknown path
  'site.webmanifest',
  'exam-client.js',
  'quiz.js',
  'style.css',
  'questions.json',
  'car_questions.json',
  'red_questions.json',
  'robots.txt',
  'sitemap.xml',
];

// Text files carrying absolute URLs, rewritten when SITE_URL is overridden.
const REWRITABLE = /\.(html|xml|txt)$/i;

const DIRS = ['assets'];

// Anything here would be dead weight or misleading on a static host
const MUST_NOT_SHIP = ['serve.js', 'Dockerfile', 'scripts', '.github', 'README.md', 'RUNNING.md'];

function build(dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  for (const file of FILES) {
    const from = path.join(ROOT, file);
    if (!fs.existsSync(from)) throw new Error(`build-pages: missing ${file}`);

    if (SITE_URL !== DEFAULT_SITE_URL && REWRITABLE.test(file)) {
      const src = fs.readFileSync(from, 'utf8').split(DEFAULT_SITE_URL).join(SITE_URL);
      fs.writeFileSync(path.join(dest, file), src);
      continue;
    }
    fs.copyFileSync(from, path.join(dest, file));
  }

  for (const dir of DIRS) {
    const from = path.join(ROOT, dir);
    if (!fs.existsSync(from)) throw new Error(`build-pages: missing ${dir}/`);
    fs.cpSync(from, path.join(dest, dir), { recursive: true });
  }

  return dest;
}

function countFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce(
    (n, e) => n + (e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1),
    0
  );
}

module.exports = { build, FILES, DIRS, MUST_NOT_SHIP, SITE_URL, DEFAULT_SITE_URL };

if (require.main === module) {
  const dest = path.resolve(ROOT, process.argv[2] || '_site');
  build(dest);
  console.log(`built ${path.relative(ROOT, dest) || dest} — ${countFiles(dest)} files`);
}
