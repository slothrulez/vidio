import { NextResponse } from "next/server";
import { actor } from "@/studio/auth";
import { checkOrigin, studioMode } from "@/studio/config";
import { executeTool, isToolName, safeError } from "@/studio/service";
import { jobInputSchema, StudioError } from "@/studio/types";
import { z } from "zod";
import { boundedBody } from "@/studio/request";
import { rateLimit } from "@/studio/rate-limit";
import { consentOperationForJob, consumeCostConsent, type PaidJobOperation } from "@/studio/consent";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const mode=studioMode();
    checkOrigin(request);
    const owner = await actor(request);
    await rateLimit(owner);
    const text = new TextDecoder().decode(await boundedBody(request, 20_000));
    const body = z
      .object({ name: z.string(), arguments: z.unknown(), consentToken: z.uuid().optional() })
      .strict()
      .parse(JSON.parse(text));
    if (!isToolName(body.name)) throw new StudioError("TOOL", "Unknown tool");
    if(mode==="production" && ["generate_segments","regenerate_segment","compose_video"].includes(body.name)) {
      if(!body.consentToken) throw new StudioError("CONSENT","Approve this paid step in the vidio studio first",409);
      const operation=body.name as PaidJobOperation;
      const input=jobInputSchema.parse(body.arguments);
      await consumeCostConsent(owner,body.consentToken,consentOperationForJob(operation),input);
    }
    return NextResponse.json(
      await executeTool(owner, body.name, body.arguments),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const failure = safeError(error);
    return NextResponse.json(failure.body, { status: failure.status });
  }
}
