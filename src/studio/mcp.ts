import { McpServer } from "@modelcontextprotocol/server";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { safeError } from "./service";
import { mcpSchemas, executeMcpTool, type McpToolName } from "./mcp-contracts";
import { mcpScope } from "./mcp-auth";
import { toolOutputSchema,StudioError } from "./types";
import { publicOrigin,studioMode } from "./config";

export const widgetUri = "ui://vidio/studio-v2.html";
const oauthSecuritySchemes = [{ type: "oauth2" as const, scopes: [mcpScope] }];
export async function addMcpToolAuthMetadata(response: Response, requestBody: unknown) {
  if (!requestBody || typeof requestBody !== "object" || (requestBody as { method?: unknown }).method !== "tools/list")
    return response;
  if (!response.headers.get("content-type")?.includes("application/json")) return response;
  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { result?: { tools?: unknown } }).result?.tools))
    return response;
  const result = payload as { result: { tools: Array<Record<string, unknown>> }; [key: string]: unknown };
  result.result.tools = result.result.tools.map((tool) => ({
    ...tool,
    securitySchemes: oauthSecuritySchemes,
  }));
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(JSON.stringify(result), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
const titles: Record<McpToolName, string> = {
  abort_image_upload: "Cancel an unfinished private image upload",
  retry_job: "Retry an existing video job safely",
  save_scripts: "Save reviewed scene scripts",
  begin_image_upload: "Begin a private product image upload",
  append_image_chunk: "Upload a private product image chunk",
  finish_image_upload: "Validate and save a private product image",
  create_project: "Create an English project",
  list_projects: "List demo projects",
  get_project: "Read a demo project",
  render_project: "Open the vidio studio",
  get_job: "Check demo job progress",
  cancel_job: "Cancel a demo job",
  get_download: "Get sample video download",
  update_script: "Edit a demo script",
  grant_cost_consent: "Record human approval for a paid step",
  identify_product: "Analyze uploaded product image",
  draft_scripts: "Draft product marketing scripts",
  generate_scripts: "Generate product scripts",
  start_video_job: "Start a sample video job after explicit approval",
  get_video_job_status: "Read video job status",
  preview_voice: "Preview narration (not configured)",
  generate_segments: "Render product video scenes locally",
  regenerate_segment: "Regenerate one product video scene locally",
  compose_video: "Compose selected product video scenes",
  compose_final_video: "Compose a sample final video after explicit approval",
  get_final_video: "Read the final video asset",
};
export function createMcpServer(owner: string) {
  const mode=studioMode();
  const domain=process.env.VIDIO_WIDGET_ORIGIN ? publicOrigin(process.env.VIDIO_WIDGET_ORIGIN) : undefined;
  if(domain && !domain.startsWith("https://"))throw new StudioError("CONFIGURATION","The widget origin must use HTTPS",503);
  const server = new McpServer({ name: "vidio", version: "0.1.0" });
  for (const name of Object.keys(mcpSchemas) as McpToolName[]) {
    const appOnly=["begin_image_upload","append_image_chunk","finish_image_upload","abort_image_upload","save_scripts","grant_cost_consent"].includes(name);
    const metadata: Record<string, unknown> = {
      securitySchemes: oauthSecuritySchemes,
    };
    if (!appOnly) {
      metadata.ui = { resourceUri: widgetUri };
      metadata["openai/outputTemplate"] = widgetUri;
    }
    registerAppTool(
      server,
      name,
      {
        title: mode==="demo" ? titles[name] : titles[name].replace(/(?:demo|sample|fixture|local) /gi,""),
        description: mode==="demo" ? `${titles[name]}. Authenticated local studio. Generic marketing copy and FFmpeg video scenes work without external services. Gemini image analysis is optional and enabled only with GEMINI_API_ENABLED=true and a configured key. Narration is optional. Paid video providers are disabled.` : "Authenticated owner-scoped production studio. Generation requires confirmed=true, an idempotency key, operator opt-in and daily segment budget. Poll returned job IDs for durable progress. Recognition, draft scripts and voice preview are not yet connected in production and fail explicitly. Confirmation is client-declared, not proof of human consent.",
        inputSchema: mcpSchemas[name],
        outputSchema: toolOutputSchema,
        annotations: {
          readOnlyHint: [
            "list_projects",
            "get_project",
            "get_job",
            "get_video_job_status",
            "get_download",
            "get_final_video",
            "render_project",
          ].includes(name),
          destructiveHint: name === "cancel_job",
            openWorldHint: mode==="production",
          idempotentHint: !["create_project","update_script","save_scripts","begin_image_upload","grant_cost_consent"].includes(name),
        },
        _meta: appOnly ? { ...metadata,ui:{visibility:["app"]} } : metadata,
      },
      async (args: unknown) => {
        try {
          const result = await executeMcpTool(owner, name, args);
          return {
            ...result,
            content: [
              { type: "text" as const, text: result.structuredContent.message },
            ],
          };
        } catch (error) {
          const failure = safeError(error);
          return {
            isError: true,
            structuredContent: { mode, message: failure.body.error.message, error: failure.body.error },
            content: [
              { type: "text" as const, text: failure.body.error.message },
            ],
          };
        }
      },
    );
  }
  registerAppResource(server, "vidio studio", widgetUri, {mimeType:RESOURCE_MIME_TYPE}, async () => ({
    contents: [
      {
        uri: widgetUri,
        mimeType: RESOURCE_MIME_TYPE,
        text: await readFile(
          path.join(process.cwd(), ".vidio", "widget.html"),
          "utf8",
        ),
        _meta: {
          ui: {
            ...(domain ? {domain} : {}),
            csp: { resourceDomains: [publicOrigin()], connectDomains: [] },
            prefersBorder: true,
          },
          "openai/widgetDescription":
            mode==="demo" ? "vidio local studio: review generic or Gemini-generated scripts, render product-image scenes with FFmpeg and compose a real MP4." : "vidio studio: inspect owned jobs and media, approve generation within your configured budget, and compose completed scenes.",
          "openai/widgetCSP": {
            resource_domains: [publicOrigin()],
            connect_domains: [],
          },
        },
      },
    ],
  }));
  return server;
}
