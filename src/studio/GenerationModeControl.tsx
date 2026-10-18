import { generationModeSchema } from "./types";
import type { z } from "zod";

export type GenerationMode = z.infer<typeof generationModeSchema>;
export function generationDescription(mode: GenerationMode) {
  if (mode === "wan") return "Generate actual AI footage with Wan on anonymous, shared ZeroGPU. Your selected image and prompts are sent to a third-party community Space. Free quota and capacity are not guaranteed. No token, credits or paid inference are used. Failed AI requests never switch to static fallback. Clips have no generated narration.";
  if (mode === "static") return "Static-image fallback: locally animate the product image with a sample tone. This is NOT AI-generated footage. No external inference is used.";
  return "Paid Ark generation uses your configured provider and approved daily allowance. Requires separate operator opt-in. No automatic fallback.";
}
export function footageLabel(mode?: GenerationMode) {
  return mode === "wan" ? "Wan AI footage" : mode === "ark" ? "Ark AI footage" : mode === "static" ? "Static-image fallback — NOT AI" : "Legacy media — source unverified";
}
export function GenerationModeControl({ value, onChange, disabled, production }: {
  value: GenerationMode; onChange: (value: GenerationMode) => void; disabled: boolean; production: boolean;
}) {
  return <div className="space-y-2 rounded-xl border border-purple-100 bg-white p-4">
    <label className="block text-sm font-medium">Footage source
      <select aria-label="Footage source" value={value} disabled={disabled}
        className="mt-2 block w-full rounded-lg border p-2 text-sm"
        onChange={event => onChange(generationModeSchema.parse(event.target.value))}>
        <option value="wan">Wan AI footage — free shared GPU (quota limited)</option>
        <option value="static">Static-image fallback — NOT AI footage</option>
        {production && <option value="ark">Ark AI footage — paid, operator approval required</option>}
      </select>
    </label>
    <p className="text-xs text-slate-500">{generationDescription(value)}</p>
  </div>;
}
