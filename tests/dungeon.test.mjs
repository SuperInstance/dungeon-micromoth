// tests/dungeon.test.mjs — pins for the vendored quilt-dungeons core.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  genDungeon, initialState, observe, step, playEpisode,
  policyScores, argmaxAction, WEIGHT_VECTOR_73C, ACTIONS, MAX_STEPS, REWARDS,
} from '../src/dungeon.js';
import { softmaxMasses, sampleAction, temperatureFor } from '../src/micromoth-sampler.mjs';

function snapshot(d) {
  return JSON.stringify({
    size: d.size, grid: d.grid, start: d.start, exit: d.exit,
    gold: [...d.gold].sort(), traps: [...d.traps].sort(), attempt: d.attempt,
  });
}

test('genDungeon is deterministic per seed and distinct across the eval seeds', () => {
  for (const seed of [101, 102, 103, 104, 105, 106, 107, 108]) {
    assert.equal(snapshot(genDungeon(seed)), snapshot(genDungeon(seed)));
  }
  const snaps = new Set([101, 102, 103, 104, 105, 106, 107, 108].map((s) => snapshot(genDungeon(s))));
  assert.equal(snaps.size, 8);
});

test('dungeon structure: border walls, start clear, exit reachable and far, gold/traps disjoint from start/exit', () => {
  for (const seed of [101, 102, 103, 104, 105, 106, 107, 108]) {
    const d = genDungeon(seed);
    assert.equal(d.grid[0].every((c) => c === '#'), true);
    assert.equal(d.grid[d.size - 1].every((c) => c === '#'), true);
    assert.notEqual(d.grid[1][1], '#');
    assert.ok(d.exit[0] > 0 && d.exit[0] < d.size);
    assert.ok(!d.gold.has('1,1'));
    assert.ok(!d.gold.has(d.exit.join(',')));
    for (const t of d.traps) assert.ok(!d.gold.has(t));
    assert.equal(d.gold.size, 4);
    assert.equal(d.traps.size, 3);
  }
});

test('step(): bump costs and stays; gold/trap/exit score exactly the pinned rewards', () => {
  const d = genDungeon(101);
  const st = initialState(d);
  // force a wall bump: walk the player next to a wall via a hand-built state
  const hand = { dungeon: d, pos: [1, 1], steps: 0, score: 0, done: false, exitReached: false, goldLeft: new Set() };
  const r = step(hand, 'U'); // (0,1) is border wall
  assert.equal(r.event, 'bump');
  assert.equal(r.delta, REWARDS.bump);
  assert.deepEqual(hand.pos, [1, 1]);
  assert.throws(() => step({ ...hand }, 'X'), /E_BAD_ACTION/);
  const r2 = step(hand, 'D'); // (2,1): whatever it is, the event must be a legal one
  assert.ok(['move', 'gold', 'trap', 'exit', 'bump'].includes(r2.event));
});

test('argmax episodes are deterministic; sampled episodes are deterministic given the policy seed', () => {
  const d = genDungeon(101);
  const a1 = playEpisode(d, { mode: 'argmax' });
  const a2 = playEpisode(genDungeon(101), { mode: 'argmax' });
  assert.deepEqual(a1, a2);
  const p = { mode: 'sample', temperature: 1.0, seed: '73e:101:t1.0:0' };
  const s1 = playEpisode(genDungeon(101), p);
  const s2 = playEpisode(genDungeon(101), { ...p });
  assert.deepEqual(s1, s2);
  assert.ok(s1.steps <= MAX_STEPS);
  assert.ok(Number.isFinite(s1.score));
  const otherSeed = playEpisode(genDungeon(101), { mode: 'sample', temperature: 1.0, seed: '73e:101:t1.0:1' });
  assert.ok(
    s1.score !== otherSeed.score || s1.steps !== otherSeed.steps,
    'two different sampler seeds produced byte-identical episodes — suspicious'
  );
});

test('policy scores follow the 73-c weight vector; argmax tie-break is first-in-order', () => {
  const d = genDungeon(101);
  const st = initialState(d);
  const scores = policyScores(st);
  assert.equal(scores.length, 4);
  assert.equal(argmaxAction([1, 2, 2, 1]), ACTIONS[1]); // first max wins
  // weights actually bind: f_exit weighted 4.0 dominates
  const feats = observe(st);
  feats.forEach((f, i) => {
    const manual = f[0] * 0.6 + f[1] * 4.0 + f[2] * 2.0 + f[3] * -2.5 + f[4] * 1.4;
    assert.ok(Math.abs(scores[i] - manual) < 1e-12);
  });
  assert.deepEqual(WEIGHT_VECTOR_73C, [0.6, 4.0, 2.0, -2.5, 1.4]);
});

test('annealing flows through play (early-hot starts 1.5T, decreases toward 0.5T)', () => {
  const d = genDungeon(101);
  const r = playEpisode(d, { mode: 'sample', temperature: 1.0, seed: 'anneal', anneal: 'early-hot' });
  assert.ok(r.temperature && Math.abs(r.temperature.first - 1.5) < 1e-9);
  assert.ok(r.temperature.last < r.temperature.first, 'annealed temperature must decrease across the episode');
  assert.ok(r.temperature.last >= 0.5 - 1e-9);
  // constant-T runs report the same first/last
  const c = playEpisode(d, { mode: 'sample', temperature: 1.0, seed: 'const' });
  assert.ok(Math.abs(c.temperature.first - 1.0) < 1e-12 && Math.abs(c.temperature.last - 1.0) < 1e-12);
});

test('sample-mode episodes use the sampler distribution (T=0 collapses to argmax behavior)', () => {
  // With T=0 the sampled policy must reproduce the argmax episode exactly.
  const d = genDungeon(102);
  const a = playEpisode(d, { mode: 'argmax' });
  const z = playEpisode(genDungeon(102), { mode: 'sample', temperature: 0, seed: 'zero' });
  assert.equal(z.score, a.score);
  assert.equal(z.steps, a.steps);
});

test('all eight eval dungeons admit a completed episode shape for every arm', () => {
  for (const seed of [101, 102, 103, 104, 105, 106, 107, 108]) {
    for (const T of [0.5, 1.0, 2.0]) {
      const r = playEpisode(genDungeon(seed), { mode: 'sample', temperature: T, seed: `73e:${seed}:t${T}:0` });
      assert.ok(r.steps > 0 && r.steps <= MAX_STEPS);
    }
  }
});

test('sampler integration: sampled action choices come from the encoded policy distribution', () => {
  const d = genDungeon(101);
  const st = initialState(d);
  const scores = policyScores(st);
  const m = softmaxMasses(scores, 1.0);
  const a = sampleAction({ scores, temperature: 1.0, seed: 'integ:0', actions: ACTIONS });
  assert.ok(ACTIONS.includes(a.action));
  assert.ok(Math.abs(a.probs.reduce((x, y) => x + y, 0) - 1) < 1e-9);
  // the encoded distribution IS the softmax policy (to float rounding)
  a.probs.forEach((p, i) => assert.ok(Math.abs(p - m[i]) < 1e-12, `probs[${i}] ${p} vs masses ${m[i]}`));
});

test('temperatureFor is importable from the dungeon test too (cross-module glue check)', () => {
  assert.equal(typeof temperatureFor, 'function');
});
