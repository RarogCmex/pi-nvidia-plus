# Changelog

Entries are read by pi 1.5.0 and shown under "Extension Updates" on the first fresh
launch after the package version grows. Headings must stay in the `## [x.y.z]` form —
pi's parser (`dist/utils/changelog.js`) only recognises a version triple.

## [0.6.0] — 2026-11-28

**Two curated model cards added** for live NIM chat ids pi does not ship, so they
become selectable (Node 26.10, `tsc` clean, 27/27 offline test files):

- **`mistralai/mistral-large-4-1t-a52b`** — Mistral Large 4 (1T/52B-active MoE,
  text + image). Card: `contextWindow`/`maxTokens` `1 048 576` (live 400-oracle:
  the vendor's printed `262 144` output cap is not enforced; only the shared
  `prompt + output ≤ 1 048 576` budget rejects), native `reasoning_effort`
  (`low`/`medium`/`high`, always reasons → `none`/`off` 400, `off` hidden).
- **`moonshotai/kimi-k3.1-pro`** — Kimi K3.1 Pro (3T-class MoE, text + image).
  Card: `contextWindow` `1 048 576`, `maxTokens` `65 536` (vendor doc), native
  `reasoning_effort` (`low`…`max`, forced reasoner). **Caveat: the model does
  not generate right now** (hangs on every route/egress), so its thinking
  contract is vendor-documented, not probe-verified — see README Limitations.

Both entries live in `models` (not `modelOverrides`) because the ids are absent
from pi 1.7.0's built-in nvidia catalog; `test/overrides-schema.test.ts` 1b
reddens the moment pi ships either id (the entry then moves to `modelOverrides`,
the same migration as `minimax-m3.1-flash`/`kimi-k3`). A new test block 3h pins
both cards. Evidence: [research/17](research/17-catalog-sync-2026-11-28.md) §7.

## [0.5.2] — 2026-11-28

**Endpoint re-probe (2026-11-28) and data re-verification on pi 1.7.0** (Node 26.10,
`tsc` clean, 27/27 offline test files). No behavioural code change — the catalog
values were re-confirmed rather than edited:

- **Catalog re-confirmed.** The live `/v1/models` snapshot (30 ids, 14 chat / 16
  non-chat) still matches pi 1.7.0's 11 built-in nvidia cards (byte-identical to
  1.6.1), so `overrides/models.json`, `DEAD_MODELS` and the thinking maps are
  unchanged.
- **`DEAD_MODELS` fully re-probed.** Keyless 410 probing re-confirmed all 44 dated
  entries; the three `404 in every probe` ids (`google/gemma-3-4b-it`,
  `google/gemma-3-12b-it`, `nvidia/cosmos-reason2-8b`) were re-confirmed as
  account-scoped NVCF-layer 404s with valid keys.
- **`max_tokens` ceiling is now gateway-wide `1 048 576`.** The 400-oracle no longer
  varies per model (`ultra`/`nano-omni` now validate too; `mistral-large-4-1t-a52b`
  no longer accepts 20 000 000) — a change from research 11/16, recorded for the
  record; nothing in the extension hardcodes a higher budget.
- **Keyless provider table.** `deepseek` moved from `expectation: "any"` to
  `"json"` (its 401 now carries `application/json`), tightening proxy-interstitial
  detection; `together` and `cohere` stay `any`.
- **`z-ai/glm-5.3-flash` regressed to an all-routes hang** (every body, egress and
  key on 2026-11-28 after a `200` on 2026-11-26) — documented in Limitations; the
  override is kept in case the route recovers.

Evidence: [research/17](research/17-catalog-sync-2026-11-28.md).

## [0.5.1] — 2026-11-27

**Re-verified on pi 1.7.0** (Node 26.10, `tsc` clean, 27/27 offline test files).
pi 1.7.0 removes install-telemetry (`/api/report-install`,
`enableInstallTelemetry`, `PI_TELEMETRY`) — this extension never read those APIs,
and no hook it uses (`session_start`, `model_select`, `thinking_level_select`,
`before_provider_request`, `after_provider_response`, `message_end`) changed for
the `nvidia` provider. pi 1.7.0 touches no nvidia id, so the catalog,
`overrides/models.json` and `DEAD_MODELS` are unchanged; no live probe needed.

## [0.5.0] — 2026-11-27

**Catalog sync (2026-11-26 snapshot) and re-verification on pi 1.6.1** (Node 26.10,
`tsc` clean, 27/27 offline test files and 4/4 `acceptance:agent-dir` assertions):

- **Nemotron 3.5 / 3-ultra moved to native `reasoning_effort` (`NEMOTRON_NATIVE_EFFORT`).**
  Live retesting showed `chat_template_kwargs.enable_thinking` is accepted (HTTP 200)
  but does not toggle reasoning on `nvidia/nemotron-3-ultra-550b-a55b`,
  `nvidia/nemotron-3.5-lightning-30b-a3b`, or `nvidia/nemotron-3.5-super-vl-120b-a12b`,
  whereas top-level `reasoning_effort` works across the full NIM `none…max` scale
  (`"off"` → 400). `NEMOTRON_THINKING_MODELS` now keeps only ids where
  `enable_thinking` is proven to switch thinking (`nemotron-3.5-bolt-e4b`,
  `nemotron-3-nano-omni-30b-a3b-reasoning`, `nemotron-3-nano-30b-a3b`); the three
  `NEMOTRON_NATIVE_EFFORT` ids get `compat.supportsReasoningEffort: true` and
  `off→none`, `minimal…max→identity` in `overrides/models.json`, no injected
  `chat_template_kwargs`, and the new `planCaveatNemotronNativeEffort` status caveat.
- **Dead models and pruned overrides (`DEAD_MODELS`, `overrides/models.json`).**
  Keyless 410 re-probing updated 17 `404 in every probe` entries to exact EOL dates
  (`2026-11-15` / `2026-09-01`) and retired five models removed from `/v1/models` and
  pi 1.6.1's built-in catalog: `nvidia/nemotron-3-super-120b-a12b` (`2026-10-03`),
  `google/diffusiongemma-26b-a4b-it` (`2026-11-12`), `deepseek-ai/deepseek-v4.1-flash`
  (`2026-11-16`), `openai/gpt-oss-20b` (`2026-11-18`), and `meta/muse-glimmer-30b`
  (`2026-11-24`). Their overrides were removed (leaving 7 live `modelOverrides` plus
  1 curated card for `nvidia/nemotron-3.5-bolt-e4b`).
- **Non-chat discovery filter.** Added narrow `/\bgliner/i` pattern to
  `NON_CHAT_PATTERNS` so `fastino/gliner2-pii` (NER extraction, HTTP 422) is filtered
  out from `/nvidia-plus discover`.
- **Tooling & docs.** `scripts/agent-dir-acceptance.mjs` ignores concurrent live
  session/cache files in `~/.pi/agent` while strictly asserting on config/ledger
  files; `scripts/probe-catalog-fields.mjs` updated for the live catalog;
  `research/16-catalog-sync-2026-11-26.md`, `research/14`, `research/README.md`, and
  `README.md` updated to match.

## [0.4.1] — 2026-11-03

**Re-verified against pi 1.5.0** (2026-11-03): `tsc -p tsconfig.typecheck.json`
clean (tsc 5.9.3) and all 27 offline test files green, Node 26.10. This release
carries no provider-behaviour change: it is the 1.5.0 host migration plus the first
`CHANGELOG.md`, which pi now reads by default from the package root
(`pi.changelogPath` is therefore not set).

- **Fixed — the one real 1.5.0 break for this package.** pi 1.5.0 added
  `minimaxai/minimax-m3.1-flash` to its built-in nvidia catalog. The extension's
  own `models` entry for that id then became a *shadow*: pi applies a `models`
  entry by replacement, so the built-in card's `inputLimits` image-resize box and
  its measured `maxTokens`/headers would have been dropped.
  `test/overrides-schema.test.ts` caught it (`shadowed` was
  `['minimaxai/minimax-m3.1-flash']`). The card's deltas moved to
  `modelOverrides` — `supportsReasoningEffort: true`, the identity
  `thinkingLevelMap` (`off`→`none`), the vendor sampling pair and the display
  name — which pi merges per key (`compat` via `mergeCompat`). This is the same
  migration already made for `kimi-k3` and `deepseek-v4.1-flash`; the `models`
  array now holds only `nvidia/nemotron-3.5-bolt-e4b`, which pi 1.5.0 does not
  ship.
- **Not adopted from 1.5.0, deliberately.** The tool-schema change is moot (the
  extension registers no tools), `Usage.cost.totalFromProvider` and
  `responseModel` are filled by the host runtime, `keyText()`/`keyHint()` need a
  custom tool renderer, `blocked` on `ctx.ui.custom()` needs an inline custom UI,
  `pi.exec()` is never called, and the GPT-6.1 Terra / models.dev v2 /
  default-model swaps are host catalogs. `collapseChangelog` is a host setting
  and starts working on its own now that the changelog exists.
- **Docs.** README's verification section gains the 1.5.0 run, the minimax move
  and the reasons each 1.5.0 feature does or does not reach this extension.

## [0.4.0] — 2026-10-22

Catalog sync: 21 ids, `nvidia/nemotron-3.5-super-vl-120b-a12b` as the default,
NIM attribution headers moved into pi-ai's client identity. Re-verified on
pi 1.3.0 / 1.4.0; the extension's own `deepseek-v4.1-flash` card was removed
because pi's built-in card became fuller.

## [0.3.2] — 2026-10-13

Re-verified on pi 1.2.0: typecheck, tests and the agent-dir acceptance were green
without code changes; the newly published `models.json` schema covers every field
the extension writes.

## [0.3.1] — 2026-10-06

Re-verified on pi 1.0.4; one test line needed `?? ""` because `@types/node`
26.6.4's `assert.ok` no longer accepts `string | undefined` as the message.

## [0.3.0] — 2026-10-05

The status line shows the `reasoning_effort` that actually reaches NIM; kimi-k3
sends a valid effort; research 06 added exact EOL dates, keyless oracles and a
degenerate-output detector; starcoder stays out of chat discovery.

## [0.2.2] — 2026-09-30

State paths resolve through pi's `getAgentDir()`, so `$PI_CODING_AGENT_DIR` is
honoured; the npm package name is documented.

## [0.2.1] — 2026-09-30

Agent-dir wording corrected; paths follow `$PI_CODING_AGENT_DIR`.

## [0.2.0] — 2026-09-22

Compatibility with pi 0.87.0; native SOCKS5 in the proxy pool; the proxy-pool
ring, intake seam and audit tooling.

## [0.1.0] — 2026-09-18

Publication readiness: README, LICENSE, cross-platform `npm test`.

## [0.0.1] — 2026-08-26

Initial goal: an extension that improves the built-in nvidia provider.
