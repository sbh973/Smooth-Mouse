// simulator.js — the "shaky hand" simulator, so people without a tremor can
// feel the problem (and watch Smooth Mouse fix it).
//
// When it's on:
//   - a fake tremor (~5 times a second, ±2-40 px set by a slider, plus noise) is
//     added to every mouse sample BEFORE the rest of Smooth Mouse sees it,
//     and it keeps shaking even when the mouse is still
//   - the real cursor is hidden; you steer a shaky one
//   - clicks land where the SHAKY cursor is (unless Smooth Mouse's steady
//     cursor has taken over, which is the point of the demo)
//   - now and then a click comes with an accidental extra tap
// It works even with Smooth Mouse switched off, to show the "before".

(() => {
  const SM = window.SmoothMouse;

  const DEFAULT_AMP = 12; // px; the popup / demo page slider changes it live
  const FREQ = 5;     // shakes per second
  const EXTRA_TAP_CHANCE = 0.35;
  const phase = Math.random() * Math.PI * 2;
  const noise = () => (Math.random() - 0.5) * 3;

  const sim = (SM.simulator = { on: false });
  let realX = null, realY = null, lastRealT = 0;
  let shakyX = null, shakyY = null;

  /** The fake tremor at time t (ms): an elliptical wobble plus a little noise. */
  function tremor(t) {
    const w = 2 * Math.PI * FREQ * (t / 1000) + phase;
    const base = (SM.settings && SM.settings.simAmplitudePx) || DEFAULT_AMP;
    const amp = base * (1 + 0.15 * Math.sin(2 * Math.PI * 0.4 * (t / 1000)));
    // Bigger shakes are also messier: the random jitter grows with the strength.
    const n = 1 + base / 25;
    return [amp * Math.sin(w) + noise() * n, 0.45 * amp * Math.sin(w + 1.3) + noise() * n];
  }

  // Applied to every real sample in capture.js.
  SM.capture.transform = (x, y, t) => {
    if (!sim.on) return [x, y];
    const [dx, dy] = tremor(t);
    return [x + dx, y + dy];
  };

  function setOn(on) {
    if (on === sim.on) return;
    sim.on = on;
    if (on) start();
    else stop();
  }
  (SM.settingsListeners = SM.settingsListeners || []).push((settings) => setOn(!!settings.simulateTremor));

  window.addEventListener("mousemove", (e) => {
    realX = e.clientX;
    realY = e.clientY;
    lastRealT = performance.now();
  }, { capture: true, passive: true });

  // --- Keep shaking while the mouse is still -----------------------------------
  let idleTimer = null, raf = null;
  function start() {
    idleTimer = setInterval(() => {
      if (realX === null || performance.now() - lastRealT < 12) return;
      const [dx, dy] = tremor(performance.now());
      SM.capture.inject(realX + dx, realY + dy); // no-op when Smooth Mouse is off
    }, 8);
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    clearInterval(idleTimer);
    cancelAnimationFrame(raf);
    if (cursorEl) cursorEl.hidden = true;
    document.documentElement.classList.toggle("sm-hide-cursor", !!(SM.stabilize && SM.stabilize.engaged));
  }

  // --- Draw the shaky cursor ---------------------------------------------------------
  let cursorEl = null;
  const steadyShowing = () => SM.enabled && SM.settings && SM.settings.stabilize && SM.stabilize && SM.stabilize.engaged;

  function frame() {
    if (!sim.on) return;
    if (realX !== null) {
      const [dx, dy] = tremor(performance.now());
      shakyX = realX + dx;
      shakyY = realY + dy;
    }
    document.documentElement.classList.add("sm-hide-cursor");
    if (!cursorEl) {
      cursorEl = document.createElement("div");
      cursorEl.className = "sm-cursor sm-shaky-cursor";
      cursorEl.setAttribute("aria-hidden", "true");
      cursorEl.innerHTML =
        '<svg width="22" height="28" viewBox="0 0 22 28" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M1.5 1.5 L1.5 22 L7 16.8 L10.8 25.5 L14.3 24 L10.6 15.5 L18 15.5 Z" ' +
        'fill="#B4441A" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      document.documentElement.appendChild(cursorEl);
    }
    // When Smooth Mouse's steady cursor is on screen, it replaces the shaky one.
    cursorEl.hidden = shakyX === null || steadyShowing();
    if (!cursorEl.hidden) cursorEl.style.transform = `translate(${shakyX - 1.5}px, ${shakyY - 1.5}px)`;
    raf = requestAnimationFrame(frame);
  }

  // --- Clicks land where the shaky cursor is ----------------------------------------
  const CLICKABLE = 'a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"], [onclick], [tabindex]';
  const activation = (el) => (el && el.closest ? el.closest(CLICKABLE) || el : el);
  let press = null;

  window.addEventListener("mousedown", (e) => {
    if (!sim.on || !e.isTrusted || e.button !== 0) return;
    // Use the press's own position (not only the last mousemove), so the
    // shaky click is always measured from where the hand really is.
    realX = e.clientX;
    realY = e.clientY;
    const [dx, dy] = tremor(performance.now());
    shakyX = realX + dx;
    shakyY = realY + dy;
    press = { x: shakyX, y: shakyY };
  }, true);

  function clickAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    if (SM.enabled && SM.risky) SM.risky.guardedClick(el, x, y);
    else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, detail: 1 }));
  }

  // Registered after clickhold.js (ignored taps stay ignored) and before the
  // steady cursor (which takes over when Smooth Mouse is helping).
  window.addEventListener("click", (e) => {
    if (!sim.on || !e.isTrusted || e.button !== 0 || e.detail === 0 || !press) return;
    const p = press;
    press = null;

    // Sometimes a shaky hand taps twice.
    if (Math.random() < EXTRA_TAP_CHANCE) {
      setTimeout(() => {
        if (SM.enabled && SM.clickHold && SM.clickHold.ignoreSimulatedTap("left")) return;
        clickAt(shakyX ?? p.x, shakyY ?? p.y);
      }, 110);
    }

    if (steadyShowing()) return; // the steady cursor handles where this click goes
    const shakyTarget = document.elementFromPoint(p.x, p.y);
    if (!shakyTarget || activation(shakyTarget) === activation(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    clickAt(p.x, p.y);
  }, true);
})();
