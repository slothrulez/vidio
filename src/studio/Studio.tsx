"use client";

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import {
  Play,
  ArrowRight,
  Loader2,
  Check,
  Download,
  ImagePlus,
  RefreshCw,
  Film,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import {
  toolOutputSchema,
  type StudioProject,
  type StudioJob,
  type ToolResponse,
  type Operation,
} from "./types";
import type { ToolName } from "./service";

export type StudioTransport = {
  callTool: (
    name: ToolName,
    args: Record<string, unknown>,
  ) => Promise<ToolResponse>;
  upload?: (project: StudioProject, file: File) => Promise<ToolResponse>;
};
export function parseToolResponse(value: unknown): ToolResponse {
  const raw = z
    .object({
      isError: z.boolean().optional(),
      content: z.array(z.object({ text: z.string().optional() })).optional(),
      structuredContent: z.unknown().optional(),
      _meta: z
        .object({ media: z.record(z.string(), z.string().url()).optional() })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .parse(value);
  if (raw.isError)
    throw new Error(
      raw.content?.find((item) => item.text)?.text ?? "Tool failed",
    );
  return {
    structuredContent: toolOutputSchema.parse(raw.structuredContent),
    _meta: raw._meta,
  };
}

function ScriptEditor({
  script,
  busy,
  onSave,
  onDirty,
}: {
  script: StudioProject["scripts"][number];
  busy: boolean;
  onSave: (script: string, prompt: string) => Promise<void>;
  onDirty: (id: number, dirty: boolean) => void;
}) {
  const [text, setText] = useState(script.script),
    [prompt, setPrompt] = useState(script.prompt);
  const dirty = text !== script.script || prompt !== script.prompt;
  useEffect(() => {
    onDirty(script.id, dirty);
  }, [script.id, dirty, onDirty]);
  return (
    <Card className="border-purple-100 shadow-none">
      <CardContent className="p-5 space-y-3">
        <div className="flex justify-between items-center">
          <Badge variant="secondary">
            Scene {script.id.toString().padStart(2, "0")}
          </Badge>
          <span className="text-xs text-slate-400">
            {dirty ? "Unsaved edits" : "Ready to review"}
          </span>
        </div>
        <label
          className="block text-sm font-medium"
          htmlFor={`script-${script.id}`}
        >
          Narration script
        </label>
        <Textarea
          id={`script-${script.id}`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={1000}
          disabled={busy}
          className="min-h-24 resize-y bg-slate-50 border-slate-100"
        />
        <details>
          <summary className="cursor-pointer text-xs font-medium text-purple-700 py-1">
            Visual direction
          </summary>
          <Textarea
            aria-label={`Scene ${script.id} visual direction`}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            maxLength={1500}
            disabled={busy}
            className="mt-2"
          />
        </details>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !dirty || !text.trim() || !prompt.trim()}
          onClick={() => {
            void onSave(text, prompt);
          }}
        >
          Save edits
        </Button>
      </CardContent>
    </Card>
  );
}

export function Studio({
  transport,
  incoming,
  embedded = false,
}: {
  transport: StudioTransport;
  incoming?: ToolResponse;
  embedded?: boolean;
}) {
  const [project, setProject] = useState<StudioProject>(),
    [projects, setProjects] = useState<StudioProject[]>([]);
  const [job, setJob] = useState<StudioJob>(),
    [media, setMedia] = useState<Record<string, string>>({});
  const [name, setName] = useState("Everyday essential"),
    [language, setLanguage] = useState<"english" | "mandarin">("english"),
    [ratio, setRatio] = useState<"16:9" | "9:16" | "1:1">("16:9");
  const [working, setWorking] = useState(false),
    [error, setError] = useState(""),
    [dirty, setDirty] = useState<Record<number, boolean>>({});
  const [selected, setSelected] = useState<number[]>([]);
  const [confirmation, setConfirmation] = useState<{
    operation: Operation;
    segmentId?: number;
    segmentIds?: number[];
  }>();
  const busy = working || job?.status === "queued" || job?.status === "running";
  const hasEdits = Object.values(dirty).some(Boolean);
  const apply = useCallback(
    (result: ToolResponse) => {
      if (result.structuredContent.project) {
        const next = result.structuredContent.project;
        setProject(next);
        setProjects((old) =>
          [next, ...old.filter((item) => item.id !== next.id)].slice(0, 20),
        );
        if (!embedded) localStorage.setItem("vidio_studio_project", next.id);
      }
      if (result.structuredContent.projects)
        setProjects(result.structuredContent.projects);
      if (result.structuredContent.job) setJob(result.structuredContent.job);
      if (result._meta?.media)
        setMedia((old) => ({ ...old, ...result._meta!.media }));
    },
    [embedded],
  );
  useEffect(() => {
    if (incoming) apply(incoming);
  }, [incoming, apply]);
  useEffect(() => {
    if (embedded) return;
    let alive = true;
    async function load() {
      try {
        const result = await transport.callTool("list_projects", {});
        if (!alive) return;
        apply(result);
        const last = localStorage.getItem("vidio_studio_project");
        const saved =
          result.structuredContent.projects?.find((item) => item.id === last) ??
          result.structuredContent.projects?.[0];
        if (saved) {
          const result = await transport.callTool("get_project", {
            projectId: saved.id,
          });
          if (alive) apply(result);
        }
      } catch (error) {
        if (alive)
          setError(
            error instanceof Error ? error.message : "Studio could not load",
          );
      }
    }
    void load();
    return () => {
      alive = false;
    };
  }, [transport, embedded, apply]);
  const selectionKey = JSON.stringify({
    projectId: project?.id,
    ids: project?.segments.map((item) => item.id) ?? [],
  });
  useEffect(() => {
    setSelected(JSON.parse(selectionKey).ids);
    setDirty({});
  }, [selectionKey]);
  const activeJobId = project?.activeJobId;
  useEffect(() => {
    if (!activeJobId) return;
    let alive = true;
    void transport
      .callTool("get_job", { jobId: activeJobId })
      .then((result) => {
        if (alive) apply(result);
      })
      .catch((error) => {
        if (alive)
          setError(
            error instanceof Error ? error.message : "Job could not load",
          );
      });
    return () => {
      alive = false;
    };
  }, [activeJobId, transport, apply]);
  const jobId = job?.id,
    jobProjectId = job?.projectId,
    jobStatus = job?.status;
  useEffect(() => {
    if (!jobId || !jobStatus || !["queued", "running"].includes(jobStatus))
      return;
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    async function poll() {
      try {
        const result = await transport.callTool("get_job", { jobId });
        if (!alive) return;
        apply(result);
        if (
          !["queued", "running"].includes(
            result.structuredContent.job?.status ?? "failed",
          )
        ) {
          const updated = await transport.callTool("get_project", {
            projectId: jobProjectId,
          });
          if (alive) {
            apply(updated);
            if (result.structuredContent.job?.error)
              setError(result.structuredContent.job.error);
          }
          return;
        }
        attempts = 0;
      } catch (error) {
        attempts++;
        if (alive)
          setError(
            error instanceof Error ? error.message : "Progress check failed",
          );
      }
      if (alive)
        timer = setTimeout(
          () => {
            void poll();
          },
          Math.min(1500 * 2 ** attempts, 10000),
        );
    }
    timer = setTimeout(() => {
      void poll();
    }, 1000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [jobId, jobStatus, jobProjectId, transport, apply]);
  const run = useCallback(
    async (action: () => Promise<ToolResponse>) => {
      setWorking(true);
      setError("");
      try {
        apply(await action());
      } catch (error) {
        setError(
          error instanceof Error ? error.message : "Something went wrong",
        );
      } finally {
        setWorking(false);
      }
    },
    [apply],
  );
  const onDirty = useCallback((id: number, value: boolean) => {
    setDirty((old) => (old[id] === value ? old : { ...old, [id]: value }));
  }, []);
  const start = (
    operation: Operation,
    options: Record<string, unknown> = {},
  ) => {
    if (!project) return;
    if (hasEdits) {
      setError("Save your script edits before starting a job.");
      return;
    }
    void run(() =>
      transport.callTool(operation, {
        projectId: project.id,
        revision: project.revision,
        idempotencyKey: crypto.randomUUID(),
        ...options,
      }),
    );
  };
  const step = !project
    ? 0
    : ["new", "identified", "scripted", "generated", "done"].indexOf(
        project.stage,
      );
  const finalUrl = project?.finalAssetId
    ? media[project.finalAssetId]
    : undefined;

  return (
    <div className="studio-shell min-h-screen bg-[#f8f7fc] text-slate-900 font-sans">
      <header className="border-b border-purple-100 bg-white/90 px-5 sm:px-8 py-5">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="bg-[#7543cf] text-white rounded-xl p-2.5">
              <Play size={22} fill="currentColor" />
            </span>
            <span className="text-2xl font-bold tracking-tight">
              vidio
              <span className="ml-3 text-[10px] font-medium tracking-[0.2em] text-slate-400 align-middle">
                STUDIO
              </span>
            </span>
          </div>
          <Badge className="bg-purple-100 text-purple-800 border-0 hover:bg-purple-100">
            Interactive demo
          </Badge>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 sm:px-8 py-8 space-y-7">
        <div className="flex flex-col sm:flex-row justify-between gap-5">
          <div>
            <p className="text-purple-700 text-xs font-semibold tracking-widest uppercase mb-2">
              From product to story
            </p>
            <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
              Make your next product story.
            </h1>
            <p className="text-slate-500 mt-3 text-sm max-w-xl">
              Review the script. Choose your scenes. Bring it together.
            </p>
          </div>
          {!!projects.length && (
            <div className="sm:w-52">
              <label
                htmlFor="project-selector"
                className="text-xs text-slate-500 block mb-2"
              >
                Saved projects
              </label>
              <select
                id="project-selector"
                value={project?.id ?? ""}
                disabled={busy}
                onChange={(event) => {
                  setJob(undefined);
                  void run(() =>
                    transport.callTool("get_project", {
                      projectId: event.target.value,
                    }),
                  );
                }}
                className="w-full rounded-lg border border-purple-100 bg-white px-3 py-2 text-sm"
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
          )}
        </div>
        <div className="rounded-xl border border-purple-100 bg-purple-50/80 px-4 py-3 text-xs sm:text-sm text-purple-900 flex gap-3">
          <Sparkles className="shrink-0 mt-0.5" size={16} />
          <p>
            <strong>A safe preview, not live AI generation.</strong> Recognition
            and scripts are fixtures. Audio is a sample tone; videos are
            two-second local samples. No paid providers or credits are used.
          </p>
        </div>
        {error && (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 p-4 flex justify-between gap-3 text-sm text-red-800"
          >
            <span>{error}</span>
            <button
              type="button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        <nav aria-label="Creation progress" className="grid grid-cols-4 gap-2">
          {["Product", "Script", "Scenes", "Final cut"].map((label, index) => (
            <div
              key={label}
              className={`rounded-xl px-2 sm:px-4 py-3 flex items-center gap-2 text-xs sm:text-sm ${step > index ? "bg-purple-100 text-purple-900" : step === index ? "bg-white text-purple-800 ring-1 ring-purple-200" : "bg-white text-slate-400"}`}
            >
              <span className="rounded-full border border-current w-5 h-5 flex items-center justify-center shrink-0 text-[10px]">
                {step > index ? <Check size={12} /> : index + 1}
              </span>
              <span>{label}</span>
            </div>
          ))}
        </nav>
        {busy && (
          <div
            role="status"
            aria-live="polite"
            className="rounded-xl bg-white border border-purple-100 p-4 space-y-3"
          >
            <div className="flex justify-between gap-3 text-sm">
              <span className="flex gap-2 items-center">
                <Loader2 size={16} className="animate-spin" />
                {job && ["queued", "running"].includes(job.status)
                  ? `${job.operation.replaceAll("_", " ")} · ${job.status}`
                  : "Saving your changes…"}
              </span>
              {job && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={working}
                  onClick={() => {
                    void run(() =>
                      transport.callTool("cancel_job", { jobId: job.id }),
                    );
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
            <Progress value={job?.progress ?? 5} className="h-1.5" />
            <p className="text-xs text-slate-500">
              Progress is saved in PostgreSQL. You can reopen this project
              later.
            </p>
          </div>
        )}
        <div className="grid lg:grid-cols-[300px_1fr] gap-6 items-start">
          <Card className="border-purple-100 shadow-sm">
            <CardContent className="p-6 space-y-5">
              <div>
                <h2 className="font-semibold text-lg">Your product</h2>
                <p className="text-xs text-slate-500 mt-1">
                  Start with a name. An image is optional.
                </p>
              </div>
              {project?.imageAssetId && media[project.imageAssetId] ? (
                <div
                  role="img"
                  aria-label={`${project.name} product image`}
                  className="h-40 rounded-xl bg-white border border-purple-100 bg-center bg-contain bg-no-repeat"
                  style={{
                    backgroundImage: `url("${media[project.imageAssetId]}")`,
                  }}
                />
              ) : (
                <div className="h-36 rounded-xl bg-gradient-to-br from-[#e9dffd] to-[#f8f6ff] grid place-content-center text-purple-500">
                  <Film size={40} strokeWidth={1.2} />
                </div>
              )}
              <div>
                <label
                  htmlFor="product-name"
                  className="text-xs font-medium block mb-2"
                >
                  Product name
                </label>
                <Input
                  id="product-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={100}
                  disabled={busy}
                  placeholder="e.g. Everyday water bottle"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="language"
                    className="text-xs font-medium block mb-2"
                  >
                    Language
                  </label>
                  <select
                    id="language"
                    value={language}
                    onChange={(event) =>
                      setLanguage(event.target.value as typeof language)
                    }
                    disabled={busy}
                    className="w-full rounded-lg border bg-white p-2 text-sm"
                  >
                    <option value="english">English</option>
                    <option value="mandarin">Mandarin</option>
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="ratio"
                    className="text-xs font-medium block mb-2"
                  >
                    Format
                  </label>
                  <select
                    id="ratio"
                    value={ratio}
                    onChange={(event) =>
                      setRatio(event.target.value as typeof ratio)
                    }
                    disabled={busy}
                    className="w-full rounded-lg border bg-white p-2 text-sm"
                  >
                    <option>16:9</option>
                    <option>9:16</option>
                    <option>1:1</option>
                  </select>
                </div>
              </div>
              <Button
                className="w-full bg-[#7543cf] hover:bg-[#6332b8]"
                disabled={busy || !name.trim()}
                onClick={() => {
                  setJob(undefined);
                  void run(() =>
                    transport.callTool("create_project", {
                      name,
                      language,
                      ratio,
                    }),
                  );
                }}
              >
                {project ? "Create another project" : "Create a project"}
                <ArrowRight size={15} />
              </Button>
              {project && (
                <>
                  <div className="border-t pt-4 text-xs text-slate-500 space-y-2">
                    <p className="font-semibold text-slate-800">
                      {project.name}
                    </p>
                    <p>
                      {project.language === "english" ? "English" : "Mandarin"}{" "}
                      · {project.ratio} · Revision {project.revision}
                    </p>
                  </div>
                  {transport.upload ? (
                    <label
                      className={`flex items-center justify-center gap-2 text-xs border border-dashed rounded-lg p-3 ${busy ? "opacity-50" : "cursor-pointer hover:bg-purple-50"}`}
                    >
                      <ImagePlus size={15} />
                      Upload a product image
                      <input
                        type="file"
                        className="sr-only"
                        aria-label="Upload a product image"
                        accept="image/png,image/jpeg"
                        disabled={busy}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file)
                            void run(() => transport.upload!(project, file));
                          event.target.value = "";
                        }}
                      />
                    </label>
                  ) : (
                    <p className="text-xs text-slate-500">
                      Image uploads are available in the web studio. This
                      embedded demo uses sample media; ChatGPT file ingestion is
                      not connected yet.
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
          <div className="space-y-5">
            {!project && (
              <Card className="border-purple-100 shadow-none">
                <CardContent className="p-10 sm:p-16 text-center space-y-4">
                  <span className="inline-flex p-4 rounded-2xl bg-purple-50 text-purple-500">
                    <Sparkles size={28} />
                  </span>
                  <h2 className="text-xl font-semibold">
                    A little product. A big story.
                  </h2>
                  <p className="text-sm text-slate-500 max-w-sm mx-auto">
                    Create a project to explore the complete flow, from a
                    product brief to a downloadable sample video.
                  </p>
                </CardContent>
              </Card>
            )}
            {project && (
              <Card className="border-purple-100 shadow-none">
                <CardContent className="p-6">
                  <div className="flex justify-between items-start gap-4">
                    <div>
                      <p className="text-xs uppercase tracking-widest text-purple-600 mb-2">
                        01 / Product brief
                      </p>
                      <h2 className="text-xl font-semibold">{project.name}</h2>
                      <p className="text-sm text-slate-500 mt-2">
                        {project.features.length
                          ? project.features.join(" · ")
                          : "Demo recognition creates a sample brief, without analyzing your image."}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || hasEdits}
                      onClick={() => start("identify_product")}
                    >
                      {project.features.length ? (
                        <RefreshCw size={14} />
                      ) : (
                        <Sparkles size={14} />
                      )}
                      {project.features.length
                        ? "Reset brief"
                        : "Identify product"}
                    </Button>
                  </div>
                  {project.stage === "identified" && (
                    <Button
                      className="mt-5 bg-[#7543cf] hover:bg-[#6332b8]"
                      disabled={busy}
                      onClick={() => start("draft_scripts")}
                    >
                      Draft sample scripts
                      <ArrowRight size={15} />
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}
            {project && !!project.scripts.length && (
              <section aria-labelledby="scripts-title" className="space-y-4">
                <div className="flex flex-wrap justify-between gap-3 items-center">
                  <div>
                    <p className="text-xs uppercase tracking-widest text-purple-600 mb-1">
                      02 / Script review
                    </p>
                    <h2 id="scripts-title" className="text-xl font-semibold">
                      Shape the story.
                    </h2>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || hasEdits}
                    onClick={() =>
                      setConfirmation({ operation: "preview_voice" })
                    }
                  >
                    Preview sample tone
                  </Button>
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                  {project.scripts.map((script) => (
                    <ScriptEditor
                      key={`${project.id}-${script.id}-${project.revision}`}
                      script={script}
                      busy={busy}
                      onDirty={onDirty}
                      onSave={async (text, prompt) => {
                        await run(() =>
                          transport.callTool("update_script", {
                            projectId: project.id,
                            revision: project.revision,
                            id: script.id,
                            script: text,
                            prompt,
                          }),
                        );
                      }}
                    />
                  ))}
                </div>
                {project.voiceAssetId && media[project.voiceAssetId] && (
                  <div className="rounded-xl border bg-white p-4">
                    <p className="text-xs text-slate-500 mb-2">
                      Sample tone only — this is not spoken narration or AI TTS.
                    </p>
                    <audio
                      controls
                      src={media[project.voiceAssetId]}
                      className="w-full"
                    />
                  </div>
                )}
                <Button
                  className="bg-[#7543cf] hover:bg-[#6332b8]"
                  disabled={busy || hasEdits}
                  onClick={() =>
                    setConfirmation({ operation: "generate_segments" })
                  }
                >
                  <Film size={16} />
                  Generate sample scenes
                </Button>
                {hasEdits && (
                  <p className="text-xs text-purple-700">
                    Save your edits before generating scenes.
                  </p>
                )}
              </section>
            )}
            {project && !!project.segments.length && (
              <section aria-labelledby="scenes-title" className="space-y-4">
                <div>
                  <p className="text-xs uppercase tracking-widest text-purple-600 mb-1">
                    03 / Scene selection
                  </p>
                  <h2 id="scenes-title" className="text-xl font-semibold">
                    Keep the moments that work.
                  </h2>
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                  {project.segments.map((segment) => (
                    <Card
                      key={segment.assetId}
                      className="overflow-hidden border-purple-100 shadow-none"
                    >
                      <video
                        controls
                        preload="metadata"
                        src={media[segment.assetId]}
                        aria-label={`Sample scene ${segment.id}`}
                        className="w-full aspect-video bg-purple-100 object-contain"
                      />
                      <CardContent className="p-4 space-y-3">
                        <div className="flex justify-between items-center">
                          <label className="flex gap-2 items-center text-sm">
                            <Checkbox
                              checked={selected.includes(segment.id)}
                              disabled={busy}
                              onCheckedChange={(checked) =>
                                setSelected((old) =>
                                  checked
                                    ? [...old, segment.id]
                                    : old.filter((id) => id !== segment.id),
                                )
                              }
                            />
                            Scene {segment.id}
                          </label>
                          <span className="text-xs text-slate-400">
                            {segment.duration}s · sample
                          </span>
                        </div>
                        <p className="text-xs text-slate-500">
                          {segment.script}
                        </p>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy || hasEdits}
                          onClick={() =>
                            setConfirmation({
                              operation: "regenerate_segment",
                              segmentId: segment.id,
                            })
                          }
                        >
                          <RefreshCw size={13} />
                          Regenerate sample
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>
                <Button
                  className="bg-[#7543cf] hover:bg-[#6332b8]"
                  disabled={busy || hasEdits || !selected.length}
                  onClick={() =>
                    setConfirmation({
                      operation: "compose_video",
                      segmentIds: [...selected].sort((a, b) => a - b),
                    })
                  }
                >
                  Compose {selected.length} selected{" "}
                  {selected.length === 1 ? "scene" : "scenes"}
                  <ArrowRight size={15} />
                </Button>
              </section>
            )}
            {finalUrl && (
              <Card className="border-purple-200 bg-white overflow-hidden">
                <CardContent className="p-6 space-y-4">
                  <div className="flex justify-between items-center gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-widest text-purple-600 mb-1">
                        04 / Final cut
                      </p>
                      <h2 className="text-xl font-semibold">
                        Your sample story is ready.
                      </h2>
                    </div>
                    <Badge className="bg-emerald-50 text-emerald-700 hover:bg-emerald-50">
                      <Check size={12} />
                      Complete
                    </Badge>
                  </div>
                  <video
                    controls
                    src={finalUrl}
                    aria-label="Composed sample video"
                    className="w-full max-h-96 rounded-xl bg-purple-100"
                  />
                  <Button asChild className="bg-[#7543cf] hover:bg-[#6332b8]">
                    <a
                      href={`${finalUrl}&download=1`}
                      download="vidio-demo.mp4"
                      rel="noreferrer"
                    >
                      <Download size={16} />
                      Download sample MP4
                    </a>
                  </Button>
                  <p className="text-xs text-slate-500">
                    This file contains local sample visuals and audio tones, not
                    AI-generated video or narration.
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
        <footer className="border-t border-purple-100 pt-5 text-xs text-slate-400 flex flex-wrap gap-2 justify-between">
          <span>vidio · Make the story yours.</span>
          <span>Next.js + LangGraph preserved · MCP Apps preview</span>
        </footer>
      </main>
      <AlertDialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open) setConfirmation(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run this demo step?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.operation === "preview_voice"
                ? "This produces a short sample tone, not spoken narration."
                : "This creates clearly labelled local sample media, not AI-generated scenes."}{" "}
              No paid provider or credits are used. Your current saved script
              revision will be used.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction
              className="bg-[#7543cf] hover:bg-[#6332b8]"
              onClick={() => {
                if (confirmation)
                  start(confirmation.operation, {
                    confirmed: true,
                    segmentId: confirmation.segmentId,
                    segmentIds: confirmation.segmentIds,
                  });
                setConfirmation(undefined);
              }}
            >
              Run demo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
