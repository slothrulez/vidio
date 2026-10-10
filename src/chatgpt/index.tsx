import { createRoot } from "react-dom/client";
import { useCallback, useMemo, useState } from "react";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import {
  Studio,
  parseToolResponse,
  type StudioTransport,
} from "../studio/Studio";
import { type ToolResponse } from "../studio/types";

function Widget() {
  const [incoming, setIncoming] = useState<ToolResponse>(),
    [toolError, setToolError] = useState("");
  const { app, isConnected, error } = useApp({
    appInfo: { name: "vidio", version: "0.1.0" },
    capabilities: {},
    onAppCreated: (app) => {
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
    },
  });
  useHostStyles(app);
  const callTool = useCallback<StudioTransport["callTool"]>(
    async (name, args) => {
      if (!app || !isConnected)
        throw new Error("Waiting for the host connection");
      return parseToolResponse(
        await app.callServerTool({ name, arguments: args }),
      );
    },
    [app, isConnected],
  );
  const transport = useMemo(() => ({ callTool }), [callTool]);
  if (error || toolError)
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
  return <Studio transport={transport} incoming={incoming} embedded />;
}
createRoot(document.getElementById("root")!).render(<Widget />);
