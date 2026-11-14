// settings.js — default values for every on/off switch in the popup.
// Loaded by both the content scripts (manifest.json) and the popup (popup.html),
// so the defaults are defined in exactly one place.
window.SmoothMouseDefaults = {
  enabled: true,              // master switch
  stabilize: true,            // adaptive cursor stabilization (Checkpoint 4)
  redirectClicks: true,       // clicks land where the steady cursor is
  usePersonalModel: true,     // use the model trained during calibration (Checkpoint 5)
  showBadgeEverywhere: false, // debug badge on all sites (always on the demo page)
};
