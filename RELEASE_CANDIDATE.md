# vidio release candidate checklist

Branch `codex/release-hardening`. Status: **staging not deployed**. No hosting project,
staging domain, database, private bucket or staging secret set is configured in this
workspace. Nothing was published or deployed.

## Verification run on this candidate

| Check | Command | Result |
|---|---|---|
| TypeScript + lint (errors) | `pnpm validate` | passed |
| Full lint | `pnpm lint` | 0 errors, 50 pre-existing warnings (`<img>`, hooks deps, unused vars in legacy UI) |
| Unit | `pnpm test:unit` | 26 passed |
| Embedded UI | `pnpm test:ui` | 10 passed |
| Branding (vidio identity, English-only, no legacy/hosting markers) | `pnpm test:branding` | 9 passed |
| Integration (PostgreSQL, mocked S3/JWKS/provider, real FFmpeg) | `TEST_DATABASE_URL=postgresql://.../vidio_test pnpm test:integration` | 26 passed, incl. killed/restarted worker |
| MCP protocol (running app + worker) | `pnpm test:mcp` / `pnpm test:mcp:identification` | 55 checks passed (deterministic; status polls are not counted) / passed |
| Widget + production build | `pnpm build:widget` / `pnpm build` | passed |
| Official MCP Apps host replay | manual, recorded | passed (see gaps) |
| Dependency audit (`pnpm audit --prod --registry=https://registry.npmjs.org`) | — | 0 critical/high; 1 moderate (`baseline-browser-mapping`), 1 low (`@babel/core`) |
| Whitespace / secrets | `git diff --check`, pattern scan | clean; `.env.local` and `.vidio/` are git-ignored |

No paid provider call was made. Recognition and scripts are fixtures in demo mode and fail
explicitly in production; video uses locally rendered samples in demo mode.

## Security checks

- No hardcoded keys: all credentials come from environment variables; tests use synthetic values.
- Auth: every `/api/studio/*`, `/api/media/*` and `/mcp` request requires a scoped OAuth bearer
  (production) or a loopback-only local token / preview cookie (demo). Expired, wrong-issuer,
  wrong-audience, wrong-scope, HS256 and claim-less tokens return 401 on every route without
  issuing demo sessions; foreign origins return 403.
- Ownership: projects, jobs, segments, uploads, assets and media are owner-scoped in SQL;
  cross-owner reads return 404 and cross-owner writes are rejected.
- Uploads: PNG/JPEG only, ≤5 MB, ≤4096², signature + full FFmpeg decode, ≤6 images, bounded
  chunks, expiring upload sessions, decoder admission cap.
- Storage: private S3 verified via Block Public Access before every operation; signed URLs and
  media capability tokens expire in 10 minutes; `Cache-Control: private, no-store`.
- Media: byte ranges validated before any storage read; ranged S3 GET; bounded global/per-owner
  active streams; invalid ranges return 416 without a storage read.
- Limits: 240 requests/min/owner (durable, 429), ≤2 concurrent asset writes per process,
  per-owner/global storage quotas with rollback-safe intent reservations, worker concurrency,
  lease/deadline/attempt limits, daily paid-segment budget behind operator opt-in.
- Provider media: downloaded MP4s are probed and fully decoded (H264/AAC, ratio, 1–30 s) before
  becoming segments; composition caps input and output size and verifies the timeline.
- Logs/errors: internal errors are sanitized before reaching clients; tokens and signed URLs are
  never logged; worker logs contain job IDs and error codes only.
- Legacy routes are 503 in demo/production, under `NODE_ENV=production`, and for unknown modes.

## Functional checks (automated + official-host replay)

Multi-image (PNG+JPEG) identification, script generation and editing with conflict protection,
16:9 and 9:16 project creation, immediate job IDs with persistent status, segment regeneration,
composition with English captions and soft music, real MP4 playback/download (H264 640×360 8.0 s,
AAC, mov_text), failed-job persistence across reload with safe retry (attempt 2), worker
kill/restart recovery, expired-media refresh, website pages intact. The studio is English-only;
projects are English-only; migration 0007 normalises older rows.

## Known bugs and gaps

- Paid MCP tools (`start_video_job`, `regenerate_segment`, `compose_final_video`) require a server-issued,
  single-use `consentToken` in every mode (app-only `grant_cost_consent`, bound to owner, project, revision,
  operation and idempotencyKey; 10-minute expiry; replay only with the identical idempotencyKey). Legacy agent
  and API logs redact URLs, paths and error internals via `src/lib/log-redact.ts`. The host does
  not cryptographically prove a human click, so this remains defence in depth, not proof of consent.
- Live recognition, live script generation and real English speech/TTS are not connected;
  demo audio is a tone. Production recognition/script tools fail explicitly.
- Legacy website routes (shell execution, caller-controlled files, SSRF-capable fetch, unbounded
  uploads, verbose logs) are pre-existing and unchanged; they are only safe because they are
  blocked outside explicit private legacy mode.
- Official-host gaps: one unattributed console 404; expired-media HTTP 401 masked by a browser
  CORS error (recovery verified); active-running-job reopening, malformed-image rejection in the
  host, narrow layout and full accessibility were not replayed; fresh 9:16 generation was not
  repeated in this run (covered by earlier run and automated tests).
- Media/decoder/write admission counters are per process; multi-replica deployments need an edge
  limiter.
- Dependency advisories above are in transitive dev/build tooling; no in-range fix available.

## Required environment variables

Demo (local): `DATABASE_URL`, `VIDIO_MODE=demo`, `VIDIO_MCP_LOCAL_AUTH=true`,
`VIDIO_PREVIEW_SECRET` (≥32 chars), `VIDIO_PUBLIC_ORIGIN=http://localhost:5000`.

Production: `VIDIO_MODE=production`, `NODE_ENV=production`, `DATABASE_URL`,
`VIDIO_PUBLIC_ORIGIN=https://…`, optional `VIDIO_WIDGET_ORIGIN`, `OAUTH_ISSUER`,
`OAUTH_JWKS_URL`, `OAUTH_AUDIENCE`, `VIDIO_MEDIA_SECRET` (≥32 chars), `S3_BUCKET_NAME`,
`S3_REGION`, optional `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` pair or IAM role, optional
`S3_ENDPOINT_URL`; for live video jobs `ARK_API_KEY`, `VIDEO_MODEL_EP`, optional `ARK_BASE_URL`,
`VIDIO_PROVIDER_MEDIA_HOSTS`, `VIDIO_PAID_GENERATION_ENABLED=true`,
`VIDIO_MAX_PAID_SEGMENTS_PER_OWNER_DAY`; optional `VIDIO_WORKER_CONCURRENCY`,
`VIDIO_WORKER_LEASE_SECONDS`, `VIDIO_JOB_TIMEOUT_SECONDS`, `VIDIO_JOB_MAX_ATTEMPTS`.
Never set `VIDIO_MCP_LOCAL_AUTH` in production. See README for the full table.

## Manual steps before any public release

1. Provision an OAuth 2.1 authorization server (PKCE, browser sign-in) issuing RS256/ES256 JWTs
   with scope `vidio:studio`; configure issuer/JWKS/audience.
2. Provision PostgreSQL, run `pnpm db:migrate` (0001–0006), private S3 with all four Block Public
   Access flags and least-privilege IAM, canonical HTTPS origin.
3. Deploy the Next.js service and a separate long-running `pnpm worker` (FFmpeg/FFprobe) with
   identical configuration; verify legacy routes return 503 from the public edge.
4. Add operator budget/kill switches and alerting; connect live
   recognition/script adapters and verify English speech before enabling paid generation.
5. Register the HTTPS `/mcp` endpoint in the ChatGPT developer connector and complete host
   acceptance; publish privacy/deletion policy and storage retention.
6. Run one controlled live generation with a 1-segment daily budget before raising limits.

## Local verification commands

```bash
pnpm install --frozen-lockfile
pnpm validate && pnpm lint
pnpm test:unit && pnpm test:ui && pnpm test:branding
TEST_DATABASE_URL=postgresql://vidio:vidio_local@127.0.0.1:54329/vidio_test pnpm test:integration
pnpm build:widget && pnpm build
pnpm db:migrate && pnpm dev   # terminal 1 (demo .env.local)
pnpm worker                   # terminal 2
pnpm test:mcp && pnpm test:mcp:identification
git diff --check
```

## Deployment risks and cost controls

- Paid generation is off unless `VIDIO_PAID_GENERATION_ENABLED=true` and a daily per-owner
  segment budget is set; unknown submissions block resubmission until reconciled; retries never
  create a second provider task for a known task ID.
- Storage growth is bounded per owner and globally and orphaned reservations are cleaned up; add
  S3 lifecycle rules for defence in depth.
- Request and media limits are per owner; add edge rate limiting and WAF for anonymous traffic.
- Risks: single-region PostgreSQL/pg-boss as a hard dependency; FFmpeg CPU on the worker; media
  egress from capability URLs (10-minute expiry limits sharing); no budget alerting yet.

## Staging readiness audit (2026-10-11)

The baseline inspected for this handoff was `02a6ffbaaac9444f4a3dc4cf62b267d390a49025`.
This workspace contains only a local PostgreSQL Compose service; it has no staging
deployment manifest, linked Vercel project, or configured staging credentials. The
authenticated Vercel account had no `vidio` project, so no unrelated project was used.
The Docker CLI is installed but its daemon is unavailable. No staging deployment or
paid provider request was attempted.

Confirmed and fixed before any staging rollout:

- The custom server selected Next development mode unless `COZE_PROJECT_ENV=PROD`, even
  with `NODE_ENV=production`. It now recognizes either production marker.
- The start script discarded a platform-provided `PORT`; it now honors it.
- Added generic liveness and readiness endpoints. Readiness requires PostgreSQL and a
  fresh PostgreSQL worker heartbeat for the configured mode. Migration 0008 creates the
  heartbeat table.

Still blocking staging acceptance: select/provision the hosting target and HTTPS domain,
managed PostgreSQL, private S3 bucket/role, OAuth issuer/JWKS/audience, and server-side
Ark credentials/endpoint allowlist. The managed production path also has no live product
recognition, script-generation or English TTS adapter; these functions fail explicitly.
The managed product is English-only. Official ChatGPT developer-connector acceptance and
a controlled paid generation require the deployed HTTPS endpoint, connected OAuth, and
real provider credentials. Do not claim staging acceptance until those checks are run.

Checks run for this hardening change (Node 24.17.0; invoked installed package binaries
directly because the Corepack cache could not be written in this environment):

| Check | Result |
|---|---|
| TypeScript (`tsc -p tsconfig.json`) | passed |
| ESLint (`eslint . --quiet`) | passed |
| Unit suite, including new startup/readiness regressions | 33 passed |
| Embedded UI suite | 10 passed |
| Branding suite | 9 passed |
| Widget bundle | passed |
| Next.js production build | passed; health routes included |
| Custom Node server bundle | passed |
| Local production-mode HTTP health smoke | liveness 200; readiness 503 without DB/worker, generic body |
| PostgreSQL/pg-boss integration and live worker startup | blocked: Docker daemon and database are unavailable |
| ChatGPT developer connector and end-to-end media workflow | blocked: no HTTPS staging endpoint, OAuth setup, bucket, or provider credentials |
| Paid generation cost | $0; no paid operation was attempted |

The OpenAI developer flow requires a reachable HTTPS `/mcp` endpoint (or its secure
development tunnel) before adding the custom MCP server and exercising its tools. This
endpoint was unavailable here, so there is no ChatGPT host acceptance result.
