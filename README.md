<img src="public/assets/vidio-logo.svg" alt="vidio" width="240" />

# vidio

AI product-video creation — from product image to finished video.

vidio helps e-commerce sellers and creators turn product images into short promotional videos: identify the product and its selling points, draft a script, generate voiceover and scenes, and compose the final video.

## Brand and page metadata

- The brand is always lowercase **vidio**. The original logo lives in `public/assets/vidio-logo.svg` and `public/assets/vidio-icon.svg`; favicon, app icons and the social image are in `src/app/`.
- Site metadata is English (`src/app/layout.tsx`). The legacy conversational website UI and its LLM prompts remain Chinese because they drive Chinese Volcengine models; the MCP Apps studio (ChatGPT) is English-only.
- Before a public deployment set the existing `COZE_PROJECT_DOMAIN_DEFAULT` to the real application domain or full URL so metadata resolves correctly.
- `pnpm test:branding` runs branding regression checks without calling models or generating video; `pnpm validate`, `pnpm lint` and `pnpm build` remain the standard checks.

## Safe MCP Apps preview (no paid provider calls)

The `/studio` page and `/mcp` endpoint offer a managed preview workflow. Recognition and script drafts are fixtures; voice preview is a sample tone. Scene generation now has explicit **Wan AI footage** and **Static-image fallback — NOT AI** modes. Wan requires operator opt-in (`VIDIO_WAN_ENABLED=true`) and available anonymous shared ZeroGPU capacity; it supports image-to-video and text-to-video without a paid token. The static renderer is never used after an AI failure. See [VIDEO_GENERATION.md](VIDEO_GENERATION.md) for verified model licensing, hardware requirements, privacy, setup, retry behavior and real free-inference results. Legacy provider/file/proxy APIs remain blocked in managed demo mode.

Requires Node.js 22.12+ (24 recommended), pnpm, Docker, and FFmpeg with libx264. From the repository root:

```bash
pnpm install --frozen-lockfile
docker compose up -d --wait
```

Create a **local, ignored** `.env.local` file. Generate the secret yourself; never commit or print its value:

```bash
(umask 077; set -C; printf 'DATABASE_URL=postgresql://vidio:vidio_local@127.0.0.1:55432/vidio\nVIDIO_MODE=demo\nVIDIO_MCP_LOCAL_AUTH=true\nVIDIO_PUBLIC_ORIGIN=http://localhost:5000\nVIDIO_PREVIEW_SECRET=%s\n' "$(openssl rand -hex 32)" > .env.local)
pnpm db:migrate
pnpm build:widget
pnpm exec next build
pnpm exec tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting --no-minify
```

Start two processes in separate terminals (the worker must have access to the same `.vidio/` media directory as the web process):

```bash
pnpm worker
COZE_PROJECT_ENV=PROD pnpm start
```

Open `http://localhost:5000/studio`. To run the protocol test, use `pnpm test:mcp` with both processes running. For the isolated database test, create a disposable `vidio_test` database and run `TEST_DATABASE_URL=postgresql://vidio:vidio_local@127.0.0.1:55432/vidio_test pnpm test:integration`. Unit tests require no database: `pnpm test:unit`. Both databases live in the Docker volume; `docker compose down` stops the container but does not delete the volume. Never point the disposable integration test at user data.

The demo uses signed, owner-bound browser sessions, bounded uploads, expiring media links, PostgreSQL and a separate worker. **MCP requires a bearer token; anonymous access and browser-cookie authentication are not supported on `/mcp`.** Demo media stays local; production mode instead uses private S3 and the resumable provider adapter described below. OAuth authorization-code/PKCE, browser sign-in, server-verified human cost consent, privacy/deletion policy, production provisioning and ChatGPT-host verification remain public-launch requirements. No paid calls run in demo mode.

### Authenticated local MCP client

Endpoint: `http://localhost:5000/mcp`, stateless Streamable HTTP with JSON responses. GET and DELETE return 405; jobs are polled through tools rather than held in a long-running MCP request. `VIDIO_MCP_LOCAL_AUTH=true` is an explicit demo-only opt-in: signed tokens expire after 15 minutes, require `vidio:studio`, and are accepted only with a loopback Host. Add this flag to an existing private `.env.local` without replacing other values. With the flag absent, MCP instead requires configured OAuth JWT validation (`OAUTH_ISSUER`, `OAUTH_JWKS_URL`, `OAUTH_AUDIENCE`); missing configuration fails closed. Local bearer testing is not a ChatGPT-compatible OAuth authorization server.

```bash
pnpm mcp:token
pnpm test:mcp:identification
```

Token creation writes `.vidio/mcp-token` with mode 0600 and refuses to overwrite an existing file. Remove an expired file yourself before issuing another token; never commit, print or share it. Connect from a local TypeScript client:

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readFile } from 'node:fs/promises';
const client = new Client({ name: 'vidio-local', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:5000/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${(await readFile('.vidio/mcp-token', 'utf8')).trim()}` } },
}));
const tools = await client.listTools();
```

The canonical tools are:

| Tool | Strict input schema | Behavior |
|---|---|---|
| `identify_product` | `{ projectId: UUID, revision: integer ≥ 0, idempotencyKey?: string (8–100 chars), confirmed?: boolean }` | Queues fixture recognition; mutates the project. |
| `generate_scripts` | Same as `identify_product` | Queues four fixture scripts after identification. |
| `grant_cost_consent` (app-only) | `{ projectId, revision, operation: start_video_job \| regenerate_segment \| compose_final_video, idempotencyKey }` | Records a single-use human approval bound to owner, project, revision, operation and idempotencyKey; returns `consent.token` (10-minute expiry). Paid tools require it as `consentToken` with the same `idempotencyKey` in every mode. |
| `start_video_job` | `{ projectId, revision, idempotencyKey?, confirmed: true, consentToken?, generationMode?: "wan" \| "static" \| "ark" }` | Explicit approval required; queues real Wan footage, labelled static fallback, or paid Ark scenes in the selected mode. |
| `get_video_job_status` | `{ jobId: UUID }` | Read-only; returns the owned job ID, status, progress and bounded error. |
| `regenerate_segment` | `{ projectId, revision, idempotencyKey?, confirmed: true, segmentId: integer 1–4, generationMode?: "wan" \| "static" \| "ark" }` | Explicit approval required; regenerates one scene in the selected mode. |
| `compose_final_video` | `{ projectId, revision, idempotencyKey?, confirmed: true, segmentIds: unique array of 1–4 integers 1–4 }` | Explicit approval required; queues local composition. |
| `get_final_video` | `{ projectId: UUID }` | Read-only; returns the owned final asset ID, MIME type and a short-lived signed download URL in MCP result `_meta.media[assetId]`. |

Job tools enqueue asynchronous work and return stable UUIDs; use `create_project` first, then `get_video_job_status` and `get_project`. The table above describes demo mode. Production generation additionally requires an idempotency key, authenticated ownership, operator opt-in and a daily admission budget. `confirmed: true` is client-declared and **not proof of human approval**; implement owner-bound, single-use cost consent before a public ChatGPT release. Invalid fields, missing confirmation and cross-owner IDs are rejected. Older widget tool names remain available. Provider credentials never become tool arguments/results. Run `pnpm test:mcp` with the demo worker and server active for the full protocol/media workflow.

## Production job lifecycle

This is an opt-in managed execution path, not a replacement of the existing
LangGraph/Coze website. It reuses PostgreSQL, pg-boss, the Ark video task API and
FFmpeg. Legacy routes and their contracts are unchanged when `VIDIO_MODE` is unset;
keep that legacy deployment private. In **demo and production managed modes**, when
`NODE_ENV=production`, or when `VIDIO_MODE` is misspelled or unknown, unsafe legacy
SSE/provider/file/proxy routes return 503 so they cannot bypass authentication,
ownership or budgets; only an explicit `VIDIO_MODE=legacy` (or an unset mode in
development) exposes them. Production browser sign-in is not included.
Release-candidate status, verification commands and launch gates are listed in
[RELEASE_CANDIDATE.md](RELEASE_CANDIDATE.md). Migration `0005` adds durable per-owner
request limits (240/minute, HTTP 429) and storage-intent reservations that the worker
cleans up.

### Required production configuration

| Variable | Purpose |
|---|---|
| `VIDIO_MODE=production` | Enables authenticated managed jobs; never demo fixtures |
| `DATABASE_URL` | Same durable PostgreSQL database for Next.js and worker |
| `VIDIO_PUBLIC_ORIGIN` | Canonical HTTPS origin, without paths/query/credentials |
| `OAUTH_ISSUER`, `OAUTH_JWKS_URL`, `OAUTH_AUDIENCE` | HTTPS JWT issuer/JWKS and expected resource audience; tokens need `sub`, `exp`, `iss`, `aud`, and `vidio:studio` scope; RS256/ES256 only |
| `VIDIO_MEDIA_SECRET` | Stable, private signing secret of at least 32 characters; survives restarts |
| `S3_BUCKET_NAME`, `S3_REGION` | Private managed asset bucket and region |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Optional **pair**, or use the server's IAM role/default AWS credential chain |
| `S3_ENDPOINT_URL` | Optional HTTPS endpoint; must support `GetPublicAccessBlock` privacy verification |
| `ARK_API_KEY`, `VIDEO_MODEL_EP` | Existing server-side Ark credentials/model endpoint; required only for live video jobs |
| `ARK_BASE_URL` | Optional origin, default `https://ark.cn-beijing.volces.com`; **do not append `/api/v3`** |
| `VIDIO_PROVIDER_MEDIA_HOSTS` | Comma-separated exact provider CDN hostnames; required for live jobs; no wildcards, redirects or IP URLs |
| `VIDIO_PAID_GENERATION_ENABLED=true` | Explicit operator permission for paid submissions; off by default |
| `VIDIO_MAX_PAID_SEGMENTS_PER_OWNER_DAY` | Required 1–100 daily admitted-segment reservation limit; retries reuse reservations, regeneration reserves another segment |

Unset `VIDIO_MCP_LOCAL_AUTH` in production: local tokens/cookies are demo-only.
Never commit environment files or tokens. Original Coze integrations retain their
existing configuration (`COZE_BUCKET_ENDPOINT_URL`, `COZE_BUCKET_NAME`, SDK
credentials); managed S3 uses the separate explicit variables above. Historical
S3 examples later in this README do not configure this managed backend.

Enable **all four** S3 Block Public Access flags (`BlockPublicAcls`,
`IgnorePublicAcls`, `BlockPublicPolicy`, `RestrictPublicBuckets`) and disable public
bucket policies/ACLs. The backend refuses operations if privacy cannot be verified;
there is no public fallback. IAM needs bucket `s3:GetBucketPublicAccessBlock` and
object Get/Put/Delete access restricted to `studio/*`. Asset keys use project/asset
UUIDs, never user paths. Image uploads are PNG/JPEG only, at most 5 MB, with signature
and dimension checks; generated media is capped at 100 MB per asset. Signed media
capability URLs and provider image URLs expire after ten minutes. Reacquire through
`get_project`/`get_final_video`; never log/share query tokens. Signed URLs are bearer
capabilities: recipients can read them until expiry.

### Deployment and API

Run `pnpm install --frozen-lockfile`, `pnpm db:migrate`, `pnpm build`, then run the
HTTP process and `pnpm worker` separately with the same production configuration.
The worker needs the full locked dependencies (including the existing `tsx` runner),
FFmpeg/FFprobe and a **long-running container/VM**, not a request-scoped serverless
function. Production assets are shared through S3, so web/worker disks need not be
shared. Migration `0003` adds owned final-result checkpoints and compound asset
ownership constraints. Pool size scales with bounded worker concurrency so uploads
cannot starve lease heartbeats; size deployment replicas to database capacity.

All `/api/studio/*` production routes require a scoped OAuth bearer token. Create a
project using the existing `create_project` tool. Upload an owned image via
`POST /api/studio/upload` (multipart `projectId`, `revision`, `image`), or use text-only
generation. Recognition, draft scripts and voice-preview provider adapters are not
connected in production and fail explicitly rather than returning fixtures.
Import reviewed scripts using `PUT /api/studio/projects/{projectId}/scripts`:

```json
{"revision":0,"scripts":[{"id":1,"script":"Your approved narration.","prompt":"Your approved visual description."}]}
```

Send `POST /api/studio/jobs` to receive **202 immediately**, a stable `jobId`, and a
`Location` header. Example (replace the synthetic ID and use the current revision):

```json
{"operation":"generate_segments","input":{"projectId":"00000000-0000-4000-8000-000000000001","revision":1,"confirmed":true,"idempotencyKey":"your-unique-request-key"}}
```

Use `operation: "regenerate_segment"` with `segmentId` (1–4, including failed scenes)
or `operation: "compose_video"` with unique completed `segmentIds`. Script IDs are
unique and limited to four. `GET /api/studio/jobs/{jobId}` returns the current
lifecycle `status`, timestamps, bounded errors and segment checkpoints. MCP retains
its old `status` contract and adds `lifecycleStatus`; REST status uses `completed`
and `partially_completed`. `POST /api/studio/jobs/{jobId}/retry` returns the same ID
for active/completed work and only requeues safe failed work within the attempt
limit. Conflicting idempotency-key reuse returns 409, not another provider job.

Completed scenes and final composition checkpoints survive worker/process restarts.
The adapter persists `submitting` **before** one paid POST, stores its task ID before
polling and resumes that same task after recovery. Unknown outcomes are terminal
`SUBMISSION_UNKNOWN`; new keys cannot bypass reconciliation for that scene. A known
but unresolved provider task also blocks a new paid submission. Operators must
reconcile with provider records before clearing the block; never blindly reset
status or delete task IDs. Explicitly failed provider tasks may be regenerated after
fresh confirmation. Cancellation stops local work/polling, not necessarily an
already-submitted provider task; it does not promise a refund.

The managed adapter uses the model's **native audio**, prompted with the approved
narration, and local FFmpeg concatenation. Separate legacy TTS/BGM/subtitle paths
remain unchanged in legacy mode; they are not claimed as managed production
features. Support for native audio must exist on the configured video model.
Request/poll contracts follow the official [create-task](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)
and [get-task](https://docs.volcengine.com/docs/ark/get-video-generation-task-api?lang=zh)
references; provider `expired` is terminal, not a reason to submit again automatically.

Routine verification uses no live credentials/cost: `pnpm test:unit`,
`TEST_DATABASE_URL=postgresql://.../vidio_test pnpm test:integration`,
`pnpm test:branding`, `pnpm ts-check`, `pnpm lint:build`, `pnpm build` and
`git diff --check`. Integration coverage includes an actual killed/restarted
pg-boss worker, stale-lease fencing, bounded failures, task-ID reuse, owner isolation,
private S3 mocks, upload validation and signed completed-video retrieval.

The installed stable TypeScript MCP SDK v2 packages are pinned to 2.3.1, MCP Apps to 2.0.3, and schemas use Zod 4. APIs are verified against the official [SDK v2 source](https://github.com/modelcontextprotocol/typescript-sdk), [MCP Apps](https://github.com/modelcontextprotocol/ext-apps), [OpenAI quickstart](https://developers.openai.com/apps-sdk/quickstart), [MCP Apps compatibility](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt), and [authentication guidance](https://developers.openai.com/apps-sdk/build/auth). No plugin tutorial or new AI framework is used.

## Legacy website features

- **Product recognition** from one or more uploaded images (main image plus auxiliary images).
- **AI script generation** with per-scene visual prompts.
- **Aspect ratios** 16:9 (landscape) and 9:16 (portrait).
- **Segmented generation**: each script segment becomes its own video clip.
- **Composition** of all clips into one video with captions and background music.
- **Preview and download** of clips and the final video.

The legacy website speaks Chinese to Chinese Volcengine models; the English-only ChatGPT studio is documented below under *Separate vidio MCP Apps studio (v2)*.

## Workflow

```
Upload images → identify product → draft scripts → confirm / edit scripts
→ generate clips → preview / regenerate → compose final video → download
```

| Stage | What happens | User action |
|-----|------|---------|
| Identification | Analyse images, extract product information | Upload images |
| Scripts | Generate script and visual prompts | Wait / edit |
| Generation | Generate a clip with voiceover per segment | Preview / regenerate |
| Composition | Combine clips with captions and music | Confirm |
| Done | Final video is ready | Download |

## Secrets

`.gitignore` excludes `.env`, `.env.local`, `.env.*.local`, `*.pem`, `*.key` and `secrets/`. Before pushing, run `git status` and `git ls-files | grep .env` (must return nothing). Copy `.env.example` to `.env.local` and fill in real values locally; never hardcode keys in code, use GitHub repository secrets for CI, and rotate any key that leaks.

## Quick start

```bash
cp .env.example .env.local   # fill in values; see the production table above for managed mode
pnpm install
pnpm dev                      # http://localhost:5000
pnpm build && pnpm start      # production build
```

Legacy website variables (Volcengine): `ARK_API_KEY`, `ARK_BASE_URL`, `VIDEO_MODEL_EP`, and the S3-compatible storage settings documented in `.env.example`.

## Project structure

```
src/
├── app/
│   ├── page.tsx              # Legacy conversational agent UI
│   ├── layout.tsx            # Root layout and metadata
│   ├── mcp/route.ts          # MCP Streamable HTTP endpoint
│   ├── studio/               # Legacy studio page
│   └── api/
│       ├── chat-agent/       # Conversational agent API (SSE)
│       ├── studio/           # Authenticated managed job APIs
│       ├── media/            # Expiring private media streaming
│       └── ...               # Legacy provider routes (disabled in managed modes)
├── agent/                    # Conversational agent and LangGraph workflow
├── chatgpt/                  # MCP Apps embedded studio (English-only)
├── studio/                   # Durable jobs, auth, storage, worker logic
├── components/ui/            # shadcn/ui components
├── lib/                      # Utilities and legacy object storage
└── worker.ts                 # Separate pg-boss generation/FFmpeg worker
```

## Architecture

- **Conversational agent** (`src/agent`): `doubao-seed-1-8-251228` orchestrates tool calls with SSE streaming; multimodal recognition, script generation, TTS (`zh_female_shuangkuaisisi_moon_bigtts`), Ark video generation and S3-compatible storage.
- **Core tools**: `uploadAndIdentifyProduct`, `generateScripts`, `generateVideoSegments`, `composeFinalVideo`, `regenerateSegment`, `modifyScript`.
- **Managed studio** (`src/studio`, `src/worker.ts`): PostgreSQL + pg-boss durable jobs, owner-scoped assets, private storage and the MCP server.

## Development conventions

- **pnpm only** (`pnpm install`, `pnpm add <pkg>`); npm and yarn are blocked by `preinstall`.
- Prefer shadcn/ui components from `src/components/ui/`, Tailwind CSS v4 and Lucide icons.
- TypeScript strict mode: no implicit `any`, typed parameters and returns, `@/` path alias.

## Stack

| Area | Technology |
|-----|------|
| Framework | Next.js 16 (App Router) |
| UI | React 19, shadcn/ui (Radix UI), Tailwind CSS v4, Lucide React |
| Language | TypeScript 5 |
| Workflow | LangGraph |
| Jobs | PostgreSQL, pg-boss |
| MCP | @modelcontextprotocol/server 2.x, @modelcontextprotocol/ext-apps |
| Package manager | pnpm |

## Reference

### Durable job lifecycle

Run `pnpm db:migrate` before starting the HTTP server and `pnpm worker`.
The existing PostgreSQL/pg-boss infrastructure is retained. Migration `0002`
adds owned per-job segment records, timestamps, error codes, provider task
checkpoints and fenced worker leases. Each completed segment is saved immediately;
an interrupted worker resumes it instead of regenerating it. Unknown paid
submission outcomes require reconciliation and are never automatically resubmitted.

Job responses add `lifecycleStatus` (`queued`, `running`, `partially_completed`,
`completed`, `failed`, `cancelled`) and segment records. The existing `status`
contract remains compatible (`running` for partial progress, `succeeded` for
completion). PostgreSQL is the source of truth across browser refreshes and restarts.

Worker limits: `VIDIO_WORKER_CONCURRENCY` (default 2, maximum 8),
`VIDIO_WORKER_LEASE_SECONDS` (default 60, range 15–300),
`VIDIO_JOB_TIMEOUT_SECONDS` (default 900, range 60–3600), and
`VIDIO_JOB_MAX_ATTEMPTS` (default 3, maximum 5). Retries use bounded backoff.
Keep the separate worker on a long-running host with FFmpeg, FFprobe and access
to the same PostgreSQL database as Next.js; it is not a request-scoped Function.

Run mocked failure/recovery/ownership checks with a disposable database:
`TEST_DATABASE_URL=postgresql://.../vidio_test pnpm test:integration`.
Live providers remain disabled in demo mode.

### Separate vidio MCP Apps studio (v2)

The original website and `/studio` remain unchanged. The **separate** bundled
React 19 studio is served through the authenticated Streamable HTTP endpoint
`http://localhost:5000/mcp` in demo mode and `https://<your-host>/mcp` after
production deployment. `pnpm build:widget` writes its self-contained HTML to
`.vidio/widget.html` (also run by `pnpm build`). The server registers
`ui://vidio/studio-v2.html` as `text/html;profile=mcp-app`, associates it with
the normal project/video tools using `_meta.ui.resourceUri`, and advertises the
resource CSP for private media on `VIDIO_PUBLIC_ORIGIN`. The UI initializes
through `@modelcontextprotocol/ext-apps/react`, consumes host tool input and
results, calls tools through the bridge, and opens final downloads through the
standard `ui/open-link` capability if the host supports it. No ChatGPT-specific
browser globals or cross-origin upload `fetch` calls are needed.

Use the **Safe MCP Apps preview** setup above to configure `.env.local` and
PostgreSQL; run `pnpm db:migrate` before starting the server. In separate
terminals, run `pnpm dev` and `pnpm worker`. In demo mode, issue a new private
token with `pnpm mcp:token` (expires in 15 minutes). Configure a supported MCP
Apps host, such as the [official basic-host example](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/basic-host),
to connect to `http://localhost:5000/mcp` via Streamable HTTP with the
`Authorization: Bearer <token>` header. The local token only works on loopback
and cannot be used from a hosted ChatGPT connector. The current basic-host has
no bearer-header setting. Local testing therefore requires an external
**loopback-only**, same-origin `/mcp` proxy that injects a fresh scoped token
server-side, forwards only the exact MCP endpoint and sets upstream `Host` to
`localhost:5000`. Keep official AppBridge/sandbox code unchanged and keep tokens
out of frontend code and logs. If the host cannot forward this header, it
cannot use local demo mode; do **not** disable authentication.
Open `render_project` or a project/video tool in the host to load the widget;
then select a saved project or create a new one. Use fresh synthetic images in
demo mode and avoid live provider testing.

The widget accepts up to six images per new project, PNG/JPEG only, 5 MB each.
Its app-only MCP tools `begin_image_upload`, `append_image_chunk`,
`finish_image_upload`, and `abort_image_upload` transfer bounded base64 chunks
through the authenticated bridge into private, owner-bound storage. Invalid
bytes, unfinished uploads, foreign IDs, stale revisions and expired uploads
fail; completed images return stable asset UUIDs. `save_scripts` atomically
saves the editable scenes and invalidates stale renders. The seven workflow-tool
input contracts remain unchanged; `retry_job` resumes an eligible failed job without
submitting a second paid provider task. The MCP Apps studio creates **English-only**
scripts, voiceover requests and captions; choose 16:9 or 9:16 on project creation.
Demo audio remains an explicitly labelled sample tone, not English speech.
Projects are English-only; migration `0007_english_only.sql` normalises any older rows.
Script approval is separate from saving and from
the final paid-action confirmation. Confirmations use accessible in-flow Radix
panels beside their action, not full-iframe centered overlays that can appear
offscreen in an auto-height host. Job and scene progress are recovered from
PostgreSQL on widget reopen, with an explicit media-link refresh on expiry.

`compose_final_video` additionally accepts optional
`composition: { subtitles: boolean, backgroundMusic: "none" | "soft" }`.
When requested, the worker creates timed UTF-8 captions (MP4 mov_text track
and a private expiring WebVTT preview track) and mixes a locally synthesized
soft instrumental under the existing audio. Captions and final media have
owner-bound UUIDs; no downloaded MP4 control appears before the preview loads
and validates a final asset. No external BGM/voice provider is contacted by
these composition options. Tests: `pnpm test:ui`,
`TEST_DATABASE_URL=postgresql://.../vidio_test pnpm test:integration`,
`pnpm test:unit`, `pnpm test:mcp`, `pnpm build:widget`, `pnpm build`.

**Manual ChatGPT configuration / release gates:** deploy the Next.js service
and separate long-running pg-boss/FFmpeg worker with the documented production
environment, run migrations, set a canonical HTTPS `VIDIO_PUBLIC_ORIGIN`, and
optionally set a separate HTTPS `VIDIO_WIDGET_ORIGIN` for the host's app domain.
Configure ChatGPT's developer connector with the HTTPS `/mcp` endpoint and a
real OAuth 2.1 authorization server/JWKS audience/scope `vidio:studio`, as in
the [Apps SDK authentication guide](https://developers.openai.com/apps-sdk/build/auth).
Do not paste a local demo token into ChatGPT or expose the unauthenticated
endpoint. Public OAuth provisioning, end-user data policy, server-verified
single-use human cost consent, live recognition/scripts and verified live
English speech are **not implemented**. Production recognition/script
requests fail visibly until those adapters are implemented; video generation
requires the existing operator opt-in, daily segment limit, storage and provider
credentials.
`confirmed: true` remains client-declared outside the widget and must not be
described as proof of consent. No live paid test was run here.

- [Next.js documentation](https://nextjs.org/docs)
- [shadcn/ui documentation](https://ui.shadcn.com)
- [Tailwind CSS documentation](https://tailwindcss.com/docs)
- [LangGraph documentation](https://langchain-ai.github.io/langgraph/)
- [Volcengine API documentation](https://www.volcengine.com/docs)

## Notes

1. Live generation requires valid provider credentials; the managed studio additionally requires the production configuration above.
2. Use pnpm only.
3. Prefer shadcn/ui components and follow Next.js App Router conventions.
