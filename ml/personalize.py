"""Personalize the movement classifier with one user's calibration data.

Called by server.py (POST /calibrate). Takes a few seconds.

Inputs (from calibrate/calibrate.html, sent to localhost only):
  measurements  amplitudePx and frequencyHz of the cursor while the user held it on a dot
  hold          raw pointer samples from the 10 s hold      [{t, x, y}, ...]
  reach         raw pointer samples from clicking 10 targets [{t, x, y}, ...]

What we do:
  1. Base data: the 9,000 synthetic windows from train.py (cached in ml/cache/).
  2. Personalized synthetic data: extra "unstable" windows whose oscillation
     matches THIS user's measured size and frequency (if they have one).
  3. The user's real windows, labeled using their own hold as the yardstick:
       - steady user (hold wobble < 1.5 px): everything they did was intentional
         -> all real windows are "stable". This stops the model calling their
         normal fast movement "unstable".
       - user with a measurable wobble: hold windows -> "unstable" (that IS their
         resting fluctuation); reach windows clearly calmer than the hold ->
         "stable"; reach windows as wobbly as the hold -> "unstable"; in between
         -> not used (we're not sure).
  4. Retrain the same pipeline with weights: real x4, personalized synthetic x2,
     base x1. Export in the same JSON format as shared/model.json.

Labels are engineering labels for cursor movement, not medical diagnoses.
"""

import json

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from features import FEATURE_NAMES, ROOT, load_config, window_features
from synth import UNSTABLE_AMP, UNSTABLE_FREQ, generate_dataset, make_window
from train import CACHE, N_PER_CLASS, SEED, build_features, model_to_dict

STEADY_AMPLITUDE_PX = 1.5   # below this, we treat the user as having no measurable wobble
N_PERSONAL = 900            # personalized synthetic "unstable" windows
WEIGHT_REAL = 4.0
WEIGHT_PERSONAL = 2.0
WOBBLE = FEATURE_NAMES.index("wobble")

_base = None  # (X, y) cached in memory after the first load


def load_base(cfg):
    """Base synthetic features. Built once by train.py (or here, ~1 minute)."""
    global _base
    if _base is not None:
        return _base
    if CACHE.exists():
        data = np.load(CACHE, allow_pickle=False)
        if json.loads(str(data["config"])) == cfg:
            _base = (data["X"], data["y"])
            return _base
    print("Building the base dataset cache (about a minute, only once)...")
    X, y = build_features(generate_dataset(N_PER_CLASS, cfg, seed=SEED), cfg)
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(CACHE, X=X, y=y, config=json.dumps(cfg))
    _base = (X, y)
    return _base


def base_model_probs(X):
    """Run the bundled default model (shared/model.json) exactly like the browser does."""
    m = json.loads((ROOT / "shared" / "model.json").read_text())
    z = (X - np.array(m["scaler"]["mean"])) / np.array(m["scaler"]["scale"])
    logits = z @ np.array(m["coef"]).T + np.array(m["intercept"])
    e = np.exp(logits - logits.max(axis=1, keepdims=True))
    return m["classes"], e / e.sum(axis=1, keepdims=True)


def real_windows(samples, cfg):
    """Cut a recording into windows exactly like the live extension does (every stepMs)."""
    if len(samples) < 5:
        return np.zeros((0, len(FEATURE_NAMES)))
    t = np.array([s["t"] for s in samples], float)
    x = np.array([s["x"] for s in samples], float)
    y = np.array([s["y"] for s in samples], float)
    order = np.argsort(t, kind="stable")
    t, x, y = t[order], x[order], y[order]
    feats = []
    for end in np.arange(t[0] + cfg["windowMs"], t[-1] + 1e-9, cfg["stepMs"]):
        inside = np.sum((t >= end - cfg["windowMs"]) & (t <= end))
        if inside < 5:  # cursor (almost) still: nothing to learn from
            continue
        feats.append(window_features(t, x, y, end, cfg))
    return np.array(feats) if feats else np.zeros((0, len(FEATURE_NAMES)))


def label_real(X_hold, X_reach, amplitude_px):
    """Label the user's real windows using their own hold as the yardstick."""
    if amplitude_px < STEADY_AMPLITUDE_PX or len(X_hold) == 0:
        X = np.vstack([X_hold, X_reach]) if len(X_hold) else X_reach
        return X, np.array(["stable"] * len(X))

    hold_wobble = np.median(X_hold[:, WOBBLE])
    X_out, y_out = [X_hold], ["unstable"] * len(X_hold)
    for row in X_reach:
        if row[WOBBLE] <= 0.5 * hold_wobble:
            X_out.append(row[None, :]); y_out.append("stable")
        elif row[WOBBLE] >= hold_wobble:
            X_out.append(row[None, :]); y_out.append("unstable")
    return np.vstack(X_out), np.array(y_out)


def personal_synthetic(cfg, amplitude_px, frequency_hz, rng):
    """Extra 'unstable' windows shaped like this user's measured fluctuation."""
    if amplitude_px < STEADY_AMPLITUDE_PX or not frequency_hz:
        return np.zeros((0, len(FEATURE_NAMES))), np.array([])
    amp = (max(1.5, 0.6 * amplitude_px), min(30.0, 1.6 * amplitude_px))
    freq = (max(3.0, frequency_hz - 1.5), min(12.0, frequency_hz + 1.5))
    windows = [make_window(rng, "unstable", cfg, unstable_amp=amp, unstable_freq=freq) for _ in range(N_PERSONAL)]
    X, y = build_features(windows, cfg)
    return X, y


def personalize(measurements, hold, reach):
    cfg = load_config()
    rng = np.random.default_rng(SEED + 1)
    amplitude = float(measurements.get("amplitudePx") or 0.0)
    frequency = measurements.get("frequencyHz")

    X_base, y_base = load_base(cfg)
    X_pers, y_pers = personal_synthetic(cfg, amplitude, frequency, rng)
    X_real, y_real = label_real(real_windows(hold, cfg), real_windows(reach, cfg), amplitude)

    # Hold out 20% of the synthetic data to report accuracy honestly.
    X_syn = np.vstack([X_base, X_pers]) if len(X_pers) else X_base
    y_syn = np.concatenate([y_base, y_pers]) if len(y_pers) else y_base
    w_syn = np.concatenate([np.ones(len(y_base)), np.full(len(y_pers), WEIGHT_PERSONAL)])
    Xs_tr, Xs_te, ys_tr, ys_te, ws_tr, _ = train_test_split(
        X_syn, y_syn, w_syn, test_size=0.2, stratify=y_syn, random_state=SEED)

    X_train = np.vstack([Xs_tr, X_real]) if len(X_real) else Xs_tr
    y_train = np.concatenate([ys_tr, y_real]) if len(y_real) else ys_tr
    w_train = np.concatenate([ws_tr, np.full(len(y_real), WEIGHT_REAL)])

    pipe = Pipeline([("scaler", StandardScaler()), ("clf", LogisticRegression(max_iter=3000))])
    pipe.fit(X_train, y_train, clf__sample_weight=w_train)
    test_acc = float(np.mean(pipe.predict(Xs_te) == ys_te))

    # Before vs after on the user's OWN movement: the most convincing number.
    report = {
        "realWindows": int(len(y_real)),
        "realStable": int(np.sum(y_real == "stable")),
        "realUnstable": int(np.sum(y_real == "unstable")),
        "personalSyntheticWindows": int(len(y_pers)),
        "syntheticTestAccuracy": round(test_acc, 4),
    }
    if len(X_real):
        classes, base_p = base_model_probs(X_real)
        base_pred = np.array(classes)[base_p.argmax(axis=1)]
        new_pred = pipe.predict(X_real)
        calm = y_real == "stable"
        shaky = y_real == "unstable"
        if calm.any():
            report["calmCalledUnstableBefore"] = round(float(np.mean(base_pred[calm] == "unstable")), 3)
            report["calmCalledUnstableAfter"] = round(float(np.mean(new_pred[calm] == "unstable")), 3)
        if shaky.any():
            report["shakyDetectedBefore"] = round(float(np.mean(base_pred[shaky] == "unstable")), 3)
            report["shakyDetectedAfter"] = round(float(np.mean(new_pred[shaky] == "unstable")), 3)

    metrics = {"testAccuracy": round(test_acc, 4), "personalization": report}
    model = model_to_dict(pipe, cfg, metrics, trained_on="synthetic+personal")
    return model, report
