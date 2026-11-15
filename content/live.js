// live.js — real-time inference: every 50 ms, classify the last 400 ms of movement.
//
//   capture.js buffer → features.js (window → 6 numbers) → model.js (→ probabilities)
//
// The latest result is kept in SmoothMouse.live so later stages (the
// stabilizer's controller, click protection, ...) can read it. A small debug
// badge shows it on the demo page (or on every page if the popup says so).

(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const SM = window.SmoothMouse;

  const live = (SM.live = {
    ready: false,
    label: "stable",
    probs: { stable: 1, uncertain: 0, unstable: 0 },    // smoothed (what everything uses)
    rawProbs: { stable: 1, uncertain: 0, unstable: 0 }, // this window only
    features: null,
    updatedAt: 0,
    model: null,
    listeners: new Set(),
    /** Subscribe to every new prediction. Returns an unsubscribe function. */
    onUpdate(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },
  });

  // Each new window gets this much weight; the rest comes from earlier windows.
  // 0.4 means one odd 50 ms window can't flip the label on its own, while a
  // real, sustained shake still takes over within ~100-150 ms.
  const SMOOTHING = 0.4;

  /**
   * The personal model from calibration (saved in storage.local) if there is
   * one and the popup switch allows it; otherwise the bundled default model.
   */
  async function loadModel() {
    const { personalModel, usePersonalModel } = await api.storage.local.get({
      personalModel: null,
      usePersonalModel: true,
    });
    const compatible =
      personalModel &&
      personalModel.format === "smooth-mouse-logreg-v1" &&
      personalModel.featureNames.join() === SM.features.FEATURE_NAMES.join();
    if (usePersonalModel && compatible) return personalModel;
    const res = await fetch(api.runtime.getURL("shared/model.json"));
    return res.json();
  }

  // Swap models live when calibration finishes or the popup switch changes.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(changes.personalModel || changes.usePersonalModel)) return;
    loadModel()
      .then((model) => { live.model = model; })
      .catch((err) => console.warn("[Smooth Mouse] could not reload model:", err));
  });

  function tick() {
    if (!SM.enabled || document.hidden) {
      hideBadge();
      return;
    }
    // The model carries the window settings it was trained with, so a model
    // and its config can never get out of sync.
    const cfg = live.model.config;
    const now = performance.now();
    const samples = SM.capture
      .getPointerHistory((cfg.windowMs + cfg.marginMs) / 1000)
      .filter((s) => s.type === "move");

    const features = SM.features.windowFeatures(
      samples.map((s) => s.t),
      samples.map((s) => s.x),
      samples.map((s) => s.y),
      now,
      cfg
    );
    const raw = SM.model.predict(live.model, features).probs;

    const probs = {};
    let label = "stable";
    for (const c of live.model.classes) {
      probs[c] = SMOOTHING * raw[c] + (1 - SMOOTHING) * (live.probs[c] ?? 0);
      if (probs[c] > (probs[label] ?? -1)) label = c;
    }
    Object.assign(live, { label, probs, rawProbs: raw, features, updatedAt: now });

    for (const fn of live.listeners) {
      try { fn(live); } catch (err) { console.error("[Smooth Mouse]", err); }
    }
    renderBadge();
  }

  // --- Debug badge ------------------------------------------------------------
  const ORDER = ["stable", "uncertain", "unstable"];
  let badge = null;
  let rows = null;

  const isDemoPage = () => !!document.querySelector('meta[name="smooth-mouse-demo"]');
  const badgeWanted = () => isDemoPage() || (SM.settings && SM.settings.showBadgeEverywhere);

  function buildBadge() {
    badge = document.createElement("div");
    badge.className = "sm-badge";
    badge.setAttribute("aria-hidden", "true"); // visual debug aid; updates 20x/sec
    badge.innerHTML = `
      <div class="sm-badge-title">Smooth Mouse · <span class="sm-badge-label"></span></div>
      ${ORDER.map(
        (c) => `<div class="sm-badge-row" data-class="${c}">
          <span class="sm-badge-name">${c}</span>
          <span class="sm-badge-bar"><span class="sm-badge-fill"></span></span>
          <span class="sm-badge-pct"></span>
        </div>`
      ).join("")}
      <div class="sm-badge-strength"></div>
      <div class="sm-badge-note">Engineering label, not a diagnosis</div>`;
    document.documentElement.appendChild(badge);
    rows = Object.fromEntries(
      ORDER.map((c) => {
        const row = badge.querySelector(`[data-class="${c}"]`);
        return [c, { fill: row.querySelector(".sm-badge-fill"), pct: row.querySelector(".sm-badge-pct") }];
      })
    );
  }

  function renderBadge() {
    if (!badgeWanted()) return hideBadge();
    if (!badge) buildBadge();
    badge.hidden = false;
    badge.dataset.label = live.label;
    badge.querySelector(".sm-badge-label").textContent = live.label;
    for (const c of ORDER) {
      const pct = Math.round((live.probs[c] || 0) * 100);
      rows[c].fill.style.width = pct + "%";
      rows[c].pct.textContent = pct + "%";
    }
    const st = SM.stabilize;
    badge.querySelector(".sm-badge-strength").textContent =
      st && SM.settings && SM.settings.stabilize
        ? `Smoothing: ${Math.round(Math.max(st.strength, (SM.settings.minSmoothing || 0) / 100) * 100)}% (${st.level}` +
          `${SM.settings.minSmoothing ? `, min ${SM.settings.minSmoothing}%` : ""})`
        : "Smoothing: off";
  }

  function hideBadge() {
    if (badge) badge.hidden = true;
  }

  // --- Start ------------------------------------------------------------------
  loadModel()
    .then((model) => {
      live.model = model;
      live.ready = true;
      setInterval(tick, model.config.stepMs);
    })
    .catch((err) => console.warn("[Smooth Mouse] could not load model:", err));
})();
