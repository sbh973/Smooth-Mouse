// clickhold.js — ignore accidental clicks with a HOLD PERIOD, per mouse button.
//
// A press only counts as a click if the button was held for at least the hold
// period (chosen by calibration, see calibrate.js → chooseClickHold). Quick
// accidental taps from a shaky hand are ignored. Left, middle and right each
// have their own on/off switch in the popup.
//
// How it works: we let the press itself through untouched and decide when the
// browser announces the finished click (click / auxclick / contextmenu, all
// fired AFTER the button is released). If the press was too short, we cancel
// that event before the page sees it. Real clicks stay real ("trusted")
// events, so they work on every site.
//
// While a protected button is held, a small ring around the cursor fills up;
// when it's full, letting go will count as a click.
//
// Also here: "ignore sliding clicks". If the cursor slid further than the
// calibrated distance between pressing and releasing, the click is ignored
// (a shaky slip, not an aimed click). We measure on the STEADY cursor when
// smoothing is active, so the raw shaking itself doesn't count as sliding.

(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const SM = window.SmoothMouse;

  const NAMES = { 0: "left", 1: "middle", 2: "right" };
  const SETTING = { left: "ignoreLeft", middle: "ignoreMiddle", right: "ignoreRight" };
  const DEFAULT_HOLD_MS = 150;

  const DEFAULT_SLIDE_PX = 20;

  let calibratedHold = null; // { left, middle, right } ms from the last calibration
  let slideLimitPx = DEFAULT_SLIDE_PX;
  const readProfile = (p) => {
    calibratedHold = p && p.clickHold ? p.clickHold : null;
    slideLimitPx = p && p.shakyPressDriftPx ? p.shakyPressDriftPx : DEFAULT_SLIDE_PX;
  };
  api.storage.local.get({ profile: null }).then(({ profile }) => readProfile(profile));
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.profile) readProfile(changes.profile.newValue);
  });

  /** Cursor position to measure sliding on: the steady cursor if it's shown. */
  const cursorPos = (e) => {
    const st = SM.stabilize;
    return st && st.engaged && st.x !== null ? { x: st.x, y: st.y } : { x: e.clientX, y: e.clientY };
  };

  /** Hold period for a button: the popup override if set, else calibration, else the default. */
  function holdMs(name) {
    const override = SM.settings && SM.settings.holdOverrideMs;
    if (typeof override === "number") return override;
    return (calibratedHold && calibratedHold[name]) || DEFAULT_HOLD_MS;
  }
  const protectedButton = (name) => SM.enabled && SM.settings && SM.settings[SETTING[name]];
  const slideProtection = () => SM.enabled && SM.settings && SM.settings.shakyClicks;

  const presses = {};   // button number → { t, upT }
  let lastBlockedAt = 0;
  SM.clickHold = {
    blocked: 0,
    holdMs,
    /** For the simulator's fake accidental taps: ignore it if quick-click protection is on. */
    ignoreSimulatedTap(name = "left") {
      if (!protectedButton(name)) return false;
      SM.clickHold.blocked++;
      lastBlockedAt = performance.now();
      toast(`Smooth Mouse ignored a quick accidental ${name} click.`);
      if (document.querySelector('meta[name="smooth-mouse-demo"]')) document.dispatchEvent(new CustomEvent("smoothmouse:ignored"));
      return true;
    },
  };

  // --- Track every press (mousedown fires for every button) -----------------
  window.addEventListener("mousedown", (e) => {
    if (!e.isTrusted) return;
    const name = NAMES[e.button];
    if (!name) return;
    presses[e.button] = { t: performance.now(), upT: null, down: cursorPos(e), up: null };
    if (protectedButton(name)) startRing(e.clientX, e.clientY, holdMs(name));
  }, true);

  window.addEventListener("mouseup", (e) => {
    if (!e.isTrusted || !presses[e.button]) return;
    presses[e.button].upT = performance.now();
    presses[e.button].up = cursorPos(e);
    stopRing();
  }, true);

  window.addEventListener("mousemove", (e) => moveRing(e.clientX, e.clientY), { capture: true, passive: true });

  // --- Decide when the browser reports the finished click ------------------
  function judge(e) {
    if (!e.isTrusted) return; // our own / the page's script clicks
    const name = NAMES[e.button];
    if (!name || !(protectedButton(name) || slideProtection())) return;
    if (e.type === "click" && e.detail === 0) return; // Enter/Space on a button, not the mouse
    const press = presses[e.button];
    if (!press) return;

    if (e.type === "contextmenu" && press.upT === null) {
      // On macOS/Linux the browser opens the right-click menu as soon as the
      // button goes DOWN, before we can know how long it will be held. We let
      // it through (see README: Firefox's ui.context_menus.after_mouseup).
      return;
    }
    // 1. Too quick? (hold period)
    const held = (press.upT ?? performance.now()) - press.t;
    if (protectedButton(name) && held < holdMs(name)) {
      return block(e, `Smooth Mouse ignored a quick ${name} click. Hold for ${(holdMs(name) / 1000).toFixed(2)} s to click.`);
    }
    // 2. Slid too far while pressed?
    if (slideProtection() && press.up) {
      const slid = Math.hypot(press.up.x - press.down.x, press.up.y - press.down.y);
      if (slid > slideLimitPx) {
        return block(e, `Smooth Mouse ignored a click where the cursor slid ${Math.round(slid)} px.`);
      }
    }
  }

  function block(e, message) {
    e.preventDefault();
    e.stopImmediatePropagation();
    lastBlockedAt = performance.now();
    SM.clickHold.blocked++;
    toast(message);
    // On the demo page only: tell the page, so its status line can say so.
    if (document.querySelector('meta[name="smooth-mouse-demo"]')) {
      document.dispatchEvent(new CustomEvent("smoothmouse:ignored"));
    }
  }

  // Registered BEFORE stabilize.js's click listener (see manifest order), so a
  // blocked click never gets redirected.
  window.addEventListener("click", judge, true);
  window.addEventListener("auxclick", judge, true);     // middle and right buttons
  window.addEventListener("contextmenu", judge, true);  // right button (menu)
  window.addEventListener("dblclick", (e) => {
    // A double-click made of a blocked click is blocked too.
    if (e.isTrusted && performance.now() - lastBlockedAt < 600 && (protectedButton("left") || slideProtection())) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // --- Hold ring --------------------------------------------------------------
  let ring = null, ringTimer = null;
  const RING_C = 2 * Math.PI * 15; // circumference of the r=15 circle

  function startRing(x, y, ms) {
    if (!ring) {
      ring = document.createElement("div");
      ring.className = "sm-hold-ring";
      ring.setAttribute("aria-hidden", "true");
      ring.innerHTML =
        '<svg width="40" height="40" viewBox="0 0 40 40"><circle class="sm-hold-track" cx="20" cy="20" r="15"/>' +
        `<circle class="sm-hold-fill" cx="20" cy="20" r="15" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"/></svg>`;
      document.documentElement.appendChild(ring);
    }
    const fill = ring.querySelector(".sm-hold-fill");
    ring.classList.remove("sm-done");
    fill.style.transition = "none";
    fill.style.strokeDashoffset = String(RING_C);
    ring.hidden = false;
    moveRing(x, y);
    // Next frame: animate the ring filling up over the hold period.
    requestAnimationFrame(() => {
      fill.style.transition = `stroke-dashoffset ${ms}ms linear`;
      fill.style.strokeDashoffset = "0";
    });
    clearTimeout(ringTimer);
    ringTimer = setTimeout(() => ring && ring.classList.add("sm-done"), ms);
  }

  function moveRing(x, y) {
    if (!ring || ring.hidden) return;
    // Follow the steady cursor if stabilization is drawing it, else the real one.
    const st = SM.stabilize;
    const px = st && st.engaged && st.x !== null ? st.x : x;
    const py = st && st.engaged && st.y !== null ? st.y : y;
    ring.style.transform = `translate(${px - 20}px, ${py - 20}px)`;
  }

  function stopRing() {
    clearTimeout(ringTimer);
    if (ring) ring.hidden = true;
  }

  // --- Toast ------------------------------------------------------------------
  let toastEl = null, toastTimer = null;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "sm-toast";
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 2200);
  }
  SM.toast = toast;
})();
