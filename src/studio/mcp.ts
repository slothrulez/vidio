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
import { toolOutputSchema } from "./types";
import { publicOrigin } from "./config";

export const widgetUri = "ui://vidio/studio-v1.html";
const titles: Record<McpToolName, string> = {
  create_project: "Create a demo project",
  list_projects: "List demo projects",
  get_project: "Read a demo project",
  render_project: "Open the vidio studio",
  get_job: "Check demo job progress",
  cancel_job: "Cancel a demo job",
  get_download: "Get sample video download",
  update_script: "Edit a demo script",
  identify_product: "Identify sample product",
  draft_scripts: "Draft fixture scripts",
  generate_scripts: "Generate product scripts",
  start_video_job: "Start a sample video job after explicit approval",
  get_video_job_status: "Read video job status",
  preview_voice: "Preview sample audio tone",
  generate_segments: "Generate local sample scenes",
  regenerate_segment: "Regenerate one sample scene",
  compose_video: "Compose selected sample scenes",
  compose_final_video: "Compose a sample final video after explicit approval",
  get_final_video: "Read the final video asset",
};
export function createMcpServer(owner: string) {
  const server = new McpServer({ name: "vidio", version: "0.1.0" });
  for (const name of Object.keys(mcpSchemas) as McpToolName[]) {
    const metadata: Record<string, unknown> = {
      securitySchemes: [{ type: "oauth2", scopes: [mcpScope] }],
    };
    if (name === "render_project") {
      metadata.ui = { resourceUri: widgetUri };
      metadata["openai/outputTemplate"] = widgetUri;
    }
    registerAppTool(
      server,
      name,
      {
        title: titles[name],
        description: `${titles[name]}. Authenticated DEMO ONLY: no AI/provider generation. Uses fixture recognition/scripts, sample tones and local two-second videos. Job tools require the current project revision; generation/composition require confirmed=true. This flag is not verified human consent; paid execution is disabled. Use synthetic test data.`,
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
          openWorldHint: false,
          idempotentHint: name !== "create_project" && name !== "update_script",
        },
        _meta: metadata,
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
            structuredContent: { mode: "demo", message: failure.body.error.message, error: failure.body.error },
            content: [
              { type: "text" as const, text: failure.body.error.message },
            ],
          };
        }
      },
    );
  }
  registerAppResource(server, "vidio studio", widgetUri, {}, async () => ({
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
            csp: { resourceDomains: [publicOrigin()], connectDomains: [] },
            prefersBorder: true,
          },
          "openai/widgetDescription":
            "vidio demo studio: review fixture scripts, generate local sample scenes and compose a demo video. No paid AI calls.",
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
