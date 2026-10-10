import { z } from "zod";
import { schemas, executeTool, type ToolName } from "./service";

const modelJob = z.object({
  projectId: z.uuid(),
  revision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(100).optional(),
  confirmed: z.boolean().default(false),
}).strict();

export const mcpSchemas = {
  ...schemas,
  identify_product: modelJob,
  generate_scripts: modelJob,
};
export type McpToolName = keyof typeof mcpSchemas;

export async function executeMcpTool(owner: string, name: McpToolName, args: unknown) {
  const input = mcpSchemas[name].parse(args);
  const target: ToolName = name === "generate_scripts" ? "draft_scripts" : name;
  const result = await executeTool(owner, target, input);
  if (name === "generate_scripts" && result.structuredContent.job)
    result.structuredContent.job.operation = "generate_scripts";
  return result;
}
