// settings.js — default values for every on/off switch in the popup.
// Loaded by both the content scripts (manifest.json) and the popup (popup.html),
// so the defaults are defined in exactly one place.
window.SmoothMouseDefaults = {
  enabled: true,              // master switch
  stabilize: true,            // adaptive cursor stabilization (Checkpoint 4)
  redirectClicks: true,       // clicks land where the steady cursor is
  minSmoothing: 0,            // 0-100 %: smoothing floor for EVERY movement (0 = adaptive only)
  ignoreLeft: false,          // ignore quick accidental LEFT clicks (hold period); calibration decides
  ignoreRight: false,         // ...RIGHT clicks
  ignoreMiddle: false,        // ...MIDDLE clicks
  holdOverrideMs: null,       // null = use the hold period chosen by calibration
  shakyClicks: false,         // ignore clicks where the cursor slid too far while pressed
  filterRepeatedKeys: false,  // ignore accidental double key presses ("hhello" → "hello")
  magnet: false,              // nearby buttons light up and catch the click
  usePersonalModel: true,     // use the model trained during calibration (Checkpoint 5)
  showBadgeEverywhere: false, // debug badge on all sites (always on the demo page)
};
