// mothquantum-client.mjs — THE INTERFACE STUB.
//
// STATUS: STUBBED. Both mothquantum keys are BURNED-BY-EXPOSURE per the
// worklog incident record (waves ≤ 73). By lane order this module implements
// the EXACT call surface the fleet will use when fresh keys land — and every
// live path FAILS CLOSED with E_MOTHQUANTUM_UNAVAILABLE. Zero network I/O is
// performed by this module. Zero key material is read by this module.
//
// THE CALL SURFACE (mirrors the wave-63 receipts and the fleet's proven
// client, quilt-dba dba/mothqrc.mjs):
//
//   submitJob({engine, params})   POST  {base}/engines/{engine}/process
//                                 body {params} → 200/202
//                                 {job_id, status:"queued", submitted_at}
//                                 (wave-63 alternate: POST {base}/v1/jobs
//                                  {type:"comet",bits} → 202 same shape)
//   pollJob(jobId)                GET   {base}/jobs/{jobId}/status → {status}
//                                 terminal: completed | failed | cancelled
//   getResult(jobId)              GET   {base}/jobs/{jobId}/result
//                                 {$schema, result:{output:{raw:{counts},
//                                  provenance:{backend,mode,shots,engine,
//                                  readout}, pulse:{commitment,entropy,
//                                  extractor,...}, ...}}}
//   runJob({engine, params})      submit → poll → result (the fleet pattern,
//                                 429 backoff, hard timeout)
//   pulseSampling({scores|masses, temperature, seed, shots})
//                                 the qpixl-v1 policy-sampling job: amplitudes
//                                 encoded, decoded in one measurement pass.
//
// THE SWAP PATH (documented, one flag):
//   1. provision a fresh MOTHQUANTUM_API_KEY;
//   2. set LIVE_ENABLED = true below and restore the three fetch calls marked
//      [RESTORE-ON-KEYS] (their exact shapes are preserved in the comments);
//   3. call sites DO NOT CHANGE: runJob(..., {surrogate:false}) everywhere.
//   Until then: pass {surrogate:true} (or the CLI --surrogate flag) to route
//   the IDENTICAL call surface to the local micromoth sampler — labeled
//   live:false, surrogate:true everywhere it appears (a surrogate never
//   pretends to be quantum).

import { sampleBatch, circuitTag, VERSION as SAMPLER_VERSION } from './micromoth-sampler.mjs';

export const E_MOTHQUANTUM_UNAVAILABLE = 'E_MOTHQUANTUM_UNAVAILABLE';

/** THE SWAP FLAG. Flip to true ONLY when a fresh key is provisioned. */
export const LIVE_ENABLED = false;

export const BASE_CANDIDATES = [
  'https://api.mothquantum.com/api/v1',
  'https://api.mothquantum.com/v1',
];

export const CLIENT = {
  name: 'mothquantum-client',
  version: '1.0.0',
  state: 'STUBBED',
  keysBurned: 'both mothquantum keys burned-by-exposure (worklog incident record, waves ≤ 73); interface stubbed for the day fresh keys land',
  liveEnabled: LIVE_ENABLED,
  zeroNetwork: true, // this stub performs ZERO fetch calls and reads ZERO keys
  endpoints: {
    submit: (base, engine) => `${base}/engines/${engine}/process`,
    status: (base, jobId) => `${base}/jobs/${jobId}/status`,
    result: (base, jobId) => `${base}/jobs/${jobId}/result`,
  },
};

function failClosed(stage) {
  return {
    ok: false,
    stage,
    error: E_MOTHQUANTUM_UNAVAILABLE,
    httpStatus: null,
    jobId: null,
    liveEnabled: LIVE_ENABLED,
    detail: 'mothquantum keys burned-by-exposure; interface STUBBED — pass surrogate:true / --surrogate for the local micromoth sampler',
  };
}

// ── the stubbed call surface (live shapes preserved for [RESTORE-ON-KEYS]) ──

/**
 * [RESTORE-ON-KEYS] live body:
 *   for (const base of BASE_CANDIDATES) {
 *     const r = await fetch(CLIENT.endpoints.submit(base, engine), {
 *       method: 'POST',
 *       headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
 *       body: JSON.stringify({ params }),
 *     });
 *     if (r.status === 200 || r.status === 202) {
 *       const v = await r.json();
 *       return { ok: true, jobId: v.job_id, status: v.status, submittedAt: v.submitted_at, base };
 *     }
 *   }
 *   return failClosed('submit');
 */
export async function submitJob({ engine, params, surrogate = false, key = null } = {}) {
  if (surrogate) return surrogateSubmit({ engine, params });
  if (LIVE_ENABLED && key) {
    // unreachable until the swap: LIVE_ENABLED is const false in this stub
    throw new Error('E_SWAP_NOT_IMPLEMENTED — restore the [RESTORE-ON-KEYS] fetch body first');
  }
  return failClosed('submit');
}

/** [RESTORE-ON-KEYS] live body: GET {base}/jobs/{id}/status → {ok, status} */
export async function pollJob(jobId, { surrogate = false, key = null } = {}) {
  if (surrogate) return surrogatePoll(jobId);
  if (LIVE_ENABLED && key) throw new Error('E_SWAP_NOT_IMPLEMENTED — restore the [RESTORE-ON-KEYS] fetch body first');
  return failClosed('poll');
}

/** [RESTORE-ON-KEYS] live body: GET {base}/jobs/{id}/result → {ok, result} */
export async function getResult(jobId, { surrogate = false, key = null } = {}) {
  if (surrogate) return surrogateResult(jobId);
  if (LIVE_ENABLED && key) throw new Error('E_SWAP_NOT_IMPLEMENTED — restore the [RESTORE-ON-KEYS] fetch body first');
  return failClosed('result');
}

/**
 * The fleet's runJob orchestration (submit → poll → result), fail-closed.
 * surrogate:true routes the SAME orchestration to the local sampler and
 * returns the SAME envelope shape with live:false / surrogate:true labels.
 */
export async function runJob({ engine, params, surrogate = false, key = null, pollMs = 0 } = {}) {
  const submittedAt = new Date().toISOString();
  const sub = await submitJob({ engine, params, surrogate, key });
  if (!sub.ok) return { ...sub, submittedAt };
  const poll = await pollJob(sub.jobId, { surrogate, key });
  if (!poll.ok) return { ...poll, jobId: sub.jobId, submittedAt };
  const res = await getResult(sub.jobId, { surrogate, key });
  return {
    ...res,
    jobId: sub.jobId,
    submittedAt,
    completedAt: new Date().toISOString(),
    surrogate,
    live: false,
  };
}

/**
 * The qpixl-v1-shaped policy-sampling call. Live shape: submit a job whose
 * params carry the amplitude encoding; the device decodes in one measurement
 * pass and returns counts + provenance. Surrogate shape: identical envelope,
 * computed locally by micromoth-sampler.
 */
export async function pulseSampling({
  scores = null,
  masses = null,
  temperature = 1,
  seed,
  shots = 256,
  lattice = false,
  actions = null,
  surrogate = false,
  key = null,
} = {}) {
  if (!surrogate) {
    if (LIVE_ENABLED && key) throw new Error('E_SWAP_NOT_IMPLEMENTED — restore the [RESTORE-ON-KEYS] fetch body first');
    return failClosed('pulse-sampling');
  }
  const tag = circuitTag({ scores, masses, temperature, seed, shots, lattice, v: SAMPLER_VERSION });
  const batch = sampleBatch({ scores, masses, temperature, seed, shots, lattice });
  const counts = {};
  // re-key counts by action names when actions are provided (bitstrings kept too)
  for (const [bits, n] of Object.entries(batch.counts)) counts[bits] = n;
  const byAction = {};
  if (actions) {
    for (const [bits, n] of Object.entries(batch.counts)) {
      const idx = parseInt(bits, 2);
      const a = actions[idx] ?? `pad:${bits}`;
      byAction[a] = (byAction[a] || 0) + n;
    }
  }
  return {
    ok: true,
    jobId: `surrogate-${tag}`,
    engine: 'qpixl-v1-surrogate',
    surrogate: true,
    live: false,
    mock: false,
    submittedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    result: {
      $schema: 'https://api.mothquantum.com/schemas/JobResultOutputBody.json',
      result: {
        output: {
          policy_sample: {
            counts,
            ...(actions ? { counts_by_action: byAction } : {}),
            probs: batch.probs,
            temperature,
            shots,
            seed: String(seed),
          },
          raw: { counts },
          provenance: {
            backend: 'micromoth-surrogate',
            engine: 'micromoth-sampler',
            engine_version: SAMPLER_VERSION,
            mode: 'local-prng',
            shots,
            seed: String(seed),
            readout: 'counts',
            circuit_hash: tag,
            lattice,
            live: false,
            surrogate: true,
          },
        },
      },
    },
  };
}

// ── surrogate internals (same envelope shapes, local compute) ───────────────

function surrogateSubmit({ engine, params }) {
  const tag = circuitTag({ engine, params, v: SAMPLER_VERSION });
  return Promise.resolve({
    ok: true,
    jobId: `surrogate-${tag}`,
    status: 'completed',
    submittedAt: new Date().toISOString(),
    base: 'local://micromoth-surrogate',
  });
}

function surrogatePoll(jobId) {
  return Promise.resolve({ ok: true, status: 'completed', jobId, base: 'local://micromoth-surrogate' });
}

function surrogateResult(jobId) {
  // A bare getResult(surrogate) has no distribution to encode — it reports
  // the stub's identity honestly rather than fabricating counts.
  return Promise.resolve({
    ok: true,
    jobId,
    surrogate: true,
    live: false,
    result: {
      $schema: 'https://api.mothquantum.com/schemas/JobResultOutputBody.json',
      result: {
        output: {
          provenance: {
            backend: 'micromoth-surrogate',
            engine: 'micromoth-sampler',
            engine_version: SAMPLER_VERSION,
            mode: 'local-prng',
            readout: 'counts',
            live: false,
            surrogate: true,
          },
          note: 'bare result poll carries no distribution — use pulseSampling({surrogate:true}) for counts',
        },
      },
    },
  });
}

// ── CLI ─────────────────────────────────────────────────────────────────────
//   node src/mothquantum-client.mjs pulse-sampling --surrogate \
//        --scores=1.2,-0.4,2,0 --temperature=1 --seed=42 --shots=256 \
//        [--actions=U,R,D,L] [--lattice]
//   node src/mothquantum-client.mjs submit --engine=qpixl-v1 --params='{}'
// Exit codes: 0 ok · 2 usage · 3 E_MOTHQUANTUM_UNAVAILABLE (fail-closed).

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq === -1 ? a.slice(2) : a.slice(2, eq);
      out[k] = eq === -1 ? true : a.slice(eq + 1);
    } else out._.push(a);
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd) {
    console.error('usage: mothquantum-client.mjs <submit|pulse-sampling> [--surrogate] ...');
    return 2;
  }
  const surrogate = !!args.surrogate;
  if (cmd === 'submit') {
    let params = {};
    if (args.params) { try { params = JSON.parse(args.params); } catch { console.error('E_BAD_PARAMS'); return 2; } }
    const r = await submitJob({ engine: args.engine || 'qpixl-v1', params, surrogate });
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 3;
  }
  if (cmd === 'pulse-sampling') {
    const scores = args.scores ? args.scores.split(',').map(Number) : null;
    const masses = args.masses ? args.masses.split(',').map(Number) : null;
    if (!scores && !masses) { console.error('E_NO_DISTRIBUTION: pass --scores=a,b,c,d'); return 2; }
    const r = await pulseSampling({
      scores,
      masses,
      temperature: args.temperature !== undefined ? Number(args.temperature) : 1,
      seed: args.seed !== undefined ? (Number.isFinite(Number(args.seed)) && args.seed !== '' ? Number(args.seed) : String(args.seed)) : '73e',
      shots: args.shots ? Number(args.shots) : 256,
      lattice: !!args.lattice,
      actions: args.actions ? args.actions.split(',') : null,
      surrogate,
    });
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 3;
  }
  console.error(`usage: unknown command ${cmd}`);
  return 2;
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
