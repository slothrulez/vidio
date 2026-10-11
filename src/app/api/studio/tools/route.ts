import { NextResponse } from "next/server";
import { actor } from "@/studio/auth";
import { checkOrigin } from "@/studio/config";
import { executeTool, isToolName, safeError } from "@/studio/service";
import { StudioError } from "@/studio/types";
import { z } from "zod";
import { boundedBody } from "@/studio/request";
import { rateLimit } from "@/studio/rate-limit";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const owner = await actor(request);
    await rateLimit(owner);
    const text = new TextDecoder().decode(await boundedBody(request, 20_000));
    const body = z
      .object({ name: z.string(), arguments: z.unknown() })
      .strict()
      .parse(JSON.parse(text));
    if (!isToolName(body.name)) throw new StudioError("TOOL", "Unknown tool");
    return NextResponse.json(
      await executeTool(owner, body.name, body.arguments),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const failure = safeError(error);
    return NextResponse.json(failure.body, { status: failure.status });
  }
}
