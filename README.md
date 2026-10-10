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

The preview uses signed, owner-bound browser sessions, a bounded image uploader, expiring media links, PostgreSQL projects/jobs and a separate queue worker. **MCP requires a bearer token; anonymous access and browser-cookie authentication are not supported on `/mcp`.** Browser projects are scoped to an HTTP-only demo cookie, not an account. Media is stored on the local filesystem and is not production object storage. OAuth authorization-code/PKCE, tenant-bound live provider adapters, durable object storage, a public canonical HTTPS origin, privacy/deletion policy and an approved spending limit remain required before public production use or ChatGPT submission. No live provider execution or ChatGPT developer-mode submission is enabled by this preview.

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

The first verified canonical tools are `identify_product` and `generate_scripts`. Both accept `{ projectId: UUID, revision: nonnegative integer, idempotencyKey?: string (8–100 characters), confirmed?: boolean }` and enqueue fixture jobs on an existing owned project. Use `create_project` first, then `get_job` and `get_project` to read the completed fixture results. They mutate a project and are not annotated read-only. Provider credentials remain server-side and are never tool arguments or results. Existing widget tool names are retained.

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
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
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
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
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