// calibrate.js — the 1-minute calibration flow.
//
//   Step 1 Hold   10 s on a dot → resting fluctuation size (px) and frequency (Hz)
//   Step 2 Click  5 targets + 3 right-clicks → real reaching movement, how long real vs accidental clicks are held
//   Step 3 Type   one sentence  → typing rhythm and accidental double key presses
//
// Then:
//   - the browser computes a simple profile (thresholds) — always works
//   - the local ML server (if running) retrains a PERSONAL model on this data
//   - Gemini (through the server) explains the results in plain language
// Without the server, calibration still finishes with the default model and
// pre-written text. Raw movement only ever goes to localhost; Gemini only gets
// summary numbers. Key names stay in this page and are never sent anywhere.

const api = globalThis.browser ?? globalThis.chrome;
const SERVER = "http://localhost:8000";
const HOLD_MS = 10000;
const N_TARGETS = 5; // short on purpose: enough to measure, not enough to get tiring
const N_RIGHT_TARGETS = 3;
const DEFAULT_HOLD_MS = 150; // used when calibration has too few clicks to decide
const SIZES = [24, 56, 36, 72, 44]; // px, varied on purpose (small to large)
const SENTENCE = "the quick brown fox jumps over the lazy dog"; // no doubled letters, so any double press is accidental

const data = { hold: [], reach: [], clicks: [], rclicks: [], keys: [] };
let serverInfo = null; // result of GET /health, or null if the server is off

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const percentile = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

/** fetch JSON with a timeout; resolves null on ANY failure (server off, slow, error). */
async function callServer(path, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(SERVER + path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Record every pointer sample over `el` into `list` (same method as content/capture.js). */
function recordPointer(el, list, type = "move") {
  const handler = (e) => {
    const now = performance.now();
    const samples = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const s of samples.length ? samples : [e]) {
      let age = e.timeStamp - s.timeStamp;
      if (!(age >= 0 && age < 200)) age = 0;
      list.push({ t: now - age, x: s.clientX, y: s.clientY, type });
    }
  };
  el.addEventListener("pointermove", handler);
  return () => el.removeEventListener("pointermove", handler);
}

// ---------------------------------------------------------------------------
// Screens and progress
// ---------------------------------------------------------------------------
const SCREENS = ["intro", "hold", "click", "rclick", "type", "working", "results"];
const STEP_OF = { intro: 0, hold: 1, click: 2, rclick: 2, type: 3, working: 4, results: 4 };

function show(name) {
  for (const s of SCREENS) $("screen-" + s).hidden = s !== name;
  const step = STEP_OF[name];
  document.querySelectorAll(".steps li").forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle("current", n === step);
    li.classList.toggle("done", n < step);
    if (n === step) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });
  const pct = { intro: 0, hold: 10, click: 35, rclick: 55, type: 70, working: 90, results: 100 }[name];
  $("progress-fill").style.width = pct + "%";
  document.querySelector(".progress").setAttribute("aria-valuenow", String(pct));
  const heading = $("screen-" + name).querySelector("h2");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus(); // screen readers hear the new step
  }
}

// ---------------------------------------------------------------------------
// Intro: is the local server running?
// ---------------------------------------------------------------------------
async function checkServer() {
  serverInfo = await callServer("/health", null, 1500);
  const el = $("server-status");
  if (serverInfo) {
    el.textContent = serverInfo.gemini
      ? "Local ML server connected. Your personal model will be trained, and Gemini will explain your results."
      : "Local ML server connected. Your personal model will be trained. (Gemini is off: no API key in .env.)";
    el.className = "status ok";
  } else {
    el.textContent = "The local ML server isn't running, so you'll get the default model with settings tuned to you. To train a personal model, start it with: python ml/server.py";
    el.className = "status warn";
  }
}

// ---------------------------------------------------------------------------
// Step 1: hold
// ---------------------------------------------------------------------------
function startHold() {
  show("hold");
  data.hold = [];
  const arena = $("hold-arena"), dot = $("hold-dot"), timerEl = $("hold-timer");
  let startedAt = null, timer = null;
  const recent = []; // samples before the timer starts (ignored)
  const stopRecording = recordPointer(arena, recent);

  const onMove = (e) => {
    if (startedAt !== null) return;
    const r = dot.getBoundingClientRect();
    const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
    if (d < 40) {
      startedAt = performance.now();
      dot.classList.add("active");
      $("hold-instructions").textContent = "Great, keep resting on the dot…";
      timer = setInterval(tick, 100);
    }
  };
  const tick = () => {
    const left = Math.max(0, HOLD_MS - (performance.now() - startedAt));
    timerEl.textContent = Math.ceil(left / 1000);
    if (left <= 0) finish(false);
  };
  const finish = (skipped) => {
    clearInterval(timer);
    stopRecording();
    arena.removeEventListener("pointermove", onMove);
    dot.classList.remove("active");
    data.hold = skipped ? [] : recent.filter((s) => s.t >= startedAt);
    data.holdSkipped = skipped;
    startClick();
  };
  arena.addEventListener("pointermove", onMove);
  skipHandlers.hold = () => finish(true);
}

// ---------------------------------------------------------------------------
// Step 2: click targets
// ---------------------------------------------------------------------------
function startClick() {
  data.reach = [];
  runTargets({ screen: "click", button: 0, count: N_TARGETS, clicks: (data.clicks = []), skipKey: "click", next: startRightClick });
}

function startRightClick() {
  runTargets({ screen: "rclick", button: 2, count: N_RIGHT_TARGETS, clicks: (data.rclicks = []), skipKey: "rclick", next: startType });
}

/**
 * One round of targets. Records for every press of `button`:
 *   hit / miss, accidental double (a miss right after a hit), the gap since the
 *   last hit, how far the cursor drifted during the press, and HOW LONG the
 *   button was held (durationMs) — the AI uses that to pick the hold period.
 */
function runTargets({ screen, button, count, clicks, skipKey, next }) {
  show(screen);
  const arena = $(screen + "-arena");
  arena.innerHTML = "";
  const stopRecording = button === 0 ? recordPointer(arena, data.reach) : () => {};
  let hits = 0, target = null, lastHitDown = null, down = null, done = false;

  const placeTarget = () => {
    const size = SIZES[hits % SIZES.length];
    const w = arena.clientWidth, h = arena.clientHeight, pad = 12;
    target = document.createElement("button");
    target.className = "target";
    target.setAttribute("aria-label", `Target ${hits + 1} of ${count}`);
    target.style.width = target.style.height = size + "px";
    target.style.left = pad + Math.random() * (w - size - 2 * pad) + "px";
    target.style.top = pad + Math.random() * (h - size - 2 * pad) + "px";
    arena.appendChild(target);
    $(screen + "-count").textContent = `${hits} of ${count}`;
  };

  const onDown = (e) => {
    if (e.button !== button || done) return;
    const now = performance.now();
    const hit = target && e.target === target;
    down = { t: now, x: e.clientX, y: e.clientY, click: null };
    if (button === 0) data.reach.push({ t: now, x: e.clientX, y: e.clientY, type: "down" });
    // A miss soon after a hit = the target already moved = accidental double-click.
    const accidentalDouble = !hit && lastHitDown !== null && now - lastHitDown < 600;
    down.click = { t: now, hit, accidentalDouble, gapMs: lastHitDown === null ? null : now - lastHitDown, drift: 0, durationMs: null };
    clicks.push(down.click);
    if (hit) {
      lastHitDown = now;
      hits++;
      target.remove();
      target = null;
      if (hits >= count) done = true; // finish after this press is released
      else placeTarget();
    }
  };
  const onUp = (e) => {
    if (e.button !== button || !down) return;
    down.click.drift = Math.hypot(e.clientX - down.x, e.clientY - down.y); // movement during the press
    down.click.durationMs = performance.now() - down.t;                    // how long it was held
    down = null;
    if (done) finish(false);
  };
  const noMenu = (e) => e.preventDefault(); // right-clicking targets shouldn't open the browser menu
  const finish = (skipped) => {
    stopRecording();
    arena.removeEventListener("mousedown", onDown);
    window.removeEventListener("mouseup", onUp);
    arena.removeEventListener("contextmenu", noMenu);
    arena.innerHTML = "";
    data[skipKey + "Skipped"] = skipped;
    if (skipped) clicks.length = 0;
    next();
  };
  // mousedown/mouseup fire for EVERY button (pointerdown only fires for the first one pressed).
  arena.addEventListener("mousedown", onDown);
  window.addEventListener("mouseup", onUp);
  arena.addEventListener("contextmenu", noMenu);
  skipHandlers[skipKey] = () => finish(true);
  placeTarget();
}

// ---------------------------------------------------------------------------
// Step 3: type
// ---------------------------------------------------------------------------
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab", "Escape"]);

function startType() {
  show("type");
  data.keys = [];
  const box = $("type-box");
  box.value = "";
  const onKey = (e) => {
    if (e.repeat || MODIFIERS.has(e.key)) return; // held keys and modifiers don't count
    data.keys.push({ t: performance.now(), key: e.key.toLowerCase() });
  };
  box.addEventListener("keydown", onKey);
  box.focus();
  const finish = (skipped) => {
    box.removeEventListener("keydown", onKey);
    if (skipped) data.keys = [];
    analyze();
  };
  $("type-done").onclick = () => finish(false);
  box.onkeydown = (e) => { if (e.key === "Enter") finish(false); };
  skipHandlers.type = () => finish(true);
}

// ---------------------------------------------------------------------------
// Measurements (all computed here, in the browser)
// ---------------------------------------------------------------------------

/** Resting fluctuation: how far and how often the cursor moves while "holding still". */
function holdStats(samples) {
  if (samples.length < 10) return { amplitudePx: 0, frequencyHz: null };
  // Resample to 100 Hz so time steps are even.
  const t0 = samples[0].t, t1 = samples[samples.length - 1].t;
  const n = Math.floor((t1 - t0) / 10) + 1;
  if (n < 50) return { amplitudePx: 0, frequencyHz: null };
  const xs = new Array(n), ys = new Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const g = t0 + i * 10;
    while (j < samples.length - 2 && samples[j + 1].t <= g) j++;
    const a = samples[j], b = samples[Math.min(j + 1, samples.length - 1)];
    const f = b.t > a.t ? Math.min(1, Math.max(0, (g - a.t) / (b.t - a.t))) : 0;
    xs[i] = a.x + f * (b.x - a.x);
    ys[i] = a.y + f * (b.y - a.y);
  }
  // Size: distance from a 300 ms moving average (removes slow drift), as an RMS.
  // For a back-and-forth wobble of size A, sqrt(2) * RMS ≈ A.
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let mx = 0, my = 0, c = 0;
    for (let k = Math.max(0, i - 15); k <= Math.min(n - 1, i + 15); k++) { mx += xs[k]; my += ys[k]; c++; }
    sum += (xs[i] - mx / c) ** 2 + (ys[i] - my / c) ** 2;
  }
  const amplitudePx = Math.sqrt(2) * Math.sqrt(sum / n);
  if (amplitudePx < 0.5) return { amplitudePx, frequencyHz: null };

  // Frequency: the strongest 2-15 Hz component of the velocity (a direct DFT).
  const vx = [], vy = [];
  for (let i = 1; i < n; i++) { vx.push((xs[i] - xs[i - 1]) * 100); vy.push((ys[i] - ys[i - 1]) * 100); }
  const m = vx.length;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(vx), my = mean(vy);
  let best = 0, bestF = null;
  for (let k = Math.ceil((2 * m) / 100); k <= Math.floor((15 * m) / 100); k++) {
    let rx = 0, ix = 0, ry = 0, iy = 0;
    for (let i = 0; i < m; i++) {
      const a = (2 * Math.PI * k * i) / m, c = Math.cos(a), s = Math.sin(a);
      rx += (vx[i] - mx) * c; ix -= (vx[i] - mx) * s;
      ry += (vy[i] - my) * c; iy -= (vy[i] - my) * s;
    }
    const p = rx * rx + ix * ix + ry * ry + iy * iy;
    if (p > best) { best = p; bestF = (k * 100) / m; }
  }
  return { amplitudePx, frequencyHz: bestF };
}

function clickStats(clicks) {
  const hits = clicks.filter((c) => c.hit).length;
  const doubles = clicks.filter((c) => c.accidentalDouble);
  return {
    targetsHit: hits,
    misses: clicks.length - hits - doubles.length,
    accidentalDoubleClicks: doubles.length,
    accidentalDoubleMaxGapMs: doubles.length ? Math.max(...doubles.map((c) => c.gapMs)) : null,
    pressDriftP90Px: percentile(clicks.map((c) => c.drift), 0.9),
  };
}

function keyStats(keys) {
  const gaps = [], repeats = [];
  for (let i = 1; i < keys.length; i++) {
    const gap = keys[i].t - keys[i - 1].t;
    if (gap > 2000) continue; // a pause, not typing rhythm
    gaps.push(gap);
    if (keys[i].key === keys[i - 1].key && keys[i].key !== "backspace") repeats.push(gap);
  }
  return {
    keysTyped: keys.length,
    medianKeyGapMs: median(gaps),
    accidentalKeyRepeats: repeats.length,
    accidentalRepeatMaxGapMs: repeats.length ? Math.max(...repeats) : null,
  };
}

/**
 * HOLD PERIOD: how long a button must be held for a press to count as a click.
 *
 * During the circle steps we time how long the button is held on every press:
 *   REAL clicks       presses that hit a circle
 *   ACCIDENTAL clicks presses that land OUTSIDE the circle (shaky taps, slips)
 *
 * Then we try every possible hold time and keep the one that makes the fewest
 * mistakes:
 *   mistake = a REAL click that would be ignored        (counts 3x: very annoying)
 *           + an ACCIDENTAL click that would get through (counts 1x)
 * Ties go to the SHORTER hold, so clicking never feels slower than needed.
 * Some misses are just aim errors with a normal-length press; the 3x rule means
 * those can't push the hold time above the user's real clicks.
 *
 * If there were no accidental clicks to learn from, we use 80% of the user's
 * quickest real click, so every normal click still counts.
 * Clamped to 0.04-0.5 s, rounded to 0.01 s. Middle uses the left value.
 *
 * Protection is switched ON if calibration saw a reason: a measurable resting
 * wobble (>= 1.5 px) or at least one accidental click that was quicker than
 * the user's quickest real click (a quick shaky tap).
 */
const MISS_COST_REAL = 3;     // blocking a real click is 3x worse...
const MISS_COST_ACCIDENT = 1; // ...than letting an accidental one through

function bestHold(real, accidental) {
  if (real.length < 2) return { ms: DEFAULT_HOLD_MS, basis: "default", blockedReal: 0, caught: 0 };
  if (!accidental.length) {
    return { ms: roundHold(0.8 * Math.min(...real)), basis: "no accidents", blockedReal: 0, caught: 0 };
  }
  // Candidate hold times: just above each recorded press, plus "almost none".
  const candidates = [0, ...real, ...accidental].map((d) => d + 1).sort((a, b) => a - b);
  let best = null;
  for (const hold of candidates) {
    const blockedReal = real.filter((d) => d < hold).length;
    const caught = accidental.filter((d) => d < hold).length;
    const cost = MISS_COST_REAL * blockedReal + MISS_COST_ACCIDENT * (accidental.length - caught);
    if (!best || cost < best.cost) best = { hold, cost, blockedReal, caught };
  }
  // Put the hold time in the GAP: halfway between the longest accidental tap it
  // catches and the quickest real click it lets through.
  const caughtMax = Math.max(0, ...accidental.filter((d) => d < best.hold));
  const realAbove = real.filter((d) => d >= best.hold);
  const ms = realAbove.length && caughtMax > 0 ? (caughtMax + Math.min(...realAbove)) / 2 : best.hold;
  return { ms: roundHold(ms), basis: "best split", blockedReal: best.blockedReal, caught: best.caught };
}
const roundHold = (ms) => Math.round(clamp(ms, 40, 500) / 10) * 10;

function chooseClickHold(m) {
  const durations = (list, pred) => list.filter((c) => pred(c) && c.durationMs !== null).map((c) => c.durationMs);
  const leftReal = durations(data.clicks, (c) => c.hit);
  const leftAccidental = durations(data.clicks, (c) => !c.hit); // every click outside the circle
  const left = bestHold(leftReal, leftAccidental);
  const rightReal = durations(data.rclicks, (c) => c.hit);
  const right = rightReal.length >= 2
    ? bestHold(rightReal, durations(data.rclicks, (c) => !c.hit))
    : { ...left, basis: "same as left" };

  const quickTaps = leftReal.length ? leftAccidental.filter((d) => d < Math.min(...leftReal)).length : 0;
  const recommendedOn = (m.amplitudePx || 0) >= 1.5 || quickTaps > 0;

  const sec = (ms) => (ms / 1000).toFixed(2);
  const range = (list) => (Math.min(...list) === Math.max(...list) ? `${sec(list[0])} s` : `${sec(Math.min(...list))}–${sec(Math.max(...list))} s`);
  let reason;
  if (left.basis === "best split") {
    const n = leftAccidental.length;
    const caughtText = n === 1
      ? (left.caught ? "ignores that accidental click" : "can't catch that click without blocking real ones")
      : `ignores ${left.caught} of those ${n} accidental clicks`;
    reason = `You held your real clicks for ${range(leftReal)} and your ${n === 1 ? "click" : `${n} clicks`} outside the circles for ${range(leftAccidental)}. ` +
      `A ${sec(left.ms)} s hold ${caughtText}` +
      (left.blockedReal ? ` (and would have blocked ${left.blockedReal} real one).` : " and keeps all your real clicks.");
  } else if (left.basis === "no accidents") {
    reason = `You didn't click outside any circles, so the hold is set just under your quickest real click (${sec(Math.min(...leftReal))} s). All your normal clicks still count.`;
  } else {
    reason = `There weren't enough clicks to measure, so Smooth Mouse uses a standard ${sec(left.ms)} s hold.`;
  }
  reason += recommendedOn
    ? " Protection is ON because calibration saw shaking or quick accidental taps."
    : " Protection is OFF because your clicks looked steady; you can turn it on in the popup.";

  return {
    left: left.ms, right: right.ms, middle: left.ms,
    recommendedOn, reason,
    stats: {
      realClicks: leftReal.length,
      accidentalClicks: leftAccidental.length,
      quickAccidentalTaps: quickTaps,
      accidentalCaught: left.caught,
      realBlocked: left.blockedReal,
    },
  };
}

/** Thresholds used by click/key protection and target assistance (Checkpoint 6). */
function buildProfile(m) {
  const A = m.amplitudePx || 0;
  return {
    // Same key again faster than this = accidental repeat (filtered).
    keyRepeatWindowMs: Math.round(clamp(Math.max(m.medianKeyGapMs ? 0.45 * m.medianKeyGapMs : 120,
      m.accidentalRepeatMaxGapMs ? 1.3 * m.accidentalRepeatMaxGapMs : 0), 60, 300)),
    // Second click faster than this = accidental double-click (merged).
    doubleClickWindowMs: Math.round(clamp(m.accidentalDoubleMaxGapMs ? 1.3 * m.accidentalDoubleMaxGapMs : 350, 250, 600)),
    // How close the steady cursor must be for a button to "pull" the click.
    magnetRadiusPx: Math.round(clamp(12 + 1.5 * A + 2 * (m.misses || 0), 12, 48)),
    // Moving more than this while the button is held down = shaky click.
    shakyPressDriftPx: Math.round(clamp(Math.max(8, 2 * (m.pressDriftP90Px || 0)), 8, 40)),
  };
}

// ---------------------------------------------------------------------------
// Analyze, personalize, explain
// ---------------------------------------------------------------------------
async function analyze() {
  show("working");
  const measurements = {
    ...holdStats(data.hold),
    ...clickStats(data.clicks),
    ...keyStats(data.keys),
  };
  const profile = buildProfile(measurements);
  profile.clickHold = chooseClickHold(measurements);

  // 1. Personal model from the local server (raw movement goes to localhost only).
  let personal = null;
  if (serverInfo) {
    $("working-detail").textContent = "Retraining the movement classifier on your data. This takes a few seconds.";
    personal = await callServer("/calibrate", {
      measurements, profile,
      hold: data.hold.map(({ t, x, y }) => ({ t, x, y })),
      reach: data.reach.filter((s) => s.type === "move").map(({ t, x, y }) => ({ t, x, y })),
    }, 30000);
  }

  // 2. Plain-language explanation: Gemini gets summary NUMBERS only.
  const r = personal ? personal.report : {};
  const geminiStats = {
    restingFluctuationPx: round1(measurements.amplitudePx),
    restingFluctuationPerSecond: measurements.frequencyHz ? round1(measurements.frequencyHz) : null,
    targetsHit: measurements.targetsHit,
    missedClicks: measurements.misses,
    accidentalDoubleClicks: measurements.accidentalDoubleClicks,
    accidentalDoubleKeyPresses: measurements.accidentalKeyRepeats,
    personalModelTrained: !!personal,
    calmMovesWronglyFlaggedBeforePercent: pct(r.calmCalledUnstableBefore),
    calmMovesWronglyFlaggedAfterPercent: pct(r.calmCalledUnstableAfter),
    clickHoldSeconds: Math.round(profile.clickHold.left / 10) / 100,
    accidentalClickProtectionOn: profile.clickHold.recommendedOn,
  };
  let explanation = null;
  if (serverInfo && serverInfo.gemini) {
    $("working-detail").textContent = "Asking Gemini to explain your results…";
    // Up to 10 s: Gemini is usually ~1 s but slower when busy. On timeout we use a template.
    explanation = await callServer("/gemini/explain", geminiStats, 10000);
  }

  // 3. Save. Everything in the extension reads these from storage.local.
  const calibratedAt = new Date().toISOString();
  await api.storage.local.set({
    profile: { ...profile, measurements: roundAll(measurements), calibratedAt, personalModel: !!personal },
    personalModel: personal ? personal.model : null,
    // The AI's decision becomes the active setting; the user can still change it in the popup.
    ignoreLeft: profile.clickHold.recommendedOn,
    ignoreRight: profile.clickHold.recommendedOn,
    ignoreMiddle: profile.clickHold.recommendedOn,
    holdOverrideMs: null,
  });

  renderResults(measurements, profile, personal, explanation);
}

const round1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const pct = (v) => (v === null || v === undefined ? null : Math.round(v * 100));
const roundAll = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? round1(v) : v]));

function templateExplanation(m) {
  const steady = (m.amplitudePx || 0) < 1.5;
  const first = data.holdSkipped
    ? "You skipped the hold step, so Smooth Mouse will start with its standard settings."
    : steady
      ? "Your cursor stayed steady while you held it still, so Smooth Mouse will mostly stay out of your way and only step in if it notices shaking."
      : `While you held the cursor still, it moved about ${Math.round(m.amplitudePx)} pixels back and forth, about ${Math.round(m.frequencyHz)} times per second. Smooth Mouse will steady the cursor when it sees movement like that, and get out of the way when you move on purpose.`;
  return `${first} These are measurements of cursor movement, not a medical diagnosis.`;
}

function renderResults(m, profile, personal, explanation) {
  show("results");
  $("explain-text").textContent = explanation ? explanation.text : templateExplanation(m);
  const tag = $("explain-tag");
  tag.textContent = explanation ? "Explained by Gemini" : "Standard explanation";
  tag.className = explanation ? "tag" : "tag plain";

  const facts = [];
  if (data.holdSkipped) facts.push("Hold step skipped.");
  else if ((m.amplitudePx || 0) < 1) facts.push("Holding still: your cursor stayed within about 1 px.");
  else facts.push(`Holding still: your cursor fluctuated about ${m.amplitudePx.toFixed(1)} px` +
    (m.frequencyHz ? ` at about ${m.frequencyHz.toFixed(1)} times per second.` : "."));
  if (!data.clickSkipped) facts.push(`Targets: ${m.targetsHit} hit, ${m.misses} missed clicks, ${m.accidentalDoubleClicks} accidental double-clicks.`);
  if (m.keysTyped) facts.push(`Typing: about ${Math.round(m.medianKeyGapMs)} ms between keys, ${m.accidentalKeyRepeats} accidental double key presses.`);
  if (personal && personal.report.calmCalledUnstableBefore !== undefined) {
    facts.push(`Your calm movements flagged as unstable: ${pct(personal.report.calmCalledUnstableBefore)}% with the default model → ` +
      `${pct(personal.report.calmCalledUnstableAfter)}% with your personal model.`);
  }
  if (personal && personal.report.shakyDetectedBefore !== undefined) {
    facts.push(`Your shaky movements detected: ${pct(personal.report.shakyDetectedBefore)}% → ${pct(personal.report.shakyDetectedAfter)}%.`);
  }
  fillList("facts", facts);

  const ch = profile.clickHold;
  fillList("settings", [
    `Hold period: ${(ch.left / 1000).toFixed(2)} s (left and middle), ${(ch.right / 1000).toFixed(2)} s (right). ` +
      `Accidental-click protection is ${ch.recommendedOn ? "ON" : "OFF"}. ${ch.reason}`,
    `Repeated key within ${profile.keyRepeatWindowMs} ms is treated as accidental.`,
    `Second click within ${profile.doubleClickWindowMs} ms is treated as an accidental double-click.`,
    `Buttons within ${profile.magnetRadiusPx} px of the steady cursor attract the click.`,
    `Moving more than ${profile.shakyPressDriftPx} px while pressing counts as a shaky click.`,
  ]);

  const status = $("model-status");
  if (personal) {
    status.textContent = `Personal model trained on your movement (${personal.report.realWindows} of your movement windows, ${personal.report.seconds} s) and saved. It's now used on every page.`;
    status.className = "status ok";
  } else {
    status.textContent = "Personal model needs the local ML server. Using the default model, with the settings above tuned to you.";
    status.className = "status warn";
  }
}

function fillList(id, items) {
  const ul = $(id);
  ul.innerHTML = "";
  for (const text of items) {
    const li = document.createElement("li");
    li.textContent = text;
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
const skipHandlers = {};
document.querySelectorAll("[data-skip]").forEach((btn) =>
  btn.addEventListener("click", () => skipHandlers[btn.dataset.skip] && skipHandlers[btn.dataset.skip]())
);
$("start").addEventListener("click", startHold);
$("again").addEventListener("click", () => { checkServer(); startHold(); });
$("finish").addEventListener("click", () => {
  window.close();
  // window.close() can be blocked for tabs the user didn't open with a script.
  $("model-status").textContent = "All set. You can close this tab.";
});

show("intro");
checkServer();
