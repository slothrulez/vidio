# vidio

## Stack

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5 (strict)
- **UI**: shadcn/ui (Radix UI)
- **Styling**: Tailwind CSS 4
- **Agent**: LangGraph / LangChain
- **Durable jobs**: PostgreSQL + pg-boss
- **Media**: FFmpeg / FFprobe
- **ChatGPT App**: MCP SDK with the MCP Apps extension

## Directory structure

```
├── migrations/             # PostgreSQL migrations (run with pnpm db:migrate)
├── public/                 # Static assets (brand assets under public/assets)
├── scripts/                # Build, start, validation and test scripts
├── src/
│   ├── app/                # App Router pages and API routes
│   │   ├── page.tsx        # Legacy conversational website
│   │   ├── studio/         # Legacy studio page
│   │   └── api/            # API routes (chat-agent, agent, studio, mcp, media, uploads)
│   ├── agent/              # Legacy LangGraph agent (chat-node, tools, graph, nodes)
│   ├── chatgpt/            # Embedded MCP Apps studio bundle (English-only)
│   ├── studio/             # Managed studio: MCP contracts, service, store, worker, composition
│   ├── components/ui/      # shadcn/ui components
│   ├── hooks/              # Custom hooks
│   ├── lib/                # Shared utilities (storage, redaction, utils)
│   ├── proxy.ts            # Mode-based route isolation
│   └── server.ts           # Custom Node server entry (port 5000)
├── next.config.ts
├── package.json
└── tsconfig.json
```

## Product rules

- The product name is **vidio** (lowercase) everywhere a name is shown.
- The application is **English-only**: UI copy, prompts, scripts, voiceover, captions, logs and errors. Do not add other language options.
- Do not run paid video generation during tests; use the demo mode and mocks.

## Architecture

### Legacy conversational agent (`src/agent`)

1. **Chat node (`chat-node.ts`)**: drives the conversation with the configured LLM, decides which tool to call, supports multi-step tool calls and streams progress over SSE.
2. **Tools (`tools.ts`)**:
   - `uploadAndIdentifyProduct`: upload images and identify the product
   - `generateScripts`: write the voiceover script and visual prompts
   - `generateVideoSegments`: generate segments (TTS + video)
   - `composeFinalVideo`: compose the final video (music, subtitles)
   - `regenerateSegment`: regenerate one segment
   - `modifyScript`: edit a script line
3. **State (`chat-state.ts`)**: `productName`, `productImageUrl`, `features`, `scripts`, `segments`, `finalVideoUrl`, `currentStage`.

Flow: identify product → write script → wait for approval → generate segments → wait for selection → compose → download. Skip waits only when the user explicitly asks to.

Stages: `idle`, `identifying`, `product_identified`, `script_generated`, `video_generated`, `composing`, `done`.

API: `/api/chat-agent` (POST streams SSE, GET returns session state, DELETE clears the session).

### Managed studio and MCP (`src/studio`, `src/chatgpt`)

- MCP endpoint `/mcp` (Streamable HTTP, bearer auth) exposes `identify_product`, `generate_scripts`, `start_video_job`, `get_video_job_status`, `regenerate_segment`, `compose_final_video`, `get_final_video`.
- Paid operations require a server-issued single-use consent token.
- Jobs, segments and assets are durable in PostgreSQL; the worker is separate from the web process.

### Providers

The legacy path uses the third-party provider SDK configured through the `COZE_*` environment variables documented in `.env.example` (LLM, multimodal LLM, TTS, video generation, S3-compatible object storage). These are implementation dependencies, not branding.

## Package management

Use **pnpm only**; npm and yarn are not allowed.

- `pnpm add <package>`, `pnpm add -D <package>`, `pnpm install`, `pnpm remove <package>`

## Coding rules

- Write TypeScript in `strict` mode. Reuse declared variables, functions, types and imports; never reference undeclared identifiers.
- No implicit `any` or `as any`; type parameters, return values, destructured items, event objects and `catch` errors, and remove unused variables and imports.
- Do not hardcode absolute paths in `next.config`; use `path.resolve(__dirname, ...)`, `import.meta.dirname` or `process.cwd()`.

### Hydration

1. Never use `typeof window`, `Date.now()`, `Math.random()` or other dynamic data directly in JSX. Use `'use client'` with `useEffect` + `useState` so dynamic content renders only after mount. Avoid invalid HTML nesting (e.g. `<div>` inside `<p>`).
2. **Do not use `<head>`**; use the metadata API (https://nextjs.org/docs/app/api-reference/functions/generate-metadata).
   1. Import third-party CSS and fonts at the top of `globals.css` or via `next/font`
   2. Use ReactDOM `preload`, `preconnect` and `dns-prefetch`
   3. For JSON-LD see https://nextjs.org/docs/app/guides/json-ld

## UI

- shadcn/ui components live in `src/components/ui/`; use them by default unless the user asks for something else.
