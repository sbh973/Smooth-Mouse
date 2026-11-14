// model.js — runs the classifier exported by ml/train.py (shared/model.json).
//
// The model is a standardized logistic regression, so prediction is just:
//   z      = (features - mean) / scale        standardize, like sklearn's StandardScaler
//   logits = coef · z + intercept             one score per class
//   probs  = softmax(logits)                  scores -> probabilities that add up to 1
//
// Classes are engineering labels for cursor movement, not medical diagnoses.

(() => {
  const SM = (window.SmoothMouse = window.SmoothMouse || {});

  /** Returns { label, probs: { stable, uncertain, unstable } }. */
  function predict(model, features) {
    const z = features.map((v, i) => (v - model.scaler.mean[i]) / model.scaler.scale[i]);
    const logits = model.coef.map((row, c) => row.reduce((s, w, i) => s + w * z[i], model.intercept[c]));
    const max = Math.max(...logits); // subtract the max so exp() can't overflow
    const exps = logits.map((l) => Math.exp(l - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    const probs = {};
    let label = model.classes[0];
    model.classes.forEach((name, c) => {
      probs[name] = exps[c] / sum;
      if (probs[name] > probs[label]) label = name;
    });
    return { label, probs };
  }

  /** Probabilities as an array in model.classes order (used by the parity test). */
  function predictArray(model, features) {
    const { probs } = predict(model, features);
    return model.classes.map((c) => probs[c]);
  }

  SM.model = { predict, predictArray };
})();
