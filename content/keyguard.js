// keyguard.js — ignore accidental repeated key presses ("hhello" → "hello").
//
// A shaky finger can hit the same key twice. We drop the second press when:
//   1. it came EXTREMELY fast (within the user's calibrated repeat window):
//      that's a bounce, nobody types a real double letter that fast; or
//   2. it came FAIRLY fast (within twice the user's normal time between keys)
//      AND the double doesn't make sense in a word:
//        - a doubled letter at the START of a word ("hhello", "ttoday")
//        - a letter English words almost never double (hh, jj, kk, qq, vv,
//          ww, xx, yy, ii, uu, aa)
//        - a double space
// Real double letters inside words ("hello", "book", "see", "coffee") are
// kept, even when typed quickly. (The word rules assume English.)
//
// Never touched: keys held down on purpose (auto-repeat), modifier and
// control keys (Shift, Ctrl, arrows, Backspace, Enter…), shortcuts (Cmd+C),
// digits and punctuation, and input-method typing (e.g. Chinese, Japanese).

(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const SM = window.SmoothMouse;

  const DEFAULT_FAST_MS = 80;    // rule 1 window if not calibrated
  const DEFAULT_SLOW_MS = 220;   // rule 2 window if not calibrated
  const RARELY_DOUBLED = new Set("hjkqvwxyiua");

  let fastMs = DEFAULT_FAST_MS, slowMs = DEFAULT_SLOW_MS;
  const readProfile = (profile) => {
    fastMs = (profile && profile.keyRepeatWindowMs) || DEFAULT_FAST_MS;
    const typingGap = profile && profile.measurements && profile.measurements.medianKeyGapMs;
    // Twice the user's normal gap between keys, kept between 120 and 300 ms.
    slowMs = typingGap ? Math.min(300, Math.max(120, 2 * typingGap)) : DEFAULT_SLOW_MS;
    slowMs = Math.max(slowMs, fastMs);
  };
  api.storage.local.get({ profile: null }).then(({ profile }) => readProfile(profile));
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.profile) readProfile(changes.profile.newValue);
  });

  // What was typed just before: the last key, when, and the key before it.
  let last = null;    // { key, t }
  let before = null;  // the character before `last` (null = start of a word/field)
  const reset = () => { last = null; before = null; };
  window.addEventListener("focusin", reset, true); // a new text field = a fresh start

  const isLetter = (k) => k >= "a" && k <= "z" && k.length === 1;

  SM.keyguard = { filtered: 0 };
  let lastToast = 0;

  window.addEventListener("keydown", (e) => {
    if (!e.isTrusted || e.isComposing) return;
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!printable) {
      reset(); // Backspace, Enter, arrows… start over
      return;
    }
    if (e.repeat) return; // held down on purpose
    const k = e.key.toLowerCase();
    const now = performance.now();

    let drop = false;
    if (last && k === last.key && (isLetter(k) || k === " ")) {
      const gap = now - last.t;
      const startOfWord = before === null || !isLetter(before);
      const oddDouble = k === " " || startOfWord || RARELY_DOUBLED.has(k);
      drop = gap < fastMs || (gap < slowMs && oddDouble);
    }

    if (drop && SM.enabled && SM.settings && SM.settings.filterRepeatedKeys) {
      e.preventDefault();           // the character is not typed
      e.stopImmediatePropagation(); // and the page never hears the key
      last.t = now;                 // a third quick press is caught too
      SM.keyguard.filtered++;
      if (SM.toast && now - lastToast > 3000) {
        lastToast = now;
        SM.toast(`Smooth Mouse ignored an accidental double "${e.key === " " ? "space" : e.key}".`);
      }
      return;
    }
    before = last ? last.key : null;
    last = { key: k, t: now };
  }, true);
})();
