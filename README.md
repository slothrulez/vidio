<img src="public/assets/vidio-logo.svg" alt="vidio" width="240" />

# vidio

AI product-video creation — from product image to finished video.

AI商家带货视频生成工具，面向电商商家、带货主播，提供一键生成带货短视频的能力。

## 品牌与页面元数据

- 品牌名称统一为小写 **vidio**；保留现有中文界面和视频创作流程。
- 原创标志位于 `public/assets/vidio-logo.svg` 和 `public/assets/vidio-icon.svg`；浏览器图标、应用图标及分享图片通过 Next.js 元数据文件自动提供。
- 公共部署前，在构建环境中将已有的 `COZE_PROJECT_DOMAIN_DEFAULT` 设置为实际应用域名或完整 URL，供分享图片和现有 Agent HTTP 调度使用。未配置时，分享图片地址指向本地开发地址 `http://localhost:5000`；不要填入第三方品牌网站。
- 运行 `pnpm test:branding` 执行不访问模型或生成视频的品牌回归检查；现有检查命令仍为 `pnpm lint`、`pnpm ts-check`、`pnpm validate` 和 `pnpm build`。

## Safe MCP Apps preview (no paid provider calls)

The `/studio` page and `/mcp` endpoint offer a **demo-only** product-video workflow. Recognition and scripts are fixtures; audio is a sample tone, and sample video scenes are locally rendered by FFmpeg. This is not live AI image recognition, narrated TTS, or AI video generation. In `VIDIO_MODE=demo`, the existing provider, file and proxy APIs return 503 to prevent bypassing this boundary. The original implementation is retained for later authenticated integration.

Requires Node.js 22.12+ (24 recommended), pnpm, Docker, and FFmpeg with libx264. From the repository root:

```bash
pnpm install --frozen-lockfile
docker compose up -d --wait
```

Create a **local, ignored** `.env.local` file. Generate the secret yourself; never commit or print its value:

```bash
(umask 077; set -C; printf 'DATABASE_URL=postgresql://vidio:vidio_local@127.0.0.1:54329/vidio\nVIDIO_MODE=demo\nVIDIO_MCP_LOCAL_AUTH=true\nVIDIO_PUBLIC_ORIGIN=http://localhost:5000\nVIDIO_PREVIEW_SECRET=%s\n' "$(openssl rand -hex 32)" > .env.local)
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

Open `http://localhost:5000/studio`. To run the protocol test, use `pnpm test:mcp` with both processes running. For the isolated database test, create a disposable `vidio_test` database and run `TEST_DATABASE_URL=postgresql://vidio:vidio_local@127.0.0.1:54329/vidio_test pnpm test:integration`. Unit tests require no database: `pnpm test:unit`. Both databases live in the Docker volume; `docker compose down` stops the container but does not delete the volume. Never point the disposable integration test at user data.

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
| `start_video_job` | `{ projectId, revision, idempotencyKey?, confirmed: true }` | Explicit approval required; queues local sample scenes. |
| `get_video_job_status` | `{ jobId: UUID }` | Read-only; returns the owned job ID, status, progress and bounded error. |
| `regenerate_segment` | `{ projectId, revision, idempotencyKey?, confirmed: true, segmentId: integer 1–4 }` | Explicit approval required; queues one sample scene. |
| `compose_final_video` | `{ projectId, revision, idempotencyKey?, confirmed: true, segmentIds: unique array of 1–4 integers 1–4 }` | Explicit approval required; queues local composition. |
| `get_final_video` | `{ projectId: UUID }` | Read-only; returns the owned final asset ID, MIME type and a short-lived signed download URL in MCP result `_meta.media[assetId]`. |

Job tools enqueue asynchronous work and return stable UUIDs; use `create_project` first, then `get_video_job_status` and `get_project`. The table above describes demo mode. Production generation additionally requires an idempotency key, authenticated ownership, operator opt-in and a daily admission budget. `confirmed: true` is client-declared and **not proof of human approval**; implement owner-bound, single-use cost consent before a public ChatGPT release. Invalid fields, missing confirmation and cross-owner IDs are rejected. Older widget tool names remain available. Provider credentials never become tool arguments/results. Run `pnpm test:mcp` with the demo worker and server active for the full protocol/media workflow.

## Production job lifecycle

This is an opt-in managed execution path, not a replacement of the existing
LangGraph/Coze website. It reuses PostgreSQL, pg-boss, the Ark video task API and
FFmpeg. Legacy routes and their contracts are unchanged when `VIDIO_MODE` is unset;
keep that legacy deployment private. In **demo and production managed modes**,
unsafe legacy SSE/provider/file/proxy routes return 503 so they cannot bypass
authentication, ownership or budgets. Production browser sign-in is not included.

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

## 功能特性

- **智能商品识别**：上传商品图片，自动识别商品名称和核心卖点
- **多图片支持**：支持同时上传多张图片（主图+辅图），综合分析商品信息
- **AI文案生成**：基于商品特点自动生成带货文案和画面描述
- **视频比例选择**：支持横版(16:9)和竖版(9:16)两种视频比例
- **语言选择**：支持普通话和粤语两种配音语言
- **分段视频生成**：每个文案分段生成独立视频片段
- **智能合成**：自动将所有片段合成为完整带货视频
- **实时预览**：支持分段视频和最终视频在线预览
- **一键下载**：生成完成后可直接下载视频文件

## 工作流程

```
用户上传图片 → 商品识别 → 自动生成文案 → 用户确认/修改文案
→ 生成分段视频 → 用户预览/调整 → 合成最终视频 → 下载
```

### 阶段说明

| 阶段 | 说明 | 用户操作 |
|-----|------|---------|
| 商品识别 | 分析图片，提取商品信息 | 上传图片 |
| 文案生成 | 生成带货文案和画面描述 | 等待/修改 |
| 视频生成 | 为每个分段生成视频+配音 | 预览/重新生成 |
| 视频合成 | 合成最终视频+字幕+BGM | 确认合成 |
| 完成 | 输出成品视频 | 下载 |

## 密钥安全

### 推送到 GitHub 前的安全检查

项目已在 `.gitignore` 中配置排除以下敏感文件，**不会被推送到 GitHub**：

```
# Environment variables
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# Secrets and keys
*.pem
*.key
secrets/
```

### 推送前验证命令

```bash
# 查看将要推送的文件列表
git status

# 确认 .env 文件不在列表中
git ls-files | grep .env
# 应返回空结果
```

### 创建示例配置文件

建议创建 `.env.example` 文件供其他开发者参考（不含真实密钥）：

```bash
# .env.example（可提交到 GitHub）
ARK_API_KEY=your_api_key_here
ARK_BASE_URL=https://ark.cn-beijing.volces.com
VIDEO_MODEL_EP=your_video_model_endpoint_here

S3_ACCESS_KEY=your_access_key_here
S3_SECRET_KEY=your_secret_key_here
S3_BUCKET=your_bucket_name_here
S3_REGION=cn-beijing
S3_ENDPOINT=https://tos-cn-beijing.volces.com
```

### 重要提示

1. **禁止在代码中硬编码密钥**
   ```typescript
   // ✅ 正确 - 通过环境变量读取
   const apiKey = process.env.ARK_API_KEY;

   // ❌ 错误 - 禁止硬编码
   const apiKey = "ark-xxx-xxx";
   ```

2. **GitHub Secrets**：如需在 CI/CD 中使用密钥，请在 GitHub 仓库设置中添加 Repository secrets

3. **密钥更换**：如密钥已泄露，请立即更换并更新 `.env.local`

## 快速开始

### 环境配置

在 `.env.local` 文件中配置以下环境变量：

```bash
# 火山引擎 API 配置
ARK_API_KEY=your_api_key          # 大模型 API 密钥
ARK_BASE_URL=https://ark.cn-beijing.volces.com
VIDEO_MODEL_EP=ep-xxx             # 视频生成模型 endpoint

# 对象存储配置
S3_ACCESS_KEY=your_access_key
S3_SECRET_KEY=your_secret_key
S3_BUCKET=your_bucket_name
S3_REGION=cn-beijing
S3_ENDPOINT=https://tos-cn-beijing.volces.com
```

### 启动开发服务器

```bash
pnpm install
pnpm dev
```

启动后访问 [http://localhost:5000](http://localhost:5000)

### 构建生产版本

```bash
pnpm build
pnpm start
```

## 项目结构

```
src/
├── app/
│   ├── page.tsx              # 主页面（对话式Agent UI）
│   ├── layout.tsx            # 根布局
│   ├── globals.css           # 全局样式
│   └── api/
│       ├── chat-agent/       # 对话式 Agent API (SSE流式)
│       ├── generate-video/   # 视频生成 API
│       ├── generate-tts/     # 语音合成 API
│       └── upload-image/     # 图片上传 API
├── agent/
│   ├── chat-node.ts          # Agent 对话节点逻辑
│   ├── chat-state.ts         # Agent 状态定义
│   ├── tools.ts              # Agent 工具函数
│   ├── graph.ts              # LangGraph 工作流图
│   ├── state.ts              # LangGraph 状态定义
│   └── nodes/                # LangGraph 节点函数
├── components/ui/            # shadcn/ui 组件库
├── lib/
│   ├── utils.ts              # 工具函数
│   └── storage.ts            # 对象存储工具
└── hooks/                    # 自定义 Hooks
```

## 技术架构

### Agent 架构

项目采用**问答式 Agent**架构，基于 LangGraph 工作流：

- **LLM调度**：使用 `doubao-seed-1-8-251228` 模型进行对话调度
- **多模态识别**：商品图片识别使用多模态大模型
- **工具调用**：支持图片上传、文案生成、视频生成、视频合成等工具
- **SSE流式输出**：实时推送进度和结果

### 核心工具

| 工具 | 功能 |
|-----|------|
| `uploadAndIdentifyProduct` | 上传图片并识别商品信息 |
| `generateScripts` | 生成带货文案和画面Prompt |
| `generateVideoSegments` | 生成视频片段（TTS+视频生成） |
| `composeFinalVideo` | 合成最终视频（BGM+字幕） |
| `regenerateSegment` | 重新生成单个视频片段 |
| `modifyScript` | 修改文案内容 |

### 依赖服务

| 服务 | 用途 | 模型/配置 |
|-----|------|---------|
| 火山引擎 LLM | 对话调度 | `doubao-seed-1-8-251228` |
| 火山引擎 多模态 | 商品识别 | 多模态模型 |
| 火山引擎 TTS | 语音合成 | `zh_female_shuangkuaisisi_moon_bigtts` |
| 火山引擎 视频生成 | 视频生成 | `ep-xxx` |
| 火山引擎 对象存储 | 文件存储 | S3兼容存储 |

## 开发规范

### 包管理

**必须使用 pnpm** 作为包管理器：

```bash
# ✅ 正确
pnpm install
pnpm add package-name

# ❌ 禁止
npm install
yarn add
```

### UI 组件

优先使用 `src/components/ui/` 中的 shadcn/ui 组件：

```tsx
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
```

### 样式开发

使用 Tailwind CSS v4：

```tsx
<div className="flex items-center gap-4 p-4 rounded-lg">
  <Button className="bg-primary text-white">提交</Button>
</div>
```

### TypeScript 规范

- 严格模式开发，禁止隐式 `any`
- 所有函数参数和返回值必须标注类型
- 使用 `@/` 路径别名导入模块

## 技术栈

| 类别 | 技术 |
|-----|------|
| 框架 | Next.js 16 (App Router) |
| 核心 | React 19 |
| 语言 | TypeScript 5 |
| UI组件 | shadcn/ui (Radix UI) |
| 样式 | Tailwind CSS v4 |
| 图标 | Lucide React |
| 工作流 | LangGraph |
| 包管理 | pnpm |

## 参考文档

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
and cannot be used from a hosted ChatGPT connector. If the host cannot forward
this header, it cannot use local demo mode; do **not** disable authentication.
Open `render_project` or a project/video tool in the host to load the widget;
then select a saved project or create a new one. Use fresh synthetic images in
demo mode and avoid live provider testing.

The widget accepts up to six images per new project, PNG/JPEG only, 5 MB each.
Its app-only MCP tools `begin_image_upload`, `append_image_chunk`,
`finish_image_upload`, and `abort_image_upload` transfer bounded base64 chunks
through the authenticated bridge into private, owner-bound storage. Invalid
bytes, unfinished uploads, foreign IDs, stale revisions and expired uploads
fail; completed images return stable asset UUIDs. `save_scripts` atomically
saves the editable scenes and invalidates stale renders. Public tool
contracts remain unchanged; `retry_job` resumes an eligible failed job without
submitting a second paid provider task. Mandarin/Cantonese and 16:9/9:16 are
chosen on project creation. Script approval is separate from saving and from
the final paid-action confirmation. Job and scene progress are recovered from
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
single-use human cost consent, live recognition/scripts and a dedicated
Cantonese TTS voice are **not implemented**. Production recognition/script
requests fail visibly until those adapters are implemented; video generation
requires the existing operator opt-in, daily segment limit, storage and provider
credentials.
`confirmed: true` remains client-declared outside the widget and must not be
described as proof of consent. No live paid test was run here.

- [Next.js 官方文档](https://nextjs.org/docs)
- [shadcn/ui 组件文档](https://ui.shadcn.com)
- [Tailwind CSS 文档](https://tailwindcss.com/docs)
- [LangGraph 文档](https://langchain-ai.github.io/langgraph/)
- [火山引擎 API 文档](https://www.volcengine.com/docs)

## 重要提示

1. **必须配置正确的API密钥** 才能使用视频生成功能
2. **必须使用 pnpm** 作为包管理器
3. **优先使用 shadcn/ui 组件** 构建UI
4. **遵循 Next.js App Router 规范** 开发
5. **视频生成超时时间** 已设置为5分钟，支持较长的生成过程