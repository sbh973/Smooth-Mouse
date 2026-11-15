// keyguard.js — ignore accidental repeated key presses ("hhello" → "hello").
//
// A shaky finger can hit the same key twice in a fraction of a second. If the
// same character key is pressed again within the repeat window (chosen by
// calibration from the user's typing speed), the second press is cancelled
// before the page sees it.
//
// Never touched:
//   - keys held down on purpose (the browser marks those auto-repeats e.repeat)
//   - modifier and control keys (Shift, Ctrl, arrows, Backspace, Enter…):
//     only single printable characters are checked
//   - typing in an input method (IME composition, e.g. Chinese or Japanese)

(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const SM = window.SmoothMouse;
  const DEFAULT_WINDOW_MS = 80;

  let windowMs = DEFAULT_WINDOW_MS;
  const readProfile = (profile) => {
    windowMs = profile && profile.keyRepeatWindowMs ? profile.keyRepeatWindowMs : DEFAULT_WINDOW_MS;
  };
  api.storage.local.get({ profile: null }).then(({ profile }) => readProfile(profile));
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.profile) readProfile(changes.profile.newValue);
  });

  let last = { key: null, t: -Infinity };
  SM.keyguard = { filtered: 0 };
  let lastToast = 0;

  window.addEventListener("keydown", (e) => {
    if (!e.isTrusted || e.isComposing) return;
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!printable) {
      last = { key: null, t: -Infinity }; // a different kind of key breaks the run
      return;
    }
    const now = performance.now();
    const isRepeat = !e.repeat && e.key.toLowerCase() === last.key && now - last.t < windowMs;
    if (!e.repeat) last = { key: e.key.toLowerCase(), t: now };
    if (!isRepeat || !SM.enabled || !SM.settings || !SM.settings.filterRepeatedKeys) return;

    e.preventDefault();          // the character is not typed
    e.stopImmediatePropagation(); // and the page never hears the key
    SM.keyguard.filtered++;
    if (SM.toast && now - lastToast > 3000) {
      lastToast = now;
      SM.toast(`Smooth Mouse ignored an accidental double "${e.key}".`);
    }
  }, true);
})();
