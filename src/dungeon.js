// dungeon.js — VENDORED-PENDING-MERGE minimal quilt-dungeons core.
//
// PROVENANCE: GET /repos/SuperInstance/quilt-dungeons returned 404 at
// wave-73 lane-e time (2026-10-02T21:49Z, authenticated probe; sibling names
// `quilt-dungeon` and `dungeon-quilt` also 404), so this file vendors the
// minimal core contract this lane needs — deterministic grid-dungeon
// generation, an observe/step episode loop, and the 73-c baseline-shape
// policy feature rows. Marked VENDORED-PENDING-MERGE: reconcile against the
// upstream repo the day it lands; the contract pins kept minimal are
// genDungeon(seed) → observe(state) → step(state, action).
//
// Determinism law: everything below is a pure function of its seed/inputs.
// The dungeon rng is mulberry32 (same family as the sampler); the SAME PRNG
// family drives generation and play so the whole episode is replayable.

import { mulberry32, seedToU32, sampleAction, temperatureFor } from './micromoth-sampler.mjs';

export const DUNGEON_SIZE = 9;
export const MAX_STEPS = 60;
export const ACTIONS = ['U', 'R', 'D', 'L'];
export const DELTAS = { U: [-1, 0], R: [0, 1], D: [1, 0], L: [0, -1] };

// The 73-c baseline policy shape (authored stand-in for the JEV-tuned
// weights; the A/B experiments the SAMPLER given fixed weights, so the
// comparison is sampling-vs-argmax over identical weights).
export const FEATURE_NAMES = ['f_floor', 'f_exit', 'f_gold', 'f_trap', 'f_progress'];
export const BASELINE_WEIGHTS_73C = { f_floor: 0.6, f_exit: 4.0, f_gold: 2.0, f_trap: -2.5, f_progress: 1.4 };
export const WEIGHT_VECTOR_73C = FEATURE_NAMES.map((n) => BASELINE_WEIGHTS_73C[n]);

export const REWARDS = { gold: 2, trap: -2, bump: -0.5, exit: 6 };

function floodReachable(grid, size, sr, sc) {
  const seen = new Set([`${sr},${sc}`]);
  const queue = [[sr, sc]];
  const out = [];
  while (queue.length) {
    const [r, c] = queue.shift();
    out.push([r, c]);
    for (const [dr, dc] of [[-1, 0], [0, 1], [1, 0], [0, -1]]) {
      const nr = r + dr, nc = c + dc;
      const k = `${nr},${nc}`;
      if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue;
      if (grid[nr][nc] === '#' || seen.has(k)) continue;
      seen.add(k);
      queue.push([nr, nc]);
    }
  }
  return out;
}

/**
 * genDungeon(seed) → { seed, size, grid, start, exit, gold:Set, traps:Set, attempt }.
 * grid cells: '#' wall, '.' floor. Deterministic per seed; bounded regen
 * attempts if the roll is not connected enough (each attempt re-seeds the
 * same PRNG family, so the whole procedure is replayable).
 */
export function genDungeon(seed, opts = {}) {
  const size = opts.size ?? DUNGEON_SIZE;
  const goldCount = opts.gold ?? 4;
  const trapCount = opts.traps ?? 3;
  const baseSeed = seedToU32(`dungeon:${seed}`);
  for (let attempt = 0; attempt < 64; attempt++) {
    const rng = mulberry32((baseSeed ^ Math.imul(attempt + 1, 0x9e3779b9)) >>> 0);
    const grid = Array.from({ length: size }, (_, r) =>
      Array.from({ length: size }, (_, c) => (r === 0 || c === 0 || r === size - 1 || c === size - 1 ? '#' : '.'))
    );
    for (let r = 1; r < size - 1; r++) {
      for (let c = 1; c < size - 1; c++) {
        if (r === 1 && c === 1) continue; // start stays clear
        if (rng() < 0.16) grid[r][c] = '#';
      }
    }
    const reach = floodReachable(grid, size, 1, 1);
    if (reach.length < 24) continue;
    let exit = null, best = -1;
    for (const [r, c] of reach) {
      const d = Math.abs(r - 1) + Math.abs(c - 1);
      if (d > best) { best = d; exit = [r, c]; }
    }
    const pool = reach.filter(([r, c]) => !(r === 1 && c === 1) && !(r === exit[0] && c === exit[1]));
    const gold = new Set();
    for (let g = 0; g < goldCount && pool.length; g++) {
      const i = Math.floor(rng() * pool.length);
      gold.add(`${pool[i][0]},${pool[i][1]}`);
      pool.splice(i, 1);
    }
    const traps = new Set();
    for (let t = 0; t < trapCount && pool.length; t++) {
      const i = Math.floor(rng() * pool.length);
      traps.add(`${pool[i][0]},${pool[i][1]}`);
      pool.splice(i, 1);
    }
    return { seed: String(seed), size, grid, start: [1, 1], exit, gold, traps, attempt };
  }
  throw new Error('E_DUNGEON_GEN_FAILED');
}

export function initialState(dungeon) {
  return {
    dungeon,
    pos: [...dungeon.start],
    steps: 0,
    score: 0,
    done: false,
    exitReached: false,
    goldLeft: new Set(dungeon.gold),
  };
}

/**
 * observe(state) → per-action feature rows in ACTIONS order:
 * [f_floor, f_exit, f_gold, f_trap, f_progress].
 * f_progress = sign(manhattan(cur→exit) − manhattan(target→exit)) ∈ {−1,0,1}.
 */
export function observe(state) {
  const { dungeon, pos } = state;
  const [er, ec] = dungeon.exit;
  const d0 = Math.abs(pos[0] - er) + Math.abs(pos[1] - ec);
  return ACTIONS.map((a) => {
    const [dr, dc] = DELTAS[a];
    const r = pos[0] + dr, c = pos[1] + dc;
    const inb = r >= 0 && c >= 0 && r < dungeon.size && c < dungeon.size;
    const wall = !inb || dungeon.grid[r][c] === '#';
    const d1 = Math.abs(r - er) + Math.abs(c - ec);
    return [
      wall ? 0 : 1,                                // f_floor
      !wall && r === er && c === ec ? 1 : 0,       // f_exit
      dungeon.gold.has(`${r},${c}`) ? 1 : 0,       // f_gold
      dungeon.traps.has(`${r},${c}`) ? 1 : 0,      // f_trap
      Math.sign(d0 - d1),                          // f_progress
    ];
  });
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function policyScores(state, weights = WEIGHT_VECTOR_73C) {
  return observe(state).map((f) => dot(f, weights));
}

/** First-index argmax in fixed ACTIONS order — the deterministic tie-break. */
export function argmaxAction(scores) {
  let bi = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
  return ACTIONS[bi];
}

/** One environment step. Mutates state; returns {event, delta}. */
export function step(state, action) {
  if (state.done) return { event: 'done', delta: 0 };
  if (!DELTAS[action]) throw new TypeError('E_BAD_ACTION');
  const [dr, dc] = DELTAS[action];
  const r = state.pos[0] + dr, c = state.pos[1] + dc;
  const inb = r >= 0 && c >= 0 && r < state.dungeon.size && c < state.dungeon.size;
  const wall = !inb || state.dungeon.grid[r][c] === '#';
  let event = 'move';
  let delta = 0;
  if (wall) {
    event = 'bump';
    delta = REWARDS.bump;
  } else {
    const key = `${r},${c}`;
    state.pos = [r, c];
    if (state.goldLeft.has(key)) {
      state.goldLeft.delete(key);
      event = 'gold';
      delta = REWARDS.gold;
    } else if (state.dungeon.traps.has(key)) {
      event = 'trap';
      delta = REWARDS.trap;
    } else if (r === state.dungeon.exit[0] && c === state.dungeon.exit[1]) {
      event = 'exit';
      delta = REWARDS.exit;
      state.exitReached = true;
      state.done = true;
    }
  }
  state.score += delta;
  state.steps += 1;
  if (state.steps >= MAX_STEPS) state.done = true;
  return { event, delta };
}

/**
 * playEpisode(dungeon, policy) → {score, steps, exitReached, events}.
 * policy: {mode:'argmax'} — the 73-c baseline shape; or
 *         {mode:'sample', temperature, seed, lattice?, anneal?} — the
 *         micromoth surrogate. Every step encodes the current policy state
 *         as amplitudes and takes ONE seeded measurement (the qpixl
 *         "decode in one measurement" shape; a fresh preparation per step).
 */
export function playEpisode(dungeon, policy) {
  const state = initialState(dungeon);
  const events = { gold: 0, trap: 0, bump: 0, move: 0, exit: 0 };
  let temperatures = [];
  while (!state.done) {
    const scores = policyScores(state);
    let action;
    if (policy.mode === 'argmax') {
      action = argmaxAction(scores);
    } else if (policy.mode === 'sample') {
      const T = temperatureFor({
        temperature: policy.temperature,
        step: state.steps,
        totalSteps: MAX_STEPS,
        anneal: policy.anneal ?? null,
      });
      temperatures.push(T);
      // One seeded measurement per step: the seed binds (policy seed, episode
      // step) ONLY — replaying the episode re-derives it from state.steps, so
      // the episode is a pure function of (dungeon, policy) with no hidden
      // global state.
      action = sampleAction({
        scores,
        temperature: T,
        seed: `${policy.seed}:${state.steps}`,
        lattice: !!policy.lattice,
        actions: ACTIONS,
      }).action;
    } else {
      throw new TypeError('E_BAD_POLICY_MODE');
    }
    const { event } = step(state, action);
    events[event] = (events[event] || 0) + 1;
  }
  const T0 = temperatures[0] ?? null;
  const Tn = temperatures[temperatures.length - 1] ?? null;
  return {
    score: state.score,
    steps: state.steps,
    exitReached: state.exitReached,
    events,
    temperature: T0 === null ? null : { first: T0, last: Tn },
  };
}
