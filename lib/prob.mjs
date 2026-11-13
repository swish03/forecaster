// Probability helpers for binary and multiple-choice forecasts
// (research/specs/metaculus_method.md 3.5).

export function clamp(p, lo, hi) {
  if (!(lo <= hi)) throw new Error(`clamp range is empty: [${lo}, ${hi}]`);
  if (typeof p !== 'number' || !Number.isFinite(p)) throw new Error(`clamp needs a finite number, got ${p}`);
  return Math.min(hi, Math.max(lo, p));
}

export function logit(p) {
  if (!(p > 0 && p < 1)) throw new Error(`logit needs 0 < p < 1, got ${p}`);
  return Math.log(p / (1 - p));
}

export function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

// final = (1 - w) * logit(own) + w * logit(signal), back to a probability.
export function blendLogOdds(own, signal, weight) {
  if (!(weight >= 0 && weight <= 1)) throw new Error(`blend weight must be in [0, 1], got ${weight}`);
  if (weight === 0) return own;
  return sigmoid((1 - weight) * logit(own) + weight * logit(signal));
}

export function median(values) {
  if (!values.length) throw new Error('median of an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Every option gets at least `floor`; the rest is shared in proportion to the
// input. Options that fall under the floor are pinned to it and the others
// rescaled, repeated until nothing new falls under (exact, so it always stops).
export function normalizeWithFloor(probs, floor = 0.01) {
  const keys = Object.keys(probs);
  if (!keys.length) throw new Error('no options to normalise');
  if (floor * keys.length > 1) throw new Error('floor is too high for this many options');
  const values = keys.map((k) => probs[k]);
  if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
    throw new Error('option probabilities must be non-negative numbers');
  }

  const pinned = new Set();
  for (;;) {
    const free = keys.filter((k) => !pinned.has(k));
    const freeMass = free.reduce((sum, k) => sum + probs[k], 0);
    const room = 1 - floor * pinned.size;
    const scaled = Object.fromEntries(
      free.map((k) => [k, freeMass > 0 ? (probs[k] / freeMass) * room : room / free.length]),
    );
    const under = free.filter((k) => scaled[k] < floor);
    if (!under.length) {
      return Object.fromEntries(keys.map((k) => [k, pinned.has(k) ? floor : scaled[k]]));
    }
    under.forEach((k) => pinned.add(k));
  }
}
