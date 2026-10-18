import { z } from "zod";
import { boundedBody } from "./request";
import { MAX_ASSET_BYTES } from "./object-store";
import { StudioError, type StudioProject, type scriptSchema } from "./types";
import type { VideoProvider, VideoTask } from "./video-provider";
import { normalizeGeneratedVideo } from "./generated-media";
import { redactText } from "../lib/log-redact";

export const WAN_SPACE = "naxyiudu228/wan22-ti2v-5b";
export const WAN_MODEL = "FastVideo/FastWan2.2-TI2V-5B-FullAttn-Diffusers";
export const WAN_SPACE_REVISION = "566d80f899a628836941d69d8eb62ae1141142c8";
const eventIdSchema = z.string().regex(/^[a-f0-9]{32}$/);

// Anonymous requests only: never forward HF tokens, cookies or paid inference credentials.
export class WanVideoProvider implements VideoProvider {
  readonly generationMode = "wan";
  readonly modelName = WAN_MODEL;
  private readonly base = "https://naxyiudu228-wan22-ti2v-5b.hf.space";
  prepare = normalizeGeneratedVideo;

  async available(signal: AbortSignal) {
    try {
      const response = await fetch(`https://huggingface.co/api/spaces/${WAN_SPACE}`, {
        redirect: "error", credentials: "omit", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new StudioError("PROVIDER_UNAVAILABLE", "Cannot check the free ZeroGPU Space availability", 503);
      const space = z.object({ runtime: z.object({ stage: z.string(), sha:z.string(), hardware: z.object({ current: z.string().nullable() }) }) })
        .parse(JSON.parse(new TextDecoder().decode(await boundedBody(response, 64_000))));
      if (space.runtime.stage !== "RUNNING" || !space.runtime.hardware.current?.startsWith("zero-"))
        throw new StudioError("PROVIDER_UNAVAILABLE", "The free ZeroGPU Space is not running on shared GPU hardware. Retry later or explicitly select static fallback.", 503);
      if (space.runtime.sha !== WAN_SPACE_REVISION)
        throw new StudioError("PROVIDER_UNAVAILABLE", "The community Space changed. An operator must review its model, license and API before enabling this revision.", 503);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof StudioError) throw error;
      throw new StudioError("PROVIDER_UNAVAILABLE", "The free ZeroGPU Space health check failed before generation submission. Retry later or explicitly select static fallback.", 503);
    }
  }

  async uploadImage(buffer: Buffer, mime: string, signal: AbortSignal) {
    if (!buffer.length || buffer.length > 5_000_000 || !["image/png", "image/jpeg"].includes(mime))
      throw new StudioError("UPLOAD", "Wan requires a validated PNG or JPEG under 5 MB");
    await this.available(signal);
    const form = new FormData();
    form.append("files", new Blob([new Uint8Array(buffer)], { type: mime }), mime === "image/png" ? "product.png" : "product.jpg");
    const response = await fetch(`${this.base}/gradio_api/upload`, {
      method: "POST", body: form, redirect: "error", credentials: "omit",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) throw new StudioError("PROVIDER_UPLOAD", `ZeroGPU image upload failed (HTTP ${response.status})`, 503);
    return z.array(z.string().startsWith("/tmp/gradio/").max(1000)).length(1)
      .parse(JSON.parse(new TextDecoder().decode(await boundedBody(response, 8000))))[0];
  }

  async submit(project: StudioProject, script: z.infer<typeof scriptSchema>, image: string | undefined, signal: AbortSignal) {
    await this.available(signal);
    if (!script.prompt.trim()) throw new StudioError("PROMPT", "Write a scene prompt before generating footage");
    if (image && !image.startsWith("/tmp/gradio/")) throw new StudioError("PROVIDER_UPLOAD", "Upload the owned image to the Space before submission");
    const [height, width] = project.ratio === "16:9" ? [320, 576] : project.ratio === "9:16" ? [576, 320] : [448, 448];
    let response: Response;
    try {
      response = await fetch(`${this.base}/gradio_api/call/generate_video`, {
        method: "POST", redirect: "error", credentials: "omit", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        body: JSON.stringify({ data: [image ? { path: image, meta: { _type: "gradio.FileData" } } : null,
          script.prompt, "static image, still picture, text, watermark, distorted product", 49 / 24, height, width, 0, 4, 42, true] }),
      });
    } catch {
      throw new StudioError("SUBMISSION_UNKNOWN", "ZeroGPU submission response was lost. Do not resubmit automatically.", 503);
    }
    if (!response.ok && response.status >= 400 && response.status < 500)
      throw new StudioError("PROVIDER_REJECTED", `ZeroGPU rejected submission (HTTP ${response.status}); sign-in or free quota may be required`, 503);
    try {
      if (!response.ok) throw new Error("Uncertain submission");
      return eventIdSchema.parse(JSON.parse(new TextDecoder().decode(await boundedBody(response, 8000))).event_id);
    } catch {
      throw new StudioError("SUBMISSION_UNKNOWN", "ZeroGPU did not return a durable event ID. Reconcile before retrying.", 503);
    }
  }

  async poll(id: string, signal: AbortSignal, onRunning?: () => Promise<void>): Promise<VideoTask> {
    eventIdSchema.parse(id);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`${this.base}/gradio_api/call/generate_video/${id}`, {
        redirect: "error", credentials: "omit", signal: AbortSignal.any([signal, AbortSignal.timeout(240_000)]),
      });
      if (response.status === 404) return { id, status: "expired", error: "ZeroGPU no longer retains this task result. A new generation requires explicit approval." };
      if (!response.ok || !response.body) throw new Error("Status unavailable");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "", size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error("Status stream ended without a result");
        size += value.byteLength;
        if (size > 64_000) throw new StudioError("PROVIDER_MEDIA", "ZeroGPU status exceeded the response size limit", 503);
        pending += decoder.decode(value, { stream: true }).replace(/\r/g, "");
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const block = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const event = /^event:\s*(\w+)/m.exec(block)?.[1];
          const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
          if (event === "generating") await onRunning?.();
          if (event === "error") {
            const detail: unknown = data ? JSON.parse(data) : null;
            return { id, status: "failed", error: typeof detail === "string" ? `ZeroGPU: ${redactText(detail, 350)}` : "ZeroGPU returned an error without details. Free quota, authentication or GPU allocation may be unavailable; no fallback was used." };
          }
          if (event === "complete") {
            const result = z.array(z.unknown()).min(1).max(4).parse(JSON.parse(data));
            const output = z.object({ url: z.string().url() }).parse(result[0]);
            this.mediaUrl(output.url);
            return { id, status: "succeeded", content: { video_url: output.url } };
          }
        }
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof StudioError) throw error;
      throw new StudioError("POLL", "ZeroGPU task status is temporarily unavailable; the saved event ID will be reused", 503);
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }

  private mediaUrl(value: string) {
    const url = new URL(value);
    if (url.origin !== this.base || url.username || url.password || !url.pathname.startsWith("/gradio_api/file="))
      throw new StudioError("PROVIDER_MEDIA", "ZeroGPU returned media outside the approved Space file endpoint", 503);
    return url;
  }

  async download(value: string, signal: AbortSignal) {
    const response = await fetch(this.mediaUrl(value), {
      redirect: "error", credentials: "omit", signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    if (!response.ok || !["video/mp4", "application/octet-stream"].includes(response.headers.get("content-type")?.split(";")[0] ?? ""))
      throw new StudioError("PROVIDER_MEDIA", "ZeroGPU generated clip could not be downloaded as MP4", 503);
    const buffer = Buffer.from(await boundedBody(response, MAX_ASSET_BYTES));
    if (buffer.toString("ascii", 4, 8) !== "ftyp") throw new StudioError("PROVIDER_MEDIA", "ZeroGPU returned an invalid MP4 signature", 503);
    return buffer;
  }
}
