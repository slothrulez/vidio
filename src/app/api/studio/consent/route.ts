import { z } from "zod";
import { actor } from "@/studio/auth";
import { checkOrigin, studioMode } from "@/studio/config";
import { issueCostConsent, consentOperations } from "@/studio/consent";
import { boundedBody } from "@/studio/request";
import { rateLimit } from "@/studio/rate-limit";
import { safeError } from "@/studio/service";
import { StudioError } from "@/studio/types";

export const runtime = "nodejs";

const requestSchema = z.object({
  projectId: z.uuid(),
  revision: z.number().int().nonnegative(),
  operation: z.enum(consentOperations),
  idempotencyKey: z.string().min(8).max(100),
}).strict();

export async function POST(request: Request) {
  try {
    if (studioMode() !== "production")
      throw new StudioError("NOT_CONFIGURED", "Paid-step approvals are only available in production mode", 503);
    checkOrigin(request);
    const owner = await actor(request);
    await rateLimit(owner);
    const body = requestSchema.parse(JSON.parse(new TextDecoder().decode(await boundedBody(request, 4_000))));
    const consent = await issueCostConsent(owner, body);
    return Response.json(
      { mode: "production", message: "Approval recorded for this operation and idempotency key.", consent },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const failure = safeError(error);
    return Response.json(failure.body, { status: failure.status, headers: { "Cache-Control": "no-store" } });
  }
}
