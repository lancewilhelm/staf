import { STAF_TOOL_CATALOG, type AgentSummary, type StafToolId } from "@staf/protocol";
import { useState } from "react";
import { saveAgentTools } from "../store.ts";

export function ToolsPane({ agent }: { agent: AgentSummary }) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const hasCustom = STAF_TOOL_CATALOG.some((tool) => agent.tools[tool.id] !== tool.defaultEnabled);

  const toggle = async (toolId: StafToolId, enabled: boolean) => {
    setBusyId(toolId);
    await saveAgentTools(agent.id, { [toolId]: enabled });
    setBusyId(null);
  };

  const resetDefaults = async () => {
    setBusyId("reset");
    const defaults = {} as Record<StafToolId, boolean>;
    for (const tool of STAF_TOOL_CATALOG) defaults[tool.id] = tool.defaultEnabled;
    await saveAgentTools(agent.id, defaults);
    setBusyId(null);
  };

  return (
    <div className="drawer-scroll tools-pane">
      <div className="tools-head">
        <p className="tasks-intro">
          Built-in Staf tools available to {agent.name} across every provider. All default tools start enabled; turn
          off any tool that this agent should not use.
        </p>
        {hasCustom && (
          <button
            type="button"
            className="button proposal-btn"
            disabled={busyId !== null}
            onClick={() => void resetDefaults()}
          >
            Reset defaults
          </button>
        )}
      </div>

      <div className="tool-list">
        {STAF_TOOL_CATALOG.map((tool) => {
          const enabled = agent.tools[tool.id] ?? tool.defaultEnabled;
          const isDefault = enabled === tool.defaultEnabled;
          return (
            <article key={tool.id} className={`tool-card${enabled ? "" : " disabled"}`}>
              <div className="tool-card-top">
                <div className="tool-card-title">
                  <h3>
                    {tool.name}
                    {!isDefault && <span className="proposal-pill subtle">{enabled ? "Custom" : "Restricted"}</span>}
                  </h3>
                  <p className="tool-card-desc">{tool.description}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={enabled ? `Disable ${tool.name}` : `Enable ${tool.name}`}
                  className="task-switch"
                  disabled={busyId !== null}
                  onClick={() => void toggle(tool.id, !enabled)}
                >
                  <span className={`toggle${enabled ? " on" : ""}`} aria-hidden="true" />
                </button>
              </div>

              <div className="tool-chips">
                {tool.mcpTools.map((mcpName) => (
                  <code key={mcpName} className="tool-chip">
                    {mcpName}
                  </code>
                ))}
              </div>
            </article>
          );
        })}
      </div>

      <p className="field-note">
        Changes take effect immediately on the next tool call. Harness access settings (network, extra writable
        folders, and ChatGPT account apps) stay in <code>~/.staf/agents/{agent.id}/agent.json</code>.
      </p>
    </div>
  );
}
