# vidio release candidate checklist

Branch `feature/mcp-integration`. Status: **internal release candidate — NO-GO for public
deployment** until the launch gates below are closed. Nothing was published or deployed.

## Verification run on this candidate

| Check | Command | Result |
|---|---|---|
| TypeScript + lint (errors) | `pnpm validate` | passed |
| Full lint | `pnpm lint` | 0 errors, 50 pre-existing warnings (`<img>`, hooks deps, unused vars in legacy UI) |
| Unit | `pnpm test:unit` | 23 passed |
| Embedded UI | `pnpm test:ui` | 11 passed |
| Branding | `pnpm test:branding` | 6 passed |
| Integration (PostgreSQL, mocked S3/JWKS/provider, real FFmpeg) | `TEST_DATABASE_URL=postgresql://.../vidio_test pnpm test:integration` | 24 passed, incl. killed/restarted worker |
| MCP protocol (running app + worker) | `pnpm test:mcp` / `pnpm test:mcp:identification` | 72 checks passed / passed |
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
historical non-English website projects are read-only for the MCP tools.

## Known bugs and gaps

- `confirmed: true` is client-declared; server-verifiable single-use human cost consent is not
  implemented (launch gate).
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
2. Provision PostgreSQL, run `pnpm db:migrate` (0001–0005), private S3 with all four Block Public
   Access flags and least-privilege IAM, canonical HTTPS origin.
3. Deploy the Next.js service and a separate long-running `pnpm worker` (FFmpeg/FFprobe) with
   identical configuration; verify legacy routes return 503 from the public edge.
4. Implement server-verified human cost consent and operator budget/kill switches; connect live
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
