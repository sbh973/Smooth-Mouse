// stabilize.js — the stabilized cursor.
//
//   every raw pointer sample ─► One Euro filter (strength from controller.js) ─► steady position
//   every model update (50 ms) ─► controller ─► smoothing strength
//
// While smoothing is active ("engaged") we hide the real cursor on the page
// and draw our own at the steady position. When movement is calm, smoothing
// is off, the real cursor is shown, and there is zero added lag.
//
// Clicks: if the steady cursor is over a DIFFERENT element than the real one,
// we cancel the real click and send a click to the element under the steady
// cursor. Those clicks are "untrusted" (made by a script), and a few sites
// ignore untrusted clicks, so this has its own toggle in the popup.

(() => {
  const SM = window.SmoothMouse;
  const { OneEuroFilter2D } = SM.filters;
  const { Controller } = SM;

  const BLEND_FULL_AT = 0.2;   // effective strength where output is 100% filtered
  const ENGAGE_AT = 0.08;      // controller strength that switches to our cursor
  const DISENGAGE_AT = 0.03;   // ...and back to the real cursor (with < 1 px gap)
  const DIRECTED_WINDOW_MS = 200;
  const TRAIL_MS = 3000;

  const controller = new Controller();
  const filter = new OneEuroFilter2D(Controller.filterParams(0));

  const state = (SM.stabilize = {
    strength: 0,    // from the controller (what the model asks for)
    effective: 0,   // after the "deliberate movement" override
    level: "light",
    engaged: false, // our cursor is shown instead of the real one
    x: null, y: null,       // steady position
    rawX: null, rawY: null, // real position
    lastSampleT: 0,
    trail: [],      // {t, rx, ry, sx, sy} for the demo visualization
    clicksRedirected: 0,
  });

  const active = () => SM.enabled && SM.settings && SM.settings.stabilize;

  // Switching a toggle off must give the real cursor back immediately.
  (SM.settingsListeners = SM.settingsListeners || []).push(() => {
    updateEngaged();
    render();
  });

  // --- Model → controller ---------------------------------------------------
  SM.live.onUpdate((live) => {
    if (!active()) return;
    state.strength = controller.update(live.probs, live.updatedAt);
    state.level = controller.level;
    updateEngaged();
    scheduleLoop();
  });

  // --- Raw samples → filter -------------------------------------------------
  const recent = []; // last ~150 ms of raw samples, for directed speed

  /**
   * How fast the cursor is heading somewhere ON PURPOSE (px/s).
   *
   * = net displacement over the last 200 ms / time, multiplied by how straight
   *   the path was (net distance / path length).
   * A deliberate reach goes one way (straight, big net distance) → high.
   * A shake goes back and forth, even a big, fast one → the path folds back on
   * itself, straightness is low, and so is this number. (An earlier version
   * used only 80 ms and no straightness, so big shakes looked like reaches and
   * switched smoothing off.)
   */
  function directedSpeed(t, x, y) {
    recent.push({ t, x, y });
    while (recent.length && recent[0].t < t - DIRECTED_WINDOW_MS - 20) recent.shift();
    let start = 0;
    while (start < recent.length - 1 && recent[start].t < t - DIRECTED_WINDOW_MS) start++;
    const ref = recent[start];
    let path = 0;
    for (let i = start + 1; i < recent.length; i++) {
      path += Math.hypot(recent[i].x - recent[i - 1].x, recent[i].y - recent[i - 1].y);
    }
    const net = Math.hypot(x - ref.x, y - ref.y);
    const straightness = path > 0 ? net / path : 0;
    const dt = Math.max(t - ref.t, 40) / 1000;
    return (net / dt) * straightness;
  }

  /**
   * "Minimum smoothing" from the popup slider (0-100%), as 0..1.
   * 0 = fully adaptive (the model decides; no lag when calm).
   * 1 = always strong, for EVERY movement, including big, fast, straight ones
   *     (the cursor then glides in behind the hand instead of jumping).
   * Neither the model nor the "deliberate movement" override can go below it.
   */
  const floor = () => Math.min(1, Math.max(0, ((SM.settings && SM.settings.minSmoothing) || 0) / 100));

  /** What the user gets: the model's strength, but never below the floor. */
  const targetStrength = () => Math.max(state.strength, floor());

  function step(x, y, t, isRealSample) {
    const override = Controller.override(directedSpeed(t, x, y));
    const eff = Math.max(floor(), state.strength * (1 - override));
    filter.setParams(Controller.filterParams(eff));
    const f = filter.filter(x, y, t);

    // Fade between raw and filtered so turning smoothing on/off never jumps.
    // The fade follows the controller's slow, slewed strength, NOT the fast
    // override: a deliberate reach loosens the filter (above), so the steady
    // cursor catches up smoothly instead of snapping between two positions.
    const w = Math.min(1, targetStrength() / BLEND_FULL_AT);
    state.x = x + w * (f.x - x);
    state.y = y + w * (f.y - y);
    state.rawX = x;
    state.rawY = y;
    state.effective = eff;
    if (isRealSample) state.lastSampleT = t;

    state.trail.push({ t, rx: x, ry: y, sx: state.x, sy: state.y });
    while (state.trail.length && state.trail[0].t < t - TRAIL_MS) state.trail.shift();
  }

  SM.capture.onSample((s) => {
    if (!active() || s.x === undefined) return;
    if (s.type !== "move" && s.type !== "down" && s.type !== "up") return;
    outside = false;
    step(s.x, s.y, s.t, true);
    scheduleLoop();
  });

  // --- Animation loop: keeps the steady cursor moving when the mouse stops --
  // A still mouse sends no events, but the filtered position still has to
  // glide to where the mouse stopped. So each frame without a new sample we
  // feed the last raw position again. The loop sleeps when there's nothing to do.
  let loopRunning = false;

  function scheduleLoop() {
    if (!loopRunning) {
      loopRunning = true;
      requestAnimationFrame(frame);
    }
  }

  function frame() {
    const now = performance.now();
    if (active() && state.rawX !== null && now - state.lastSampleT > 12) {
      step(state.rawX, state.rawY, now, false);
    }
    updateEngaged();
    render();
    const gap = state.x === null ? 0 : Math.hypot(state.x - state.rawX, state.y - state.rawY);
    const busy = active() && (state.engaged || gap > 0.3 || now - state.lastSampleT < 500);
    if (busy) requestAnimationFrame(frame);
    else loopRunning = false;
  }

  // --- Our cursor -----------------------------------------------------------
  let cursorEl = null;
  let outside = false;

  function updateEngaged() {
    if (!active()) {
      state.engaged = false;
    } else if (!state.engaged && targetStrength() >= ENGAGE_AT) {
      state.engaged = true;
    } else if (state.engaged && targetStrength() <= DISENGAGE_AT) {
      const gap = Math.hypot(state.x - state.rawX, state.y - state.rawY);
      if (gap < 1) state.engaged = false; // only swap back once they line up
    }
  }

  function buildCursor() {
    cursorEl = document.createElement("div");
    cursorEl.className = "sm-cursor";
    cursorEl.setAttribute("aria-hidden", "true");
    // A classic arrow pointer; the tip is at the element's top-left corner.
    cursorEl.innerHTML =
      '<svg width="22" height="28" viewBox="0 0 22 28" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M1.5 1.5 L1.5 22 L7 16.8 L10.8 25.5 L14.3 24 L10.6 15.5 L18 15.5 Z" ' +
      'fill="#102A43" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(cursorEl);
  }

  function render() {
    const show = state.engaged && !outside && state.x !== null;
    // (While the shaky-hand simulator runs, the real cursor stays hidden: it draws its own.)
    document.documentElement.classList.toggle("sm-hide-cursor", show || !!(SM.simulator && SM.simulator.on));
    if (!show) {
      if (cursorEl) cursorEl.hidden = true;
      return;
    }
    if (!cursorEl) buildCursor();
    cursorEl.hidden = false;
    cursorEl.style.transform = `translate(${state.x - 1.5}px, ${state.y - 1.5}px)`;
  }

  window.addEventListener("mouseout", (e) => {
    if (!e.relatedTarget) {
      outside = true; // pointer left the window
      render();
    }
  }, true);

  // --- Clicks land where the steady cursor is ---------------------------------
  const CLICKABLE = 'a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"], [onclick], [tabindex]';
  const activationTarget = (el) => (el && el.closest ? el.closest(CLICKABLE) || el : el);
  const FOCUSABLE = "input, textarea, select, button, a[href], [tabindex], [contenteditable='true']";

  let press = null; // where the steady cursor was when the button went down

  window.addEventListener("pointerdown", (e) => {
    if (!e.isTrusted || !active()) return;
    press = { x: state.x, y: state.y, engaged: state.engaged, t: performance.now() };
  }, true);

  window.addEventListener("click", (e) => {
    const p = press;
    press = null;
    if (!e.isTrusted || !active() || !SM.settings.redirectClicks) return;
    if (!p || !p.engaged || e.detail === 0 || performance.now() - p.t > 2000) return; // keyboard clicks, stale presses
    const steadyTarget = document.elementFromPoint(p.x, p.y);
    if (!steadyTarget) return;
    if (activationTarget(steadyTarget) === activationTarget(e.target)) return; // same thing either way

    // Cancel the real click and click what the steady cursor is on instead
    // (through risky.js, which asks first if that's a risky button).
    e.preventDefault();
    e.stopImmediatePropagation();
    if (SM.risky) {
      SM.risky.guardedClick(steadyTarget, p.x, p.y);
    } else {
      if (steadyTarget.matches && steadyTarget.matches(FOCUSABLE)) steadyTarget.focus();
      steadyTarget.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, button: 0, detail: 1 }));
    }
    state.clicksRedirected++;
  }, true);
})();
