"""Train the Smooth Mouse movement classifier and export it for the browser.

Usage (from the repo root, with the virtual environment active):
    python ml/train.py                      # train, evaluate, export
    python ml/train.py recording.json ...   # also run the model over real recordings

Outputs:
    shared/model.json     the trained model, in a format content/model.js can run
    shared/fixtures.json  test windows + expected features/probabilities for the
                          JS parity test (demo/parity.html)
    ml/plots/*.png        charts for the slides
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # save charts to files, no window needed
import matplotlib.pyplot as plt
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.tree import DecisionTreeClassifier

from features import FEATURE_NAMES, ROOT, load_config, window_features
from synth import CLASSES, generate_dataset

SEED = 42
N_PER_CLASS = 3000
PLOTS = ROOT / "ml" / "plots"
COLORS = {"stable": "#0F766E", "unstable": "#B4441A", "uncertain": "#6B7C93"}


def build_features(windows, cfg):
    X = np.array([window_features(w["t"], w["x"], w["y"], w["t_end"], cfg) for w in windows])
    y = np.array([w["label"] for w in windows])
    return X, y


def export_model(pipe, cfg, metrics):
    """Write the model as plain numbers so JavaScript can run it in a few lines.

    In the browser, prediction is:
        z      = (features - scaler.mean) / scaler.scale      # standardize
        logits = coef @ z + intercept                          # one score per class
        probs  = softmax(logits)                               # scores -> probabilities
    """
    scaler = pipe.named_steps["scaler"]
    clf = pipe.named_steps["clf"]
    model = {
        "format": "smooth-mouse-logreg-v1",
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "trainedOn": "synthetic",
        "classes": [str(c) for c in clf.classes_],  # order matches coef/intercept rows
        "featureNames": FEATURE_NAMES,
        "scaler": {"mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist()},
        "coef": clf.coef_.tolist(),
        "intercept": clf.intercept_.tolist(),
        "config": cfg,  # the window settings the model was trained with
        "metrics": metrics,
    }
    (ROOT / "shared" / "model.json").write_text(json.dumps(model, indent=2))


def edge_case_windows(windows, test_idx, rng):
    """Hand-made tricky inputs, so the JS code is tested on them too."""
    base = next(windows[i] for i in test_idx if windows[i]["label"] == "unstable")
    order = rng.permutation(len(base["t"]))  # deliver samples out of order
    t = base["t"].copy()
    t[5] = t[4]  # force a duplicate timestamp
    return [
        {"label": "stable", "kind": "edge/no-samples-in-window", "t_end": 650.0,
         "t": np.array([0.0, 8.0, 16.0]), "x": np.array([100.0, 101.0, 102.5]), "y": np.array([200.0, 200.0, 200.5])},
        {"label": "stable", "kind": "edge/single-sample", "t_end": 650.0,
         "t": np.array([600.0]), "x": np.array([300.0]), "y": np.array([400.0])},
        {"label": base["label"], "kind": "edge/unsorted-with-duplicate", "t_end": base["t_end"],
         "t": t[order], "x": base["x"][order], "y": base["y"][order]},
    ]


def export_fixtures(pipe, fixture_windows, cfg):
    """~20 windows for the JS parity test: raw input + expected output."""
    X = np.array([window_features(w["t"], w["x"], w["y"], w["t_end"], cfg) for w in fixture_windows])
    probs = pipe.predict_proba(X)
    fixtures = []
    for w, feats, p in zip(fixture_windows, X, probs):
        fixtures.append(
            {
                "label": w["label"],
                "kind": w["kind"],
                "tEnd": w["t_end"],
                "t": w["t"].tolist(),
                "x": w["x"].tolist(),
                "y": w["y"].tolist(),
                "features": feats.tolist(),
                "probs": p.tolist(),
            }
        )
    out = {
        "classes": [str(c) for c in pipe.classes_],
        "featureNames": FEATURE_NAMES,
        "tolerance": {"features": 1e-6, "probs": 1e-6},
        "fixtures": fixtures,
    }
    (ROOT / "shared" / "fixtures.json").write_text(json.dumps(out))


def pick_fixture_windows(windows, test_idx, rng):
    """6 random test windows per class, plus hand-made edge cases."""
    chosen = []
    for label in CLASSES:
        pool = [i for i in test_idx if windows[i]["label"] == label]
        chosen += [windows[i] for i in rng.choice(pool, size=6, replace=False)]
    return chosen + edge_case_windows(windows, test_idx, rng)


# ---------------------------------------------------------------------------
# Charts
# ---------------------------------------------------------------------------

def plot_confusion(cm, classes, acc):
    fig, ax = plt.subplots(figsize=(5.2, 4.4))
    norm = cm / cm.sum(axis=1, keepdims=True)
    ax.imshow(norm, cmap="Greens", vmin=0, vmax=1)
    for r in range(len(classes)):
        for c in range(len(classes)):
            ax.text(c, r, f"{cm[r, c]}\n{norm[r, c]:.0%}", ha="center", va="center",
                    color="white" if norm[r, c] > 0.6 else "#102A43", fontsize=10)
    ax.set_xticks(range(len(classes)), classes)
    ax.set_yticks(range(len(classes)), classes)
    ax.set_xlabel("Predicted")
    ax.set_ylabel("True")
    ax.set_title(f"Confusion matrix (synthetic test set, accuracy {acc:.1%})")
    fig.tight_layout()
    fig.savefig(PLOTS / "confusion_matrix.png", dpi=160)
    plt.close(fig)


def plot_feature_distributions(X, y):
    fig, axes = plt.subplots(2, 4, figsize=(15, 6.5))
    for ax in axes.flat[len(FEATURE_NAMES):]:
        ax.axis("off")
    for k, ax in zip(range(len(FEATURE_NAMES)), axes.flat):
        lo, hi = np.percentile(X[:, k], [0.5, 99.5])
        bins = np.linspace(lo, hi + 1e-9, 40)
        for label in CLASSES:
            ax.hist(X[y == label, k], bins=bins, alpha=0.5, label=label, color=COLORS[label], density=True)
        ax.set_title(FEATURE_NAMES[k])
    axes[0, 0].legend()
    fig.suptitle("Feature distributions by class (synthetic data)")
    fig.tight_layout()
    fig.savefig(PLOTS / "feature_distributions.png", dpi=160)
    plt.close(fig)


def plot_examples(windows, rng, span_ms):
    fig, axes = plt.subplots(3, 4, figsize=(12, 9))
    for r, label in enumerate(CLASSES):
        pool = [w for w in windows if w["label"] == label and len(w["t"]) > 20]
        for c, i in enumerate(rng.choice(len(pool), size=4, replace=False)):
            w = pool[i]
            ax = axes[r, c]
            ax.plot(w["x"], w["y"], "-o", ms=2, lw=1, color=COLORS[label])
            ax.set_aspect("equal", adjustable="datalim")
            ax.invert_yaxis()
            ax.set_title(f"{label}: {w['kind']}", fontsize=9)
            ax.tick_params(labelsize=7)
    fig.suptitle(f"Example synthetic cursor paths ({span_ms:.0f} ms each)")
    fig.tight_layout()
    fig.savefig(PLOTS / "example_windows.png", dpi=160)
    plt.close(fig)


# ---------------------------------------------------------------------------
# Optional: run the model over real exported recordings
# ---------------------------------------------------------------------------

def check_recording(path, pipe, cfg):
    data = json.loads(Path(path).read_text())
    s = [p for p in data["samples"] if p["type"] == "move"]
    if len(s) < 5:
        print(f"  {path}: too few samples")
        return
    t = np.array([p["t"] for p in s], float)
    x = np.array([p["x"] for p in s], float)
    y = np.array([p["y"] for p in s], float)
    ends = np.arange(t[0] + cfg["windowMs"], t[-1], cfg["stepMs"])
    X = np.array([window_features(t, x, y, e, cfg) for e in ends])
    pred = pipe.predict(X)
    counts = {c: int((pred == c).sum()) for c in pipe.classes_}
    share = ", ".join(f"{c} {n / len(pred):.0%}" for c, n in counts.items())
    print(f"  {Path(path).name}: {len(pred)} windows -> {share}")


def main():
    cfg = load_config()
    PLOTS.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(SEED)

    print(f"Generating {N_PER_CLASS} synthetic windows per class...")
    windows = generate_dataset(N_PER_CLASS, cfg, seed=SEED)
    X, y = build_features(windows, cfg)

    idx = np.arange(len(y))
    train_idx, test_idx = train_test_split(idx, test_size=0.2, stratify=y, random_state=SEED)

    # With 3 classes and the default lbfgs solver, LogisticRegression is multinomial
    # (one softmax over all classes), which is what model.js implements.
    pipe = Pipeline([("scaler", StandardScaler()), ("clf", LogisticRegression(max_iter=2000))])
    pipe.fit(X[train_idx], y[train_idx])
    pred = pipe.predict(X[test_idx])
    acc = accuracy_score(y[test_idx], pred)
    classes = list(pipe.classes_)
    cm = confusion_matrix(y[test_idx], pred, labels=classes)

    print(f"\nLogistic regression test accuracy: {acc:.1%}  (synthetic data)\n")
    print(classification_report(y[test_idx], pred, digits=3))
    print("Confusion matrix (rows = true, cols = predicted):", classes)
    print(cm)

    # Comparison only: a small decision tree. We ship logistic regression because
    # it exports to a handful of numbers and runs in a few lines of JS.
    tree = DecisionTreeClassifier(max_depth=6, random_state=SEED).fit(X[train_idx], y[train_idx])
    tree_acc = accuracy_score(y[test_idx], tree.predict(X[test_idx]))
    print(f"\nComparison - decision tree (depth 6) test accuracy: {tree_acc:.1%}")

    report = classification_report(y[test_idx], pred, output_dict=True)
    metrics = {
        "testAccuracy": round(acc, 4),
        "decisionTreeTestAccuracy": round(tree_acc, 4),
        "perClass": {c: {k: round(report[c][k], 4) for k in ("precision", "recall", "f1-score")} for c in classes},
        "nTrain": int(len(train_idx)),
        "nTest": int(len(test_idx)),
    }

    export_model(pipe, cfg, metrics)
    fixture_windows = pick_fixture_windows(windows, list(test_idx), rng)
    export_fixtures(pipe, fixture_windows, cfg)

    plot_confusion(cm, classes, acc)
    plot_feature_distributions(X, y)
    plot_examples(windows, rng, windows[0]["t_end"])

    print(f"\nWrote shared/model.json, shared/fixtures.json ({len(fixture_windows)} fixtures), ml/plots/*.png")

    if len(sys.argv) > 1:
        print("\nReal recordings (no labels, just what the model thinks):")
        for path in sys.argv[1:]:
            check_recording(path, pipe, cfg)


if __name__ == "__main__":
    main()
