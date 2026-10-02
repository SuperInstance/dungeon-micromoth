// micromoth-sampler.mjs — the MicroMoth SURROGATE: a local, quantum-flavored
// stochastic policy sampler. No API, no keys, no network — local compute only.
//
// LINEAGE (SuperInstance/MicroMoth-quilt @ 014f1f293f62c82ae35b5763503930f3a9d7ecec):
//   * micromoth.py `simulate()` — Born rule: `probs = e[0]**2 + e[1]**2` over the
//     statevector (line 223); shot sampling = inverse-CDF walk over probs with one
//     uniform draw per shot (lines 255–271). This module ports that idiom to JS.
//   * docs/CELL-MAPPING.md — quantum ops as quilt cells (BIND/LINK/EFFECT/VIEW/TICK
//     + adopted WORLD/PROOF). The "determinism hole": micromoth's counts sample the
//     GLOBAL unseeded `random`, so an unseeded collapse receipt is not replayable.
//     The mapping's resolution — the seed is part of the cell's identity (a WORLD
//     witness `{op:"WORLD", params:{seed, shots}}`) — is implemented here as the
//     FLEET DETERMINISM LAW: same (weights, seed) → same samples, always.
//   * tools/collapse_ledger.py — the seed-plumbing precedent (seed → sampler →
//     SEALED collapse receipts). Here the seed plumbs a mulberry32 PRNG.
//
// THE MOTHQUANTUM SHAPE IT EMULATES (qpixl-v1, per the wave-63 receipts):
//   "numbers-as-waveform: amplitudes encoded as qubit angles, decoded in one
//   measurement." A policy score vector IS the waveform: softmax(scores/T) gives
//   target masses, encodeAmplitudes() gives |α_i| = √mass_i on a 2^q lattice,
//   and measurement collapse = one seeded Bernoulli walk down the qubit tree.
//
// Fidelity vs a true device (full table in docs/SURROGATE.md):
//   EXACT      — the sampled distribution (Born rule over the encoded amplitudes
//                IS the softmax policy, bit for bit, up to float rounding);
//                determinism under (weights, seed).
//   APPROX     — randomness provenance (PRNG, not physical QRNG); no readout
//                error / decoherence / crosstalk modeled.
//   NOT MODELED— device latency, queueing, certified pulse receipts, the
//                amplitude-loading circuit itself (only its measurement
//                statistics are emulated).

// ── deterministic randomness ────────────────────────────────────────────────

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

/** FNV-1a 64-bit over a UTF-8 string (the fleet ledger hash convention). */
export function fnv1a64(str) {
  let h = FNV_OFFSET;
  const bytes = new TextEncoder().encode(String(str));
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * FNV_PRIME) & FNV_MASK;
  }
  return h;
}

/** Any seed (number or string) → uint32. Strings fold fnv1a-64 halves by xor. */
export function seedToU32(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  const h = fnv1a64(String(seed));
  return Number((h ^ (h >> 32n)) & 0xffffffffn) >>> 0;
}

/** mulberry32 — tiny seeded PRNG, uint32 state, returns floats in [0,1). */
export function mulberry32(seedU32) {
  let a = seedU32 >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Provenance tag for a payload (the circuit_hash analog). */
export function circuitTag(payload) {
  return 'fnv1a64:' + fnv1a64(JSON.stringify(payload)).toString(16).padStart(16, '0');
}

export const VERSION = '1.0.0';

// ── (a) encode action weights → amplitudes ──────────────────────────────────

/**
 * scores × temperature → unnormalized sampling masses (log-stable softmax).
 * T === 0 (or < 1e-12) degenerates to a delta on the argmax (first index wins
 * ties) — the sampler then IS the argmax policy.
 */
export function softmaxMasses(scores, temperature = 1) {
  if (!Array.isArray(scores) || scores.length === 0) throw new TypeError('E_BAD_SCORES');
  for (const s of scores) if (!Number.isFinite(s)) throw new TypeError('E_BAD_SCORES');
  const T = Number(temperature);
  if (!Number.isFinite(T) || T < 0) throw new TypeError('E_BAD_TEMPERATURE');
  if (T < 1e-12) {
    let bi = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
    return scores.map((_, i) => (i === bi ? 1 : 0));
  }
  const max = Math.max(...scores);
  const z = scores.map((s) => Math.exp((s - max) / T));
  const Z = z.reduce((a, b) => a + b, 0);
  if (!(Z > 0)) throw new Error('E_SOFTMAX_UNDERFLOW'); // unreachable: max-subtraction
  return z.map((v) => v / Z);
}

/**
 * masses → amplitude register on a 2^q lattice: amps[i] = √p_i, padded with
 * exact zeros to the next power of two. Σ amps² === 1 (within float rounding).
 * Non-negative real amplitudes only — the policy case (a phase-bearing loader
 * is device territory, not needed for sampling a categorical policy).
 */
export function encodeAmplitudes(masses) {
  if (!Array.isArray(masses) || masses.length === 0) throw new TypeError('E_BAD_MASSES');
  let Z = 0;
  for (const m of masses) {
    if (!Number.isFinite(m) || m < 0) throw new TypeError('E_BAD_MASSES');
    Z += m;
  }
  if (!(Z > 0)) throw new TypeError('E_BAD_MASSES');
  const q = Math.max(1, Math.ceil(Math.log2(masses.length)));
  const N = 1 << q;
  const amps = new Array(N).fill(0);
  for (let i = 0; i < masses.length; i++) amps[i] = Math.sqrt(masses[i] / Z);
  return { q, amps };
}

/**
 * The qpixl-v1 idiom: amplitudes encoded as qubit angles. Returns the
 * conditional ry angle per (level, prefix block): a loader would apply
 * ry(θ) on qubit `level`, controlled on the block's prefix bits. P(0) of
 * that rotation is exactly the block's left-subtree mass fraction.
 */
export function encodeAngles(masses) {
  const { q, amps } = encodeAmplitudes(masses);
  const N = amps.length;
  const levels = [];
  for (let d = 0; d < q; d++) {
    const blockSize = 1 << (q - d);
    const half = blockSize >> 1;
    const blocks = [];
    for (let start = 0; start < N; start += blockSize) {
      let p0 = 0, tot = 0;
      for (let i = start; i < start + blockSize; i++) tot += amps[i] * amps[i];
      for (let i = start; i < start + half; i++) p0 += amps[i] * amps[i];
      const r0 = tot > 0 ? p0 / tot : 0;
      blocks.push(2 * Math.atan2(Math.sqrt(1 - r0), Math.sqrt(r0)));
    }
    levels.push(blocks);
  }
  return { q, levels };
}

/** Born rule: amplitudes → probabilities. */
export function bornProbs(amps) {
  return amps.map((a) => a * a);
}

export function indexToBits(i, q) {
  return i.toString(2).padStart(q, '0');
}

// ── (b) simulate measurement (seeded collapse) ──────────────────────────────

/**
 * Joint measurement: inverse-CDF walk over the Born probabilities — the exact
 * MicroMoth `simulate(get='counts')` idiom, with the seeded rng replacing the
 * global unseeded random (this closes CELL-MAPPING's determinism hole).
 */
export function measureExact(amps, rng) {
  const u = rng();
  let cum = 0;
  for (let j = 0; j < amps.length; j++) {
    cum += amps[j] * amps[j];
    if (u < cum) return j;
  }
  // float rounding guard: return the last nonzero-amplitude index
  for (let j = amps.length - 1; j >= 0; j--) if (amps[j] > 0) return j;
  return 0;
}

/**
 * Device-shaped measurement: collapse qubit by qubit (MSB first). At each
 * level the conditional P(bit=0 | prefix) is the block's left-half Born mass
 * fraction; one seeded draw per level; the register stays collapsed.
 * For non-negative real amplitudes this is distributionally EXACT vs
 * measureExact (pinned by tests) — it is the walk a real lattice would do.
 */
export function measureLattice(amps, q, rng) {
  let start = 0;
  let blockSize = amps.length;
  let index = 0;
  for (let d = 0; d < q; d++) {
    const half = blockSize >> 1;
    let p0 = 0, tot = 0;
    for (let i = start; i < start + blockSize; i++) tot += amps[i] * amps[i];
    for (let i = start; i < start + half; i++) p0 += amps[i] * amps[i];
    const u = rng() * tot;
    if (u < p0) {
      blockSize = half; // bit = 0: stay in the left half
    } else {
      start += half;
      blockSize = half;
      index |= 1 << (q - 1 - d); // bit = 1
    }
  }
  return index;
}

function validateOptions({ scores, masses, temperature, shots }) {
  if (shots !== undefined && (!Number.isInteger(shots) || shots < 1)) throw new TypeError('E_BAD_SHOTS');
  const hasScores = scores !== undefined && scores !== null;
  const hasMasses = masses !== undefined && masses !== null;
  if (!hasScores && !hasMasses) throw new TypeError('E_NO_DISTRIBUTION');
  if (hasScores && hasMasses) throw new TypeError('E_BOTH_DISTRIBUTIONS');
}

/**
 * ONE measurement of the policy state (the qpixl "decoded in one measurement"
 * shape): encode → collapse once. Returns {index, bits, action, probs, temperature}.
 */
export function sampleAction({ scores, masses, temperature = 1, seed, lattice = false, actions = null }) {
  validateOptions({ scores, masses, temperature });
  const m = masses ?? softmaxMasses(scores, temperature);
  const { q, amps } = encodeAmplitudes(m);
  if (typeof seed === 'undefined') throw new TypeError('E_NO_SEED');
  const rng = mulberry32(seedToU32(seed));
  const idx = (lattice ? measureLattice(amps, q, rng) : measureExact(amps, rng));
  return {
    index: idx,
    bits: indexToBits(idx, q),
    action: actions ? (actions[idx] ?? null) : null,
    probs: bornProbs(amps).slice(0, m.length),
    temperature,
  };
}

/**
 * shots-fold re-prepare-and-measure (device semantics: every shot is a fresh
 * preparation of the same encoded state). Deterministic given (distribution,
 * temperature, seed, shots, lattice).
 */
export function sampleBatch({ scores, masses, temperature = 1, seed, shots = 256, lattice = false }) {
  validateOptions({ scores, masses, temperature, shots });
  const m = masses ?? softmaxMasses(scores, temperature);
  const { q, amps } = encodeAmplitudes(m);
  if (typeof seed === 'undefined') throw new TypeError('E_NO_SEED');
  const rng = mulberry32(seedToU32(seed));
  const counts = {};
  for (let s = 0; s < shots; s++) {
    const idx = lattice ? measureLattice(amps, q, rng) : measureExact(amps, rng);
    const k = indexToBits(idx, q);
    counts[k] = (counts[k] || 0) + 1;
  }
  return {
    counts,
    probs: bornProbs(amps),
    q,
    shots,
    seed: String(seed),
    backend: 'micromoth-surrogate',
    lattice,
  };
}

// ── (c) temperature / annealing per game phase ──────────────────────────────

/**
 * Effective temperature at a game step. anneal:
 *   null        — constant T (the A/B arms use this),
 *   'early-hot' — 1.5T → 0.5T linearly across the episode (explore early, exploit late),
 *   'late-hot'  — 0.5T → 1.5T (the mirrored schedule).
 */
export function temperatureFor({ temperature, step = 0, totalSteps = 0, anneal = null }) {
  const T = Number(temperature);
  if (!Number.isFinite(T) || T < 0) throw new TypeError('E_BAD_TEMPERATURE');
  if (!anneal) return T;
  if (!Number.isFinite(totalSteps) || totalSteps <= 0) throw new TypeError('E_BAD_TOTAL_STEPS');
  const x = Math.min(1, Math.max(0, step / totalSteps));
  if (anneal === 'early-hot') return T * (1.5 - x);
  if (anneal === 'late-hot') return T * (0.5 + x);
  throw new TypeError('E_BAD_ANNEAL');
}

// ── the fidelity table, as data (mirrors docs/SURROGATE.md) ─────────────────

export const FIDELITY = [
  { property: 'sampled distribution == softmax policy', verdict: 'EXACT', note: 'Born rule over √mass amplitudes IS the categorical distribution; both measurement paths agree (pinned).' },
  { property: 'determinism under (weights, seed)', verdict: 'EXACT', note: 'mulberry32 seeded collapse; the CELL-MAPPING determinism hole closed by construction.' },
  { property: 'two-qubit-lattice measurement statistics (non-negative amps)', verdict: 'EXACT', note: 'sequential per-qubit collapse ≡ joint inverse-CDF for this register class.' },
  { property: 'randomness provenance (QRNG vs PRNG)', verdict: 'APPROXIMATED', note: 'a real device sources physical randomness; the surrogate sources mulberry32. Same distributions, different provenance — and the PRNG is the feature the fleet determinism law wants.' },
  { property: 'hardware readout error / decoherence / crosstalk', verdict: 'APPROXIMATED (none modeled)', note: 'wave-63 receipts show real readout spread (bell correlator σ ≈ 0.011 at 4096 shots); the surrogate is noiseless.' },
  { property: 'amplitude-loading circuit depth & entanglement', verdict: 'NOT MODELED', note: 'encodeAngles() emits the conditional ry angles a loader would apply; the surrogate emulates the measurement statistics, not the gate-level execution.' },
  { property: 'device latency, queueing, certified pulse receipts', verdict: 'NOT MODELED', note: 'surrogate provenance is local and immediate; pulse commitment/extractor chains exist only on the live API.' },
];
