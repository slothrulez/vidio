import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";
import { randomUUID } from "node:crypto";
import { signingKey, requireDemoMode } from "./config";
import { StudioError } from "./types";

let jwksUrl="";
let verifier:ReturnType<typeof createRemoteJWKSet>|undefined;

export async function previewSession() {
  requireDemoMode();
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(randomUUID())
    .setIssuer("vidio-preview")
    .setAudience("vidio-studio")
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(signingKey());
}

export async function actor(request: Request) {
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("vidio_preview="))
    ?.slice(14);
  if (process.env.VIDIO_MODE === "demo") {
    if (cookie) {
      try {
        const { payload } = await jwtVerify(cookie, signingKey(), {
          issuer: "vidio-preview",
          audience: "vidio-studio",
          algorithms: ["HS256"],
        });
        if (payload.sub) return payload.sub;
      } catch {
        /* Invalid sessions cannot access another workspace. */
      }
    }
    throw new StudioError(
      "AUTH",
      "Open the studio to start a preview session",
      401,
    );
  }
  return oauthActor(request);
}

export async function oauthActor(request: Request) {
  const issuer = process.env.OAUTH_ISSUER,
    jwks = process.env.OAUTH_JWKS_URL,
    audience = process.env.OAUTH_AUDIENCE;
  if (!issuer || !jwks || !audience)
    throw new StudioError(
      "AUTH_CONFIG",
      "OAuth resource server is not configured",
      503,
    );
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer "))
    throw new StudioError("AUTH", "Bearer authentication required", 401);
  try {
    if (!verifier || jwksUrl!==jwks) {verifier=createRemoteJWKSet(new URL(jwks));jwksUrl=jwks;}
    const { payload } = await jwtVerify(
      authorization.slice(7),
      verifier,
      { issuer, audience, algorithms: ["RS256", "ES256"], requiredClaims: ["sub","exp","iss","aud"] },
    );
    if (
      payload.sub &&
      typeof payload.scope === "string" &&
      payload.scope.split(" ").includes("vidio:studio")
    )
      return `${issuer}|${payload.sub}`;
  } catch {
    /* Return a bounded error, never token or provider detail. */
  }
  throw new StudioError(
    "AUTH",
    "Invalid token or missing vidio:studio scope",
    401,
  );
}
