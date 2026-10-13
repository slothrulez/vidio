# vidio production release and operations runbook

**Status (2026-10-14):** candidate only; no approved or deployed production release. Production hosting, public MCP endpoint, OAuth provider, database, private bucket, Ark credentials, reviewer account, approval evidence, and public support/privacy pages are not configured here. The inspected Git candidate is fe80f9edf1035a82cbca1489dada17a6d3eeaa69; no portal configuration or approval record is available to establish that this is an approved release commit.

This provider-neutral runbook assumes a long-running Node.js web service, a separate Node.js worker, PostgreSQL, private S3-compatible storage, an OAuth 2.1 provider, and the existing Ark video adapter. No hosting, database, storage, auth, or monitoring vendor is selected by this repository.

## 1. Release identity and approval gate

For each release, record the Git commit SHA, clean-worktree state, immutable artifact/image digest, web and worker artifact IDs, OpenAI plugin/draft ID, package version, approved MCP origin/path, latest tool-scan timestamp, review/publication approval, schema migration set, backup/PITR point, secret configuration version (not secret values), and rollout/rollback owner.

The approved portal configuration must point at the same production MCP origin/path and advertise the tool schemas, OAuth schemes, widget resource, and CSP built from the intended release. If code, tool metadata, or UI changes after review, follow OpenAI's current update/review flow and wait for required approval. An origin change requires a new plugin submission. Do not infer approval from a successful build or draft upload.

Before rollout, verify the release artifact's source SHA equals the approved commit, build inputs are clean, and web and worker use the exact same artifact. This workspace has no deployment metadata endpoint, provider project, dashboard approval evidence, release tag, or deployed artifact to compare.

## 2. Preflight

1. Confirm review approval and the separately authorized publication/launch decision. This runbook never performs publication.
2. Confirm the OAuth authorization server supports authorization-code + PKCE S256, standards-compliant discovery, the ChatGPT connection's selected client-registration method, the MCP `resource` parameter, and tokens with the exact resource audience and `vidio:studio` scope. The app is a resource server only; it does not host account login or the OAuth authorization server.
3. Provision production secrets in the hosting provider's secret manager. Required names are `VIDIO_MODE=production`, `NODE_ENV=production`, `DATABASE_URL`, `VIDIO_PUBLIC_ORIGIN`, `OAUTH_ISSUER`, `OAUTH_JWKS_URL`, `OAUTH_AUDIENCE`, `VIDIO_MEDIA_SECRET`, `S3_BUCKET_NAME`, and `S3_REGION`. Configure either both S3 key variables or an IAM role. For paid video jobs also configure `ARK_API_KEY`, `VIDEO_MODEL_EP`, `VIDIO_PROVIDER_MEDIA_HOSTS`, `VIDIO_PAID_GENERATION_ENABLED=true`, and `VIDIO_MAX_PAID_SEGMENTS_PER_OWNER_DAY`. Never set `VIDIO_MCP_LOCAL_AUTH` in production or put secrets in `NEXT_PUBLIC_*`, package files, or logs.
4. Verify the bucket has all four S3 Block Public Access settings enabled and the runtime identity has only required `GetBucketPublicAccessBlock`, object Get/Put/Delete permissions for the `studio/*` keyspace. The app checks privacy settings before operations but cannot prove the IAM policy is least privilege.
5. Check database capacity for web and worker pool sizing (`max = 2 * worker concurrency + 4` per process), queue operation, migration privileges, backup/PITR, TLS, and network rules. Confirm FFmpeg/FFprobe are installed on the worker.
6. Run frozen install, `pnpm validate`, `pnpm test:unit`, `pnpm test:ui`, `pnpm test:branding`, `pnpm test:integration` against a disposable `_test` database, `pnpm build:widget`, and `pnpm build`. Integration tests mock S3/JWKS/provider calls and use FFmpeg; never point them at production data.
7. Confirm an edge/request limiter is configured for unauthenticated ingress. The app-level 240-request/minute limit is per owner after successful auth, and media/write admission counters are process-local.

## 3. Database and deployment sequence

The current migrations are `0001` through `0008`. `pnpm db:migrate` applies unapplied files in lexical order in one transaction, protected by a PostgreSQL advisory lock. The migration runner has no down-migration mechanism.

1. Take or verify a recoverable database backup/PITR point and an object-storage recovery/versioning plan. Record the exact checkpoint.
2. Apply migrations once using the release artifact and migration role: `pnpm db:migrate`. Confirm all eight names in `vidio_migrations`; do not rerun custom SQL or manually edit migration rows.
3. Start the separate worker with the approved artifact, identical relevant environment, and FFmpeg/FFprobe. Verify it logs `vidio durable worker ready (production)` and writes a fresh production heartbeat.
4. Start/update the web service from the same artifact, set the canonical HTTPS origin and platform `PORT`, and check `GET /api/health/live` (200) and `GET /api/health/ready` (200). Readiness requires PostgreSQL plus a worker heartbeat newer than 30 seconds. These probes return generic status only.
5. Smoke-test OAuth discovery, a valid ChatGPT authorization, `/mcp` `initialize` and `tools/list`, UI resource loading, private project creation, and one no-cost workflow. Verify legacy website/provider routes remain 503 in production mode.
6. Keep paid generation disabled until the checks below pass and the operator approves a bounded real call.

### Migration rollback limits

All migrations are forward-only. Migration `0008_worker_health.sql` is additive and can remain applied during an app rollback. Migration `0007_english_only.sql` rewrites stored project language values to `english`; it is a data migration and is not reversible from the live database alone. Do not drop tables or attempt ad-hoc down SQL. Prefer rolling the app and worker back together to a previously tested artifact compatible with the current schema. If data restoration is unavoidable, stop writers and restore the database and associated object storage from a consistent pre-migration checkpoint, with an explicitly accepted loss window; restoration can remove projects/jobs/assets created after that checkpoint. Preserve the same `VIDIO_MEDIA_SECRET` across ordinary code rollback so existing signed media links remain verifiable.

## 4. Controlled end-to-end video check

Run only after approval, with synthetic photos and a dedicated reviewer/test account:

1. Set a low daily segment budget and record it. Create a test project with exactly one reviewed English scene; `VIDIO_MAX_PAID_SEGMENTS_PER_OWNER_DAY=1` bounds the generation to one segment. Do not use a multi-scene project under this cap.
2. Upload one valid PNG/JPEG (maximum 5 MB) and confirm it is private, owner-bound, and retrievable only by the test account.
3. Confirm the job requires fresh server-issued cost consent bound to owner/project/revision/operation/idempotency key. Approve the single generation in the UI.
4. Record request time, job ID, provider task ID from authorized operational tooling, completion time, job status, and provider-reported charge. Never record bearer tokens, signed URL query strings, or provider secrets.
5. Verify progress survives a page reload, the individual segment previews, composition produces an MP4, and the final video can be downloaded by its owner.
6. Verify the object is in the private bucket, record before/after object byte counts, then wait over ten minutes and confirm the old media URL fails. Refresh via `get_project` or `get_final_video` and confirm the new URL works for its owner.
7. Check quota usage remains within the recorded limit and reconcile spend with the provider billing/usage console. Disable paid admissions afterward unless further tests are approved.

No provider generation, API usage, latency, object storage, worker heartbeat, or cost could be verified in this workspace. The repo does not export production latency/usage metrics; use the selected host, database, object-store, and Ark telemetry. The daily segment admission counter is not monetary metering.

## 5. Operations and incident response

### Worker down, queue stalled, or readiness 503

- Check liveness first. If it is 200 but readiness is 503, inspect database connectivity and the latest `vidio_worker_health` row for `mode='production'`; heartbeat older than 30 seconds fails readiness.
- Inspect sanitized worker logs for queue connection, dispatch, heartbeat, or migration startup errors. Do not print SQL connection strings or job payloads.
- Check PostgreSQL capacity and pg-boss queue health. Verify the worker serves `vidio-jobs` and its artifact/mode/config match the web service.
- Restart the worker with SIGTERM/graceful stop where possible. It removes its heartbeat and asks pg-boss to stop gracefully. On forced termination, lease expiry lets the dispatcher recover/requeue safe jobs. Verify status before retrying.
- Wait for a fresh heartbeat and healthy readiness. Do not enable paid jobs while readiness is failing.

### Failed jobs and provider incidents

- Read the owned job's status/error code through the app. For transient `POLL`, `STORAGE`, `WORKER_ERROR`, or eligible `TIMEOUT` failures, use `retry_job` only when the stored job is retryable, under the attempt cap, and matches the project revision.
- `PROVIDER_FAILED` does not automatically resubmit a paid task. `SUBMISSION_UNKNOWN` means the provider may have accepted a task but the local response/checkpoint was lost. Do not retry or issue another approval until an operator reconciles the provider task/billing record through a reviewed recovery procedure.
- For provider-wide outage, set `VIDIO_PAID_GENERATION_ENABLED=false` and restart the worker with that value. This blocks new execution; queued work will fail safely while disabled. Keep HTTP available for safe status reads if appropriate. Re-enable only after provider status, quota, hostname allowlist, and one low-cost probe are reviewed.
- Never retry an ambiguous network timeout with a fresh idempotency key; reconcile first. Known task IDs are checkpointed and polled rather than resubmitted.

### Expired or inaccessible media URLs

- Media capabilities and S3 signed GET URLs last 600 seconds. A stale link is expected to fail; reacquire it through authenticated owner-scoped `get_project`/`get_final_video`.
- If a new URL fails, check owner association, object existence, bucket policy, `GetObject` IAM, region/endpoint, clock skew, and signing configuration. Do not make the bucket public or extend signatures as an emergency workaround.
- Treat URL query tokens as bearer capabilities; redact them from tickets, screenshots, logs, chat, and recordings.

### Storage/quota failures

- `STORAGE_CONFIGURATION` means the app could not verify all four public-access blocks or use the storage identity. Keep writes disabled until fixed.
- Check bucket privacy, object permissions limited to `studio/*`, S3 request errors, quota, and database reservations. Orphan reservations older than two hours are cleaned by the worker; failed deletions retain reservations.
- Production limits in code: 5 MB/image, up to six images/project, 64 assets/project, 1 GB/owner, 100 GB global, 20 projects/owner, 200 projects/global, 100 jobs/owner, and 1–100 configured daily paid segments/owner. The runtime only proves configured values; no production DB was available to check current usage.

### Security, privacy, or cost incident

1. Use the selected hosting edge to restrict/pause `/mcp` and affected APIs. Disable paid admissions and stop the worker if continued processing could increase cost or expose data.
2. Revoke/rotate affected OAuth signing credentials at the identity provider, media-signing secret, or Ark key as appropriate. Update secret-manager versions and restart services. The app has no per-user revocation console.
3. Preserve timestamps, release SHA, job IDs, error codes, and platform audit events. Do not collect/share tokens, signed URLs, images, scripts, or raw request bodies in incident notes.
4. Determine affected owners/projects/assets using the incident process. Notify users/regulators according to the final privacy policy and applicable law. The public contact, deletion process, and notification policy are currently unconfigured.
5. Restore service only after credentials, bucket privacy, ownership queries, readiness, quotas, and incident-specific checks pass.

### Data deletion

There is currently no user-facing project/account deletion operation or automatic retention TTL for committed projects, jobs, and S3 objects. A raw SQL cascade would remove database rows but does not guarantee matching S3 object deletion; do not use it as a complete deletion procedure. Before launch, implement owner-authorized deletion that enumerates asset keys, deletes/verifies every object, then deletes rows or records retryable tombstones. Define backup expiry and failed-delete escalation, test partial S3 failure/recovery, and publish the final contact and completion timeline. Until then, do not claim user deletion is available.

## 6. Rollback

1. Set `VIDIO_PAID_GENERATION_ENABLED=false` and confirm no new paid admissions.
2. If the prior version is schema-compatible, roll web and worker to the same previously tested immutable artifact. Preserve `VIDIO_PUBLIC_ORIGIN`, OAuth issuer/audience/JWKS, bucket, database, and `VIDIO_MEDIA_SECRET`; verify auth, MCP compatibility, health, ownership, and job progress.
3. Keep applied additive migrations. Do not run down migrations or delete migration records. Migration `0007` has irreversible in-place normalization.
4. Restore database/object storage only for a separately approved data-recovery event, after stopping writers and choosing a consistent checkpoint. Document the loss window and verify objects before service resumes.
5. Restart/verify the worker before reopening mutation traffic; check readiness and a no-cost workflow before re-enabling paid admissions.

Host-specific image rollback, traffic routing, backup restore, S3 version restore, and provider-key rotation commands cannot be finalized until providers are selected.

## 7. Future update and release process

1. Branch from deployed source SHA; keep a clean diff. Migrations are forward-only; document data transforms and rollback effects.
2. Run frozen install, typecheck/lint, unit, UI, branding, disposable DB integration (worker kill/restart, ownership, private S3 mock, expired URLs, quotas, provider failures/idempotency), widget build, Next production build, and custom-server bundle.
3. Test the MCP and UI in a staging ChatGPT connection with mocks first. Check failures, latency, object growth, quotas, access isolation, logs, and recovery. Never use production data for integration tests.
4. If a real provider smoke is needed, obtain explicit budget approval, cap to one scene, use synthetic data, record provider spend, then disable paid admissions.
5. Review tool schemas/security/CSP in the OpenAI portal, rescan the exact public endpoint, and update package/release notes as required. Do not change MCP origin under an existing plugin.
6. Obtain required review and publication approvals. Record approver, package version, final SHA, and portal state before any separately authorized rollout.
7. After authorized rollout, compare artifact SHA/digest, run health and authenticated smoke checks, watch worker/provider/storage/error/quota signals, and retain previous artifact plus DB/object recovery points for the agreed rollback window.

## Historical verification record (2026-10-11)

- Candidate SHA: `0be99e434046e4d9068efab4c4a0afab5323d6f3` on `codex/release-hardening`; no release tag.
- Local checks rerun 2026-10-11: TypeScript passed, ESLint error-only passed, unit 33/33, embedded UI 10/10, branding 9/9, widget bundle passed, Next production build passed, custom server bundle passed.
- Local production-mode HTTP smoke: liveness returned 200; readiness returned generic 503 without database/worker config; `/mcp` returned 503 without production OAuth configuration. The server started on localhost and was stopped after the check. Node 24 emitted a `DEP0169` warning from the custom server's `url.parse()` use.
- Not run: database integration, worker startup with PostgreSQL, live MCP connection, real provider generation/download, S3 permission/expiry tests, staging/production latency or usage. `TEST_DATABASE_URL`, runtime secrets, `.env.local`, and production env files are absent; Docker/PostgreSQL is unavailable.
- Approval status: not verifiable from this workspace. The app is not confirmed approved, deployed, or published.

## Latest verification record (2026-10-14)

- Inspected candidate: fe80f9edf1035a82cbca1489dada17a6d3eeaa69 on codex/release-hardening. It is not an approved release SHA. The worktree is not clean: RELEASE_CANDIDATE.md and next-env.d.ts are modified, and .stage-build-836dfacfb0564cb589f6ee49d97b01e6/, this runbook, and submission-prep/ are untracked. These changes were preserved and not staged.
- TypeScript passed with corepack pnpm exec tsc -p tsconfig.json --noEmit. ESLint passed for src, scripts, and next.config.ts with corepack pnpm exec eslint src scripts next.config.ts --quiet. The package validate script did not complete because its nested pnpm command is not on this shell's PATH; a repository-wide ESLint traversal was stopped because it was processing the existing untracked build scratch directory.
- Tests passed: unit 34/34, embedded UI 10/10, branding 9/9. The frozen offline lockfile install, MCP Apps widget build, Next.js 16 production build, and custom Node server bundle all passed from an isolated copy of the inspected commit. The running preview and its generated .next/.vidio assets were not overwritten.
- Local-only HTTP checks: GET /api/health/live returned 200; GET /api/health/ready and unauthenticated POST /mcp returned 503. These are not production endpoint checks. No deployed HTTPS origin, production environment files, hosting project, production OAuth configuration, database, object store, provider credentials, or dashboard approval evidence were found.
- Not verified: production MCP authentication/tool exchange and embedded UI; worker startup/heartbeat; PostgreSQL integration and restart recovery; live quotas/ownership; actual S3 privacy/IAM and URL expiry; provider failures, latency, API usage, storage consumption, and worker health. The integration suite was not run because no disposable TEST_DATABASE_URL/PostgreSQL runtime was available.
- No paid generation or download was attempted. No provider spend was incurred by this verification; production spend and usage are unknown.
- Privacy/support/deletion gate remains open: public policy and support URLs are absent, committed-data retention is undefined, and owner-authorized project/account deletion is not implemented. Do not represent deletion as available.
- Migration rollback remains limited: migrations are forward-only and migration 0007 performs an irreversible in-place language normalization. The provider-neutral rollback steps are documented above, but host-specific image, routing, restore, and worker rollback commands cannot be validated until infrastructure is selected.
- Review/publication state is unverified. There is no approved configuration to compare with the candidate SHA, no production artifact digest, and no confirmation of required review or publication approval. Do not deploy or publish from this runbook.

### Manual gates before launch

1. Select the production web/worker host, HTTPS origin, OAuth authorization server, PostgreSQL, private S3-compatible store, monitoring, and provider. Provision credentials only through each provider's secret manager; never paste secrets into this repository or chat.
2. Implement and publish a real privacy policy, support contact, retention schedule, and owner-authorized deletion flow including object deletion, retries/tombstones, and backup expiry. Validate the public URLs and deletion behavior.
3. Deploy the exact candidate to staging only after separate authorization. Apply migrations with a backup/PITR checkpoint; start the worker; verify readiness, OAuth, MCP initialize/tools/list, widget loading, no-cost workflow, ownership, private storage, expiry, quotas, recovery, and sanitized telemetry.
4. With explicit budget authorization and paid generation enabled only for a one-scene cap, run one synthetic-data video job end to end in staging, download and inspect the MP4, verify no duplicate provider submission on retry/restart, record observed spend, then disable paid admission.
5. Record the immutable web/worker artifact digest and compare its source SHA, MCP origin/path, advertised schemas, auth/resource metadata, widget, and CSP with the exact approved portal configuration. Obtain and retain actual review approval and separate publication approval; if any configuration or code changes, repeat the required review.
6. Confirm backup/restore and code/worker rollback on the selected host. Only after all gates pass and the user separately authorizes launch should an operator perform the manual production rollout/publication and record the resulting dashboard state.
