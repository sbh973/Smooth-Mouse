// assist.js — the button magnet (target assistance).
//
// When the cursor is NEAR (but not on) a button or link, the nearest one
// gets a teal outline, and a click there goes to it. Small targets become
// much easier to hit.
//
// Accuracy rules (so random things don't light up):
//   - only real targets count: links, buttons, checkboxes/radios, selects and
//     ARIA buttons/links/tabs. Not big boxes with tabindex/onclick, not labels,
//     not text fields.
//   - if the cursor is already on anything interactive (including a text
//     field), the magnet stays out of the way.
//   - skipped: huge elements (cards, banners), invisible ones, and ones
//     covered by something else at that spot.
//   - links that wrap onto several lines are measured line by line, and only
//     the nearest line is outlined.
//   - if two targets are about equally close, we don't guess: no magnet.
// The pull distance comes from calibration (capped at 36 px). While our own
// "Did you mean to…?" dialog is open, only its two buttons count (80 px).

(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const SM = window.SmoothMouse;

  const DEFAULT_RADIUS = 20;
  const MAX_RADIUS = 36;
  const DIALOG_RADIUS = 80;
  const MAX_W = 500, MAX_H = 120; // bigger than this = a card or banner, not a button

  const TARGETS =
    'a[href], button, input[type="submit"], input[type="button"], input[type="reset"], input[type="image"], ' +
    'input[type="checkbox"], input[type="radio"], select, summary, [role="button"], [role="link"], ' +
    '[role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="switch"]';
  // On any of these, the user is already where they want to be.
  const INTERACTIVE = TARGETS + ', input, textarea, label, [contenteditable=""], [contenteditable="true"], [tabindex]:not([tabindex="-1"]), [onclick]';
  const OURS = ".sm-badge, .sm-cursor, .sm-toast, .sm-hold-ring, .sm-magnet, .sm-viz-canvas, .sm-dialog";

  let radius = DEFAULT_RADIUS;
  const readProfile = (profile) => {
    radius = Math.min(MAX_RADIUS, (profile && profile.magnetRadiusPx) || DEFAULT_RADIUS);
  };
  api.storage.local.get({ profile: null }).then(({ profile }) => readProfile(profile));
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.profile) readProfile(changes.profile.newValue);
  });

  const dialogEl = () => document.querySelector(".sm-dialog");
  // The magnet always helps answer our own dialog, even when switched off for pages.
  const active = () => SM.enabled && SM.settings && (SM.settings.magnet || !!dialogEl());
  SM.assist = { assists: 0, target: null };

  // --- Where is the cursor? -------------------------------------------------------
  let rawX = null, rawY = null;
  window.addEventListener("mousemove", (e) => { rawX = e.clientX; rawY = e.clientY; }, { capture: true, passive: true });
  function cursor() {
    const st = SM.stabilize;
    if (st && st.engaged && st.x !== null) return { x: st.x, y: st.y };
    return rawX === null ? null : { x: rawX, y: rawY };
  }

  const onInteractive = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el || !el.closest) return false;
    if (dialogEl()) return !!el.closest(".sm-dialog button"); // in the dialog, only its buttons count
    return !!el.closest(INTERACTIVE);
  };

  // --- Candidate targets (refreshed 4x a second, or when the dialog opens/closes) --
  let candidates = [], candidatesAt = 0, candidatesForDialog = false;
  function usable(el) {
    if (el.disabled || el.getAttribute("aria-hidden") === "true" || el.closest(OURS)) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.pointerEvents !== "none" && Number(st.opacity) > 0.1;
  }
  function refreshCandidates() {
    candidates = [];
    const dialog = dialogEl();
    candidatesForDialog = !!dialog;
    const pool = dialog ? dialog.querySelectorAll("button") : document.querySelectorAll(TARGETS);
    for (const el of pool) {
      const box = el.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) continue;
      if (box.bottom < -50 || box.top > innerHeight + 50 || box.right < -50 || box.left > innerWidth + 50) continue;
      if (!dialog && (box.width > MAX_W || box.height > MAX_H)) continue;
      if (!dialog && !usable(el)) continue;
      // Each line of a wrapped link is its own rectangle.
      const rects = [...el.getClientRects()].filter((r) => r.width >= 2 && r.height >= 2);
      candidates.push({ el, box, rects: rects.length ? rects : [box] });
    }
    candidatesAt = performance.now();
  }

  // Distance from a point to a rectangle (0 if inside) and the closest point in it.
  function nearest(x, y, r) {
    const cx = Math.min(Math.max(x, r.left + 1), r.right - 1);
    const cy = Math.min(Math.max(y, r.top + 1), r.bottom - 1);
    return { d: Math.hypot(x - cx, y - cy), cx, cy };
  }

  /** True if `el` is really the thing on top at (x, y): not covered by something else. */
  function onTop(el, x, y) {
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit));
  }

  function findTarget() {
    const c = cursor();
    if (!active() || !c) return null;
    if (onInteractive(c.x, c.y)) return null; // already on something: no help needed
    const forDialog = !!dialogEl();
    if (forDialog !== candidatesForDialog || performance.now() - candidatesAt > 250) refreshCandidates();
    const reach = forDialog ? DIALOG_RADIUS : radius;

    // Distance to every candidate within reach (nearest line for wrapped links).
    const near = [];
    for (const cand of candidates) {
      const b = cand.box;
      if (c.x < b.left - reach || c.x > b.right + reach || c.y < b.top - reach || c.y > b.bottom + reach) continue;
      let best = null;
      for (const r of cand.rects) {
        const n = nearest(c.x, c.y, r);
        if (!best || n.d < best.d) best = { ...n, rect: r };
      }
      if (best.d <= reach) near.push({ ...cand, ...best });
    }
    if (!near.length) return null;
    near.sort((a, b) => a.d - b.d);

    // Skip targets that are covered by something else at that spot.
    const visible = near.filter((n) => onTop(n.el, n.cx, n.cy));
    if (!visible.length) return null;
    const [first, second] = visible;
    // Two targets about equally close (e.g. halfway between two links): don't guess.
    if (!forDialog && second && second.el !== first.el && second.d < first.d * 1.5 + 4) return null;
    return first;
  }

  // --- Highlight (the nearest line of the target) ----------------------------------------
  let ring = null;
  function highlight(t) {
    if (!t) {
      if (ring) ring.hidden = true;
      return;
    }
    if (!ring) {
      ring = document.createElement("div");
      ring.className = "sm-magnet";
      ring.setAttribute("aria-hidden", "true");
      document.documentElement.appendChild(ring);
    }
    const r = t.rect;
    Object.assign(ring.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
    ring.hidden = false;
  }

  let pending = false;
  function update() {
    pending = false;
    const t = findTarget();
    SM.assist.target = t ? t.el : null;
    highlight(t);
  }
  const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(update); } };
  window.addEventListener("mousemove", schedule, { capture: true, passive: true });
  window.addEventListener("scroll", () => { candidatesAt = 0; schedule(); }, { capture: true, passive: true });
  (SM.settingsListeners = SM.settingsListeners || []).push(schedule);

  // --- Click: send it to the magnet target ------------------------------------------------
  // Registered after clickhold.js (so ignored clicks never get here) and before
  // stabilize.js (so the magnet wins over plain click redirection).
  window.addEventListener("click", (e) => {
    if (!e.isTrusted || !active() || e.detail === 0 || e.button !== 0) return;
    const t = findTarget();
    if (!t) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (SM.risky) {
      SM.risky.guardedClick(t.el, t.cx, t.cy); // asks first if it's a risky button
    } else {
      if (t.el.matches("input, textarea, select, button, a[href], [tabindex]")) t.el.focus();
      t.el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, clientX: t.cx, clientY: t.cy, button: 0, detail: 1 }));
    }
    SM.assist.assists++;
  }, true);
})();
