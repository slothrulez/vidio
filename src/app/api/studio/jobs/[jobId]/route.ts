import { z } from "zod";
import { actor } from "@/studio/auth";
import { studioMode } from "@/studio/config";
import { getJob } from "@/studio/store";
import { safeError } from "@/studio/service";

export const runtime="nodejs";
export async function GET(request:Request,{params}:{params:Promise<{jobId:string}>}) {
  try {
    studioMode();
    const owner=await actor(request);
    const job=await getJob(owner,z.uuid().parse((await params).jobId));
    return Response.json({...job,status:job.lifecycleStatus},{headers:{"Cache-Control":"private, no-store"}});
  } catch(error) {
    const failure=safeError(error);
    return Response.json(failure.body,{status:failure.status});
  }
}
