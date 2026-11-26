import {
  harnessToolsForAgent,
  STAF_TOOL_CATALOG,
  type AgentSummary,
  type StafToolId,
} from "@staf/protocol";
import { useState } from "react";
import { saveAgentTools } from "../store.ts";

export function ToolsPane({ agent }: { agent: AgentSummary }) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const hasCustom = STAF_TOOL_CATALOG.some((tool) => agent.tools[tool.id] !== tool.defaultEnabled);
  const harnessTools = harnessToolsForAgent(agent);

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
      <section className="tools-section">
        <div className="tools-head">
          <div>
            <h3 className="tools-section-title">Staf tools</h3>
            <p className="tasks-intro">
              Built-in Staf tools available to {agent.name} across every provider. All default tools start enabled;
              turn off any tool that this agent should not use.
            </p>
          </div>
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
                    <h4>
                      {tool.name}
                      {!isDefault && <span className="proposal-pill subtle">{enabled ? "Custom" : "Restricted"}</span>}
                    </h4>
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
      </section>

      <section className="tools-section">
        <div className="tools-head">
          <div>
            <h3 className="tools-section-title">Built-in {harnessTools.harnessLabel} tools</h3>
            <p className="tasks-intro">
              Provided by {agent.name}&apos;s default harness ({harnessTools.harnessLabel}). If you switch providers
              inside a thread, that provider&apos;s built-in tools apply instead.
            </p>
          </div>
        </div>

        {harnessTools.capabilities.length > 0 && (
          <div className="tool-list">
            {harnessTools.capabilities.map((cap) => (
              <article key={cap.id} className={`tool-card readonly${cap.status === "off" ? " disabled" : ""}`}>
                <div className="tool-card-top">
                  <div className="tool-card-title">
                    <h4>{cap.name}</h4>
                    <p className="tool-card-desc">{cap.description}</p>
                  </div>
                  <span className={`tool-status ${cap.status}`}>{cap.statusLabel}</span>
                </div>

                {cap.names && cap.names.length > 0 && (
                  <div className="tool-chips">
                    {cap.names.map((name) => (
                      <code key={name} className="tool-chip">
                        {name}
                      </code>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}

        <p className="field-note">{harnessTools.disabledNote}</p>
        <p className="field-note">
          Harness access settings (<code>network</code>, <code>writableFolders</code>, and <code>harnessApps</code>)
          are edited in <code>~/.staf/agents/{agent.id}/agent.json</code>.
        </p>
      </section>
    </div>
  );
}
