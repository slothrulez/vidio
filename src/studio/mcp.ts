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
  grant_cost_consent: "Record human approval for the selected generation mode or composition",
  identify_product: "Identify sample product",
  draft_scripts: "Draft fixture scripts",
  generate_scripts: "Generate product scripts",
  start_video_job: "Start video generation in the explicitly selected mode",
  get_video_job_status: "Read video job status",
  preview_voice: "Preview sample audio tone",
  generate_segments: "Generate scenes: Wan AI or explicit static fallback",
  regenerate_segment: "Regenerate one scene in the selected mode",
  compose_video: "Compose selected sample scenes",
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
      securitySchemes: [{ type: "oauth2", scopes: [mcpScope] }],
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
        description: `${titles[name]}. Owned durable jobs. generationMode=wan uses anonymous free-quota ZeroGPU (operator opt-in required); generationMode=static explicitly renders a labelled still image, never AI footage. Uploaded images are shared with the community Space for Wan inference. Failures never trigger fallback. generationMode=ark is paid and production-only with separate budget/consent gates. Always ask the user which generation mode to use. Poll job IDs; retry status checks never submit a replacement task. Recognition/scripts/voice preview are fixtures in demo and unavailable in production.`,
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
            openWorldHint: true,
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
            mode==="demo" ? "vidio demo studio: review fixture scripts, generate local sample scenes and compose a demo video. No paid AI calls." : "vidio studio: inspect owned jobs and media, approve generation within your configured budget, and compose completed scenes.",
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
