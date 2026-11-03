# Changelog

Entries are read by pi 1.5.0 and shown under "Extension Updates" on the first fresh
launch after the package version grows. Headings must stay in the `## [x.y.z]` form —
pi's parser (`dist/utils/changelog.js`) only recognises a version triple.

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
