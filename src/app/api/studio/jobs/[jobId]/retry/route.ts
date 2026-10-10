import { z } from "zod";
import { actor } from "@/studio/auth";
import { checkOrigin,studioMode } from "@/studio/config";
import { retryJob } from "@/studio/lifecycle";
import { safeError } from "@/studio/service";

export const runtime="nodejs";
export async function POST(request:Request,{params}:{params:Promise<{jobId:string}>}) {
  try {
    studioMode();
    checkOrigin(request);
    const owner=await actor(request);
    const job=await retryJob(owner,z.uuid().parse((await params).jobId));
    return Response.json({jobId:job.id,status:job.lifecycleStatus,job},{status:202,headers:{"Cache-Control":"no-store"}});
  } catch(error) {
    const failure=safeError(error);
    return Response.json(failure.body,{status:failure.status});
  }
}
