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
    language: "mandarin",
    ratio: "16:9",
    stage: "scripted",
    features: ["Insulated"],
    scripts: [{ id: 1, script: "認識旅行杯", prompt: "A close-up" }],
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
      return name === "list_projects" ? response() : response(project);
    },
    openLink: async () => {},
  };
  return { api, calls };
}
test("empty and loading states expose accessible Mandarin/Cantonese and 16:9/9:16 controls", async () => {
  const { api } = transport();
  render(<EmbeddedStudio transport={api} />);
  assert.ok(screen.getByText("Loading owned projects…"));
  await screen.findByText("A product. A story. Your approval.");
  assert.equal(
    screen
      .getByRole("combobox", { name: "Voiceover language" })
      .querySelectorAll("option").length,
    2,
  );
  assert.equal(
    screen
      .getByRole("combobox", { name: "Video format" })
      .querySelectorAll("option").length,
    2,
  );
  assert.equal(screen.queryByRole("button", { name: /Download/ }), null);
});
test("explicit review and a separate confirmation are required before generation", async () => {
  const project = fixture(),
    { api, calls } = transport(project);
  render(<EmbeddedStudio transport={api} incoming={response(project)} />);
  const generate = await screen.findByRole("button", {
    name: "Generate labelled sample scenes",
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
  assert.equal(started.args.confirmed, true);
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
        name: "Generate labelled sample scenes",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  assert.ok(screen.getByText(/Unsaved edits/));
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
  assert.ok(screen.getByRole("button", { name: "Download sample MP4" }));
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
