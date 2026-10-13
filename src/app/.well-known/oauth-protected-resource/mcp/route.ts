import { publicOrigin } from "@/studio/config";

export function GET() {
  const issuer = process.env.OAUTH_ISSUER;
  if (!issuer || !process.env.OAUTH_JWKS_URL || !process.env.OAUTH_AUDIENCE || process.env.VIDIO_MCP_LOCAL_AUTH === "true")
    return Response.json(
      {
        error:
          "OAuth is not configured. Local bearer testing does not implement the ChatGPT OAuth flow.",
      },
      { status: 503 },
    );
  return Response.json({
    resource: `${publicOrigin()}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: ["vidio:studio"],
    bearer_methods_supported: ["header"],
  });
}
