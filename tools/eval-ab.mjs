#!/usr/bin/env node
// eval-ab.mjs — THE EXPERIMENT (wave-73 lane e).
//
// A/B on eval seeds 101–108: the argmax policy (73-c baseline shape) vs the
// micromoth-sampled policy at temperatures {0.5, 1.0, 2.0}.
//
// Claims (sealed in claims/prereg-73e.json BEFORE this run):
//   P1  T=1.0 sampling ≥ argmax on ≥ 5/8 seeds   (exploration pays)
//   P2  T=2.0 < argmax on ≥ 5/8 seeds            (over-exploration hurts;
//                                                 with P1 ⇒ single-peaked curve)
//
// Determinism: dungeons are genDungeon(seed); sampled episodes bind their
// sampler seed to `73e:<seed>:<arm>:<ep>` + the step index; argmax episodes
// are pure. Re-running this tool byte-reproduces the receipts.
//
// Usage: node tools/eval-ab.mjs [--out=receipts/eval-73e.json]
//        [--seeds=101,102,...] [--episodes=24]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { genDungeon, playEpisode, WEIGHT_VECTOR_73C, MAX_STEPS } from '../src/dungeon.js';
import { VERSION as SAMPLER_VERSION, FIDELITY } from '../src/micromoth-sampler.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

const outPath = path.join(root, arg('out', 'receipts/eval-73e.json'));
const seeds = (arg('seeds', '101,102,103,104,105,106,107,108')).split(',').map((s) => parseInt(s, 10));
const EPISODES = parseInt(arg('episodes', '24'), 10);
const TEMPERATURES = [0.5, 1.0, 2.0];
const EPS = 1e-9;

const generatedAt = new Date().toISOString();
const arms = { argmax: { perSeed: {} } };

for (const seed of seeds) {
  // argmax arm: deterministic, so run twice and assert identity (a live pin,
  // not a trust-me).
  const d1 = genDungeon(seed);
  const a1 = playEpisode(d1, { mode: 'argmax' });
  const a2 = playEpisode(genDungeon(seed), { mode: 'argmax' });
  if (a1.score !== a2.score || a1.steps !== a2.steps || a1.exitReached !== a2.exitReached) {
    throw new Error(`E_ARGMAX_NONDETERMINISTIC seed=${seed}`);
  }
  arms.argmax.perSeed[seed] = { score: a1.score, steps: a1.steps, exitReached: a1.exitReached, events: a1.events };
}

for (const T of TEMPERATURES) {
  const arm = `t${T}`;
  arms[arm] = { temperature: T, perSeed: {} };
  for (const seed of seeds) {
    const episodes = [];
    for (let ep = 0; ep < EPISODES; ep++) {
      const dungeon = genDungeon(seed);
      const r = playEpisode(dungeon, {
        mode: 'sample',
        temperature: T,
        seed: `73e:${seed}:${arm}:${ep}`,
      });
      episodes.push({ ep, score: r.score, steps: r.steps, exitReached: r.exitReached, events: r.events });
    }
    const mean = episodes.reduce((s, e) => s + e.score, 0) / episodes.length;
    const exits = episodes.filter((e) => e.exitReached).length;
    arms[arm].perSeed[seed] = { mean, episodes, exits };
  }
}

// ── metrics (exactly what the sealed claims score) ──────────────────────────

function seedsWhere(cmp) {
  let n = 0;
  const per = {};
  for (const seed of seeds) {
    const am = arms.argmax.perSeed[seed].score;
    const t1 = arms['t1'].perSeed[seed].mean;
    const t2 = arms['t2'].perSeed[seed].mean;
    const ok1 = t1 >= am - EPS;
    const ok2 = t2 < am - EPS;
    per[seed] = { argmax: am, t1Mean: t1, t2Mean: t2, t1GeArgmax: ok1, t2LtArgmax: ok2 };
    if (cmp === 'p1' ? ok1 : ok2) n++;
  }
  return { n, per };
}

const p1 = seedsWhere('p1');
const p2 = seedsWhere('p2');

// pooled score std across ALL sampled episodes (the vacuity guard: if the
// temperature knob moved nothing anywhere, the run did not discriminate).
const allScores = [];
for (const T of TEMPERATURES) {
  for (const seed of seeds) for (const e of arms[`t${T}`].perSeed[seed].episodes) allScores.push(e.score);
}
const mu = allScores.reduce((a, b) => a + b, 0) / allScores.length;
const std = Math.sqrt(allScores.reduce((a, b) => a + (b - mu) ** 2, 0) / allScores.length);

// curve means over seeds: argmax (T=0), t0.5, t1, t2
const curve = ['argmax', 't0.5', 't1', 't2'].map((a) => {
  const vals = seeds.map((s) => (a === 'argmax' ? arms.argmax.perSeed[s].score : arms[a].perSeed[s].mean));
  return vals.reduce((x, y) => x + y, 0) / vals.length;
});
function singlePeaked(vals) {
  // weak unimodality: rises (non-strictly) to the first max, then falls.
  let k = 0;
  for (let i = 1; i < vals.length; i++) if (vals[i] > vals[k]) k = i;
  for (let i = 0; i < k; i++) if (vals[i + 1] < vals[i] - 1e-12) return false;
  for (let i = k; i < vals.length - 1; i++) if (vals[i + 1] > vals[i] + 1e-12) return false;
  return true;
}

const metrics = {
  'p1.seedsWon': p1.n,
  'p2.seedsBelow': p2.n,
  'curve.means.argmax': curve[0],
  'curve.means.t0.5': curve[1],
  'curve.means.t1.0': curve[2],
  'curve.means.t2.0': curve[3],
  'curve.singlePeaked': singlePeaked(curve) ? 1 : 0,
  'ab.sampledScoreStdMax': std,
};

const results = {
  experiment: '73-e micromoth surrogate A/B — argmax vs sampled policy',
  generatedAt,
  determinism: 'dungeon=genDungeon(seed); sampled episodes bind seed 73e:<seed>:<arm>:<ep>; rerun reproduces byte-identical receipts',
  config: {
    seeds,
    episodesPerSampledArm: EPISODES,
    temperatures: TEMPERATURES,
    weights: WEIGHT_VECTOR_73C,
    featureNames: ['f_floor', 'f_exit', 'f_gold', 'f_trap', 'f_progress'],
    rewards: { gold: 2, trap: -2, bump: -0.5, exit: 6 },
    maxSteps: MAX_STEPS,
    anneal: null,
    samplerVersion: SAMPLER_VERSION,
  },
  arms,
  perSeed: { p1: p1.per, p2: p2.per },
  metrics,
  evidence: {
    prereg: 'claims/prereg-73e.json',
    seal: 'claims/prereg-73e.seal.json',
    verdict: 'claims/prereg-73e.verdict.json',
    fidelityTable: FIDELITY,
    curveReading: `mean score by temperature: argmax=${curve[0].toFixed(3)}, T0.5=${curve[1].toFixed(3)}, T1.0=${curve[2].toFixed(3)}, T2.0=${curve[3].toFixed(3)}; singlePeaked=${singlePeaked(curve)}`,
  },
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(results, null, 2) + '\n');

const metricsPath = outPath.replace(/\.json$/, '-metrics.json');
fs.writeFileSync(metricsPath, JSON.stringify({ metrics, evidence: { receipt: path.relative(root, outPath) } }, null, 2) + '\n');

console.log('seed  argmax    T0.5    T1.0    T2.0   t1>=am  t2<am');
for (const seed of seeds) {
  const p = p1.per[seed];
  console.log(
    `${seed}  ${p.argmax.toFixed(2).padStart(6)}  ${arms['t0.5'].perSeed[seed].mean.toFixed(2).padStart(6)}  ${p.t1Mean.toFixed(2).padStart(6)}  ${p.t2Mean.toFixed(2).padStart(6)}  ${String(p.t1GeArgmax).padStart(6)}  ${String(p.t2LtArgmax).padStart(5)}`
  );
}
console.log(`\ncurve: argmax=${curve[0].toFixed(3)} T0.5=${curve[1].toFixed(3)} T1.0=${curve[2].toFixed(3)} T2.0=${curve[3].toFixed(3)} singlePeaked=${singlePeaked(curve)}`);
console.log(`metrics: ${JSON.stringify(metrics)}`);
console.log(`receipt: ${outPath}\nmetrics: ${metricsPath}`);
