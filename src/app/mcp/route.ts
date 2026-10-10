import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { actor } from "@/studio/auth";
import { createMcpServer } from "@/studio/mcp";
import { checkOrigin, publicOrigin, requireDemoMode } from "@/studio/config";
import { StudioError } from "@/studio/types";
import { safeError } from "@/studio/service";
import { boundedBody } from "@/studio/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    requireDemoMode();
    const host = request.headers.get("host");
    if (
      host &&
      ![
        new URL(publicOrigin()).host,
        "localhost:5000",
        "127.0.0.1:5000",
      ].includes(host)
    )
      throw new StudioError("HOST", "Host is not permitted", 403);
    const owner = await actor(request, true);
    const body = JSON.parse(
      new TextDecoder().decode(await boundedBody(request, 20_000)),
    );
    const server = createMcpServer(owner);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request, { parsedBody: body });
    } finally {
      await server.close();
    }
  } catch (error) {
    const failure = safeError(error);
    return Response.json(failure.body, { status: failure.status });
  }
}
export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
export function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
