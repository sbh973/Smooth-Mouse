// main.js — wires the content-script modules together.
//
// Jobs right now (Checkpoint 1):
//   1. Read the popup settings (master switch, toggles) and keep them in sync.
//   2. Answer the popup's "give me live stats" messages.
//   3. Let the demo page switch the shaky-hand simulator and read the status.

(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const SM = window.SmoothMouse;

  // 1. Settings (popup toggles) ----------------------------------------------
  // Every feature gets an on/off switch in the popup, stored in storage.local.
  // Defaults live in shared/settings.js (also used by the popup).
  const DEFAULTS = window.SmoothMouseDefaults;
  SM.settings = { ...DEFAULTS };

  function applySettings(values) {
    Object.assign(SM.settings, values);
    SM.enabled = SM.settings.enabled;
    // Let modules react right away (e.g. bring the real cursor back).
    for (const fn of SM.settingsListeners || []) {
      try { fn(SM.settings); } catch (err) { console.error("[Smooth Mouse]", err); }
    }
  }

  api.storage.local.get(DEFAULTS).then(applySettings);

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const updates = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (changes[key]) updates[key] = changes[key].newValue;
    }
    applySettings(updates);
  });

  // 2. Popup messages ------------------------------------------------------
  // We answer with sendResponse (synchronously) because that style works in
  // both Firefox and Chrome.
  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "sm:getStats") {
      const live = SM.live || {};
      sendResponse({
        enabled: SM.enabled,
        ...SM.capture.getStats(),
        movement: live.ready ? live.label : null,
        clicksIgnored: SM.clickHold ? SM.clickHold.blocked : 0,
        keysFiltered: SM.keyguard ? SM.keyguard.filtered : 0,
        risky: SM.risky ? SM.risky.summary() : null,
        modelKind: live.model ? (live.model.trainedOn === "synthetic+personal" ? "personal" : "default") : null,
        unstablePct: live.ready ? Math.round(live.probs.unstable * 100) : null,
      });
    }
  });

  // 3. Demo page bridge -----------------------------------------------------
  // The demo page and this content script share the DOM but not JavaScript
  // variables, so they talk with window.postMessage.
  //
  // We only answer on pages that opt in with <meta name="smooth-mouse-demo">.
  // Even then we only hand back pointer data that happened on that same page
  // (which the page could have recorded itself), never keystrokes.
  const isDemoPage = () => !!document.querySelector('meta[name="smooth-mouse-demo"]');

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "smooth-mouse-page" || !isDemoPage()) return;

    const reply = (payload) =>
      // Send a JSON string: plain strings cross the page/extension boundary
      // cleanly in both Firefox and Chrome.
      window.postMessage({ source: "smooth-mouse-ext", json: JSON.stringify(payload) }, "*");

    if (data.type === "set-sim-strength") {
      const px = Math.max(2, Math.min(40, Number(data.px) || 12));
      api.storage.local.set({ simAmplitudePx: px });
      reply({ type: "sim-strength", px });
    } else if (data.type === "set-simulator") {
      api.storage.local.set({ simulateTremor: !!data.on });
      reply({ type: "simulator", on: !!data.on });
    } else if (data.type === "ping") {
      reply({ type: "pong", enabled: SM.enabled, simulator: !!SM.settings.simulateTremor, simAmplitudePx: SM.settings.simAmplitudePx });

    }
  });
})();
