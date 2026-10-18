import { z } from "zod";
import { readAsset } from "./assets";
import { StudioError, type StudioProject } from "./types";

const resultSchema = z.object({
  productName: z.string().trim().min(1).max(100),
  features: z.array(z.string().trim().min(1).max(160)).min(1).max(5),
  scripts: z.array(z.object({
    script: z.string().trim().min(1).max(500),
    prompt: z.string().trim().min(1).max(500),
  }).strict()).min(1).max(4).optional(),
}).strict();
const geminiResponseSchema = z.object({
  candidates: z.array(z.object({
    content: z.object({ parts: z.array(z.object({ text: z.string() })).min(1) }),
  })).min(1),
});

/** Uses Gemini only when the operator explicitly configures an API key. */
export async function generateMarketing(project: StudioProject, owner: string, includeScripts = false) {
  if (process.env.GEMINI_API_ENABLED !== "true") return undefined;
  const key = process.env.GEMINI_API_KEY;
  if (!key) return undefined;
  if (!project.imageAssetId) throw new StudioError("IMAGE_REQUIRED", "Upload a product image first");
  const image = await readAsset(owner, project.imageAssetId);
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  let response: Response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
      contents: [{ parts: [
        { text: includeScripts
          ? "Analyze this product photo and create an English product video campaign. Return JSON only with productName, features (2-4 visible or cautious claims), and scripts (exactly 4 objects, each with a short spoken script and visual prompt). Do not invent specifications, certifications, health benefits, or claims not supported by the photo. Keep each script concise and suitable for a 5-second scene."
          : "Analyze this product photo. Return JSON only with productName and features (2-4 visible or cautious observations). Do not invent specifications, certifications, health benefits, or claims not supported by the photo." },
        { inline_data: { mime_type: image.mime, data: image.buffer.toString("base64") } },
      ] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: {
        type: "OBJECT", properties: {
          productName: { type: "STRING" },
          features: { type: "ARRAY", items: { type: "STRING" } },
          ...(includeScripts ? { scripts: { type: "ARRAY", items: { type: "OBJECT", properties: { script: { type: "STRING" }, prompt: { type: "STRING" } }, required: ["script", "prompt"] } } } : {}),
        }, required: includeScripts ? ["productName", "features", "scripts"] : ["productName", "features"],
      } },
      }),
    });
  } catch {
    throw new StudioError("GEMINI_UNAVAILABLE", "Could not reach Gemini. Check the network and retry.", 503);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new StudioError("GEMINI_AUTH", "Gemini rejected the API key or API access. Check GEMINI_API_KEY and Gemini API access.", 503);
    if (response.status === 429)
      throw new StudioError("GEMINI_QUOTA", "Gemini rate or quota limit reached. Check the project quota before retrying.", 503);
    if (response.status >= 500)
      throw new StudioError("GEMINI_UNAVAILABLE", "Gemini is temporarily unavailable. Retry later.", 503);
    throw new StudioError("GEMINI_REQUEST", `Gemini rejected the request (HTTP ${response.status}). Check the configured model and request access.`, 503);
  }
  let raw: z.infer<typeof geminiResponseSchema>;
  try {
    raw = geminiResponseSchema.parse(await response.json());
  } catch {
    throw new StudioError("GEMINI_RESPONSE", "Gemini returned an invalid response. Try again or check the configured model.", 503);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw.candidates[0].content.parts[0].text); }
  catch { throw new StudioError("GEMINI_RESPONSE", "Gemini returned invalid campaign JSON", 503); }
  try { return resultSchema.parse(parsed); }
  catch { throw new StudioError("GEMINI_RESPONSE", "Gemini returned campaign data in an unexpected format. Try again.", 503); }
}
