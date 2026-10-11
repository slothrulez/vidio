import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { mcpActor, mcpChallenge } from "@/studio/mcp-auth";
import { createMcpServer } from "@/studio/mcp";
import { checkOrigin, publicOrigin, studioMode } from "@/studio/config";
import { StudioError } from "@/studio/types";
import { safeError } from "@/studio/service";
import { boundedBody } from "@/studio/request";
import { rateLimit } from "@/studio/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    studioMode();
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
    const owner = await mcpActor(request);
    await rateLimit(owner);
    const body = JSON.parse(
      new TextDecoder().decode(await boundedBody(request, 350_000)),
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
    return Response.json(failure.body, {
      status: failure.status,
      headers: failure.status === 401 ? { "WWW-Authenticate": mcpChallenge() } : undefined,
    });
  }
}
export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
export function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
