# SURROGATE.md — the MicroMoth surrogate: mechanism, fidelity, swap path

Wave-73 lane e. The principal's question, verbatim: *"how Mothquantum can
quickly find the stochastic answer once JEV has fine-tuned the weights of the
quilt's player-logic. and how once the ML is good enough through heavier
machinery, something like https://github.com/SuperInstance/MicroMoth-quilt can
be an engine for driving the ML without true mothquantum api calls."*

This document is the answer in four parts: the mechanism, the honest fidelity
table, the stub swap path, and the lineage — plus the pre-registered A/B that
measured the sampler against argmax.

---

## 1. The mechanism: a policy is a waveform; play is a measurement

After JEV tunes the player-logic weights (the 73-c waveform), the player must
turn a weight vector into *actions*. Argmax is the degenerate sampler — always
the peak, no exploration, brittle against plateaus and bump-loops. The
mothquantum shape is different and better:

1. **encode** — the per-action scores `(s_0..s_{K-1})` at temperature `T` are
   masses `m_i ∝ exp(s_i/T)`; the sampler encodes them as amplitudes
   `|α_i| = √m_i` on a `2^q` register (`encodeAmplitudes`, q = ⌈log2 K⌉).
   `encodeAngles` emits the conditional ry angles a real amplitude-loader
   would apply per (level, prefix block) — the qpixl-v1
   *numbers-as-waveform* move (wave-63 receipts: "amplitudes encoded as qubit
   angles, decoded in one measurement").
2. **measure** — one seeded collapse draws an outcome:
   - `measureExact` — joint Born rule + inverse-CDF walk, the exact
     MicroMoth `simulate(get='counts')` idiom;
   - `measureLattice` — the device-shaped walk: collapse qubit 0, renormalize,
     collapse qubit 1, … one seeded draw per level. Distributionally identical
     for non-negative real amplitudes (pinned: tests/sampler.test.mjs).
3. **anneal** — `temperatureFor` supports per-game-phase schedules
   (`early-hot`: 1.5T→0.5T across the episode; `late-hot`: mirrored), so
   exploration can be phased: hotter early, exploit late.

**Determinism law**: the seed is a call parameter everywhere
(`mulberry32`, FNV-1a-64-folded seeds). Same (weights, seed) → same samples,
byte for byte — pinned by tests, and the A/B receipts re-run byte-identical
(only the wall-clock `generatedAt` field differs). This *closes by
construction* the determinism hole MicroMoth-quilt's `docs/CELL-MAPPING.md`
names: micromoth's own `simulate(get='counts')` samples the **global unseeded
`random`**, so its collapse receipts are `EFFECT/UNSEALED`; the mapping's
resolution — *the seed is part of the cell's identity* (a WORLD witness
`{op:"WORLD", params:{seed, shots}}`) — is exactly what the sampler implements,
in the sampler's own JS cell of this repo.

Per dungeon step the player calls `sampleAction` once: fresh preparation, one
measurement — the physical shape. `sampleBatch` exists for statistics, not play.

### Where the engine runs

Everything above is **local**: no API, no queue, no key. A policy measurement
is microseconds. The mothquantum device becomes unnecessary for *this* class of
sampling because the circuit class is trivial — a categorical distribution
loaded into amplitudes and measured once. The surrogate is the engine that
drives the ML player while the heavy machinery (and fresh keys) mature.

---

## 2. The fidelity table (honest, per part 3 of the mission)

| property | local surrogate vs true mothquantum device | verdict |
|---|---|---|
| sampled distribution == softmax policy | Born rule over the encoded amplitudes **is** the categorical distribution — exact to float rounding; both measurement paths agree | **EXACT** |
| determinism under (weights, seed) | seeded mulberry32 collapse; replay reproduces samples byte-for-byte (the device's physical randomness is a *different* provenance, not a different distribution) | **EXACT** |
| lattice measurement statistics (non-negative amplitudes) | sequential per-qubit collapse ≡ joint inverse-CDF for this register class | **EXACT** |
| randomness provenance | device: physical QRNG (wave-63 comet receipts). surrogate: mulberry32 PRNG. Same distributions, different provenance — and the PRNG provenance is the feature the fleet determinism law wants | **APPROXIMATED** |
| hardware readout error / decoherence / crosstalk | modeled **none**. The wave-63 Bell witness shows real device spread (correlator σ ≈ 0.011 at 4096 shots; counts like 1774/1727 vs ideal 2048). The surrogate is noiseless | **APPROXIMATED (none modeled)** |
| amplitude-loading circuit depth & entanglement | not executed locally. `encodeAngles` emits the angles a loader would apply; only the *measurement statistics* are emulated, not gate-level execution | **NOT MODELED** |
| device latency, queueing, certified pulse receipts | commitment/extractor/entropy chains (wave-63 `pulse` block) exist only on the live API; surrogate provenance is local and immediate | **NOT MODELED** |

Two lines, as the mission asked: **exact** — the statistics a policy consumer
needs (the distribution and its determinism); **approximated** — everything
physical *around* the statistics (provenance, noise, latency, certification).
For driving an ML player, only the first row matters; rows 5–7 are what fresh
keys would one day add.

---

## 3. The stub: `mothquantum-client.mjs` and the swap path

Both mothquantum keys are **burned-by-exposure** (worklog incident record,
waves ≤ 73). Per lane order the interface is STUBBED, not deleted: the fleet's
future call surface is implemented and every live path fails closed with
`E_MOTHQUANTUM_UNAVAILABLE`. The module performs **zero network I/O** and reads
**zero key material** (pinned by a test that scans the module source).

The surface mirrors the receipts and the fleet's proven client:

| call | live wire (from wave-63 receipts + quilt-dba `dba/mothqrc.mjs`) |
|---|---|
| `submitJob({engine, params})` | `POST {base}/engines/{engine}/process` body `{params}` → 200/202 `{job_id, status:"queued", submitted_at}` (receipt `probe63_moth_job.json`: http 202, job `06884e96-…`) |
| `pollJob(jobId)` | `GET {base}/jobs/{jobId}/status` → `{status}`; terminal `completed\|failed\|cancelled` |
| `getResult(jobId)` | `GET {base}/jobs/{jobId}/result` → `{$schema, result:{output:{raw:{counts}, provenance:{backend,mode,shots,engine,readout}, pulse:{commitment,entropy,extractor,…}}}}` (receipt `probe63_moth_result.json`) |
| `runJob({engine, params})` | submit → poll → result, the fleet orchestration |
| `pulseSampling({scores\|masses, temperature, seed, shots})` | the qpixl-v1 policy-sampling job shape |

**The swap path (flip one flag, same call sites):**

1. provision a fresh `MOTHQUANTUM_API_KEY`;
2. in `src/mothquantum-client.mjs` set `LIVE_ENABLED = true` and restore the
   three fetch bodies marked `[RESTORE-ON-KEYS]` (their exact shapes are
   preserved as comments in the stub — endpoint builders are already live code);
3. call sites do not change. `runJob(...)` / `pulseSampling(...)` return the
   same envelope either way.

Until then, `surrogate: true` (or CLI `--surrogate`) routes the **identical**
call surface to the local sampler, labeled `live:false, surrogate:true,
mock:false` everywhere it appears — a surrogate never pretends to be quantum
(the E-D3 key doctrine, inherited from `dba/mothqrc.mjs`). Exit codes: 0 ok,
2 usage, 3 `E_MOTHQUANTUM_UNAVAILABLE`.

```bash
# fails closed (exit 3):
node src/mothquantum-client.mjs submit --engine=qpixl-v1
# runs locally (exit 0):
node src/mothquantum-client.mjs pulse-sampling --surrogate \
     --scores=1.2,-0.4,2,0 --temperature=1 --seed=42 --shots=256
```

---

## 4. The experiment: argmax vs sampled, pre-registered

Claims sealed **before** the eval ran (`claims/prereg-73e.json`, seal
`claims/prereg-73e.seal.json`, pushed in commit `04431a5` — the proof
timestamp; fleet-seeds `preregister@1` @ `ac1134d`):

- **P1** — T=1.0 sampling ≥ argmax on ≥ 5/8 eval seeds (exploration pays).
- **P2** — T=2.0 sampling < argmax on ≥ 5/8 seeds (over-exploration hurts);
  with P1, the temperature curve is single-peaked.

Setup: 8 eval seeds (101–108), one deterministic dungeon each (vendored core:
9×9, 4 gold, 3 traps, 60-step cap, rewards gold +2 / trap −2 / bump −0.5 /
exit +6); the authored 73-c baseline weight shape `[0.6, 4.0, 2.0, −2.5, 1.4]`
over features `[f_floor, f_exit, f_gold, f_trap, f_progress]`; sampled arms:
24 episodes per (seed, temperature), sampler seeds `73e:<seed>:<arm>:<ep>:<step>`.

### Results (receipts/eval-73e.json; verdict claims/prereg-73e.verdict.json)

| seed | argmax | T=0.5 | T=1.0 | T=2.0 | t1 ≥ argmax | t2 < argmax |
|---|---|---|---|---|---|---|
| 101 | 8.00 | 9.08 | 8.29 | 6.94 | ✓ | ✓ |
| 102 | 10.00 | 8.27 | 4.10 | 3.38 | ✗ | ✓ |
| 103 | **−19.00** | 5.54 | 6.46 | 2.90 | ✓ | ✗ |
| 104 | **−22.50** | −8.27 | −5.52 | −6.21 | ✓ | ✗ |
| 105 | **−27.50** | −10.98 | −2.44 | −6.19 | ✓ | ✗ |
| 106 | 8.00 | 0.88 | 4.29 | 3.50 | ✗ | ✓ |
| 107 | 4.00 | 5.35 | 5.77 | 4.40 | ✓ | ✗ |
| 108 | **−18.00** | 3.85 | 5.54 | 5.94 | ✓ | ✗ |

Mean curve: **argmax −7.125 → T=0.5 1.716 → T=1.0 3.313 (peak) → T=2.0 1.831**;
`curve.singlePeaked = 1`.

**Verdicts (scored from the seal only, no surgery):**

- **P1: PASS** — 6/8 seeds (≥ 5 required). Exploration pays.
- **P2: FAIL** — 3/8 seeds (< 5 required). An honest finding, and the reason
  is measured, not mysterious: on 4 of 8 seeds argmax is *catastrophic* —
  it enters a wall-bump loop (50–55 of 60 steps spent bumping, never exits,
  scores −18 to −27.5). Any sampled temperature rescues those seeds, so
  over-exploration cannot fall below the greedy baseline on ≥ 5 seeds. What
  P2 *did* get right is the curve's shape: T=2.0 < T=1.0 on **7/8 seeds** and
  on the means — the fall from the peak is real. The temperature curve is
  single-peaked with its peak exactly at T = 1.0, measured (`curve.singlePeaked = 1`).

Failure-mode receipts (argmax per-seed events): seeds 103/104/105/108:
`bumps 50–55, exit=false`; seed 107: no bumps but 60 aimless steps (plateau
oscillation), while sampled policy exits 24/24. The mechanism matches the
principal's framing: the greedy player has *no taste*, only a maximum.

Practical read for the fleet: sample at T ≈ 1.0; anneal (`early-hot`) is
available for phased play; T=0 is available as a self-check — the sampler with
T=0 *is* the argmax policy (pinned), so one code path drives both arms of any
future A/B.

---

## 5. Lineage (what was actually studied, commit-cited)

- **SuperInstance/MicroMoth-quilt** @ `014f1f293f62c82ae35b5763503930f3a9d7ecec`
  ("seal pin + selfplay widening", PR #32, main) — cloned and read in full at
  lane time:
  - `micromoth.py` (289 lines, the whole engine): statevector of 2ⁿ complex
    pairs; executable arity `{init, m, x, h, rx, rz, cx, crx, swap}` (`y`, `z`,
    `ry`, `t` decompose at append); **line 223** `probs = e[0]**2 + e[1]**2`
    (the Born rule the sampler ports); **lines 255–271** the per-shot
    inverse-CDF walk over probs (the collapse idiom) — driven by the global
    unseeded `random.random()`.
  - `docs/CELL-MAPPING.md` — quantum ops as quilt cells: BIND (circuit program),
    LINK (prev chain), EFFECT (collapse events), VIEW (pure looks),
    TICK (moments), WORLD (seeded shot sampling — "the honest home for
    counts"), PROOF (witness hash chain); the *determinism hole* and its
    resolution (seed as part of the cell's identity).
  - `tools/collapse_ledger.py` — seed-plumbed SEALED collapse receipts; the
    precedent for plumb-a-seed-and-receipt-the-collapse this sampler follows.
  - `README.md` — "the smallest quantum computing framework, taught to keep
    receipts"; standard library only.
- **wave-63 receipts** (this lane's own repo history):
  `scripts/probe63_moth_job.json` (submit: 202, `job_id`, `status:"queued"`,
  `submitted_at`), `scripts/probe63_moth_result.json` (result: counts,
  provenance, pulse, bell witness), `scripts/probe63.mjs` +
  `scripts/probe63d_mothpoll.mjs` (the endpoints).
- **quilt-dba `dba/mothqrc.mjs`** — the fleet's hardened moth client
  (submit/poll/result, 429 backoff, shape-tolerant normalization, the
  live/mock labeling doctrine).
- **fleet-seeds `tools/preregister.mjs`** @ `ac1134d9ff0e032687d1115e2d14f9b93cb8999a`
  — preregister@1, the seal primitive (claims → seal → push → run → score).
- **quilt-dungeons** — `GET /repos/SuperInstance/quilt-dungeons` → 404 at
  2026-10-02T21:49Z (also `quilt-dungeon`, `dungeon-quilt`). Minimal core
  vendored in `src/dungeon.js`, marked **VENDORED-PENDING-MERGE**; reconcile
  when upstream lands.

## 6. What would make the surrogate *more* exact

1. A readout-noise knob (per-qubit measurement-error probabilities — micromoth's
   own `noise_model` idiom) for robustness studies of the policy under device
   noise.
2. Phase-bearing amplitude loading (complex amplitudes) if policies ever need
   interference structure — not needed for categorical play.
3. Fresh keys: the certified-pulse provenance chain replaces the PRNG seed as
   the randomness receipt, and the fidelity table's NOT MODELED rows collapse
   into measured ones.
