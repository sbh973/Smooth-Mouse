"""Synthetic mouse-movement windows for training the Smooth Mouse classifier.

We don't have a dataset of real tremor mouse movement, so we simulate one.
Each example is a short raw recording (t in ms, x, y in px) that looks like
what the browser actually gives us. We matched these details to a real
Firefox recording:
  * samples arrive every ~7-10 ms (about 125 Hz), timestamps are whole ms
  * positions come in 0.5 px steps (a devicePixelRatio = 2 screen)
  * the browser sends NO event when the position doesn't change

Labels (engineering labels, NOT medical diagnoses):
  stable     intentional movement: smooth reaches, small corrections, holds,
             slow drags (plus the tiny jitter every hand has)
  unstable   the same movements plus an involuntary oscillation of
             4-10 Hz and 2-20 px
  uncertain  borderline cases: very small oscillations (0.7-2 px), or fast
             intentional back-and-forth "scribbles" (1.5-3.5 Hz)

Run directly to print a quick summary: python ml/synth.py
"""

import numpy as np

from features import load_config

CLASSES = ["stable", "unstable", "uncertain"]

# Simulated span per example: the window plus some context before it.
SPAN_EXTRA_MS = 400


# ---------------------------------------------------------------------------
# Intentional ("base") movements: functions of time in seconds -> (x, y)
# ---------------------------------------------------------------------------

def min_jerk(s):
    """Minimum-jerk profile: the smooth S-curve that human reaches follow.

    s goes 0 -> 1 over the reach; output goes 0 -> 1 with zero velocity and
    zero acceleration at both ends.
    """
    s = np.clip(s, 0.0, 1.0)
    return 10 * s**3 - 15 * s**4 + 6 * s**5


def make_reach(rng, span_s, start=None):
    """One point-to-point reach (like moving to a button), slightly curved."""
    p0 = rng.uniform([100, 100], [1200, 700]) if start is None else start
    dist = np.exp(rng.uniform(np.log(15), np.log(900)))  # many short + some long
    angle = rng.uniform(0, 2 * np.pi)
    direction = np.array([np.cos(angle), np.sin(angle)])
    normal = np.array([-direction[1], direction[0]])
    duration = rng.uniform(0.18, 0.9) * (dist / 300) ** 0.25  # longer reaches take a bit longer
    onset = rng.uniform(-duration, span_s)  # window may catch any phase of the reach
    curve = rng.normal(0, 0.08) * dist

    def f(t):
        s = (t - onset) / duration
        progress = min_jerk(s)
        bow = curve * np.sin(np.pi * np.clip(s, 0, 1))
        pos = p0[None, :] + progress[:, None] * dist * direction + bow[:, None] * normal
        return pos[:, 0], pos[:, 1]

    return f, onset + duration


def make_reach_with_correction(rng, span_s):
    """A reach followed by a small corrective sub-movement (very common in real use)."""
    first, end_time = make_reach(rng, span_s)
    # A 3-15 px correction starting just after the main reach ends.
    scale = rng.uniform(3, 15)
    angle = rng.uniform(0, 2 * np.pi)
    c_dur = rng.uniform(0.12, 0.3)
    c_onset = end_time + rng.uniform(0.0, 0.15)

    def f(t):
        x, y = first(t)
        p = min_jerk((t - c_onset) / c_dur) * scale
        return x + p * np.cos(angle), y + p * np.sin(angle)

    return f


def make_hold(rng):
    """Resting on a target: still, or drifting very slowly."""
    p0 = rng.uniform([100, 100], [1200, 700])
    speed = rng.uniform(0, 25)  # px/s
    angle = rng.uniform(0, 2 * np.pi)

    def f(t):
        return p0[0] + speed * np.cos(angle) * t, p0[1] + speed * np.sin(angle) * t

    return f


def make_slow_drag(rng):
    """Slow, steady movement along a gentle curve (e.g. reading while moving)."""
    p0 = rng.uniform([100, 100], [1200, 700])
    speed = rng.uniform(40, 350)
    angle0 = rng.uniform(0, 2 * np.pi)
    turn = rng.normal(0, 1.0)  # rad/s

    def f(t):
        a = angle0 + turn * t
        return p0[0] + speed * t * np.cos(a), p0[1] + speed * t * np.sin(a)

    return f


def make_base(rng, span_s):
    kind = rng.choice(["reach", "correction", "hold", "slow"], p=[0.4, 0.2, 0.25, 0.15])
    if kind == "reach":
        return make_reach(rng, span_s)[0], kind
    if kind == "correction":
        return make_reach_with_correction(rng, span_s), kind
    if kind == "hold":
        return make_hold(rng), kind
    return make_slow_drag(rng), kind


def make_scribble(rng):
    """Fast intentional back-and-forth (scribbling, shaking to find the cursor)."""
    p0 = rng.uniform([100, 100], [1200, 700])
    freq = rng.uniform(1.5, 3.5)
    amp = rng.uniform(15, 80)
    angle = rng.uniform(0, 2 * np.pi)
    drift = rng.uniform(-150, 150, size=2)
    phase = rng.uniform(0, 2 * np.pi)

    def f(t):
        s = amp * np.sin(2 * np.pi * freq * t + phase)
        return p0[0] + drift[0] * t + s * np.cos(angle), p0[1] + drift[1] * t + s * np.sin(angle)

    return f


# ---------------------------------------------------------------------------
# Involuntary oscillation ("tremor-like" component)
# ---------------------------------------------------------------------------

def make_oscillation(rng, amp_range, freq_range):
    """Returns f(t) -> (dx, dy): an elliptical oscillation with slow amplitude wobble."""
    amp = rng.uniform(*amp_range)
    freq = rng.uniform(*freq_range)
    axis = rng.uniform(0, np.pi)
    minor = rng.uniform(0.0, 0.7)  # 0 = straight line back-and-forth, 1 = circle
    phase = rng.uniform(0, 2 * np.pi)
    wobble_f = rng.uniform(0.3, 1.5)
    wobble_phase = rng.uniform(0, 2 * np.pi)

    def f(t):
        a = amp * (1 + 0.25 * np.sin(2 * np.pi * wobble_f * t + wobble_phase))
        w = 2 * np.pi * freq * t + phase
        u, v = a * np.sin(w), minor * a * np.cos(w)
        return u * np.cos(axis) - v * np.sin(axis), u * np.sin(axis) + v * np.cos(axis)

    return f


# ---------------------------------------------------------------------------
# Browser-like sampling
# ---------------------------------------------------------------------------

def sample_like_browser(rng, f, span_ms, noise_px):
    """Evaluate a trajectory at realistic event times, like Firefox delivers them."""
    gaps = rng.choice([7, 8, 8, 8, 8, 9, 10, 10], size=int(span_ms / 6) + 10)
    t = np.cumsum(gaps) + rng.integers(0, 10)
    t = t[t <= span_ms].astype(float)
    # Occasionally two samples share a timestamp (seen in real recordings).
    dup = rng.random(len(t)) < 0.01
    t[1:][dup[1:]] = t[:-1][dup[1:]]

    x, y = f(t / 1000.0)
    x = x + rng.normal(0, noise_px, len(t))
    y = y + rng.normal(0, noise_px, len(t))
    x, y = np.round(x * 2) / 2, np.round(y * 2) / 2  # 0.5 px steps

    # The browser sends no pointermove when the position didn't change.
    moved = np.ones(len(t), dtype=bool)
    moved[1:] = (np.diff(x) != 0) | (np.diff(y) != 0)
    return t[moved], x[moved], y[moved]


def make_window(rng, label, cfg):
    """One labeled example: raw samples plus the time the window ends."""
    span_ms = cfg["windowMs"] + SPAN_EXTRA_MS
    span_s = span_ms / 1000.0
    # Sensor/hand jitter. IMPORTANT: the same range for every class. An earlier
    # version gave 'unstable' extra noise, and the model learned "noisy =
    # unstable" instead of "oscillating = unstable", so smooth real shakes were missed.
    noise = rng.uniform(0.05, 0.6)
    physio = make_oscillation(rng, (0.0, 0.4), (8, 12))  # tiny normal hand jitter

    if label == "stable":
        base, kind = make_base(rng, span_s)
        extra = physio
    elif label == "unstable":
        base, kind = make_base(rng, span_s)
        extra = make_oscillation(rng, (2, 20), (4, 10))
    else:  # uncertain
        if rng.random() < 0.5:
            base, kind = make_base(rng, span_s)
            extra = make_oscillation(rng, (0.7, 2.0), (4, 12))
            kind = "small-oscillation/" + kind
        else:
            base, kind = make_scribble(rng), "scribble"
            extra = physio

    def f(ts):
        bx, by = base(ts)
        ex, ey = extra(ts)
        return bx + ex, by + ey

    t, x, y = sample_like_browser(rng, f, span_ms, noise)
    return {"t": t, "x": x, "y": y, "t_end": float(span_ms), "label": label, "kind": kind}


def generate_dataset(n_per_class, cfg, seed=42):
    """Balanced list of windows, n_per_class for each class, reproducible via seed."""
    rng = np.random.default_rng(seed)
    windows = []
    for label in CLASSES:
        for _ in range(n_per_class):
            windows.append(make_window(rng, label, cfg))
    return windows


if __name__ == "__main__":
    cfg = load_config()
    data = generate_dataset(5, cfg)
    for w in data:
        print(f"{w['label']:10s} {w['kind']:28s} samples={len(w['t'])}")
