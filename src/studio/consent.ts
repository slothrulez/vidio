import { randomUUID } from "node:crypto";
import { database } from "./db";
import { getProject } from "./store";
import { StudioError } from "./types";

export const consentOperations = [
  "start_video_job",
  "regenerate_segment",
  "compose_final_video",
] as const;
export type ConsentOperation = (typeof consentOperations)[number];
export type PaidJobOperation = "generate_segments" | "regenerate_segment" | "compose_video";

const jobConsentOperations: Record<PaidJobOperation, ConsentOperation> = {
  generate_segments: "start_video_job",
  regenerate_segment: "regenerate_segment",
  compose_video: "compose_final_video",
};

export function consentOperationForJob(operation: PaidJobOperation) {
  return jobConsentOperations[operation];
}

export async function issueCostConsent(
  owner: string,
  input: {
    projectId: string;
    revision: number;
    operation: ConsentOperation;
    idempotencyKey: string;
  },
) {
  const project = await getProject(owner, input.projectId);
  if (project.revision !== input.revision)
    throw new StudioError("REVISION", "The project changed; review the latest revision before approving", 409);
  await database().query(
    "DELETE FROM vidio_cost_consents WHERE owner_id=$1 AND (expires_at<now() OR used_at<now()-interval '1 day')",
    [owner],
  );
  const pending = await database().query(
    "SELECT count(*)::int AS n FROM vidio_cost_consents WHERE owner_id=$1 AND used_at IS NULL",
    [owner],
  );
  if (pending.rows[0].n >= 20)
    throw new StudioError("RATE_LIMIT", "Too many pending approvals; wait for them to expire", 429);
  const token = randomUUID();
  const row = await database().query(
    "INSERT INTO vidio_cost_consents(id,owner_id,project_id,revision,operation,idempotency_key,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes') RETURNING expires_at",
    [token, owner, input.projectId, input.revision, input.operation, input.idempotencyKey],
  );
  return {
    token,
    operation: input.operation,
    expiresAt: new Date(row.rows[0].expires_at).toISOString(),
  };
}

export async function consumeCostConsent(
  owner: string,
  token: string,
  operation: ConsentOperation,
  input: { projectId: string; revision: number; idempotencyKey?: string },
) {
  if (!input.idempotencyKey)
    throw new StudioError("CONSENT", "Paid steps require the idempotencyKey that was approved", 409);
  const result = await database().query(
    `UPDATE vidio_cost_consents
     SET used_at=coalesce(used_at,now())
     WHERE id=$1 AND owner_id=$2 AND project_id=$3 AND revision=$4 AND operation=$5 AND expires_at>now()
       AND idempotency_key=$6::text
     RETURNING id`,
    [token, owner, input.projectId, input.revision, operation, input.idempotencyKey],
  );
  if (!result.rows.length)
    throw new StudioError("CONSENT", "This approval is invalid, expired or already used; approve again in the vidio studio", 409);
}
