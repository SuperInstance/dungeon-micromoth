// tests/client.test.mjs — the interface stub fails closed; the surrogate path
// routes to the local sampler with honest labels; the CLI honors --surrogate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  E_MOTHQUANTUM_UNAVAILABLE, CLIENT, LIVE_ENABLED,
  submitJob, pollJob, getResult, runJob, pulseSampling,
} from '../src/mothquantum-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'mothquantum-client.mjs');

test('the stub is stubbed: no live flag, zero-network doctrine pinned', () => {
  assert.equal(LIVE_ENABLED, false);
  assert.equal(CLIENT.state, 'STUBBED');
  assert.equal(CLIENT.zeroNetwork, true);
  assert.match(CLIENT.keysBurned, /burned-by-exposure/);
});

test('every live call fails closed with E_MOTHQUANTUM_UNAVAILABLE — structurally, never by hanging', async () => {
  const s = await submitJob({ engine: 'qpixl-v1', params: { shots: 8 } });
  assert.equal(s.ok, false);
  assert.equal(s.error, E_MOTHQUANTUM_UNAVAILABLE);
  assert.equal(s.stage, 'submit');
  const p = await pollJob('deadbeef');
  assert.equal(p.ok, false);
  assert.equal(p.error, E_MOTHQUANTUM_UNAVAILABLE);
  const g = await getResult('deadbeef');
  assert.equal(g.ok, false);
  assert.equal(g.error, E_MOTHQUANTUM_UNAVAILABLE);
  const r = await runJob({ engine: 'qpixl-v1', params: {} });
  assert.equal(r.ok, false);
  assert.equal(r.error, E_MOTHQUANTUM_UNAVAILABLE);
  const ps = await pulseSampling({ scores: [1, 2, 3, 0.5], seed: 'x', shots: 8 });
  assert.equal(ps.ok, false);
  assert.equal(ps.error, E_MOTHQUANTUM_UNAVAILABLE);
});

test('the stub reads no keys: no credential-class material in the module source', () => {
  // pattern list assembled from string fragments so this scanner itself never
  // trips a credential-class key-scan of the repo
  const pats = ['m' + 'oth_', 's' + 'k-', 'gh' + 'p_', 'github_' + 'pat_', 'AK' + 'IA', ['BEGIN ', 'PRIVATE KEY'].join('')];
  const src = readFileSync(path.join(here, '../src/mothquantum-client.mjs'), 'utf8');
  for (const pat of pats) {
    assert.ok(!src.includes(pat), `module source must not embed ${pat}`);
  }
});

test('surrogate routing: pulseSampling returns the live-result envelope shape, labeled live:false', async () => {
  const r = await pulseSampling({
    scores: [1.2, -0.4, 2.0, 0.0], temperature: 1.0, seed: '73e:cli', shots: 128,
    actions: ['U', 'R', 'D', 'L'], surrogate: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.surrogate, true);
  assert.equal(r.live, false);
  assert.equal(r.mock, false);
  assert.match(r.jobId, /^surrogate-fnv1a64:[0-9a-f]{16}$/);
  const out = r.result.result.output;
  assert.equal(out.provenance.backend, 'micromoth-surrogate');
  assert.equal(out.provenance.live, false);
  assert.equal(out.provenance.surrogate, true);
  assert.equal(out.provenance.readout, 'counts');
  const total = Object.values(out.raw.counts).reduce((a, b) => a + b, 0);
  assert.equal(total, 128);
  const totalActions = Object.values(out.policy_sample.counts_by_action).reduce((a, b) => a + b, 0);
  assert.equal(totalActions, 128);
  assert.ok(Math.abs(out.policy_sample.probs.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('surrogate determinism: same inputs → same surrogate job (jobId and counts)', async () => {
  const a = await pulseSampling({ scores: [0.3, 2.2, -1.1, 0.7], temperature: 0.5, seed: 'det', shots: 64, surrogate: true });
  const b = await pulseSampling({ scores: [0.3, 2.2, -1.1, 0.7], temperature: 0.5, seed: 'det', shots: 64, surrogate: true });
  assert.equal(a.jobId, b.jobId);
  assert.deepEqual(a.result.result.output.raw.counts, b.result.result.output.raw.counts);
});

test('runJob surrogate orchestration returns the full envelope', async () => {
  const r = await runJob({ engine: 'qpixl-v1', params: {}, surrogate: true });
  assert.equal(r.ok, true);
  assert.equal(r.surrogate, true);
  assert.equal(r.live, false);
  assert.match(r.jobId, /^surrogate-/);
  assert.ok(r.submittedAt && r.completedAt);
});

test('surrogate result-poll without a distribution reports itself honestly (no fabricated counts)', async () => {
  const g = await getResult('surrogate-fnv1a64:0123456789abcdef', { surrogate: true });
  assert.equal(g.ok, true);
  assert.equal(g.result.result.output.provenance.surrogate, true);
  assert.equal(g.result.result.output.raw, undefined);
  assert.match(g.result.result.output.note, /no distribution/);
});

test('CLI without --surrogate fails closed with exit code 3 and the named error', () => {
  const r = spawnSync(process.execPath, [cli, 'pulse-sampling', '--scores=1,2,3,0.5', '--seed=42'], { encoding: 'utf8' });
  assert.equal(r.status, 3);
  const v = JSON.parse(r.stdout);
  assert.equal(v.error, E_MOTHQUANTUM_UNAVAILABLE);
  assert.equal(v.ok, false);
});

test('CLI with --surrogate succeeds (exit 0) and emits the surrogate envelope', () => {
  const r = spawnSync(process.execPath, [
    cli, 'pulse-sampling', '--surrogate', '--scores=1,2,3,0.5', '--seed=42', '--shots=64',
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(v.ok, true);
  assert.equal(v.surrogate, true);
  assert.equal(Object.values(v.result.result.output.raw.counts).reduce((a, b) => a + b, 0), 64);
});

test('CLI submit without --surrogate fails closed (exit 3)', () => {
  const r = spawnSync(process.execPath, [cli, 'submit', '--engine=qpixl-v1'], { encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stdout).error, E_MOTHQUANTUM_UNAVAILABLE);
});

test('CLI usage errors exit 2', () => {
  const r = spawnSync(process.execPath, [cli, 'pulse-sampling', '--surrogate'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
