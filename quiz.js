// quiz.js — shared quiz engine for YAM (Youssef Ahmad Moussawi)
// Random 30 questions + confirm answer + free navigation + end-of-exam review (Arabic UI)
// Each page names its question bank on <body data-questions="...">
//
// The bank files are never downloaded by the browser: the server deals the exam,
// hands over one correct answer per confirmed question, and releases the full
// answer key only when the exam is finished.

const BRAND_NAME = "يوسف أحمد الموسوي";
const BRAND_PHONE = "03 450 763 - 76 058 603";

// Relative on purpose, so the app also works when hosted under a sub-path
const API_START = "api/exam/start";
const API_ANSWER = "api/exam/answer";
const API_FINISH = "api/exam/finish";

let quiz = {
  examId: null,
  list: [],         // questions WITHOUT the correct answer
  index: 0,
  score: 0,
  passed: false,
  selected: null,   // selected index (original index in q.choices)
  locked: false,    // becomes true only AFTER confirm
  answers: [],      // confirmed: { chosenIndex, correctIndex }
  pending: [],      // per-question selection that was picked but not confirmed yet
  busy: false,      // a request to the server is in flight
  _navItems: [],    // buttons of the question strip
  _lastNavAt: 0
};

function dataFile() {
  const f = document.body.getAttribute("data-questions");
  return f && f.trim() !== "" ? f.trim() : "questions.json";
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    /* handled right below */
  }

  if (!res.ok || !data) {
    throw new Error((data && data.error) || `تعذّر الاتصال بالخادم (${res.status})`);
  }
  return data;
}

function setButtonEnabled(btn, enabled) {
  if (!btn) return;
  btn.disabled = !enabled;
  btn.setAttribute("aria-disabled", String(!enabled));
  btn.style.pointerEvents = enabled ? "auto" : "none"; // HARD block taps on mobile
}

// The button the user has to press next should carry the primary styling
function setPrimary(btn, isPrimary) {
  if (!btn) return;
  btn.classList.toggle("btn-primary", isPrimary);
  btn.classList.toggle("btn-secondary", !isPrimary);
}

function bindTap(el, handler) {
  if (!el) return;

  const wrapped = (e) => {
    if (el.disabled) return;
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    handler(e);
  };

  if (window.PointerEvent) {
    el.addEventListener("pointerup", wrapped, { passive: false });
    // pointerup never fires for keyboard users, and we bind no click handler here
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") wrapped(e);
    });
  } else {
    el.addEventListener("touchend", wrapped, { passive: false });
    el.addEventListener("click", wrapped);
  }
}

function preloadImages(list) {
  (list || []).forEach((q) => {
    const src = (q && q.image) ? String(q.image) : "";
    if (src.trim() !== "") {
      const img = new Image();
      img.src = src;
    }
  });
}

/* ---------------------------------------------------
   Answer bookkeeping
--------------------------------------------------- */

function isCorrectAnswer(a) {
  return !!a && typeof a.correctIndex === "number" && a.chosenIndex === a.correctIndex;
}

function answeredCount() {
  return quiz.answers.filter(Boolean).length;
}

// Keep an unconfirmed pick so it is still there when the user comes back
function stashPending() {
  if (!quiz.locked) quiz.pending[quiz.index] = quiz.selected;
}

/* ---------------------------------------------------
   Question strip (jump to any question)
--------------------------------------------------- */

function buildNav() {
  const nav = document.getElementById("qNav");
  if (!nav) return;

  nav.innerHTML = "";
  quiz._navItems = quiz.list.map((q, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "qnav-item";
    btn.textContent = String(i + 1);
    btn.setAttribute("aria-label", `السؤال ${i + 1}`);

    bindTap(btn, () => goTo(i));
    nav.appendChild(btn);
    return btn;
  });

  updateNav();
}

function updateNav() {
  quiz._navItems.forEach((btn, i) => {
    const a = quiz.answers[i];
    const picked = quiz.pending[i] !== undefined && quiz.pending[i] !== null;

    btn.classList.toggle("ok", !!a && isCorrectAnswer(a));
    btn.classList.toggle("bad", !!a && !isCorrectAnswer(a));
    btn.classList.toggle("marked", !a && picked);
    btn.classList.toggle("current", i === quiz.index);

    if (i === quiz.index) btn.setAttribute("aria-current", "true");
    else btn.removeAttribute("aria-current");
  });

  scrollNavToCurrent();
}

function scrollNavToCurrent() {
  const el = quiz._navItems[quiz.index];
  if (!el) return;
  try {
    el.scrollIntoView({ block: "nearest", inline: "center" });
  } catch (_) {
    /* older browsers: the strip just stays where it is */
  }
}

/* ---------------------------------------------------
   Rendering
--------------------------------------------------- */

function setProgress() {
  const pct = (answeredCount() / quiz.list.length) * 100;
  const progressEl = document.getElementById("progress");
  if (progressEl) progressEl.style.setProperty("--p", `${pct}%`);

  const counterEl = document.getElementById("qCounterTop");
  if (counterEl) {
    counterEl.textContent = `السؤال ${quiz.index + 1} من ${quiz.list.length}`;
  }
}

function renderQuestion() {
  const q = quiz.list[quiz.index];

  const qTextEl = document.getElementById("qText");
  const qImgEl = document.getElementById("qImg");

  // Reset state
  quiz.selected = null;
  quiz.locked = false;

  const fb = document.getElementById("feedback");
  if (fb) {
    fb.className = "feedback hidden";
    fb.textContent = "";
  }

  // Question image / text (no ?? for old Android browsers)
  const hasImg = q && q.image && String(q.image).trim() !== "";
  if (hasImg) {
    qImgEl.src = q.image;
    qImgEl.classList.remove("hidden");

    const t = ((q.question || "")).trim();
    if (t === "") {
      qTextEl.textContent = "";
      qTextEl.classList.add("hidden");
    } else {
      qTextEl.textContent = t;
      qTextEl.classList.remove("hidden");
    }
  } else {
    qImgEl.removeAttribute("src");
    qImgEl.classList.add("hidden");

    qTextEl.textContent = (q && q.question) ? q.question : "";
    qTextEl.classList.remove("hidden");
  }

  // Render choices
  const box = document.getElementById("choices");
  box.innerHTML = "";

  (q.choices || []).forEach((text, idx) => {
    if (String(text || "").trim() === "") return;

    const btn = document.createElement("button");
    btn.className = "choice";
    btn.type = "button";
    btn.innerHTML = `<span></span>`;
    btn.firstChild.textContent = text;
    btn.dataset.index = String(idx); // original index

    bindTap(btn, () => {
      if (quiz.locked) return;

      [...box.querySelectorAll(".choice")].forEach((b) =>
        b.classList.remove("selected")
      );

      btn.classList.add("selected");
      quiz.selected = idx;
      quiz.pending[quiz.index] = idx;

      updateActionButtons();
      updateNav();
    });

    box.appendChild(btn);
  });

  // Restore what the user already did on this question
  const answer = quiz.answers[quiz.index];
  if (answer) {
    applyReveal(answer);
  } else {
    const picked = quiz.pending[quiz.index];
    if (picked !== undefined && picked !== null) {
      const btn = box.querySelector(`.choice[data-index="${picked}"]`);
      if (btn) {
        btn.classList.add("selected");
        quiz.selected = picked;
      }
    }
  }

  updateActionButtons();
  updateNav();
  setProgress();
}

// Paint the correct / wrong colors and freeze the choices
function applyReveal(a) {
  quiz.locked = true;
  quiz.selected = a.chosenIndex;

  const box = document.getElementById("choices");
  const buttons = [...box.querySelectorAll(".choice")];

  buttons.forEach((btn) => { btn.style.pointerEvents = "none"; });

  // If correctIndex is missing, only show what was picked (no colors)
  if (typeof a.correctIndex !== "number") {
    buttons.forEach((btn) => {
      if (Number(btn.dataset.index) === a.chosenIndex) btn.classList.add("selected");
    });
    return;
  }

  buttons.forEach((btn) => {
    const idx = Number(btn.dataset.index);
    btn.classList.remove("selected");
    if (idx === a.correctIndex) btn.classList.add("correct");
    if (idx === a.chosenIndex && a.chosenIndex !== a.correctIndex) btn.classList.add("wrong");
  });
}

// "تأكيد الإجابة" leads until the answer is confirmed, then "التالي" takes over
function updateActionButtons() {
  const prevBtn = document.getElementById("prevBtn");
  const confirmBtn = document.getElementById("confirmBtn");
  const nextBtn = document.getElementById("nextBtn");

  const isLast = quiz.index === quiz.list.length - 1;

  setButtonEnabled(prevBtn, quiz.index > 0);
  setButtonEnabled(confirmBtn, !quiz.locked && quiz.selected !== null);
  setButtonEnabled(nextBtn, true);

  if (nextBtn) nextBtn.textContent = isLast ? "إنهاء الاختبار" : "التالي";

  setPrimary(confirmBtn, !quiz.locked);
  setPrimary(nextBtn, quiz.locked);
}

// The correct answer lives on the server: ask for it, one question at a time,
// and only once the user has committed to a choice.
async function revealAnswer() {
  if (quiz.locked || quiz.busy) return;

  const at = quiz.index;
  const chosen = quiz.selected;
  if (chosen === null) return;

  quiz.busy = true;
  setButtonEnabled(document.getElementById("confirmBtn"), false);

  let record;
  try {
    const data = await postJson(API_ANSWER, {
      examId: quiz.examId,
      index: at,
      chosenIndex: chosen,
    });
    record = { chosenIndex: data.chosenIndex, correctIndex: data.correctIndex };
  } catch (err) {
    quiz.busy = false;
    updateActionButtons(); // give the confirm button back
    alert("خطأ: " + err.message);
    return;
  }
  quiz.busy = false;

  quiz.answers[at] = record;
  quiz.pending[at] = null;

  // The user may have moved on while the request was in flight
  if (quiz.index === at) applyReveal(record);

  updateActionButtons();
  updateNav();
  setProgress();
}

/* ---------------------------------------------------
   Navigation
--------------------------------------------------- */

// Anti double-tap on every move
function navThrottled() {
  const now = Date.now();
  if (now - quiz._lastNavAt < 250) return true;
  quiz._lastNavAt = now;
  return false;
}

function goTo(i) {
  if (i < 0 || i >= quiz.list.length) return;
  if (i === quiz.index) return;
  if (navThrottled()) return;

  stashPending();
  quiz.index = i;

  renderQuestion();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function prevQuestion() {
  goTo(quiz.index - 1);
}

function nextQuestion() {
  if (quiz.index < quiz.list.length - 1) goTo(quiz.index + 1);
  else finishExam();
}

function finishExam() {
  if (navThrottled() || quiz.busy) return;

  stashPending();

  const remaining = quiz.list.length - answeredCount();
  if (remaining > 0) {
    const what = remaining === 1 ? "سؤال واحد" : `${remaining} سؤال`;
    if (!window.confirm(`لديك ${what} بدون إجابة. هل تريد إنهاء الاختبار وعرض النتيجة؟`)) return;
  }

  showResults().catch((err) => alert("خطأ: " + err.message));
}

/* ---------------------------------------------------
   Results
--------------------------------------------------- */

async function showResults() {
  // Closing the exam is what releases the full answer key
  quiz.busy = true;
  let final;
  try {
    final = await postJson(API_FINISH, { examId: quiz.examId });
  } finally {
    quiz.busy = false;
  }

  quiz.score = final.score;
  quiz.passed = final.passed;
  quiz.answers = final.results.map((r) =>
    r.chosenIndex === null ? null : { chosenIndex: r.chosenIndex, correctIndex: r.correctIndex }
  );

  document.getElementById("quizView").classList.add("hidden");
  document.getElementById("resultsView").classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });

  // Keep the phone digits in their own LTR run, otherwise RTL reorders the groups
  const resultUser = document.getElementById("resultUser");
  resultUser.innerHTML = "";
  resultUser.appendChild(document.createTextNode(BRAND_NAME + " — "));

  const phoneSpan = document.createElement("span");
  phoneSpan.dir = "ltr";
  phoneSpan.className = "ltr-num";
  phoneSpan.textContent = BRAND_PHONE;
  resultUser.appendChild(phoneSpan);

  const passed = quiz.passed;

  document.getElementById("scoreBox").innerHTML = `
    <div class="score-title">علامتك</div>
    <div class="score-value">${quiz.score} / ${quiz.list.length}</div>
    <div class="result-status ${passed ? "pass" : "fail"}">
      النتيجة: ${passed ? "ناجح" : "راسب"}
    </div>
  `;

  const review = document.getElementById("reviewList");
  review.innerHTML = "";

  quiz.list.forEach((q, i) => {
    const a = final.results[i] || { chosenIndex: null, correctIndex: null };

    const chosenText =
      (a.chosenIndex !== null && q.choices[a.chosenIndex] !== undefined)
        ? q.choices[a.chosenIndex]
        : "لم تُجب";

    const correctText =
      (typeof a.correctIndex === "number" && q.choices[a.correctIndex] !== undefined)
        ? q.choices[a.correctIndex]
        : "غير متوفر";

    const isCorrect =
      (typeof a.correctIndex === "number") && (a.chosenIndex === a.correctIndex);

    const qText = ((q.question || "")).trim();
    const hasImg = q.image && String(q.image).trim() !== "";

    const item = document.createElement("div");
    item.className = "review-item";

    item.innerHTML = `
      <div class="review-q">
        <div class="review-num">سؤال ${i + 1}</div>
        ${hasImg ? `<img class="qimg" src="${q.image}" alt="صورة السؤال">` : ""}
        ${qText ? `<div class="review-text"></div>` : ""}
      </div>

      <div class="review-answers">
        <div class="ans-row ${isCorrect ? "ans-ok" : "ans-bad"}">
          <span class="ans-label">إجابتك:</span>
          <span class="ans-value chosen"></span>
        </div>

        <div class="ans-row ans-ok">
          <span class="ans-label">الصحيح:</span>
          <span class="ans-value correct"></span>
        </div>
      </div>
    `;

    const textEl = item.querySelector(".review-text");
    if (textEl) textEl.textContent = qText;
    item.querySelector(".ans-value.chosen").textContent = chosenText;
    item.querySelector(".ans-value.correct").textContent = correctText;

    review.appendChild(item);
  });
}

/* ---------------------------------------------------
   Boot
--------------------------------------------------- */

// The server draws the 30 questions and keeps their answers
async function dealNewList() {
  const data = await postJson(API_START, { bank: dataFile() });

  quiz.examId = data.examId;
  quiz.list = data.questions;
  quiz.index = 0;
  quiz.score = 0;
  quiz.passed = false;
  quiz.selected = null;
  quiz.locked = false;
  quiz.answers = [];
  quiz.pending = [];
  quiz._lastNavAt = 0;

  preloadImages(quiz.list);
  buildNav();
}

async function startNewExam() {
  if (quiz.busy) return;

  quiz.busy = true;
  try {
    await dealNewList();
  } catch (err) {
    alert("خطأ: " + err.message);
    return;
  } finally {
    quiz.busy = false;
  }

  document.getElementById("resultsView").classList.add("hidden");
  document.getElementById("quizView").classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });

  renderQuestion();
}

async function init() {
  document.getElementById("userName").textContent = BRAND_NAME;
  document.getElementById("userPhone").textContent = BRAND_PHONE;

  await dealNewList();

  bindTap(document.getElementById("prevBtn"), prevQuestion);
  bindTap(document.getElementById("confirmBtn"), revealAnswer);
  bindTap(document.getElementById("nextBtn"), nextQuestion);
  bindTap(document.getElementById("retryBtn"), startNewExam);

  bindTap(document.getElementById("homeBtn"), () => {
    window.location.href = "index.html";
  });

  // Arrow keys on desktop (RTL: right goes back, left goes forward)
  document.addEventListener("keydown", (e) => {
    if (document.getElementById("quizView").classList.contains("hidden")) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      goTo(quiz.index - 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      goTo(quiz.index + 1);
    }
  });

  // The top back button is easy to hit by mistake, so warn once the exam started.
  // Plain click (not bindTap) so the link still works if this script fails.
  [...document.querySelectorAll(".home-link")].forEach((link) => {
    link.addEventListener("click", (e) => {
      const answered = quiz.answers.filter(Boolean).length > 0;
      if (answered && !window.confirm("سيتم إلغاء الاختبار الحالي. هل تريد الرجوع للصفحة الرئيسية؟")) {
        e.preventDefault();
      }
    });
  });

  renderQuestion();
}

init().catch((err) => alert("خطأ: " + err.message));
