import { z } from "zod";
import { actor } from "@/studio/auth";
import { checkOrigin,studioMode } from "@/studio/config";
import { startJob } from "@/studio/store";
import { jobInputSchema } from "@/studio/types";
import { boundedBody } from "@/studio/request";
import { safeError } from "@/studio/service";

export const runtime="nodejs";
export async function POST(request:Request) {
  try {
    studioMode();
    checkOrigin(request);
    const owner=await actor(request);
    const body=z.object({operation:z.enum(["generate_segments","regenerate_segment","compose_video"]),input:jobInputSchema}).strict().parse(JSON.parse(new TextDecoder().decode(await boundedBody(request,20_000))));
    const job=await startJob(owner,body.operation,body.input);
    return Response.json({jobId:job.id,status:job.lifecycleStatus,job},{status:202,headers:{Location:`/api/studio/jobs/${job.id}`,"Cache-Control":"no-store"}});
  } catch(error) {
    const failure=safeError(error);
    return Response.json(failure.body,{status:failure.status});
  }
}
