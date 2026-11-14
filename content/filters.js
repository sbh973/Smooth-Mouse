// filters.js — the One Euro filter (Casiez, Roussel & Vogel, CHI 2012).
//
// A low-pass filter whose cutoff frequency changes with speed:
//   cutoff = minCutoff + beta * speed
// Slow movement → low cutoff → lots of smoothing (kills jitter).
// Fast movement → high cutoff → little smoothing (no lag when you mean to move).
//
// We filter x and y together and use the 2D speed, so the cursor behaves the
// same in every direction. The controller (controller.js) changes minCutoff
// and beta on the fly depending on what the ML model says.

(() => {
  const SM = (window.SmoothMouse = window.SmoothMouse || {});

  /** Smoothing factor for a first-order low-pass filter at `cutoffHz` with step `dt` seconds. */
  function alpha(cutoffHz, dt) {
    const tau = 1 / (2 * Math.PI * cutoffHz);
    return 1 / (1 + tau / dt);
  }

  class OneEuroFilter2D {
    constructor({ minCutoff = 1.0, beta = 0.01, dCutoff = 1.0 } = {}) {
      this.setParams({ minCutoff, beta, dCutoff });
      this.reset();
    }

    setParams({ minCutoff, beta, dCutoff }) {
      if (minCutoff !== undefined) this.minCutoff = minCutoff;
      if (beta !== undefined) this.beta = beta;
      if (dCutoff !== undefined) this.dCutoff = dCutoff;
    }

    reset() {
      this.x = null; // filtered position
      this.y = null;
      this.dx = 0;   // filtered velocity (px/s)
      this.dy = 0;
      this.rawX = null;
      this.rawY = null;
      this.t = null; // ms
    }

    /** Feed one raw sample (t in ms). Returns the filtered {x, y}. */
    filter(rawX, rawY, t) {
      if (this.t === null) {
        this.x = this.rawX = rawX;
        this.y = this.rawY = rawY;
        this.t = t;
        return { x: rawX, y: rawY };
      }
      let dt = (t - this.t) / 1000;
      if (dt <= 0) dt = 0.001; // duplicate timestamp: treat as 1 ms apart

      // 1. Smoothed velocity of the RAW signal (decides how much to trust it).
      const aD = alpha(this.dCutoff, dt);
      this.dx = aD * ((rawX - this.rawX) / dt) + (1 - aD) * this.dx;
      this.dy = aD * ((rawY - this.rawY) / dt) + (1 - aD) * this.dy;
      const speed = Math.sqrt(this.dx * this.dx + this.dy * this.dy);

      // 2. Speed-dependent cutoff, then low-pass the position.
      const cutoff = this.minCutoff + this.beta * speed;
      const a = alpha(cutoff, dt);
      this.x = a * rawX + (1 - a) * this.x;
      this.y = a * rawY + (1 - a) * this.y;

      this.rawX = rawX;
      this.rawY = rawY;
      this.t = t;
      return { x: this.x, y: this.y };
    }
  }

  SM.filters = { OneEuroFilter2D, alpha };
})();
