// tests/sampler.test.mjs — pins for the MicroMoth surrogate sampler.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32, seedToU32, fnv1a64, circuitTag,
  softmaxMasses, encodeAmplitudes, encodeAngles, bornProbs,
  measureExact, measureLattice, sampleAction, sampleBatch,
  temperatureFor, FIDELITY, VERSION,
} from '../src/micromoth-sampler.mjs';

function tv(a, b) { // total variation between two length-equal arrays
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / 2;
}
function countsToProbs(counts, shots, q) {
  const p = new Array(1 << q).fill(0);
  for (const [k, n] of Object.entries(counts)) p[parseInt(k, 2)] = n / shots;
  return p;
}

test('mulberry32 is deterministic and in range', () => {
  const a = mulberry32(42), b = mulberry32(42);
  const xs = Array.from({ length: 64 }, () => a());
  const ys = Array.from({ length: 64 }, () => b());
  assert.deepEqual(xs, ys);
  for (const x of xs) assert.ok(x >= 0 && x < 1);
});

test('seedToU32: same string → same u32, different strings differ; fnv1a64 stable', () => {
  assert.equal(seedToU32('73e:101:t1.0:3'), seedToU32('73e:101:t1.0:3'));
  assert.notEqual(seedToU32('a'), seedToU32('b'));
  assert.equal(seedToU32(7), 7 >>> 0);
  assert.equal(fnv1a64('').toString(16), 'cbf29ce484222325'); // FNV-1a 64 offset basis
});

test('softmaxMasses: normalizes; T=0 is the argmax delta; log-stable at huge scores', () => {
  const m = softmaxMasses([1, 2, 3], 1);
  assert.ok(Math.abs(m.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.deepEqual(softmaxMasses([1, 2, 3, 0.5], 0), [0, 0, 1, 0]);
  assert.deepEqual(softmaxMasses([1, 2, 3, 0.5], 1e-13), [0, 0, 1, 0]);
  const big = softmaxMasses([1e308, 1e308 + 5, 0], 1); // must not overflow
  assert.ok(Math.abs(big.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.throws(() => softmaxMasses([1, NaN], 1), /E_BAD_SCORES/);
  assert.throws(() => softmaxMasses([1, 2], -1), /E_BAD_TEMPERATURE/);
});

test('encodeAmplitudes: amps² sum to 1; padding slots are exact zeros', () => {
  const { q, amps } = encodeAmplitudes([0.2, 0.3, 0.5]);
  assert.equal(q, 2);
  assert.equal(amps.length, 4);
  assert.ok(Math.abs(amps.reduce((a, b) => a + b * b, 0) - 1) < 1e-12);
  assert.equal(amps[3], 0);
  assert.throws(() => encodeAmplitudes([0.2, -0.1]), /E_BAD_MASSES/);
  assert.throws(() => encodeAmplitudes([0, 0]), /E_BAD_MASSES/);
});

test('encodeAngles: cos²(θ/2) of each block equals its left-mass fraction', () => {
  const m = softmaxMasses([0.3, 2.2, -1.1, 0.7], 0.8);
  const { q, levels } = encodeAngles(m);
  const { amps } = encodeAmplitudes(m);
  assert.equal(levels.length, q);
  // level 0: single block over the whole register
  {
    const tot = amps.reduce((a, b) => a + b * b, 0);
    const p0 = amps[0] ** 2 + amps[1] ** 2;
    const th = levels[0][0];
    assert.ok(Math.abs(Math.cos(th / 2) ** 2 - p0 / tot) < 1e-12);
  }
  // level 1: two blocks
  for (const [b, start] of [0, 2].entries()) {
    const tot = amps[start] ** 2 + amps[start + 1] ** 2;
    const th = levels[1][b];
    assert.ok(Math.abs(Math.cos(th / 2) ** 2 - amps[start] ** 2 / tot) < 1e-12);
  }
});

test('DETERMINISM LAW: same (weights, seed) → identical samples, both measurement paths', () => {
  const args = { scores: [1.2, -0.4, 2.0, 0.0], temperature: 1.0, seed: '73e:101:t1.0:3', shots: 512 };
  assert.deepEqual(sampleBatch({ ...args }), sampleBatch({ ...args }));
  assert.deepEqual(sampleBatch({ ...args, lattice: true }), sampleBatch({ ...args, lattice: true }));
  const sa = sampleAction({ scores: args.scores, temperature: 1, seed: args.seed });
  const sb = sampleAction({ scores: args.scores, temperature: 1, seed: args.seed });
  assert.equal(sa.index, sb.index);
  assert.equal(sa.bits, sb.bits);
  // different seed ⇒ different draw sequence (chosen fixed seeds verified to differ)
  assert.notDeepEqual(sampleBatch({ ...args, seed: 'other' }), sampleBatch({ ...args }));
  // temperature and lattice are part of the identity too
  assert.notDeepEqual(sampleBatch({ ...args, temperature: 2.0 }), sampleBatch({ ...args }));
});

test('T=0 through the sampler IS the argmax policy', () => {
  const counts = sampleBatch({ scores: [0.2, 3.0, -1, 0.5], temperature: 0, seed: 'x', shots: 64 }).counts;
  assert.deepEqual(counts, { '01': 64 });
  const a = sampleAction({ scores: [0.2, 3.0, -1, 0.5], temperature: 0, seed: 'x', actions: ['U', 'R', 'D', 'L'] });
  assert.equal(a.action, 'R');
});

test('equal scores at T=1 sample near-uniformly', () => {
  const { counts, q } = sampleBatch({ scores: [0, 0, 0, 0], temperature: 1, seed: 'uniform', shots: 4000 });
  const p = countsToProbs(counts, 4000, q);
  for (const pi of p) assert.ok(pi > 0.2 && pi < 0.3, `freq ${pi} outside [0.2,0.3]`);
});

test('both measurement paths match the Born distribution (TV < 0.02 at 20k shots) and each other', () => {
  const m = softmaxMasses([0.3, 2.2, -1.1, 0.7], 0.8);
  const { q, amps } = encodeAmplitudes(m);
  const target = bornProbs(amps);
  const SHOTS = 20000;
  const pExact = countsToProbs(sampleBatch({ masses: m, seed: 'tv-exact', shots: SHOTS }).counts, SHOTS, q);
  const pLattice = countsToProbs(sampleBatch({ masses: m, seed: 'tv-lattice', shots: SHOTS, lattice: true }).counts, SHOTS, q);
  assert.ok(tv(pExact, target) < 0.02, `exact TV=${tv(pExact, target)}`);
  assert.ok(tv(pLattice, target) < 0.02, `lattice TV=${tv(pLattice, target)}`);
  assert.ok(tv(pExact, pLattice) < 0.02);
});

test('padded actions are never measured (3 actions → slot 11 empty)', () => {
  const { counts, q } = sampleBatch({ masses: [1, 2, 3], seed: 'pad', shots: 2000 });
  assert.equal(q, 2);
  assert.ok(!counts['11']);
});

test('measureExact/measureLattice are pure functions of (amps, rng stream)', () => {
  const { q, amps } = encodeAmplitudes([0.4, 0.1, 0.3, 0.2]);
  const ra = mulberry32(7), rb = mulberry32(7), rc = mulberry32(7), rd = mulberry32(7);
  const ex1 = [], ex2 = [], la1 = [], la2 = [];
  for (let i = 0; i < 32; i++) {
    ex1.push(measureExact(amps, ra));
    ex2.push(measureExact(amps, rb));
    la1.push(measureLattice(amps, q, rc));
    la2.push(measureLattice(amps, q, rd));
  }
  assert.deepEqual(ex1, ex2);
  assert.deepEqual(la1, la2);
});

test('temperatureFor: anneal schedules and validation', () => {
  assert.equal(temperatureFor({ temperature: 1.0 }), 1.0);
  assert.equal(temperatureFor({ temperature: 1.0, step: 10, totalSteps: 60 }), 1.0);
  assert.ok(Math.abs(temperatureFor({ temperature: 1.0, step: 0, totalSteps: 60, anneal: 'early-hot' }) - 1.5) < 1e-12);
  assert.ok(Math.abs(temperatureFor({ temperature: 1.0, step: 60, totalSteps: 60, anneal: 'early-hot' }) - 0.5) < 1e-12);
  assert.ok(Math.abs(temperatureFor({ temperature: 1.0, step: 0, totalSteps: 60, anneal: 'late-hot' }) - 0.5) < 1e-12);
  assert.ok(Math.abs(temperatureFor({ temperature: 1.0, step: 60, totalSteps: 60, anneal: 'late-hot' }) - 1.5) < 1e-12);
  assert.throws(() => temperatureFor({ temperature: 1, totalSteps: 60, anneal: 'sideways' }), /E_BAD_ANNEAL/);
  assert.throws(() => temperatureFor({ temperature: -1 }), /E_BAD_TEMPERATURE/);
});

test('input validation fails closed', () => {
  assert.throws(() => sampleBatch({ scores: [1, 2], temperature: 1, seed: 's', shots: 0 }), /E_BAD_SHOTS/);
  assert.throws(() => sampleBatch({ temperature: 1, seed: 's' }), /E_NO_DISTRIBUTION/);
  assert.throws(() => sampleBatch({ scores: [1, 2], masses: [1, 2], seed: 's' }), /E_BOTH_DISTRIBUTIONS/);
  assert.throws(() => sampleBatch({ masses: null, temperature: 1, seed: 's' }), /E_NO_DISTRIBUTION/);
  assert.throws(() => sampleBatch({ scores: [1, 2], temperature: 1 }), /E_NO_SEED/);
});

test('circuitTag + FIDELITY + VERSION exports (provenance surface)', () => {
  assert.match(circuitTag({ a: 1 }), /^fnv1a64:[0-9a-f]{16}$/);
  assert.equal(circuitTag({ a: 1 }), circuitTag({ a: 1 }));
  assert.notEqual(circuitTag({ a: 1 }), circuitTag({ a: 2 }));
  assert.ok(Array.isArray(FIDELITY) && FIDELITY.length >= 5);
  assert.equal(VERSION, '1.0.0');
});
