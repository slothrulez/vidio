import type { StudioJob, StudioProject } from "../studio/types";

export function jobIsActive(job?: StudioJob) {
  return (
    !!job &&
    ["queued", "running", "partially_completed"].includes(
      job.lifecycleStatus ?? job.status,
    )
  );
}
export function imageIds(project: StudioProject) {
  return (
    project.imageAssetIds ??
    (project.imageAssetId ? [project.imageAssetId] : [])
  );
}
export function sceneStates(project: StudioProject, job?: StudioJob) {
  return project.scripts.map((script) => {
    const record =
      job?.projectId === project.id
        ? job.segments?.find((segment) => segment.ordinal === script.id)
        : undefined;
    const segment = project.segments.find(
      (segment) => segment.id === script.id,
    );
    const status = record?.status ?? (segment ? "completed" : "not_started");
    return {
      script,
      segment,
      record,
      status:
        status === "queued" && job && !jobIsActive(job)
          ? "not_started"
          : status,
    };
  });
}
export function outputIsReady(
  project: StudioProject,
  readyAsset?: string,
  url?: string,
) {
  return (
    project.stage === "done" &&
    !!project.finalAssetId &&
    project.finalAssetId === readyAsset &&
    !!url
  );
}
