// controller.js — turns the ML model's probabilities into a smoothing strength.
//
//   P(stable), P(uncertain), P(unstable)  →  level (light / medium / strong)
//                                         →  strength 0..1 (slewed, no jumps)
//                                         →  One Euro filter parameters
//
// Three safeguards so the user always stays in control:
//   1. Hysteresis: going UP a level happens as soon as the model is fairly
//      sure (≥ 55%). Going DOWN needs the evidence to drop clearly (< 35%)
//      and stay there for 400 ms. So strength doesn't flicker on and off.
//   2. Slew limits: strength rises fast (~150 ms to full) when a shake starts,
//      and falls gently (~600 ms) when it stops, so the cursor never "jumps".
//   3. Responsiveness override: fast movement in ONE direction (a deliberate
//      reach) turns smoothing down immediately, whatever the model says.
//      A tremor goes back and forth, so its net displacement stays small.

(() => {
  const SM = (window.SmoothMouse = window.SmoothMouse || {});

  const LEVEL_STRENGTH = { light: 0, medium: 0.5, strong: 1 };
  const RANK = { light: 0, medium: 1, strong: 2 };

  const ENTER = 0.55;        // probability needed to go up a level
  const EXIT = 0.35;         // probability must fall below this to go down...
  const HOLD_MS = 400;       // ...and stay below it this long
  const ATTACK_PER_S = 1 / 0.15;  // strength units per second going up
  const RELEASE_PER_S = 1 / 0.6;  // ...and going down

  // Directed speed (net displacement over ~80 ms) at which we start / finish
  // handing control back to the raw cursor.
  const OVERRIDE_FROM = 350; // px/s
  const OVERRIDE_TO = 1000;  // px/s

  const lerp = (a, b, s) => a + (b - a) * s;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  class Controller {
    constructor() {
      this.level = "light";
      this.strength = 0; // 0 = no smoothing, 1 = strongest
      this.belowSince = null;
      this.lastT = null;
    }

    /** Call on every model update (every 50 ms). `probs` = smoothed class probabilities. */
    update(probs, now) {
      const strongScore = probs.unstable || 0;
      const mediumScore = (probs.unstable || 0) + (probs.uncertain || 0);

      // Which level does the evidence support, given where we are now?
      let target;
      if (strongScore >= ENTER || (this.level === "strong" && strongScore >= EXIT)) target = "strong";
      else if (mediumScore >= ENTER || (this.level !== "light" && mediumScore >= EXIT)) target = "medium";
      else target = "light";

      if (RANK[target] > RANK[this.level]) {
        this.level = target; // escalate right away
        this.belowSince = null;
      } else if (RANK[target] < RANK[this.level]) {
        if (this.belowSince === null) this.belowSince = now;
        if (now - this.belowSince >= HOLD_MS) {
          this.level = target; // de-escalate only after HOLD_MS of calm
          this.belowSince = null;
        }
      } else {
        this.belowSince = null;
      }

      // Move strength toward the level's value at a limited speed.
      const dt = this.lastT === null ? 0.05 : Math.min((now - this.lastT) / 1000, 0.2);
      this.lastT = now;
      const goal = LEVEL_STRENGTH[this.level];
      if (this.strength < goal) this.strength = Math.min(goal, this.strength + ATTACK_PER_S * dt);
      else this.strength = Math.max(goal, this.strength - RELEASE_PER_S * dt);
      return this.strength;
    }

    /** 0..1: how much to hand control back to the raw cursor for a deliberate move. */
    static override(directedSpeed) {
      return clamp01((directedSpeed - OVERRIDE_FROM) / (OVERRIDE_TO - OVERRIDE_FROM));
    }

    /**
     * One Euro parameters for an effective strength s (0..1).
     *   s = 0   → minCutoff 6 Hz,   beta 0.01   (barely any smoothing)
     *   s = 1   → minCutoff 0.6 Hz, beta 0.0008 (a 5 Hz tremor is cut by ~85%)
     * A low beta matters for tremor: a shake is FAST back-and-forth movement,
     * and a high beta would let it through just because it's fast.
     */
    static filterParams(s) {
      return {
        minCutoff: lerp(6.0, 0.6, s),
        beta: lerp(0.01, 0.0008, s),
        dCutoff: 1.0,
      };
    }
  }

  SM.Controller = Controller;
})();
