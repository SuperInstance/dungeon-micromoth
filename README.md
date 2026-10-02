# dungeon-micromoth

**The MicroMoth SURROGATE engine — a local, quantum-flavored stochastic policy
sampler for the quilt dungeons. No API. No keys. No network. Local compute only.**

This repo is the working answer to the principal's wave-73 question: *after JEV
has fine-tuned the weights of the quilt's player-logic, how does the player
SAMPLE actions stochastically — exploration with taste — and how can something
like [SuperInstance/MicroMoth-quilt](https://github.com/SuperInstance/MicroMoth-quilt)
become an engine for driving that ML **without** true mothquantum API calls?*

Three parts:

| part | file | what it is |
|---|---|---|
| the sampler | [`src/micromoth-sampler.mjs`](src/micromoth-sampler.mjs) | encode action weights → amplitudes → **seeded measurement collapse** (mulberry32). The mothquantum shape — amplitude-encoded distribution, measurement collapse — computed locally. |
| the stub | [`src/mothquantum-client.mjs`](src/mothquantum-client.mjs) | the EXACT call surface the fleet will use when fresh mothquantum keys land (job submit, pulse sampling, result poll). Every live call **fails closed** with `E_MOTHQUANTUM_UNAVAILABLE`; `--surrogate` routes the identical surface to the local sampler. |
| the experiment | [`tools/eval-ab.mjs`](tools/eval-ab.mjs) + [`claims/`](claims/) | pre-registered A/B: argmax policy vs sampled policy at temperatures {0.5, 1.0, 2.0} on eval seeds 101–108. Claims sealed **before** the eval ran (fleet-seeds `preregister@1`). |

The mechanism doc — fidelity table, stub swap path, MicroMoth lineage — is
[`docs/SURROGATE.md`](docs/SURROGATE.md).

## The stochastic policy problem

An argmax player is greedy and brittle: it oscillates on plateaus, never takes
the off-path gold pocket, and cannot escape a bump-loop it is stuck in. The
73-c JEV tuning produces *weights*; turning weights into play needs a
**sampler**: draw actions from the policy distribution instead of always taking
the peak. The mothquantum shape for this is beautiful and simple:

1. **encode** — softmax(weights/T) gives per-action masses; the sampler encodes
   them as amplitudes |α_i| = √p_i on a 2^q register (`encodeAmplitudes`), the
   same numbers-as-waveform move as the live qpixl-v1 engine;
2. **measure** — one seeded collapse draws an outcome (`measureExact`, the
   MicroMoth inverse-CDF idiom; or `measureLattice`, the device-shaped
   qubit-by-qubit walk — pinned distributionally identical);
3. **anneal** — temperature can vary by game phase (`temperatureFor`).

**Determinism law** (the fleet's, and CELL-MAPPING's): the same (weights, seed)
always yields the same samples. MicroMoth's own `simulate(get='counts')` has the
famous *determinism hole* — it samples the global unseeded `random`. The
surrogate closes the hole by construction: the seed is part of the call, a
WORLD-witness parameter, exactly as `docs/CELL-MAPPING.md` prescribes.

## Try it

```bash
node --test tests/            # 35 pins
node src/mothquantum-client.mjs pulse-sampling --surrogate \
     --scores=1.2,-0.4,2,0 --temperature=1 --seed=42 --shots=256
node tools/eval-ab.mjs        # re-runs the A/B, byte-identical receipts
```

```js
import { sampleAction } from './src/micromoth-sampler.mjs';
sampleAction({ scores: [1.2, -0.4, 2.0, 0.0], temperature: 1.0, seed: '73e:101:0', actions: ['U','R','D','L'] });
// → { index: 2, bits: '10', action: 'D', probs: [...], temperature: 1 }   (always, for this seed)
```

## When fresh keys land

Do **not** rewrite call sites. The swap is one flag plus the marked fetch
bodies — see [`docs/SURROGATE.md` § The swap path](docs/SURROGATE.md).

## Lineage & provenance

- **MicroMoth-quilt** @ `014f1f293f62c82ae35b5763503930f3a9d7ecec` — the engine
  studied and ported (Born rule, inverse-CDF collapse, cell-mapping, seeded
  collapse receipts). MIT/Apache-2.0 lineage credited in NOTICE.
- **quilt-dungeons** — upstream repo not yet public at lane time (GET 404 on
  2026-10-02T21:49Z); the minimal core is **vendored** in
  `src/dungeon.js`, marked VENDORED-PENDING-MERGE.
- **mothquantum receipts** — the call surface mirrors the wave-63 receipts
  (`probe63_moth_job.json` / `probe63_moth_result.json`) and the fleet's
  proven client (quilt-dba `dba/mothqrc.mjs`).
- **Preregistration** — fleet-seeds `tools/preregister.mjs` @ `ac1134d`
  (preregister@1). Claims: `claims/prereg-73e.json`; seal: `claims/prereg-73e.seal.json`;
  verdict: `claims/prereg-73e.verdict.json`.

Zero external model calls were made in this lane. Both mothquantum keys are
burned-by-exposure per the worklog incident record — this repo never reads,
stores, or transmits key material.
