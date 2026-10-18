import "./fixtures/widget-dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import {
  EmbeddedStudio,
  type EmbeddedTransport,
} from "../src/chatgpt/EmbeddedStudio";
import { sceneStates, outputIsReady } from "../src/chatgpt/ui-state";
import type {
  StudioProject,
  ToolResponse,
  StudioJob,
} from "../src/studio/types";
afterEach(cleanup);
function fixture(): StudioProject {
  return {
    id: randomUUID(),
    name: "Travel mug",
    revision: 3,
    language: "english",
    ratio: "16:9",
    stage: "scripted",
    features: ["Insulated"],
    scripts: [{ id: 1, script: "Meet your new everyday travel mug.", prompt: "A close-up" }],
    segments: [],
    createdAt: new Date().toISOString(),
    mode: "demo",
  };
}
function response(project?: StudioProject): ToolResponse {
  return {
    structuredContent: {
      mode: "demo",
      message: "Test result",
      ...(project ? { project } : { projects: [] }),
    },
  };
}
function transport(project?: StudioProject) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const api: EmbeddedTransport = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "grant_cost_consent")
        return { structuredContent: { mode: "demo", message: "Approved", consent: { token: randomUUID(), operation: String(args.operation), expiresAt: new Date(Date.now() + 600_000).toISOString() } } };
      return name === "list_projects" ? response() : response(project);
    },
    openLink: async () => {},
  };
  return { api, calls };
}
test("empty and loading states create English-only stories in 16:9 or 9:16", async () => {
  const { api, calls } = transport();
  render(<EmbeddedStudio transport={api} />);
  assert.ok(screen.getByText("Loading owned projects…"));
  await screen.findByText("A product. A story. Your approval.");
  const language = screen.getByRole("textbox", { name: "Voiceover language" }) as HTMLInputElement;
  assert.equal(language.value, "English");
  assert.equal(language.readOnly, true);
  assert.equal(screen.queryByRole("combobox", { name: "Voiceover language" }), null);
  assert.equal(
    screen
      .getByRole("combobox", { name: "Video format" })
      .querySelectorAll("option").length,
    2,
  );
  assert.equal(screen.queryByRole("button", { name: /Download/ }), null);
  fireEvent.change(screen.getByRole("textbox", { name: "Product name" }), { target: { value: "Travel mug" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Video format" }), { target: { value: "9:16" } });
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await waitFor(() => assert.deepEqual(calls.find((call) => call.name === "create_project")?.args,
    { name: "Travel mug", language: "english", ratio: "9:16" }));
});
test("explicit review and a separate confirmation are required before generation", async () => {
  const project = fixture(),
    { api, calls } = transport(project);
  render(<EmbeddedStudio transport={api} incoming={response(project)} />);
  const generate = await screen.findByRole("button", {
    name: "Generate AI scenes",
  });
  assert.equal((generate as HTMLButtonElement).disabled, true);
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed and approve/ }),
  );
  fireEvent.click(generate);
  assert.ok(screen.getByRole("alertdialog"));
  assert.equal(
    calls.some((call) => call.name === "start_video_job"),
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "Approve & start" }));
  await waitFor(() =>
    assert.equal(
      calls.filter((call) => call.name === "start_video_job").length,
      1,
    ),
  );
  const started = calls.find((call) => call.name === "start_video_job")!;
  const grant = calls.findIndex((call) => call.name === "grant_cost_consent");
  assert.ok(grant >= 0 && grant < calls.indexOf(started), "approval is requested before the paid tool");
  assert.equal(calls[grant].args.operation, "start_video_job");
  assert.equal(started.args.confirmed, true);
  assert.equal(started.args.generationMode, "wan");
  assert.equal(started.args.revision, 3);
  assert.equal(typeof started.args.idempotencyKey, "string");
});
test("editing a reviewed script revokes approval and blocks unsaved generation", async () => {
  const project = fixture(),
    { api } = transport(project);
  render(<EmbeddedStudio transport={api} incoming={response(project)} />);
  await screen.findByRole("checkbox", { name: /I reviewed and approve/ });
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed and approve/ }),
  );
  fireEvent.change(screen.getByLabelText("Narration · scene 1"), {
    target: { value: "Updated narration" },
  });
  assert.equal(
    screen
      .getByRole("checkbox", { name: /I reviewed and approve/ })
      .getAttribute("aria-checked"),
    "false",
  );
  assert.equal(
    (
      screen.getByRole("button", {
        name: "Generate AI scenes",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  assert.ok(screen.getByText(/Unsaved edits/));
});
test("static fallback must be selected and approved explicitly; an AI error never starts it",async()=>{
  const project=fixture(),{api,calls}=transport(project);
  render(<EmbeddedStudio transport={api} incoming={response(project)} />);
  const source=await screen.findByRole("combobox",{name:"Footage source"});
  assert.equal((source as HTMLSelectElement).value,"wan");
  assert.equal(calls.some(call=>call.name==="start_video_job"),false);
  fireEvent.change(source,{target:{value:"static"}});
  fireEvent.click(screen.getByRole("checkbox",{name:/I reviewed and approve/}));
  fireEvent.click(screen.getByRole("button",{name:"Render static fallback"}));
  assert.match(screen.getByRole("alertdialog").textContent!,/NOT AI-generated footage/);
  assert.equal((source as HTMLSelectElement).disabled,true);
  assert.equal(calls.some(call=>call.name==="start_video_job"),false);
  fireEvent.click(screen.getByRole("button",{name:"Approve & start"}));
  await waitFor(()=>assert.equal(calls.find(call=>call.name==="start_video_job")?.args.generationMode,"static"));
  assert.equal(calls.find(call=>call.name==="grant_cost_consent")?.args.generationMode,"static");
});
test("composition confirmation stays next to its action and cancellation restores focus without starting a job", async () => {
  const project = fixture();
  project.stage = "generated";
  project.segments = [{ id: 1, assetId: randomUUID(), duration: 2, script: project.scripts[0].script }];
  const { api, calls } = transport(project);
  render(<EmbeddedStudio transport={api} incoming={response(project)} />);
  const compose = await screen.findByRole("button", { name: "Compose final MP4" });
  fireEvent.click(compose);
  const dialog = screen.getByRole("alertdialog", { name: "Approve final composition?" });
  assert.equal(dialog.closest("section"), compose.closest("section"));
  assert.equal(dialog.getAttribute("aria-modal"), null);
  assert.equal(dialog.classList.contains("fixed"), false);
  assert.equal(document.body.style.pointerEvents, "");
  assert.ok(screen.getByText(/1 completed scenes; subtitles on; music soft/));
  assert.equal(calls.some((call) => call.name === "compose_final_video"), false);
  fireEvent.click(screen.getByRole("button", { name: "Not yet" }));
  await waitFor(() => assert.equal(screen.queryByRole("alertdialog"), null));
  await waitFor(() => assert.equal(document.activeElement, compose));
  assert.equal(calls.some((call) => call.name === "compose_final_video"), false);
  fireEvent.click(compose);
  fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
  await waitFor(() => assert.equal(screen.queryByRole("alertdialog"), null));
});
test("partial failure retains completed previews and allows safe retry", async () => {
  const project = fixture();
  project.scripts.push({ id: 2, script: "Second scene", prompt: "Mock" });
  project.segments = [
    {
      id: 1,
      assetId: randomUUID(),
      duration: 2,
      script: project.scripts[0].script,
    },
  ];
  const job: StudioJob = {
    id: randomUUID(),
    projectId: project.id,
    operation: "generate_segments",
    status: "failed",
    progress: 50,
    error: "Provider unavailable",
    retryable: true,
    createdAt: new Date().toISOString(),
    lifecycleStatus: "failed",
    segments: [],
  };
  const { api } = transport(project);
  const incoming: ToolResponse = {
    ...response(project),
    structuredContent: { ...response(project).structuredContent, job },
    _meta: {
      media: {
        [project.segments[0].assetId]: "https://media.example.test/video",
      },
    },
  };
  render(<EmbeddedStudio transport={api} incoming={incoming} />);
  assert.ok(await screen.findByText("Provider unavailable"));
  assert.ok(screen.getByLabelText("Scene 1 preview"));
  assert.equal(
    screen
      .getByRole("checkbox", { name: "Include scene 2" })
      .getAttribute("data-disabled"),
    "",
  );
  assert.ok(screen.getByRole("button", { name: "Retry this job safely" }));
  assert.equal(sceneStates(project, job)[1].status, "not_started");
});
test("no download until a valid final preview; expired media revokes download and can refresh", async () => {
  const project = fixture();
  project.stage = "done";
  project.finalAssetId = randomUUID();
  const { api, calls } = transport(project);
  const incoming: ToolResponse = {
    ...response(project),
    _meta: {
      media: {
        [project.finalAssetId]:
          "https://media.example.test/final?token=example",
      },
    },
  };
  render(<EmbeddedStudio transport={api} incoming={incoming} />);
  const video = await screen.findByLabelText("Final video preview");
  assert.equal(screen.queryByRole("button", { name: /Download/ }), null);
  Object.defineProperty(video, "duration", { value: 8, configurable: true });
  fireEvent.loadedMetadata(video);
  assert.ok(screen.getByRole("button", { name: "Download MP4" }));
  assert.equal(
    outputIsReady(project, project.finalAssetId, "https://media.example.test"),
    true,
  );
  fireEvent.error(video);
  assert.equal(screen.queryByRole("button", { name: /Download/ }), null);
  fireEvent.click(screen.getByRole("button", { name: "Refresh final media" }));
  await waitFor(() =>
    assert.ok(calls.some((call) => call.name === "get_project")),
  );
});
test("invalid uploads reject visibly without server calls or fake saved assets", async () => {
  const project = fixture();
  project.stage = "new";
  project.scripts = [];
  const { api, calls } = transport(project);
  render(<EmbeddedStudio transport={api} incoming={response(project)} />);
  const input = await screen.findByLabelText("Upload product images");
  fireEvent.change(input, {
    target: {
      files: [
        new File(["not an image"], "unsafe.svg", { type: "image/svg+xml" }),
      ],
    },
  });
  assert.ok(await screen.findByRole("alert"));
  assert.equal(
    calls.some((call) => call.name === "begin_image_upload"),
    false,
  );
});
test("newer project revisions conflict with local drafts; older snapshots cannot overwrite state",async()=>{
  const project=fixture(),{api,calls}=transport(project);
  const view=render(<EmbeddedStudio transport={api} incoming={response(project)} />);
  const narration=await screen.findByLabelText("Narration · scene 1");
  fireEvent.change(narration,{target:{value:"My unsaved draft"}});
  const newer={...project,revision:4,scripts:[{...project.scripts[0],script:"New server narration"}]};
  view.rerender(<EmbeddedStudio transport={api} incoming={response(newer)} />);
  await screen.findByText(/changed while you were editing/);
  assert.equal((screen.getByRole("button",{name:"Save all script edits"}) as HTMLButtonElement).disabled,true);
  assert.equal(calls.some(call=>call.name==="save_scripts"),false);
  view.rerender(<EmbeddedStudio transport={api} incoming={response(project)} />);
  fireEvent.click(screen.getByRole("button",{name:"Discard conflicted edits"}));
  assert.equal((screen.getByLabelText("Narration · scene 1") as HTMLTextAreaElement).value,"New server narration");
});
test("composition confirmation is cancelled when its project or revision changes",async()=>{
  const project=fixture();project.stage="generated";project.segments=[{id:1,assetId:randomUUID(),duration:2,script:"Approved"}];
  const {api,calls}=transport(project),view=render(<EmbeddedStudio transport={api} incoming={response(project)} />);
  const compose=await screen.findByRole("button",{name:"Compose final MP4"});
  await waitFor(()=>assert.equal((compose as HTMLButtonElement).disabled,false));
  fireEvent.click(compose);assert.ok(screen.getByRole("alertdialog"));
  view.rerender(<EmbeddedStudio transport={api} incoming={response({...project,revision:4})} />);
  await waitFor(()=>assert.equal(screen.queryByRole("alertdialog"),null));
  fireEvent.click(screen.getByRole("button",{name:"Compose final MP4"}));
  assert.ok(screen.getByRole("alertdialog"));
  const other={...project,id:randomUUID(),name:"Other owned project"};
  view.rerender(<EmbeddedStudio transport={api} incoming={response(other)} />);
  await waitFor(()=>assert.equal(screen.queryByRole("alertdialog"),null));
  assert.equal(calls.some(call=>call.name==="compose_final_video"),false);
});
test("terminal polling fetches a fresh project rather than leaving an obsolete active marker",async()=>{
  const project=fixture(),jobId=randomUUID();project.activeJobId=jobId;
  let reads=0;
  const api:EmbeddedTransport={callTool:async(name)=>{
    if (name==="list_projects") return response();
    if (name==="get_video_job_status") return {structuredContent:{mode:"demo",message:"Complete",job:{id:jobId,projectId:project.id,operation:"start_video_job",status:"succeeded",progress:100,error:null,createdAt:project.createdAt}}};
    reads++;
    if (reads===1) return response(project);
    const done={...project,revision:4};delete done.activeJobId;return response(done);
  }};
  render(<EmbeddedStudio transport={api} incoming={response(project)} />);
  await waitFor(()=>assert.ok(reads>=2));
  await waitFor(()=>assert.equal((screen.getByRole("button",{name:"Save all script edits"}) as HTMLButtonElement).disabled,true));
  assert.equal((screen.getByLabelText("Narration · scene 1") as HTMLTextAreaElement).disabled,false);
});
