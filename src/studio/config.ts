import { StudioError } from "./types";

export function requireDemoMode() {
  if (process.env.VIDIO_MODE !== "demo") {
    throw new StudioError(
      "NOT_CONFIGURED",
      "The studio preview is disabled. Live generation requires OAuth, private object storage and an approved provider budget.",
      503,
    );
  }
}

export function publicOrigin() {
  const configured = process.env.VIDIO_PUBLIC_ORIGIN;
  if (!configured) return "http://localhost:5000";
  const url = new URL(configured);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  ) {
    throw new StudioError("CONFIGURATION", "Invalid studio public origin", 503);
  }
  return url.origin;
}

export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== publicOrigin())
    throw new StudioError("ORIGIN", "Origin is not permitted", 403);
}

export function signingKey() {
  const value = process.env.VIDIO_PREVIEW_SECRET;
  if (!value || value.length < 32)
    throw new StudioError(
      "CONFIGURATION",
      "Preview signing key is not configured",
      503,
    );
  return new TextEncoder().encode(value);
}
