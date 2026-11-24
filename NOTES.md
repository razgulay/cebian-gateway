# cebian-gateway — restored to vanilla 9router-go

This directory is the deployment wrapper for the Koyeb container that runs
three processes under one public port:

    proxy.mjs   :8000   public   (/health, /webhook/telegram, /ws -> gateway; rest -> router)
    server.js   :8001   internal  Telegram relay + WebSocket
    9router-go  :20130  internal  LLM router + embedded Svelte dashboard

## What "restored" means here

As of 2026-11-24 this repo tracks **upstream 9router-go v1.9.16 (commit
`0a1cf785`)** with **two local patches** — `0010` (CORS) and `0011` (empty-schema
placeholder must be optional).

Patches `0001` through `0009` were **removed**. They had accumulated over weeks
of debugging and were never upstream: the router is now vanilla, so every
behaviour you read in the upstream README, CHANGELOG and docs is the behaviour
that actually runs.

### Why 0011 survives

`internal/translator/schema.go` injects a placeholder `reason` property when a
tool schema arrives with empty `properties`. Gemini's protobuf rejects a
function declaration with no `properties`, so a placeholder is genuinely
required — but upstream also marks it **`required`**, and that is the bug.

Measured against `ag/gemini-3.8-flash`, same tool, zero declared arguments:

| placeholder state | what the model returned |
| --- | --- |
| `required: ["reason"]` (upstream) | `{"reason":"User requested to call the tool."}` |
| no `required` (this patch) | `{}` |

So every zero-argument tool call on the Gemini lane came back carrying a
fabricated `reason`. A client that validates arguments against the declared
schema rejects that call; a client that ignores it silently passes junk onward.
It reproduces on both lanes — `/v1/chat/completions` returns it in `arguments`,
`/v1/messages` returns it in `input`.

The injection only fires when `properties` is empty. A tool that declares real
parameters is untouched (`{"x":"1"}` came back clean), which is why this looked
like "some tools work, some don't".

Why patch here and not in the client: the bogus argument is produced entirely
server-side, for every caller, on every model routed through the Gemini
translator. Patching a client means filtering it in each one.

The patch keeps the placeholder (so Gemini still accepts the schema) and only
drops `required`. Upstream's own parity test
(`TestCleanParametersSchema_StripsNextJSUnsupportedKeywords`) asserts
`properties != nil` and never required the field, so it still passes.

### Why 0010 survives

Upstream v1.9.16 does ship CORS, but only on `/health`, `/api/health`,
`/api/tags` and `/tags` (`internal/handlerutil/cors.go`, wired per-path in
`internal/handlers/router.go`). It does **not** cover the engine API
(`/v1/messages`, `/v1/chat/completions`, `/v1/embeddings`). Without 0010, chi
answers a browser's preflight `OPTIONS /v1/messages` with **405**, the browser
blocks the real request, and the client only ever sees `Failed to fetch` —
while curl and every SDK keep working, which makes it look like a client bug
rather than a server one.

That is not theoretical: it killed Claude for Office (webview) and any browser
caller. Keeping it costs one middleware and no behaviour change for non-browser
traffic (requests without an `Origin` header pass through untouched — verified).

## What you lose by removing 0001–0009

Recorded so the next person does not re-derive it after a bad night:

- **0001** — reactive 401 OAuth refresh loop. A lost `json_set` persist fed the
  dead token to the next request. Symptom without it: an OAuth connection
  (Antigravity, Gemini CLI) 401s in a tight loop and never recovers until the
  account is re-added.
- **0002** — Gemini tool_call id propagation into `functionCall`/
  `functionResponse`. Symptom: long agent sessions 400 once history contains an
  id-less tool pair. **Upstream since fixed this independently** (v1.9.16
  already carries unique-per-occurrence ids per its changelog) — the patch was
  ported from a bug that no longer exists in the pinned tag.
- **0003** — silenced per-chunk "empty envelope response" warning spam on
  native Gemini/Vertex streams. Cosmetic: log noise only.
- **0004** — validate thought signatures before sending. Symptom: a stale or
  corrupted signature costs Google's 400 plus a reactive re-send.
- **0005** — Gemini role contract + terminal-turn gate + HTTP/2 dead-connection
  probing. Symptom: heavy prompts hang into an unhelpful 502 instead of failing
  fast into the retry chain. Note v1.9.16 **already has** HTTP/2 ping-idle
  plumbing in `internal/constants/transport.go`.
- **0006** — RTK reported no-op compressions as real savings. Cosmetic
  (misleading `saved_est=0` telemetry on 90k-token payloads).
- **0007** — Vertex AI forwarding lane. Symptom: every Vertex model gets
  Google's HTML `404: The requested URL /v1 was not found`. **Only matters if
  you actually use Vertex models** — the pinned tag ships the provider in the
  catalog with no executor.
- **0008** — `GEMINI_STREAM_DEBUG` raw wire capture. Debug tooling only.
- **0009** — `REASONING_FIELD` selector for the OpenAI output shape. A local
  feature, not a fix.

If any of those symptoms return, re-port the specific patch against `0a1cf785`
rather than resurrecting the pile. `git apply --check` on the old patches shows
0001, 0004 and 0005 **no longer apply** to later upstream anyway.

## Upgrading

Bump `ROUTER_SHA` in the `Dockerfile` to the new tag's full 40-char SHA. The
`src` stage asserts the patch markers and **fails the build** if 0010 stops
applying, so a silent revert cannot ship.

## Layout

    Dockerfile          pinned SHA, patch apply + marker assertions, SPA build, Go build
    patches/0010-*      the only surviving local patch
    proxy.mjs           single-public-port splitter (router owns / because the SPA
                        uses absolute /assets and /api paths)
    server.js           Telegram relay
    start.sh            boots router -> gateway -> proxy, traps for clean shutdown
