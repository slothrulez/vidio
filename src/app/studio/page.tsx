"use client";

import {
  Studio,
  parseToolResponse,
  type StudioTransport,
} from "@/studio/Studio";
import { type StudioProject } from "@/studio/types";

async function responseValue(response: Response) {
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error?.message ?? "Studio request failed");
  return parseToolResponse(value);
}
let sessionPromise: Promise<void> | undefined;
function ensureSession() {
  return (sessionPromise ??= fetch("/api/studio/session", {
    method: "POST",
  }).then(async (response) => {
    if (!response.ok) {
      const body = await response.json();
      sessionPromise = undefined;
      throw new Error(body.error?.message ?? "Preview session unavailable");
    }
  }));
}
const transport: StudioTransport = {
  async callTool(name, args) {
    await ensureSession();
    return responseValue(
      await fetch("/api/studio/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, arguments: args }),
      }),
    );
  },
  async upload(project: StudioProject, file: File) {
    const form = new FormData();
    form.set("projectId", project.id);
    form.set("revision", String(project.revision));
    form.set("image", file);
    return responseValue(
      await fetch("/api/studio/upload", { method: "POST", body: form }),
    );
  },
};
export default function StudioPage() {
  return <Studio transport={transport} />;
}
