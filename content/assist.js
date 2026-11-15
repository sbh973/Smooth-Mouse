// assist.js — the button magnet (target assistance).
//
// When the cursor is NOT on a clickable thing but is within the magnet radius
// of one (chosen by calibration: shakier hands and more misses → bigger
// radius), the nearest button/link lights up. Clicking then goes to that
// button, so small targets are much easier to hit.
//
// If the cursor is already on something clickable, the magnet stays out of
// the way. The cursor position used is the steady (stabilized) one when
// smoothing is active, otherwise the real one.

(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const SM = window.SmoothMouse;
  const DEFAULT_RADIUS = 20;

  const CLICKABLE =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, label[for], ' +
    '[role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [onclick], [tabindex]:not([tabindex="-1"])';

  let radius = DEFAULT_RADIUS;
  const readProfile = (profile) => {
    radius = profile && profile.magnetRadiusPx ? profile.magnetRadiusPx : DEFAULT_RADIUS;
  };
  api.storage.local.get({ profile: null }).then(({ profile }) => readProfile(profile));
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.profile) readProfile(changes.profile.newValue);
  });

  const dialogOpen = () => !!document.querySelector(".sm-dialog");
  // The magnet always helps answer our own dialog, even when switched off for pages.
  const active = () => SM.enabled && SM.settings && (SM.settings.magnet || dialogOpen());
  const DIALOG_RADIUS = 80; // px: anywhere near "Yes" / "No, go back" counts
  SM.assist = { assists: 0, target: null };

  // --- Where is the cursor? ---------------------------------------------------
  let rawX = null, rawY = null;
  window.addEventListener("mousemove", (e) => { rawX = e.clientX; rawY = e.clientY; }, { capture: true, passive: true });
  function cursor() {
    const st = SM.stabilize;
    if (st && st.engaged && st.x !== null) return { x: st.x, y: st.y };
    return rawX === null ? null : { x: rawX, y: rawY };
  }

  const isOurs = (el) => el.closest && el.closest(".sm-badge, .sm-cursor, .sm-toast, .sm-hold-ring, .sm-magnet, .sm-viz-canvas");
  const clickableAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el && el.closest ? el.closest(CLICKABLE) : null;
  };

  // --- Find the nearest clickable within the radius (4x a second is enough) ---
  let candidates = [], candidatesAt = 0;
  // While the "Did you mean to…?" dialog is open, ONLY its own buttons count:
  // the page behind the dark overlay can't be clicked anyway, and pulling the
  // click toward "Yes" / "No, go back" helps a shaky hand answer the dialog.
  let dialogWasOpen = false;
  function refreshCandidates() {
    candidates = [];
    const dialog = document.querySelector(".sm-dialog");
    dialogWasOpen = !!dialog;
    const pool = dialog ? dialog.querySelectorAll("button") : document.querySelectorAll(CLICKABLE);
    for (const el of pool) {
      if (el.disabled || (!dialog && isOurs(el))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
      candidates.push({ el, r });
    }
    candidatesAt = performance.now();
  }
  // Distance from a point to a rectangle's edge (0 if inside).
  const distance = (x, y, r) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));

  function findTarget() {
    const c = cursor();
    if (!active() || !c) return null;
    if (clickableAt(c.x, c.y)) return null; // already on something clickable: no help needed
    const open = dialogOpen();
    if (open !== dialogWasOpen || performance.now() - candidatesAt > 250) refreshCandidates();
    let best = null, bestD = dialogWasOpen ? Math.max(radius, DIALOG_RADIUS) : radius;
    for (const cand of candidates) {
      const d = distance(c.x, c.y, cand.r);
      if (d <= bestD) { best = cand; bestD = d; }
    }
    return best;
  }

  // --- Highlight -------------------------------------------------------------------
  let ring = null;
  function highlight(cand) {
    if (!cand) {
      if (ring) ring.hidden = true;
      return;
    }
    if (!ring) {
      ring = document.createElement("div");
      ring.className = "sm-magnet";
      ring.setAttribute("aria-hidden", "true");
      document.documentElement.appendChild(ring);
    }
    const r = cand.el.getBoundingClientRect();
    Object.assign(ring.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
    ring.hidden = false;
  }

  let pending = false;
  function update() {
    pending = false;
    const cand = findTarget();
    SM.assist.target = cand ? cand.el : null;
    highlight(cand);
  }
  const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(update); } };
  window.addEventListener("mousemove", schedule, { capture: true, passive: true });
  window.addEventListener("scroll", () => { candidatesAt = 0; schedule(); }, { capture: true, passive: true });
  (SM.settingsListeners = SM.settingsListeners || []).push(schedule);

  // --- Click: send it to the magnet target --------------------------------------------
  // Registered after clickhold.js (so ignored clicks never get here) and before
  // stabilize.js (so the magnet wins over plain click redirection).
  window.addEventListener("click", (e) => {
    if (!e.isTrusted || !active() || e.detail === 0 || e.button !== 0) return;
    const cand = findTarget();
    if (!cand) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const r = cand.el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (SM.risky) {
      SM.risky.guardedClick(cand.el, x, y); // asks first if it's a risky button
    } else {
      if (cand.el.matches("input, textarea, select, button, a[href], [tabindex]")) cand.el.focus();
      cand.el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, detail: 1 }));
    }
    SM.assist.assists++;
  }, true);
})();
