import { createRoot } from "react-dom/client";
import { useCallback, useMemo, useState } from "react";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { parseToolResponse } from "../studio/Studio";
import { EmbeddedStudio, type EmbeddedTransport } from "./EmbeddedStudio";
import { type ToolResponse } from "../studio/types";
import { z } from "zod";

function Widget() {
  const [incoming, setIncoming] = useState<ToolResponse>(),
    [toolError, setToolError] = useState("");
  const [requestedProject, setRequestedProject] = useState<string>();
  const { app, isConnected, error } = useApp({
    appInfo: { name: "vidio", version: "0.2.0" },
    capabilities: {},
    onAppCreated: (app) => {
      app.ontoolinput = (params) => {
        const input = z
          .object({ projectId: z.uuid().optional() })
          .passthrough()
          .safeParse(params.arguments);
        if (input.success && input.data.projectId)
          setRequestedProject(input.data.projectId);
      };
      app.ontoolresult = (result) => {
        try {
          setIncoming(parseToolResponse(result));
          setToolError("");
        } catch (error) {
          setToolError(
            error instanceof Error ? error.message : "Tool result unavailable",
          );
        }
      };
      app.ontoolcancelled = () =>
        setToolError(
          "The host cancelled the tool request. Saved server progress is unchanged.",
        );
    },
  });
  useHostStyles(app);
  const callTool = useCallback<EmbeddedTransport["callTool"]>(
    async (name, args) => {
      if (!app || !isConnected)
        throw new Error("Waiting for the host connection");
      return parseToolResponse(
        await app.callServerTool({ name, arguments: args }),
      );
    },
    [app, isConnected],
  );
  const transport = useMemo<EmbeddedTransport>(
    () => ({
      callTool,
      openLink: async (url) => {
        if (!app?.getHostCapabilities()?.openLinks)
          throw new Error("Host does not support opening links");
        await app.openLink({ url });
      },
      updateContext: async (project) => {
        if (!app?.getHostCapabilities()?.updateModelContext) return;
        await app.updateModelContext({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                projectId: project.id,
                revision: project.revision,
                stage: project.stage,
                activeJobId: project.activeJobId,
                completedScenes: project.segments.length,
              }),
            },
          ],
        });
      },
    }),
    [callTool, app],
  );
  if (error)
    return (
      <div role="alert" className="p-6 text-red-800">
        {toolError || error?.message}
      </div>
    );
  if (!isConnected)
    return (
      <div role="status" className="p-6 text-purple-700">
        Connecting the vidio studio to your chat host…
      </div>
    );
  return (
    <>
      {toolError && (
        <div role="alert" className="p-3 text-red-800">
          {toolError}
        </div>
      )}
      <EmbeddedStudio
        transport={transport}
        incoming={incoming}
        requestedProject={requestedProject}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Widget />);
