// main.js — wires the content-script modules together.
//
// Jobs right now (Checkpoint 1):
//   1. Read the popup settings (master switch, toggles) and keep them in sync.
//   2. Answer the popup's "give me live stats" messages.
//   3. Let the demo page ask for an "Export recording" of raw pointer data.

(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const SM = window.SmoothMouse;

  // 1. Settings (popup toggles) ----------------------------------------------
  // Every feature gets an on/off switch in the popup, stored in storage.local.
  const DEFAULTS = {
    enabled: true,               // master switch
    showBadgeEverywhere: false,  // debug badge on all sites (always on the demo page)
  };
  SM.settings = { ...DEFAULTS };

  function applySettings(values) {
    Object.assign(SM.settings, values);
    SM.enabled = SM.settings.enabled;
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

    if (data.type === "ping") {
      reply({ type: "pong", enabled: SM.enabled });
    } else if (data.type === "export-request") {
      const seconds = Math.max(1, Math.min(Number(data.seconds) || 10, 60));
      const samples = SM.capture.getPointerHistory(seconds);
      const t0 = samples.length ? samples[0].t : 0;
      reply({
        type: "export-response",
        recording: {
          app: "Smooth Mouse",
          format: "raw-pointer-v1",
          exportedAt: new Date().toISOString(),
          seconds,
          page: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
          // Diagnostics: helps explain an empty export.
          debug: {
            enabled: SM.enabled,
            pointerSamplesSinceLoad: SM.capture.getStats().pointerSamples,
            historySize: SM.capture.getStats().historySize,
          },
          // Columns: t = ms since first sample, x/y = CSS pixels (viewport),
          // type = move | down | up, buttons = pressed-buttons bitmask.
          sampleCount: samples.length,
          samples: samples.map((s) => ({
            t: +(s.t - t0).toFixed(3),
            x: s.x,
            y: s.y,
            type: s.type,
            buttons: s.buttons,
            pointerType: s.pointerType,
          })),
        },
      });
    }
  });
})();
