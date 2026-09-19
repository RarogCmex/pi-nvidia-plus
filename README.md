# pi-nvidia-plus

Pi extension that improves the built-in `nvidia` provider **in place** — no duplicate provider, no forking of the streaming pipeline. You keep selecting `nvidia/...` models with your existing API key; the extension only fixes what the built-in provider can't do.

> 🇷🇺 Русскоязычным пользователям: все сообщения расширения двуязычны (см. `PI_NVIDIA_PLUS_LANG` ниже). Документация ниже — на английском, как принято для GitHub; вопросы можно задавать на любом языке.

## What it fixes

1. **Thinking control (P0).** The built-in catalog marks almost all models as `supportsReasoningEffort: false`, so `--thinking high` is silently dropped. This extension injects thinking parameters per model family via `before_provider_request`:
   - DeepSeek V4 → `chat_template_kwargs.thinking` / `reasoning_effort`
   - GLM → `enable_thinking` / `clear_thinking` + `reasoning_effort`
   - MiniMax M3 → `thinking_mode: disabled | adaptive | enabled`
   - Nemotron 3.x → `chat_template_kwargs.enable_thinking` (+ `low_effort`)
   - Explicit **off** really disables thinking where the model thinks by default.
2. **Stale catalog (P1).** Dead models (HTTP 410/404 on the live NIM endpoint) produce warnings instead of silent failures; missing live models can be added via `/nvidia-plus discover`.
3. **Request normalization (P2).** Text content-arrays are flattened to strings for older models; a default `max_tokens` is set when the model requires it.
4. **Per-provider proxy pool (P3).** `NVIDIA_NIM_PROXIES` (or `NVIDIA_NIM_PROXIES_FILE`, default `~/.pi/agent/nvidia-proxies.json`, legacy single `NVIDIA_NIM_PROXY`) route only `https://integrate.api.nvidia.com` through your exits; other providers are untouched. Each request pins one exit for its whole key/retry circle; a dead CONNECT goes to a 60 s quarantine, and `/nvidia-plus proxy check` measures latency and pins the fastest reachable exit.
5. **Diagnostics (P4).** `retry-after` and request IDs for 429/5xx are surfaced during pi's retry pauses.
6. **Transparent in-band retry (P4).** NIM sometimes answers an overloaded request with **HTTP 200** whose SSE stream carries `data: {"error":{"message":"Service temporarily overloaded"}}`. Both status-keyed layers (transport 429/5xx retry, key rotation) miss it, so it surfaces as a `stopReason: error` turn that pi-retry makes visible to the model. The extension sniffs the first SSE event and transparently re-issues the request (3 attempts, backoff), so pi and the model never see it. On exhaustion pi gets the original error unchanged. Toggle with `NVIDIA_NIM_TRANSPORT_RETRY`.

## Installation

Requirements: **Node ≥ 22.6** (uses native TypeScript stripping), [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) installed.

```bash
# from npm (when published)
pi install pi-nvidia-plus

# from source
git clone https://github.com/<you>/pi-nvidia-plus.git
cd pi-nvidia-plus
npm install   # only for dev (tests / typecheck)
```

The extension self-applies its model overrides on first session start (into `~/.pi/agent/models.json`, ledger in `~/.pi/agent/nvidia-plus-models.json`). It never overwrites your manual edits without `force`.

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
| `NVIDIA_NIM_PROXY` | Legacy single HTTP(S) proxy URL (or `host:port`) used **only** for `integrate.api.nvidia.com`. Lowest-priority source; a pool of one. Unset (and no pool) = direct. Only `http`/`https` CONNECT — `socks://` is rejected with a parse error. |
| `NVIDIA_NIM_PROXIES` | Comma-separated proxy-URL pool (highest priority). Each value `http://[user:pass@]host:port`. |
| `NVIDIA_NIM_PROXIES_FILE` | Path to `{"proxies": ["http://…"]}` pool file. Values support `$VAR` / `${VAR}` interpolation. |
| `NVIDIA_NIM_PROXY_ROTATION` | `0`/`false`/`no`/`off` disables the automatic ring pick (the current pin stays locked). Default: on. |
| `NVIDIA_NIM_SHARED_PROXY` | `0` disables the cross-process shared cooldown file (`~/.pi/agent/nvidia-proxies-state.json`). Default: enabled. |
| `NVIDIA_NIM_PROXY_FALLBACK_DIRECT` | `1`/`true`/`yes`/`on` allows going direct **only when the pool is empty** (never when endpoints are merely in cooldown). Default: off — an empty pool refuses to leak your origin IP. |
| `NVIDIA_NIM_KEYS` | Comma-separated key pool for rotation (one-off runs). |
| `NVIDIA_NIM_KEYS_FILE` | Path to `{"keys": ["nvapi-…"]}` pool file. Default: `~/.pi/agent/nvidia-keys.json`. Values support `$VAR` / `${VAR}` interpolation. |
| `NVIDIA_NIM_KEY_ROTATION` | `0`/`false`/`no`/`off` disables rotation. Default: enabled when a pool is configured. |
| `NVIDIA_NIM_SHARED_ROTATION` | `0` disables cross-process shared state (`~/.pi/agent/nvidia-keys-state.json`). Default: enabled. |
| `NVIDIA_NIM_TRANSPORT_RETRY` | `0` disables transparent retries — both 429/5xx **and** in-band `Service temporarily overloaded` (HTTP 200 + SSE error event). Default: enabled (3 retries each). |
| `PI_NVIDIA_PLUS_DEBUG` | `1` writes final payloads to `~/.pi/nvidia-plus-debug.log`. |
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

Per request to NIM the ring picks one **pin** — a sticky exit for the whole inner key/retry circle. A dead CONNECT goes to a 60 s **quarantine** (TTL, not a permanent denylist); 429/401/403/5xx and in-band overload never rotate the proxy (those are key/transport buckets). `/nvidia-plus proxy check` measures latency on a cheap `GET /v1/models` through each exit and pins the fastest reachable one. Only `http`/`https` CONNECT is supported (undici `ProxyAgent`); `socks://` is rejected. In notifications, status, logs and the shared state file every exit appears only as its display identity `host:port` — credentials are never written.

## How it works

**Hook-only architecture (no `registerProvider`):** the built-in `nvidia` provider's auth, streaming, retries and attribution stay untouched.

- **Behavior as code** — `before_provider_request` (thinking injection, normalization); a selective global dispatcher (proxy, transparent retry, key rotation, observability).
- **Metadata as data** — overrides in `overrides/models.json` (pi's `models.json` format), applied to `~/.pi/agent/models.json` by the extension's command; the extension owns only its own IDs.

See `docs/adr/` for architecture decisions.

## Development

```bash
npm test        # cross-platform runner (Linux / macOS / Windows)
npm run typecheck
```

Typecheck needs pi's types once (outside git):

```bash
mkdir -p node_modules/@earendil-works
ln -sfn ~/.local/lib/node_modules/@earendil-works/pi-coding-agent node_modules/@earendil-works/pi-coding-agent
```

On Windows use a directory junction instead of `ln -sfn`.

## Compatibility

Linux, macOS and Windows are supported. Pure TypeScript, no native modules, no shell-outs. Paths go through `node:os` `homedir()` + `node:path` `join()`; the atomic shared-state write falls back to copy+delete on Windows where `rename` over an open file fails with `EPERM`.

## License

MIT — see [LICENSE](LICENSE).
