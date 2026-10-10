# pi-nvidia-plus

npm package: `@rarogcmex/pi-nvidia-plus`.

Pi extension that improves the built-in `nvidia` provider **in place** — no duplicate provider, no forking of the streaming pipeline. You keep selecting `nvidia/...` models with the NVIDIA API key pi already uses; the extension only fixes what the built-in provider can't do.

[pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`) is the coding agent this extension plugs into. It ships a built-in `nvidia` provider for NVIDIA NIM (`https://integrate.api.nvidia.com`); this extension hooks that provider rather than replacing it, so pi's own auth, streaming, retries and cost attribution are untouched.

> ⚠️ **Two families this extension was built around are now end-of-life on NIM.** DeepSeek V4 (`deepseek-ai/deepseek-v4-flash-0731`, `-pro-0813`) was deprecated 2026-09-19 and is unsupported after 2026-09-21; MiniMax M3 (`minimaxai/minimax-m3`) returns 410. The thinking mappings for both are still shipped, but selecting either model produces a "reported dead" warning. See [Limitations](#limitations).

> 🇷🇺 Русскоязычным пользователям: все сообщения расширения двуязычны (см. `PI_NVIDIA_PLUS_LANG` ниже). Документация ниже — на английском, как принято для GitHub; вопросы можно задавать на любом языке.

## What it fixes

1. **Thinking control.** The built-in catalog marks almost all models as `supportsReasoningEffort: false`, so `--thinking high` is silently dropped. This extension injects thinking parameters per model family via `before_provider_request`:
   - Nemotron 3.x → `chat_template_kwargs.enable_thinking` (+ `low_effort`)
   - GLM (`z-ai/glm*`) → `enable_thinking` / `clear_thinking` + `reasoning_effort`
   - DeepSeek V4 → `chat_template_kwargs.thinking` / `reasoning_effort` *(family is EOL on NIM — kept for the ids that still answer)*
   - MiniMax M3 → `thinking_mode: disabled | adaptive | enabled` *(id returns 410)*
   - Gemma 4 → thinking is **force-disabled at every level** (see [Limitations](#limitations))
   - Explicit **off** really disables thinking where the model thinks by default.
2. **Stale catalog.** Dead models (HTTP 410/404 on the live NIM endpoint) produce warnings instead of silent failures; missing live models can be added via `/nvidia-plus discover`.
3. **Request normalization.** Text content-arrays are flattened to strings for older models; a default `max_tokens` is set when the model requires it.
4. **Per-provider proxy pool.** `NVIDIA_NIM_PROXIES` (or `NVIDIA_NIM_PROXIES_FILE`, default `~/.pi/agent/nvidia-proxies.json`, legacy single `NVIDIA_NIM_PROXY`) route only `https://integrate.api.nvidia.com` through your exits; other providers are untouched. Each request pins one exit for its whole key/retry circle; a dead CONNECT goes to a 60 s quarantine, and `/nvidia-plus proxy check` measures latency and pins the fastest reachable exit.
5. **Diagnostics.** `retry-after` and request IDs for 429/5xx are surfaced during pi's retry pauses.
6. **Transparent in-band retry.** NIM sometimes answers an overloaded request with **HTTP 200** whose SSE stream carries `data: {"error":{"message":"Service temporarily overloaded"}}`. Both status-keyed layers (transport 429/5xx retry, key rotation) miss it, so it surfaces as a `stopReason: error` turn that pi's own retry layer hands straight to the model. The extension sniffs the first SSE event and transparently re-issues the request (3 retries, 5 s→30 s backoff), so pi and the model never see it. On exhaustion pi gets the original error unchanged. Toggle with `NVIDIA_NIM_TRANSPORT_RETRY`.
7. **Truncated-stream detection.** NIM can drop an SSE stream mid-generation (typically on long thinking output or a gateway timeout): the stream ends without a `finish_reason` chunk and pi-ai throws `Stream ended without finish_reason`. pi retries this itself, so the extension only acts when retries are exhausted and the truncated message is finalized — it counts such streams in `/nvidia-plus status` and shows one throttled warning per minute with hints (lower thinking level, switch proxy exit, retry).
8. **Degenerate-output detection.** NIM can also return a *successful* response — HTTP 200, `finish_reason` present, `usage` correct — whose content is garbage: a repetition collapse (`42424242…`, `The!!!!…`), a leaked special token (`<|close|>`), or an empty answer with `finish_reason: stop` (reasoning-channel degeneration). No transport layer can see this, and a transparent retry would duplicate output, so the extension observes finalized messages (`message_end`), counts them in `/nvidia-plus status` and shows one throttled warning per minute per model. The hints distinguish the two empty answers: `stop` means *repeat the request* (raising `max_tokens` does not help), `length` means *the budget was eaten by reasoning* (raise `max_tokens` or lower the thinking level). The detector is a pure offline classifier (zlib compressibility < 0.08, single-character share > 0.75, special-token pattern) calibrated on real collapsed responses and live legitimate corpora (prose 0.41, JSON 0.16, collapses 0.007–0.009) — see [`research/06-gateway-recon-keyless-oracles.md`](research/06-gateway-recon-keyless-oracles.md) §4.

## Installation

Requirements: **Node ≥ 22.19** — the floor is the host's: pi's own `engines.node` is `>=22.19.0` (measured on 0.87.0 and 1.0.0). TypeScript runs directly (type stripping and `.ts` test discovery are unflagged from 22.18; Node 24+ also works) and [pi](https://github.com/earendil-works/pi) must be installed.

```bash
pi install git:github.com/RarogCmex/pi-nvidia-plus@main

# from source (for development)
git clone https://github.com/RarogCmex/pi-nvidia-plus.git
cd pi-nvidia-plus
node scripts/link-pi.mjs   # only for dev (tests / typecheck)
```

The extension self-applies its model overrides on first session start (into `~/.pi/agent/models.json`, ledger in `~/.pi/agent/nvidia-plus-models.json`). It never overwrites your manual edits without `force`.

Every `~/.pi/agent/…` path in this README means **pi's agent dir**, resolved with pi's own `getAgentDir()`: `$PI_CODING_AGENT_DIR` when set, `~/.pi/agent` otherwise (a rebranded pi distribution changes the default too). The extension reads and writes only that directory — it does not hardcode your home directory, so it works under an alternate config dir and never touches the default one behind your back.

## Authentication

The extension registers **no provider and no credential of its own** — it uses
whatever pi's built-in `nvidia` provider already uses:

- `NVIDIA_API_KEY=nvapi-…` in the environment, or
- pi's stored credential: `/login` inside pi, then pick `nvidia`; pi keeps it in
  `~/.pi/agent/auth.json`.

Keys are issued at <https://build.nvidia.com> (NVIDIA API Keys). Nothing in this
extension reads, writes or logs the key value; the optional key **pool** below is
a separate, read-only file you maintain yourself.

### Key pool (optional)

`NVIDIA_NIM_KEYS` / `NVIDIA_NIM_KEYS_FILE` (default `~/.pi/agent/nvidia-keys.json`)
add extra `nvapi-…` keys that the extension rotates to when the active key hits a
429 bucket or a 401/403. Your pi credential is always first in the ring. The
extension only reads the file — the one deliberate exception is
`/nvidia-plus keys cleanup-dead`, which rewrites it after a confirmed zero-
generation sweep removed only proven-dead keys (timestamped backup next to
the file, mode 0600). See [Configuration](#configuration).

## Models

The extension does not add a model list of its own — pi's built-in `nvidia`
catalog stays authoritative. Two things are layered on top:

**1. Metadata overrides** (`overrides/models.json`, applied to
`~/.pi/agent/models.json` by `/nvidia-plus apply`, automatically on session
start). Ten ids carry `reasoning: true` plus a `thinkingLevelMap`, which is what
makes pi's `--thinking <level>` selector reachable for them at all:

| id | pi level → injected |
|---|---|
| `nvidia/nemotron-3-super-120b-a12b` | `off`→off · `minimal`/`low`→low · `medium`…`max`→on |
| `nvidia/nemotron-3-ultra-550b-a55b` | same |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | same |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | same |
| `moonshotai/kimi-k3` | native `reasoning_effort` (`supportsReasoningEffort: true`): `off`→none · `minimal`/`low`/`medium`/`high`/`xhigh`/`max`→identity. NIM accepts only `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` — `off` is a 400, and omitting the field (the built-in default) leaves kimi reasoning unbounded, so `off` must send `none` (unlike `gpt-oss-20b`, where omitting is safe). Probed live 2026-10-05. |
| `z-ai/glm-5.3`, `z-ai/glm-5.3-flash` | same |
| `openai/gpt-oss-20b` | native `reasoning_effort`: `off`→omitted · `minimal`→low · `xhigh`/`max`→high |
| `poolside/laguna-xs-2.1` | `reasoning: true` + reasoning-content compat flags |
| `deepseek-ai/deepseek-v4-flash-0731` | `supportsReasoningEffort: true` — **id is EOL on NIM**, the override is kept for the ids that still answer |

**2. Per-request injection** (`extensions/transform.ts`), which covers families
rather than individual ids — so a model pi has never seen still gets the right
wire parameters if its id matches a family prefix:

| family (id prefix) | injected | verified |
|---|---|---|
| `nvidia/nemotron-3*`, `nvidia/nemotron-3.5*` | `chat_template_kwargs.enable_thinking`, `low_effort` at `minimal`/`low` | live probes |
| `z-ai/glm*` | `enable_thinking` + `clear_thinking`, `reasoning_effort` (`high`/`max`) | **hypothesis** — extrapolated from the family, not probed per id |
| `deepseek-ai/deepseek-v4*` | `chat_template_kwargs.thinking` + `reasoning_effort` | probed 2026-08-28 (family now EOL) |
| `minimaxai/minimax-m3` | `thinking_mode: disabled \| adaptive \| enabled` | id returns 410 |
| `google/gemma-4*` | `enable_thinking=false` at **every** level | live probes — see Limitations |

`/nvidia-plus status` (and the live status line) print the exact thinking
parameter that reaches NIM for the selected model and level. For hook-driven
families that is the injected `chat_template_kwargs`/`reasoning_effort`; for
native-path models (`moonshotai/kimi-k3`, `openai/gpt-oss-20b`) it is the
`reasoning_effort` pi derives from the applied `thinkingLevelMap` (e.g. kimi
`off` → `reasoning_effort="none"`), so you can verify the requested level against
what actually goes upstream without `PI_NVIDIA_PLUS_DEBUG=1`. `/nvidia-plus
discover` adds live ids that pi's catalog is missing (it never adds an id the
dead-model list already knows about).

## Usage

All commands live under one root to keep the command menu clean:

| Command | Description |
|---|---|
| `/nvidia-plus status` | Current model, thinking level, what the hook injects; proxy / rotation / retry state |
| `/nvidia-plus apply [force]` | Apply catalog overrides to `models.json` (own IDs only; `force` overwrites conflicts) |
| `/nvidia-plus rollback` | Remove the extension's entries from `models.json` (ledger-based, your edits are kept) |
| `/nvidia-plus discover` | Live `GET /v1/models` discovery: add new chat models, flag missing known ones |
| `/nvidia-plus keys` | Key-pool status |
| `/nvidia-plus keys check` | Probe each pool key against the selected nvidia model |
| `/nvidia-plus keys auth-check` | Validate every pool key with **zero generation** (research 09): auth runs before the model-function lookup, so 403 = dead, 404-for-account = alive. A `dead` verdict is re-probed before it counts |
| `/nvidia-plus keys cleanup-dead` | Remove the keys `auth-check` proved dead from the keys file (timestamped backup, mode 0600, `$VAR` entries untouched; refuses if more than half looks dead — that means the oracle broke, not the pool) |
| `/nvidia-plus keys on\|off` | Toggle key rotation for the live session |
| `/nvidia-plus proxy` | Proxy-pool settings panel: source, pin, ring state, each endpoint's state + last latency |
| `/nvidia-plus proxy check` | Probe every exit (`GET /v1/models` through each) and pin the fastest reachable |
| `/nvidia-plus proxy pin <host:port>` | Lock an exit for the session (no full check) |
| `/nvidia-plus proxy on\|off` | Toggle the automatic ring pick (`off` locks the current pin) |

Tab-completion covers subcommands and their arguments (including `proxy pin <host:port>` ids from the current pool).

## Configuration

### Environment variables

| Variable | Description |
|---|---|
| `NVIDIA_NIM_PROXY` | Legacy single proxy URL (or `host:port`) used **only** for `integrate.api.nvidia.com`. Lowest-priority source; a pool of one. Unset (and no pool) = direct. Schemes: `http`/`https` CONNECT and `socks5`/`socks5h`/`socks` (see below). |
| `NVIDIA_NIM_PROXIES` | Comma-separated proxy-URL pool (highest priority). Each value `http://[user:pass@]host:port` or `socks5://[user:pass@]host:port`. |
| `NVIDIA_NIM_PROXIES_FILE` | Path to `{"proxies": ["http://…"]}` pool file. Values support `$VAR` / `${VAR}` interpolation. |
| `NVIDIA_NIM_PROXY_ROTATION` | `0`/`false`/`no`/`off` disables the automatic ring pick (the current pin stays locked). Default: on. |
| `NVIDIA_NIM_SHARED_PROXY` | `0` disables the cross-process shared cooldown file (`~/.pi/agent/nvidia-proxies-state.json`). Default: enabled. |
| `NVIDIA_NIM_PROXY_FALLBACK_DIRECT` | `1`/`true`/`yes`/`on` allows going direct **only when the pool is empty** (never when endpoints are merely in cooldown). Default: off — an empty pool refuses to leak your origin IP. |
| `NVIDIA_NIM_KEYS` | Comma-separated key pool for rotation (one-off runs). |
| `NVIDIA_NIM_KEYS_FILE` | Path to `{"keys": ["nvapi-…"]}` pool file. Default: `~/.pi/agent/nvidia-keys.json`. Values support `$VAR` / `${VAR}` interpolation. |
| `NVIDIA_NIM_KEY_ROTATION` | `0`/`false`/`no`/`off` disables rotation. Default: enabled when a pool is configured. |
| `NVIDIA_NIM_SHARED_ROTATION` | `0` disables cross-process shared state (`~/.pi/agent/nvidia-keys-state.json`). Default: enabled. |
| `NVIDIA_NIM_TRANSPORT_RETRY` | `0` disables transparent retries — both 429/5xx **and** in-band `Service temporarily overloaded` (HTTP 200 + SSE error event). Default: enabled (3 retries each). |
| `PI_NVIDIA_PLUS_DEBUG` | `1` writes final payloads to `nvidia-plus-debug.log` in pi's agent dir (`~/.pi/agent/` by default). |
| `PI_NVIDIA_PLUS_LANG` | `ru` or `en`. Overrides `LC_ALL` / `LC_MESSAGES` / `LANG` detection. |

### Key pool file

```json
{ "keys": ["nvapi-…", "$ENV_VAR", "${ENV_VAR}"] }
```

The extension only **reads** this file. Your pi API key stays first in the rotation ring; pool keys follow. `chmod 600` is recommended (on Windows the check is skipped — NTFS ACLs of your profile directory apply).

### Proxy pool file

```json
{ "proxies": ["http://$PROXY_USER:$PROXY_PASS@us.exit.example:10001", "http://127.0.0.1:8870"] }
```

Exactly one source wins — `NVIDIA_NIM_PROXIES` > `NVIDIA_NIM_PROXIES_FILE` > the default file `~/.pi/agent/nvidia-proxies.json` (only if it exists) > the legacy single `NVIDIA_NIM_PROXY`. They are never merged. The extension only **reads** this file (hot-reload on `mtime`; a broken or vanished file keeps the last good pool and warns once); `chmod 600` is recommended since URLs may carry credentials.

Per request to NIM the ring picks one **pin** — a sticky exit for the whole inner key/retry circle. A dead CONNECT (including SOCKS handshake/auth failures) goes to a 60 s **quarantine** (TTL, not a permanent denylist); 429/401/403/5xx and in-band overload never rotate the proxy (those are key/transport buckets). `/nvidia-plus proxy check` measures latency on a cheap `GET /v1/models` through each exit and pins the fastest reachable one. In notifications, status, logs and the shared state file every exit appears only as its display identity `host:port` — credentials are never written.

**`host:port` must be unique in the pool.** Display identity is what pinning, the shared quarantine file and the status panel key on, so two entries that differ only by credentials are the *same* exit as far as the ring is concerned: `hrefForDisplay` resolves to the first match and a display-keyed cooldown lands on both. Rotating gateways sold as several identities behind one host (for example two different accounts on `p.webshare.io:80`) therefore cannot coexist — `npm run proxies:add` reports such a candidate as a display conflict and skips it unless you pass `--replace-display` to swap the credentials of the existing entry.

**SOCKS5** is served by undici's native `Socks5ProxyAgent`, which needs **undici ≥ 8.9** — the copy pi bundles decides whether it is available (pi 0.87.1 bundles undici 8.10.2). It is experimental: Node prints one `ExperimentalWarning` per process. `socks5h://` is normalized to `socks5://`: the native client always hands the hostname to the proxy (remote DNS), so the `h` distinction is degenerate for NIM. `socks4://` and other schemes are rejected with a parse error. On an older pi whose undici lacks `Socks5ProxyAgent`, a socks entry gets a clear error and is quarantined — the rest of the pool keeps working.

## How it works

**Hook-only architecture (no `registerProvider`):** the built-in `nvidia` provider's auth, streaming, retries and attribution stay untouched.

- **Behavior as code** — `before_provider_request` (thinking injection, normalization); a selective global dispatcher (proxy, transparent retry, key rotation, observability).
- **Metadata as data** — overrides in `overrides/models.json` (pi's `models.json` format), applied to `~/.pi/agent/models.json` by the extension's command; the extension owns only its own IDs.

The design evidence behind these choices — pi's provider surface, a live audit
of the NIM catalog, the thinking-format mappings per family, and the proxy
mechanics — is written up in [`research/`](research/); start at
[`research/README.md`](research/README.md).

## Limitations

- **Dead models warn, they do not disappear.** `DEAD_MODELS`
  (`extensions/dead-models.ts`) is a point-in-time audit (keyed probes of
  2026-08-26 and 2026-09-18; keyless 410 re-probe of 2026-10-05 turned the
  410 entries into exact end-of-life dates). NIM retires ids without notice, so
  the list is always behind reality; selecting a listed id produces a warning
  naming the probe evidence, and an id that died *after* the audit fails the
  ordinary way.
  Both headline thinking families this extension was built for are on that list
  (DeepSeek V4, MiniMax M3).
- **Gemma 4 cannot think.** In thinking mode `google/gemma-4*` hangs — no
  response within the 120 s header timeout at any of plain / `reasoning_effort`
  / `enable_thinking=true`; with `chat_template_kwargs.enable_thinking=false` it
  answers in ~2 s. The extension therefore force-disables thinking at every
  level, including `--thinking high`. That is deliberate: the alternative is an
  unusable model.
- **GLM mappings are unverified hypotheses.** `z-ai/glm*` injection is
  extrapolated from the family, not probed id by id. If an upstream rejects
  `chat_template_kwargs`, the request 400s.
- **kimi-k3 is flaky on NIM and slow.** Live probes of 2026-10-05
  ([`research/07`](research/07-kimi-k3-thinking-probe.md)) show `moonshotai/kimi-k3`
  takes ~2–4 min even for a one-word answer and, on a trivial prompt, returns a
  repetition collapse (`content: null`, `reasoning_content: "The!!!…"`,
  `finish_reason: stop`) in roughly half of completed runs — **independent of the
  reasoning level** (`none`, `low` and the built-in default all collapse). This is
  a model-side fault, not a mapping artifact: the extension sends the valid NIM
  variant (`off`→`none`; `off`→`"off"` was an HTTP 400 and the built-in map was
  inert), and the degenerate-output detector (§8 above) catches each collapse and
  tells you to repeat the request. No `reasoning_effort` value makes kimi-k3
  reliable; if it collapses, retry.
- **Billing is out of scope.** The extension does not read, estimate or report
  NIM cost; pi's own cost accounting for the `nvidia` provider is untouched.
- **Overrides are per-id, not per-family.** An id absent from
  `overrides/models.json` still gets request-level injection if its family
  matches, but pi's UI will not offer a thinking selector for it until the
  override adds `reasoning: true` + `thinkingLevelMap`.
- **Side files in pi's agent dir** (`~/.pi/agent/` by default, `$PI_CODING_AGENT_DIR`
  when set). `nvidia-plus-models.json` (the ownership
  ledger), `nvidia-plus-discovered.json` (discover results),
  `models.json.bak-pi-nvidia-plus` (pre-apply backup), `nvidia-keys-state.json`
  and `nvidia-proxies-state.json` (cross-process shared state). `/nvidia-plus
  rollback` removes the extension's `models.json` entries using the ledger.

## Development

```bash
npm test                       # cross-platform runner (Linux / macOS / Windows)
npm run typecheck
npm run check                  # both
```

Opt-in scripts — the acceptance and bench scripts spend real NIM quota, so none
of them run under `check`:

```bash
npm run acceptance:proxy-pool  # drives the proxy ring against real exits
npm run proxies:audit          # strict health sweep of the pool file (keyless, no quota)
npm run proxies:providers      # re-measure the provider probe table itself (direct or --via host:port)
npm run proxies:add -- --candidates /tmp/list.json --egress --write
                               # intake new exits: 3 probes in a row, all must pass
npm run proxies:audit -- --providers nvidia,openrouter,groq --rounds 2
                               # matrix "exit × provider": which exits serve which APIs
npm run proxies:prune -- --drop host:port[,host:port…] --write
npm run keys:auth-check        # zero-generation validity sweep of the keys pool
npm run keys:cleanup-dead       # remove the dead keys (backup, 0600, guards)
npm run proxies:normalize -- --write
                               # canonical form + host:port dedupe of the pool file
npm run discover               # live GET /v1/models outside a pi session (keyless = no quota)
node scripts/discover-models.mjs --probe-routes --probe-eol [--direct]
                               # keyless oracles (research/06 §1): chat-route ground truth
                               # for every live model and exact EOL dates for DEAD_MODELS.
                               # No authorization header is sent, so no key quota is spent.
npm run bench:proxies          # A/B the same probe set across several exits (needs the env below)
NVIDIA_API_KEY=nvapi-… PROXY_AB_LIST='[{"name":"a","url":"http://host:1080","type":"…","country":"…","asn":"…"}]' \
  npm run bench:proxies
```

`proxies:*` (`scripts/proxy-pool-audit.mjs`) spend **no key quota** — the probe
is a keyless `GET /v1/models`, the same one `/nvidia-plus proxy check` uses —
but they do need network, so they stay out of `check`. The intake decisions live
in a pure seam, `extensions/proxy-intake.ts`, covered offline by
`test/proxy-intake.test.ts`; the script only does I/O. Acceptance gate: every
exit must answer **all** `--rounds` probes (3 by default) within `--timeout`
(20 s — the budget the real request path gives), and is rejected as slow only
when **all** rounds exceed `--slow-ms` (12 s), since NIM itself can be sticky.
There are deliberately no retries inside a round: a retry hides a hang, and one
lucky answer out of three is not stability. The probe latency says nothing about
chat latency — `GET /v1/models` involves neither prefill nor generate, where NIM
can take 30 s and 15–30 s more. Reports land in the gitignored `test-results/`
and contain only `host:port` masks, never credentials; the pool file is written
with mode 0600 and a timestamped `.bak-*` copy next to it.

The same tool probes **other providers**, not only NIM: `--providers` takes any
of the 16 keyless catalog endpoints in its table (OpenAI, Anthropic, OpenRouter,
Google, Groq, DeepInfra, Together, Mistral, DeepSeek, xAI, Cerebras, SambaNova,
Cohere, Fireworks, Hugging Face), `--target URL` adds a custom one, and
`--require <id>` names the provider whose verdict decides (default: the first
requested). Everything else is reported as a note, so a provider that is
geo-blocked behind an exit does not disqualify an exit that serves NIM fine.
Each table entry carries the statuses it answers with (`okStatuses`) — a 401/403
means "the service answered, the tunnel is alive", while a 404 means the probe
URL itself went stale and is reported as `mismatch`, not as a bad exit.
`npm run proxies:providers` re-measures the whole table on demand, which is how
the stale `fireworks` URL was caught (`/v1/models` → 404 JSON "Path not found";
the working path is `/inference/v1/models`). Three providers answer a keyless
request with a non-JSON body (Together 401 text/plain, DeepSeek 401 with no
content-type, Cohere 403 text/html); those are marked `expectation: "any"` and
pinned by status instead, which is weaker against a proxy's own interstitial and
documented as such in the table.

`keys:auth-check` / `keys:cleanup-dead` (`scripts/keys-audit.mjs`) are the CLI
twins of the same oracle: no generation, no key quota, decisions from the pure
seam in `extensions/key-check.ts` (`classifyKeyAuthProbe`, `planKeyCleanup`),
probe model taken from the live keyless catalog on every run — a hardcoded
model id would rot and start 404-ing before auth, silently turning every key
alive (research/09).

One acceptance script spends nothing, needs no network, and runs in CI on every
push — so it is safe to run by hand:

```bash
PI_CODING_AGENT_DIR=$(mktemp -d) npm run acceptance:agent-dir
```

It starts a real `pi --list-models nvidia` twice — without the extension
(the control: it proves `models.json` is ours, not pi's) and with it — then
asserts on what landed on disk: the ownership ledger must exist with
`enabled: true`, the number of applied overrides must equal the number in
`overrides/models.json` (today 10; the assertion reads the file rather than
hardcoding the count), and `$HOME/.pi/agent` must be unchanged, file by file,
name+size+mtime. The script refuses to start if `PI_CODING_AGENT_DIR` is unset
or overlaps the real agent dir, so it cannot be pointed at a live config by
accident.

This is the class of defect the unit tests cannot see: `test/store.test.ts`
resolves paths under a substituted `$PI_CODING_AGENT_DIR` but never writes, and
before v0.2.2 the store hardcoded `homedir() + ".pi/agent"` — a pi started with a
non-default config dir got no overrides *and* the user's real `models.json` was
touched. Putting that hardcode back reddens 3 of the 4 assertions (measured
2026-10-01). The runs use `--offline` because applying overrides needs no
network: the `--list-models` output and the set of written files are
byte-identical with and without the flag.

Tests and typecheck need pi's own types, which are not dependencies of this
package (pi aliases them at load time). Link your global pi install once:

```bash
node scripts/link-pi.mjs
```

The script probes `npm root -g`, `~/.local/lib/node_modules`,
`/usr/local/lib/node_modules` and the directory the `pi` executable resolves to,
so npm, nvm, pnpm and user-prefix installs all work; on Windows it creates
junctions. To point at a specific install:
`PI_ROOT=/path/to/node_modules node scripts/link-pi.mjs`.

Verified against pi 0.87.1 / Node 26, re-verified on pi 0.99.1 (2026-09-30), on
pi 1.0.0 (2026-10-03: same bundled undici 8.10.2 and `@types/node` 22.19.19) and on
pi 1.0.4 (2026-10-06): bundled undici is still 8.10.2, but `@types/node` moved to
**26.6.4**, whose `assert.ok` no longer accepts `string | undefined` as the message
(overload 1 takes `Error`/function, overload 2 a required `string`) — one test line
needed `?? ""` to typecheck again (0.3.1). With that, typecheck (tsc 5.9.3 and
7.1.0-dev) plus all 21 test files are green, Node 26.10. Loading on 1.0.0 and 1.0.4
was checked in an isolated `PI_CODING_AGENT_DIR`: `models.json` (10 overrides) and
`nvidia-plus-models.json` appear there and `--list-models nvidia` prints exactly the
built-in catalog with and without the extension (19=19 on 1.0.0; 21=21 on 1.0.4 —
pi's own nvidia catalog grew between those hosts; this extension is hook-only, so
the list is not the signal).

`npm run typecheck` shells out to a bare `tsc`, and this repo has no TypeScript
devDependency (`link-pi.mjs` links pi's packages and undici), so TypeScript must
be on your `PATH`: `npm i -g typescript@5.9.3` — the version CI pins
(`.github/workflows/check.yml`); 7.0.2 also typechecks clean (measured 2026-09-30).

`npm install` is **not** needed for `npm run check` — `link-pi.mjs` provides
everything the typecheck and the tests resolve, which is pi's types and **pi's own
undici**. Linking undici rather than installing it matters: the extension installs
a global dispatcher, and that only affects pi's fetch when it is the *same module
instance* pi loaded. `resolvePiUndici()` derives its require base from
`process.argv[1]` — pi's entry point under pi, but the test file itself when a test
is run directly — so the tests resolve undici by walking up from this repository.
An `npm install`ed copy would satisfy them while exercising a *different* undici
than pi uses, which is worse than failing: the test passes against the wrong
object. (Verified on a fresh clone: without any link the proxy preflight test
fails; with pi's undici linked it passes.)

One consequence of pi being declared as an (optional) peer: if you do run
`npm install`, it materializes a full copy of the agent tree. It does not replace
an existing link, so running `link-pi.mjs` first is safe — but that copy is not
what the typecheck or the tests should use, and `npm install` will leave a
registry undici beside the link. Prefer `link-pi.mjs` alone.
- **There is deliberately no `package-lock.json` in this repository.** With the pi
  link in place, npm writes the installer's own path into the lock as a relative
  specifier (`../../.local/lib/node_modules/…`) on every `npm install`, so a
  committed lock keeps re-acquiring one machine's directory layout. A lock
  generated *without* the link is clean but pins the entire agent tree (293
  packages, esbuild binaries for every platform, the AWS and Google SDKs). The
  only thing a lock would usefully pin here is `undici`, which nothing in this
  package ships. Do not re-add it; if reproducibility for the opt-in scripts is
  ever wanted, pin `undici` exactly in `devDependencies` instead.

## Compatibility

Linux, macOS and Windows are supported. Pure TypeScript, no native modules, no shell-outs. Paths go through `node:os` `homedir()` + `node:path` `join()`; the atomic shared-state write falls back to copy+delete on Windows where `rename` over an open file fails with `EPERM`.

## License

MIT — see [LICENSE](LICENSE).
