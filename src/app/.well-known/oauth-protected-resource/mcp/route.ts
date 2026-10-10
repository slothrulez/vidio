import { publicOrigin } from "@/studio/config";

export function GET() {
  const issuer = process.env.OAUTH_ISSUER;
  if (!issuer || process.env.VIDIO_MODE === "demo")
    return Response.json(
      {
        error:
          "OAuth is not configured; this endpoint currently serves a synthetic demo only.",
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
