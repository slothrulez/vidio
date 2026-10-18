/* eslint-disable @next/next/no-img-element -- Standalone MCP App has no Next image runtime. */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Play,
  ImagePlus,
  RefreshCw,
  Download,
  Film,
  Sparkles,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Badge } from "../components/ui/badge";
import { Progress } from "../components/ui/progress";
import { Checkbox } from "../components/ui/checkbox";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "../components/ui/dialog";
import type { McpToolName } from "../studio/mcp-contracts";
import type {
  CompositionOptions,
  StudioJob,
  StudioProject,
  ToolResponse,
} from "../studio/types";
import { imageIds, jobIsActive, outputIsReady, sceneStates } from "./ui-state";
import { GenerationModeControl, generationDescription, footageLabel, type GenerationMode } from "../studio/GenerationModeControl";

export type EmbeddedTransport = {
  callTool: (
    name: McpToolName,
    args: Record<string, unknown>,
  ) => Promise<ToolResponse>;
  openLink?: (url: string) => Promise<void>;
  updateContext?: (project: StudioProject) => Promise<void>;
};
type ActionRequest = {
  name: "start_video_job" | "regenerate_segment" | "compose_final_video";
  segmentId?: number;
  segmentIds?: number[];
  composition?: CompositionOptions;
  generationMode?: GenerationMode;
};
type Action = ActionRequest & {projectId:string;revision:number};
type Draft = { script: string; prompt: string; revision:number };

function ActionConfirmation({
  action,
  disabled,
  onCancel,
  onConfirm,
  returnFocus,
}: {
  action: Action;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  returnFocus: () => void;
}) {
  return (
    <Dialog open modal={false} onOpenChange={(open) => { if (!open) onCancel(); }}>
      {/* In-flow content stays beside its action in auto-height host iframes. */}
      <DialogPrimitive.Content
        role="alertdialog"
        className="relative mt-3 grid gap-4 rounded-xl border border-purple-200 bg-white p-4 shadow-sm outline-none"
        onInteractOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {action.name === "compose_final_video"
              ? "Approve final composition?"
              : action.name === "regenerate_segment"
                ? `Approve scene ${action.segmentId} regeneration?`
                : "Approve video generation?"}
          </DialogTitle>
          <DialogDescription>
            {action.name === "compose_final_video" ? "Compose completed scenes with FFmpeg; no new AI inference." : generationDescription(action.generationMode ?? "wan")}{" "}
            {action.name === "compose_final_video" &&
              `${action.segmentIds?.length} completed scenes; subtitles ${action.composition?.subtitles ? "on" : "off"}; music ${action.composition?.backgroundMusic}.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Not yet</Button>
          </DialogClose>
          <Button disabled={disabled} onClick={onConfirm}>Approve &amp; start</Button>
        </DialogFooter>
      </DialogPrimitive.Content>
    </Dialog>
  );
}

export function EmbeddedStudio({
  transport,
  incoming,
  requestedProject,
}: {
  transport: EmbeddedTransport;
  incoming?: ToolResponse;
  requestedProject?: string;
}) {
  const [project, setProject] = useState<StudioProject>(),
    [projects, setProjects] = useState<StudioProject[]>([]),
    [job, setJob] = useState<StudioJob>();
  const [media, setMedia] = useState<Record<string, string>>({}),
    [expiresAt, setExpiresAt] = useState<string>();
  const [loading, setLoading] = useState(true),
    [working, setWorking] = useState(false),
    [error, setError] = useState("");
  const [name, setName] = useState(""),
    [ratio, setRatio] = useState<StudioProject["ratio"]>("16:9");
  const [drafts, setDrafts] = useState<Record<number, Draft>>({}),
    [approval, setApproval] = useState<number>(),
    [selected, setSelected] = useState<number[]>([]);
  const [generationMode,setGenerationMode] = useState<GenerationMode>("wan");
  const [composition, setComposition] = useState<CompositionOptions>({
      subtitles: true,
      backgroundMusic: "soft",
    }),
    [action, setAction] = useState<Action>();
  const [uploadStatus, setUploadStatus] = useState(""),
    [readyAsset, setReadyAsset] = useState<string>(),
    [mediaVersion, setMediaVersion] = useState(0),
    [mediaErrors, setMediaErrors] = useState<Record<string, boolean>>({});
  const projectRef = useRef(project),
    actionTrigger = useRef<HTMLButtonElement | null>(null),
    actionKeys = useRef(new Map<string, string>()),
    refreshing = useRef(false);
  const busy = working || jobIsActive(job) || !!project?.activeJobId;
  const hasEdits = Object.entries(drafts).some(([id, draft]) => {
    const original = project?.scripts.find(
      (script) => script.id === Number(id),
    );
    return (
      original &&
      (draft.script !== original.script || draft.prompt !== original.prompt)
    );
  });
  const draftConflict=hasEdits && Object.values(drafts).some(draft=>draft.revision!==project?.revision);

  const apply = useCallback((result: ToolResponse) => {
    const next = result.structuredContent.project;
    if (next) {
      if (projectRef.current?.id===next.id && next.revision<projectRef.current.revision) return;
      if (projectRef.current?.id!==next.id || projectRef.current.revision!==next.revision) setAction(undefined);
      if (projectRef.current?.id !== next.id) {
        setDrafts({});
        setJob(undefined);
        setApproval(undefined);
        setSelected([]);
        setReadyAsset(undefined);
        setMediaErrors({});
      }
      projectRef.current = next;
      setProject(next);
      setProjects((old) =>
        [next, ...old.filter((item) => item.id !== next.id)].slice(0, 20),
      );
    }
    if (result.structuredContent.projects)
      setProjects(result.structuredContent.projects);
    const nextJob = result.structuredContent.job;
    if (
      nextJob &&
      (!projectRef.current || nextJob.projectId === projectRef.current.id)
    )
      setJob(old=>old?.id===nextJob.id && old.updatedAt && nextJob.updatedAt && old.updatedAt>nextJob.updatedAt ? old : nextJob);
    if (result._meta?.media) {
      setMedia((old) => ({ ...old, ...result._meta!.media }));
      setExpiresAt(result._meta.mediaExpiresAt);
    }
  }, []);
  useEffect(() => {
    if (!requestedProject) return;
    let alive = true;
    void transport
      .callTool("get_project", { projectId: requestedProject })
      .then((result) => {
        if (alive) apply(result);
      })
      .catch((error) => {
        if (alive)
          setError(
            error instanceof Error
              ? error.message
              : "Host project could not load",
          );
      });
    return () => {
      alive = false;
    };
  }, [requestedProject, transport, apply]);
  useEffect(() => {
    if (!incoming) return;
    apply(incoming);
    setLoading(false);
    const id =
      incoming.structuredContent.project?.id ??
      incoming.structuredContent.job?.projectId;
    let alive = true;
    if (id)
      void transport
        .callTool("get_project", { projectId: id })
        .then((result) => {
          if (alive && (!projectRef.current || projectRef.current.id === id))
            apply(result);
        })
        .catch((error) => {
          if (alive)
            setError(
              error instanceof Error
                ? error.message
                : "Project could not resume",
            );
        });
    return () => {
      alive = false;
    };
  }, [incoming, apply, transport]);
  useEffect(() => {
    let alive = true;
    void transport
      .callTool("list_projects", {})
      .then((result) => {
        if (alive) {
          setProjects(result.structuredContent.projects ?? []);
          setLoading(false);
        }
      })
      .catch((error) => {
        if (alive) {
          setError(
            error instanceof Error ? error.message : "Projects could not load",
          );
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [transport]);
  const run = useCallback(
    async (work: () => Promise<ToolResponse>) => {
      setWorking(true);
      setError("");
      try {
        const result = await work();
        apply(result);
        return result;
      } catch (error) {
        setError(
          error instanceof Error
            ? error.message
            : "Request failed; refresh and try again",
        );
        return undefined;
      } finally {
        setWorking(false);
      }
    },
    [apply],
  );
  const refresh = useCallback(async () => {
    const current = projectRef.current;
    if (!current || refreshing.current) return;
    refreshing.current = true;
    try {
      const result = await transport.callTool("get_project", {
        projectId: current.id,
      });
      if (projectRef.current?.id === current.id) {
        apply(result);
        setMediaErrors({});
        setReadyAsset(undefined);
        setMediaVersion((version) => version + 1);
        setError("");
      }
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Media could not refresh",
      );
    } finally {
      refreshing.current = false;
    }
  }, [transport, apply]);
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(
      () => void refresh(),
      Math.max(1000, new Date(expiresAt).getTime() - Date.now() - 30_000),
    );
    return () => clearTimeout(timer);
  }, [expiresAt, refresh]);
  const pollingId =
      project?.activeJobId ?? (jobIsActive(job) ? job?.id : undefined),
    projectId = project?.id;
  useEffect(() => {
    if (!pollingId || !projectId) return;
    let alive = true,
      failures = 0,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [result, latest] = await Promise.all([
          transport.callTool("get_video_job_status", { jobId: pollingId }),
          transport.callTool("get_project", { projectId }),
        ]);
        if (!alive || projectRef.current?.id !== projectId) return;
        apply(latest);
        apply(result);
        failures = 0;
        if (!jobIsActive(result.structuredContent.job)) {
          const final=await transport.callTool("get_project",{projectId});
          if (!alive || projectRef.current?.id!==projectId) return;
          apply(final);
          if (result.structuredContent.job?.error)
            setError(result.structuredContent.job.error);
          return;
        }
      } catch (error) {
        if (!alive) return;
        failures++;
        setError(
          error instanceof Error
            ? error.message
            : "Progress connection interrupted",
        );
      }
      if (alive)
        timer = setTimeout(
          () => void poll(),
          Math.min(1500 * 2 ** failures, 20_000),
        );
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [pollingId, projectId, transport, apply]);
  const contextKey = JSON.stringify({
    id: project?.id,
    revision: project?.revision,
    stage: project?.stage,
    activeJobId: project?.activeJobId,
    completed: project?.segments.length,
  });
  useEffect(() => {
    if (projectRef.current && transport.updateContext)
      void transport.updateContext(projectRef.current).catch(() => {});
  }, [contextKey, transport]);
  const completedIds =
    project?.segments.map((segment) => segment.id).join(",") ?? "";
  useEffect(() => {
    setSelected(completedIds ? completedIds.split(",").map(Number) : []);
  }, [completedIds, projectId]);

  const start = async (request: Action) => {
    const current = projectRef.current;
    if (!current || request.projectId!==current.id || request.revision!==current.revision) {
      setError("Project changed; review it and confirm again.");
      return;
    }
    const args = {
      confirmed: true,
      ...request,
    };
    const identity = JSON.stringify(args);
    const key = actionKeys.current.get(identity) ?? crypto.randomUUID();
    actionKeys.current.set(identity, key);
    const { name, ...input } = args;
    await run(async () => {
      const grant = await transport.callTool("grant_cost_consent", {
        projectId: request.projectId,
        revision: request.revision,
        operation: name,
        idempotencyKey: key,
        ...(request.generationMode ? {generationMode:request.generationMode} : {}),
      });
      const consentToken = grant.structuredContent.consent?.token;
      if (!consentToken) throw new Error("Approval could not be recorded; try again.");
      return transport.callTool(name, { ...input, idempotencyKey: key, consentToken });
    });
  };
  const upload = async (files: File[]) => {
    if (!projectRef.current) return;
    if (files.length + imageIds(projectRef.current).length > 6) {
      setError("Use up to six PNG/JPEG product images");
      return;
    }
    if (
      files.some(
        (file) =>
          !["image/png", "image/jpeg"].includes(file.type) ||
          file.size > 5_000_000 ||
          file.size < 24,
      )
    ) {
      setError("Choose valid PNG/JPEG images under 5 MB each");
      return;
    }
    setWorking(true);
    setError("");
    let unfinishedUpload: string | undefined;
    try {
      for (const [index, file] of files.entries()) {
        const current = projectRef.current!;
        const begin = await transport.callTool("begin_image_upload", {
          projectId: current.id,
          revision: current.revision,
          mime: file.type,
          size: file.size,
        });
        const upload = begin._meta?.upload;
        if (!upload) throw new Error("Upload was not initialized");
        unfinishedUpload = upload.id;
        for (let offset = 0; offset < file.size; ) {
          setUploadStatus(
            `Uploading image ${index + 1} of ${files.length} · ${Math.round((offset / file.size) * 100)}%`,
          );
          const bytes = new Uint8Array(
            await file.slice(offset, offset + 196_608).arrayBuffer(),
          );
          let binary = "";
          for (let i = 0; i < bytes.length; i += 8192)
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          const chunk = { uploadId: upload.id, offset, data: btoa(binary) };
          let saved: ToolResponse | undefined;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              saved = await transport.callTool("append_image_chunk", chunk);
              break;
            } catch (error) {
              if (attempt === 2) throw error;
              await new Promise((resolve) =>
                setTimeout(resolve, 250 * 2 ** attempt),
              );
            }
          }
          const next = saved?._meta?.upload?.offset;
          if (next !== offset + bytes.length)
            throw new Error(
              "Upload could not be confirmed; select the file again",
            );
          offset = next;
        }
        apply(
          await transport.callTool("finish_image_upload", {
            uploadId: upload.id,
          }),
        );
        unfinishedUpload = undefined;
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "An image failed to upload; saved photos remain available",
      );
    } finally {
      if (unfinishedUpload)
        await transport
          .callTool("abort_image_upload", { uploadId: unfinishedUpload })
          .catch(() => {});
      setWorking(false);
      setUploadStatus("");
    }
  };
  const finalUrl = project?.finalAssetId
    ? media[project.finalAssetId]
    : undefined;
  const downloadReady =
    !!project &&
    outputIsReady(project, readyAsset, finalUrl) &&
    !mediaErrors[project.finalAssetId!];
  const sceneList = project ? sceneStates(project, job) : [];
  const requestAction = (request: ActionRequest, trigger: HTMLButtonElement) => {
    if (!project) return;
    actionTrigger.current = trigger;
    setAction({...request,...(request.name !== "compose_final_video" ? {generationMode} : {}),projectId:project.id,revision:project.revision});
  };
  const confirmation = action && project ? (
    <ActionConfirmation
      action={action}
      disabled={busy || hasEdits || (action.name !== "compose_final_video" && approval !== project.revision)}
      onCancel={() => setAction(undefined)}
      onConfirm={() => { setAction(undefined); void start(action); }}
      returnFocus={() => actionTrigger.current?.focus({preventScroll:true})}
    />
  ) : null;

  return (
    <div className="bg-[#f8f7fc] text-slate-900 min-h-screen p-4 sm:p-6 space-y-5 font-sans">
      <header className="flex justify-between items-center gap-3">
        <div className="flex items-center gap-3">
          <span className="bg-[#7543cf] text-white p-2 rounded-xl">
            <Play size={20} fill="currentColor" />
          </span>
          <strong className="text-2xl tracking-tight">vidio</strong>
        </div>
        <Badge variant="secondary">
          {(project?.mode ?? incoming?.structuredContent.mode) === "production"
            ? "Production"
            : "Explicit demo"}
        </Badge>
      </header>
      <div className="rounded-xl bg-purple-50 border border-purple-100 p-3 text-sm text-purple-900">
        {(project?.mode ?? incoming?.structuredContent.mode) === "production"
          ? "Paid generation uses your configured provider and daily allowance. Recognition/script adapters may be unavailable. English voiceover is requested from the native-audio model, not guaranteed by a dedicated TTS engine."
          : "Recognition and script drafts are fixtures; voice preview is a tone. Choose Wan for real AI footage using available free shared GPU quota, or explicitly choose static fallback. No paid provider calls in preview mode."}
      </div>
      {error && (
        <div
          role="alert"
          className="border border-red-200 bg-red-50 rounded-xl p-3 text-sm text-red-800"
        >
          <p>{error}</p>
          <div className="flex gap-3 mt-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refresh()}
              disabled={!project || working}
            >
              Refresh project / media
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setError("")}>
              Dismiss error
            </Button>
          </div>
        </div>
      )}
      {loading && <p role="status">Loading owned projects…</p>}
      <div className="flex items-center gap-2">
        <label htmlFor="embedded-projects" className="text-sm">
          Saved projects
        </label>
        <select
          id="embedded-projects"
          className="border rounded-lg p-2 bg-white min-w-0 flex-1"
          value={project?.id ?? ""}
          disabled={busy}
          onChange={(event) =>
            void run(() =>
              transport.callTool("get_project", {
                projectId: event.target.value,
              }),
            )
          }
        >
          <option value="" disabled>
            Choose a project
          </option>
          {projects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>
      <details open={!project}>
        <summary className="cursor-pointer font-medium">
          {project ? "Create another project" : "1. Create your product story"}
        </summary>
        <Card className="mt-3 border-purple-100">
          <CardContent className="p-4 space-y-3">
            <label className="block text-sm" htmlFor="embedded-name">
              Product name
            </label>
            <Input
              id="embedded-name"
              value={name}
              maxLength={100}
              disabled={busy}
              placeholder="e.g. Everyday travel mug"
              onChange={(event) => setName(event.target.value)}
            />
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm" htmlFor="embedded-language">
                Voiceover language
                <Input id="embedded-language" value="English" readOnly className="mt-1" />
              </label>
              <label className="text-sm">
                Video format
                <select
                  aria-label="Video format"
                  value={ratio}
                  disabled={busy}
                  onChange={(event) =>
                    setRatio(event.target.value as StudioProject["ratio"])
                  }
                  className="block border rounded-lg p-2 w-full mt-1 bg-white"
                >
                  <option value="16:9">16:9 · landscape</option>
                  <option value="9:16">9:16 · portrait</option>
                </select>
              </label>
            </div>
            <Button
              disabled={busy || !name.trim()}
              onClick={() =>
                void run(() =>
                  transport.callTool("create_project", {
                    name: name.trim(),
                    language: "english",
                    ratio,
                  }),
                )
              }
            >
              Create project
            </Button>
          </CardContent>
        </Card>
      </details>
      {!project && !loading && (
        <Card>
          <CardContent className="p-8 text-center space-y-3">
            <Sparkles className="mx-auto text-purple-600" />
            <h1 className="text-xl font-semibold">
              A product. A story. Your approval.
            </h1>
            <p className="text-sm text-slate-500">
              Create a project, upload up to six photos, then review every scene
              before generation.
            </p>
          </CardContent>
        </Card>
      )}
      {project && (
        <>
          <div className="flex justify-between gap-2">
            <div>
              <h1 className="text-xl font-semibold">{project.name}</h1>
              <p className="text-sm text-slate-500">
                English · {project.ratio} · Revision{" "}
                {project.revision}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={working}
              onClick={() => void refresh()}
              aria-label="Refresh project"
            >
              <RefreshCw size={16} />
            </Button>
          </div>
          <section
            aria-labelledby="embedded-product-title"
            className="space-y-3"
          >
            <h2 id="embedded-product-title" className="font-semibold">
              2. Product photos & selling points
            </h2>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              {imageIds(project).map((id, index) => (
                <img
                  key={id}
                  src={media[id]}
                  alt={`Product photo ${index + 1}`}
                  className="aspect-square rounded-xl border object-cover"
                  onError={() =>
                    setMediaErrors((old) => ({ ...old, [id]: true }))
                  }
                />
              ))}
            </div>
            {Object.values(mediaErrors).some(Boolean) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refresh()}
              >
                Refresh expired media links
              </Button>
            )}
            <label className="flex flex-wrap items-center gap-2 text-sm border border-dashed rounded-xl p-3 bg-white">
              <ImagePlus size={16} />
              Upload multiple product images
              <input
                aria-label="Upload product images"
                type="file"
                accept="image/png,image/jpeg"
                multiple
                disabled={
                  busy ||
                  project.stage !== "new" ||
                  imageIds(project).length >= 6
                }
                className="w-full min-w-0 text-xs"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  void upload(files);
                }}
              />
            </label>
            <p className="text-xs text-slate-500">
              PNG/JPEG · up to 5 MB each · 6 photos · private owner-scoped
              storage. Upload before identifying.
            </p>
            {uploadStatus && <p role="status">{uploadStatus}</p>}
            {project.features.length ? (
              <ul className="list-disc ml-5 text-sm space-y-1">
                {project.features.map((feature, index) => (
                  <li key={index}>{feature}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">
                No recognized product information yet.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={
                  busy || !imageIds(project).length || project.stage !== "new"
                }
                onClick={() =>
                  void run(() =>
                    transport.callTool("identify_product", {
                      projectId: project.id,
                      revision: project.revision,
                    }),
                  )
                }
              >
                Identify product
              </Button>
              <Button
                disabled={busy || !project.features.length || hasEdits}
                onClick={() =>
                  void run(() =>
                    transport.callTool("generate_scripts", {
                      projectId: project.id,
                      revision: project.revision,
                    }),
                  )
                }
              >
                {project.mode === "demo"
                  ? "Generate fixture scripts"
                  : "Generate promotional scripts"}
              </Button>
            </div>
          </section>
          {!!project.scripts.length && (
            <section
              aria-labelledby="embedded-script-title"
              className="space-y-3"
            >
              <h2 id="embedded-script-title" className="font-semibold">
                3. Edit & approve your script
              </h2>
              <div className="grid sm:grid-cols-2 gap-3">
                {project.scripts.map((script) => (
                  <Card key={`${project.id}-${script.id}`}>
                    <CardContent className="p-4 space-y-2">
                      <Badge variant="secondary">Scene {script.id}</Badge>
                      <label
                        htmlFor={`embedded-script-${script.id}`}
                        className="block text-sm"
                      >
                        Narration · scene {script.id}
                      </label>
                      <Textarea
                        id={`embedded-script-${script.id}`}
                        value={drafts[script.id]?.script ?? script.script}
                        maxLength={1000}
                        disabled={busy}
                        onChange={(event) => {
                          setApproval(undefined);
                          setDrafts((old) => ({
                            ...old,
                            [script.id]: {
                              prompt: old[script.id]?.prompt ?? script.prompt,
                              script: event.target.value,
                              revision: old[script.id]?.revision ?? project.revision,
                            },
                          }));
                        }}
                      />
                      <label
                        htmlFor={`embedded-prompt-${script.id}`}
                        className="block text-sm"
                      >
                        Visual direction · scene {script.id}
                      </label>
                      <Textarea
                        id={`embedded-prompt-${script.id}`}
                        value={drafts[script.id]?.prompt ?? script.prompt}
                        maxLength={1500}
                        disabled={busy}
                        onChange={(event) => {
                          setApproval(undefined);
                          setDrafts((old) => ({
                            ...old,
                            [script.id]: {
                              script: old[script.id]?.script ?? script.script,
                              prompt: event.target.value,
                              revision: old[script.id]?.revision ?? project.revision,
                            },
                          }));
                        }}
                      />
                    </CardContent>
                  </Card>
                ))}
              </div>
              <Button
                variant="outline"
                disabled={
                  busy ||
                  draftConflict ||
                  !hasEdits ||
                  project.scripts.some(
                    (script) =>
                      !(drafts[script.id]?.script ?? script.script).trim() ||
                      !(drafts[script.id]?.prompt ?? script.prompt).trim(),
                  )
                }
                onClick={async () => {
                  const result = await run(() =>
                    transport.callTool("save_scripts", {
                      projectId: project.id,
                      revision: project.revision,
                      scripts: project.scripts.map((script) => ({
                        id:script.id,
                        script:drafts[script.id]?.script ?? script.script,
                        prompt:drafts[script.id]?.prompt ?? script.prompt,
                      })),
                    }),
                  );
                  if (result) {
                    setDrafts({});
                    setApproval(undefined);
                  }
                }}
              >
                Save all script edits
              </Button>
              {hasEdits && (
                <p className="text-sm text-purple-700">
                  Unsaved edits — save before approval or generation.
                </p>
              )}
              {draftConflict && (
                <div role="alert" className="text-sm text-red-700">
                  This project changed while you were editing. Your draft has not been saved.
                  <Button variant="outline" onClick={()=>{setDrafts({});setApproval(undefined);}}>Discard conflicted edits</Button>
                </div>
              )}
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={approval === project.revision && !hasEdits}
                  disabled={busy || hasEdits}
                  onCheckedChange={(checked) =>
                    setApproval(checked === true ? project.revision : undefined)
                  }
                />
                I reviewed and approve this revision of the script
              </label>
              <GenerationModeControl value={generationMode} onChange={setGenerationMode} disabled={busy || !!action} production={project.mode === "production"} />
              <Button
                disabled={busy || hasEdits || approval !== project.revision}
                onClick={(event) => requestAction({ name: "start_video_job" }, event.currentTarget)}
              >
                <Film size={16} />
                {generationMode === "static" ? "Render static fallback" : job?.status === "failed" ? "Retry AI generation" : "Generate AI scenes"}
              </Button>
              {action?.name === "start_video_job" && confirmation}
            </section>
          )}
          {job && (
            <section
              aria-label="Persistent generation progress"
              className="bg-white rounded-xl p-4 border space-y-2"
            >
              <p role="status" aria-live="polite" className="text-sm">
                {job.lifecycleStatus ?? job.status} · {Math.round(job.progress)}
                % · attempt {job.attempts ?? 1}
              </p>
              <Progress aria-label="Generation progress" value={job.progress} />
              <p className="text-xs text-slate-500">
                Job {job.id}. Progress is stored on the server and survives
                refresh.
              </p>
              {job.error && <p className="text-sm text-red-800">{job.error}</p>}
              {job.retryable && job.status === "failed" && (
                <Button
                  variant="outline"
                  disabled={working}
                  onClick={() =>
                    void run(() =>
                      transport.callTool("retry_job", { jobId: job.id }),
                    )
                  }
                >
                  Retry this job safely
                </Button>
              )}
              {jobIsActive(job) && (
                <Button
                  variant="ghost"
                  disabled={working}
                  onClick={() =>
                    void run(() =>
                      transport.callTool("cancel_job", { jobId: job.id }),
                    )
                  }
                >
                  Cancel job
                </Button>
              )}
            </section>
          )}
          {!!sceneList.length && (
            <section
              aria-labelledby="embedded-scenes-title"
              className="space-y-3"
            >
              <h2 id="embedded-scenes-title" className="font-semibold">
                4. Scene states & previews
              </h2>
              <div className="grid sm:grid-cols-2 gap-3">
                {sceneList.map(({ script, segment, record, status }) => (
                  <Card key={script.id}>
                    <CardContent className="p-4 space-y-3">
                      <div className="flex justify-between items-center gap-2">
                        <strong className="text-sm">Scene {script.id}</strong>
                        <Badge variant="secondary">
                          {status.replaceAll("_", " ")}
                        </Badge>
                      </div>
                      {segment && <p className="text-xs text-slate-500">{footageLabel(segment.generationMode)}{segment.model ? ` · ${segment.model}` : ""}</p>}
                      {segment && media[segment.assetId] ? (
                        <video
                          key={`${segment.assetId}-${mediaVersion}`}
                          aria-label={`Scene ${script.id} preview`}
                          controls
                          preload="metadata"
                          src={media[segment.assetId]}
                          className="w-full aspect-video bg-purple-50 rounded-lg"
                          onError={() =>
                            setMediaErrors((old) => ({
                              ...old,
                              [segment.assetId]: true,
                            }))
                          }
                        />
                      ) : (
                        <p className="text-sm text-slate-500">
                          No completed video for this scene.
                        </p>
                      )}
                      {record?.error && (
                        <p className="text-sm text-red-800">{record.error}</p>
                      )}
                      <p className="text-xs text-slate-500">{script.script}</p>
                      <div className="flex flex-wrap items-center gap-3">
                        <label className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={selected.includes(script.id)}
                            disabled={busy || !segment}
                            onCheckedChange={(checked) =>
                              setSelected((old) =>
                                checked
                                  ? [
                                      ...old.filter((id) => id !== script.id),
                                      script.id,
                                    ]
                                  : old.filter((id) => id !== script.id),
                              )
                            }
                          />
                          Include scene {script.id}
                        </label>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            busy || hasEdits || approval !== project.revision
                          }
                          onClick={(event) =>
                            requestAction({
                              name: "regenerate_segment",
                              segmentId: script.id,
                            }, event.currentTarget)
                          }
                        >
                          Regenerate scene {script.id}
                        </Button>
                      </div>
                      {action?.name === "regenerate_segment" && action.segmentId === script.id && confirmation}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          )}
          {!!project.segments.length && (
            <section
              aria-labelledby="embedded-compose-title"
              className="space-y-3"
            >
              <h2 id="embedded-compose-title" className="font-semibold">
                5. Final composition
              </h2>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  disabled={busy}
                  checked={composition.subtitles}
                  onCheckedChange={(checked) =>
                    setComposition((old) => ({
                      ...old,
                      subtitles: checked === true,
                    }))
                  }
                />
                Include subtitles (MP4 captions + preview CC)
              </label>
              <label className="block text-sm">Scene transitions
                <select aria-label="Scene transitions" disabled={busy || !!action} value={composition.transition ?? "cut"} onChange={event=>setComposition(old=>({...old,transition:event.target.value === "fade" ? "fade" : "cut"}))} className="ml-3 rounded border p-2">
                  <option value="cut">Hard cut</option><option value="fade">Fade through black</option>
                </select>
              </label>
              <label className="block text-sm">
                Background music
                <select
                  aria-label="Background music"
                  value={composition.backgroundMusic}
                  disabled={busy}
                  onChange={(event) =>
                    setComposition((old) => ({
                      ...old,
                      backgroundMusic: event.target
                        .value as CompositionOptions["backgroundMusic"],
                    }))
                  }
                  className="ml-2 bg-white border rounded-lg p-2"
                >
                  <option value="none">None</option>
                  <option value="soft">
                    Soft instrumental · original synth
                  </option>
                </select>
              </label>
              <p className="text-xs text-slate-500">
                Scenes play in their original order. Failed/uncompleted scenes
                cannot be selected.
              </p>
              <Button
                disabled={busy || hasEdits || !selected.length}
                onClick={(event) =>
                  requestAction({
                    name: "compose_final_video",
                    segmentIds: [...selected].sort((a, b) => a - b),
                    composition,
                  }, event.currentTarget)
                }
              >
                Compose final MP4
              </Button>
              {action?.name === "compose_final_video" && confirmation}
            </section>
          )}
          {project.stage === "done" && project.finalAssetId && finalUrl && (
            <section
              aria-labelledby="embedded-final-title"
              className="space-y-3"
            >
              <h2 id="embedded-final-title" className="font-semibold">
                {project.mode === "demo"
                  ? "Completed MP4"
                  : "Your final MP4"}
              </h2>
              <p className="text-xs text-slate-500">Scene sources: {Array.from(new Set(project.segments.map(segment=>footageLabel(segment.generationMode)))).join("; ")}. Static scenes are not AI footage. Wan clips have no generated speech.</p>
              <video
                key={`${project.finalAssetId}-${mediaVersion}`}
                aria-label="Final video preview"
                controls
                crossOrigin="anonymous"
                preload="metadata"
                src={finalUrl}
                className="w-full max-h-96 rounded-xl bg-purple-50"
                onLoadedMetadata={(event) => {
                  if (
                    Number.isFinite(event.currentTarget.duration) &&
                    event.currentTarget.duration > 0
                  ) {
                    setReadyAsset(project.finalAssetId);
                    setMediaErrors((old) => ({
                      ...old,
                      [project.finalAssetId!]: false,
                    }));
                  }
                }}
                onError={() => {
                  setReadyAsset(undefined);
                  setMediaErrors((old) => ({
                    ...old,
                    [project.finalAssetId!]: true,
                  }));
                }}
              >
                {project.captionAssetId && media[project.captionAssetId] && (
                  <track
                    key={media[project.captionAssetId]}
                    kind="captions"
                    src={media[project.captionAssetId]}
                    srcLang="en"
                    label="English captions"
                    default
                  />
                )}
              </video>
              {downloadReady ? (
                <Button
                  disabled={working}
                  onClick={async () => {
                    const result = await run(() =>
                      transport.callTool("get_final_video", {
                        projectId: project.id,
                      }),
                    );
                    const id = result?.structuredContent.finalVideo?.assetId;
                    const url = id ? result?._meta?.media?.[id] : undefined;
                    if (id !== project.finalAssetId || !url) {
                      setError(
                        "Final output is unavailable; refresh its preview",
                      );
                      return;
                    }
                    if (transport.openLink)
                      try {
                        await transport.openLink(`${url}&download=1`);
                      } catch {
                        setError(
                          "This host could not open the download. Try another supported host.",
                        );
                      }
                    else
                      setError("This host does not support opening downloads.");
                  }}
                >
                  <Download size={16} />
                  Download MP4
                </Button>
              ) : (
                <p role="status" className="text-sm text-slate-500">
                  Download becomes available after the MP4 preview validates.
                  Refresh media if its link expired.
                </p>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refresh()}
              >
                Refresh final media
              </Button>
            </section>
          )}
        </>
      )}
    </div>
  );
}
