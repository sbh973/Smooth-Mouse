// parity.js — checks content/features.js + content/model.js against Python.
const { features, model: modelLib } = window.SmoothMouse;

const loadJSON = (path) =>
  fetch(path).then((r) => {
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  });

// Combined tolerance: tiny absolute error for small numbers, relative for big ones.
const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i]) / (1 + Math.abs(b[i]))));

async function run() {
  const [config, model, fixtureFile] = await Promise.all([
    loadJSON("../shared/config.json"),
    loadJSON("../shared/model.json"),
    loadJSON("../shared/fixtures.json"),
  ]);

  // If config.json was edited after training, the model is stale.
  const checkEl = document.getElementById("config-check");
  const keys = Object.keys(config).filter((k) => !k.startsWith("_"));
  const stale = keys.filter((k) => JSON.stringify(config[k]) !== JSON.stringify(model.config[k]));
  if (stale.length) {
    checkEl.textContent = `Warning: shared/config.json changed since training (${stale.join(", ")}). Re-run python ml/train.py.`;
    checkEl.className = "status warn";
  } else {
    checkEl.textContent = "shared/config.json matches the settings the model was trained with.";
    checkEl.className = "status ok";
  }

  const tol = fixtureFile.tolerance;
  const tbody = document.getElementById("rows");
  let passed = 0;

  fixtureFile.fixtures.forEach((fx, i) => {
    // Use the model's own config, exactly like the live extension does.
    const feats = features.windowFeatures(fx.t, fx.x, fx.y, fx.tEnd, model.config);
    const probs = modelLib.predictArray(model, feats);
    const fDiff = maxDiff(feats, fx.features);
    const pDiff = maxDiff(probs, fx.probs);
    const ok = fDiff <= tol.features && pDiff <= tol.probs;
    if (ok) passed++;

    const predicted = model.classes[probs.indexOf(Math.max(...probs))];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td><td>${fx.kind}</td><td>${fx.label}</td>
      <td>${predicted} (${Math.round(Math.max(...probs) * 100)}%)</td>
      <td class="num">${fDiff.toExponential(1)}</td><td class="num">${pDiff.toExponential(1)}</td>
      <td class="${ok ? "PASS" : "FAIL"}">${ok ? "PASS" : "FAIL"}</td>`;
    tbody.appendChild(tr);
    if (!ok) console.warn("Parity FAIL", fx.kind, { js: feats, python: fx.features });
  });

  const total = fixtureFile.fixtures.length;
  const summary = document.getElementById("summary");
  summary.textContent =
    passed === total ? `PASS: all ${total} fixtures match Python` : `FAIL: ${total - passed} of ${total} fixtures differ`;
  summary.className = `summary ${passed === total ? "pass" : "fail"}`;
}

run().catch((err) => {
  const summary = document.getElementById("summary");
  summary.textContent = `Could not run: ${err.message}. Serve the repo root with "python3 -m http.server 5500".`;
  summary.className = "summary fail";
});
