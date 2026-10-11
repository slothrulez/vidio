import { z } from "zod";
import { actor } from "@/studio/auth";
import { checkOrigin,studioMode } from "@/studio/config";
import { replaceScripts } from "@/studio/store";
import { scriptsSchema } from "@/studio/types";
import { boundedBody } from "@/studio/request";
import { safeError } from "@/studio/service";
import { rateLimit } from "@/studio/rate-limit";

export const runtime="nodejs";
export async function PUT(request:Request,{params}:{params:Promise<{projectId:string}>}) {
  try {
    studioMode();
    checkOrigin(request);
    const owner=await actor(request);
    await rateLimit(owner);
    const body=z.object({revision:z.number().int().nonnegative(),scripts:scriptsSchema.refine(scripts=>scripts.length>0 && scripts.every(script=>Boolean(script.prompt.trim())),"Provide 1–4 scripts with visual prompts")}).strict().parse(JSON.parse(new TextDecoder().decode(await boundedBody(request,20_000))));
    const project=await replaceScripts(owner,z.uuid().parse((await params).projectId),body.revision,body.scripts);
    return Response.json({project},{headers:{"Cache-Control":"no-store"}});
  } catch(error) {
    const failure=safeError(error);
    return Response.json(failure.body,{status:failure.status});
  }
}
