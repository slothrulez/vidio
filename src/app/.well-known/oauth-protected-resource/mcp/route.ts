import { publicOrigin, studioMode } from "@/studio/config";
import { mcpScope } from "@/studio/mcp-auth";
import { safeError } from "@/studio/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  try {
    if (studioMode() !== "production")
      return new Response(null, { status: 404 });

    return Response.json(
      {
        resource: `${publicOrigin()}/mcp`,
        authorization_servers: [process.env.OAUTH_ISSUER!],
        scopes_supported: [mcpScope],
      },
      { headers: { "Cache-Control": "public, max-age=300" } },
    );
  } catch (error) {
    const failure = safeError(error);
    return Response.json(failure.body, { status: failure.status });
  }
}
