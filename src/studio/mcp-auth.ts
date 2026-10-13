import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { oauthActor } from "./auth";
import { publicOrigin, requireDemoMode, signingKey } from "./config";
import { StudioError } from "./types";

export const mcpScope = "vidio:studio";
const issuer = "vidio-local-mcp";
const audience = "vidio-mcp";

export async function issueLocalMcpToken(owner = randomUUID()) {
  requireDemoMode();
  if (process.env.VIDIO_MCP_LOCAL_AUTH !== "true")
    throw new StudioError("AUTH_CONFIG", "Local MCP authentication is not enabled", 503);
  return new SignJWT({ scope: mcpScope })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(z.uuid().parse(owner))
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(signingKey());
}

export async function mcpActor(request: Request) {
  if (process.env.VIDIO_MCP_LOCAL_AUTH !== "true") return oauthActor(request);
  requireDemoMode();
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))
    throw new StudioError("AUTH_HOST", "Local MCP tokens require a loopback Host", 403);
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer "))
    throw new StudioError("AUTH", "Bearer authentication required", 401);
  try {
    const { payload } = await jwtVerify(authorization.slice(7), signingKey(), {
      algorithms: ["HS256"], issuer, audience,
    });
    const owner = z.uuid().parse(payload.sub);
    if (typeof payload.scope === "string" && payload.scope.split(" ").includes(mcpScope))
      return `mcp-local|${owner}`;
  } catch {
    /* Token details are never returned to the client. */
  }
  throw new StudioError("AUTH", "Invalid, expired or insufficiently scoped bearer token", 401);
}

export function mcpChallenge() {
  if (process.env.VIDIO_MCP_LOCAL_AUTH === "true")
    return `Bearer realm="vidio-local", scope="${mcpScope}"`;
  return `Bearer resource_metadata="${publicOrigin()}/.well-known/oauth-protected-resource/mcp", scope="${mcpScope}"`;
}
