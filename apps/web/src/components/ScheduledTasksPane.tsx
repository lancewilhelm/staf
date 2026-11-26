import {
  formatScheduleSummary,
  SCHEDULE_BLOCKED_HARNESSES,
  type AgentSummary,
  type CreateScheduledTaskRequest,
  type ScheduledTask,
  type TaskSchedule,
} from "@staf/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  closeAgentPanel,
  effortName,
  loadAgentTasks,
  loadModels,
  modelName,
  openSettings,
  openThread,
  removeScheduledTask,
  runScheduledTaskNow,
  saveScheduledTask,
  toggleScheduledTask,
  useAgentTasks,
  useHarnesses,
  useStore,
} from "../store.ts";
import { Icon } from "./Icon.tsx";
import { ModelPickerPanel, type ModelPickerValue } from "./ModelPicker.tsx";

const WEEKDAYS: Array<{ id: number; short: string; full: string }> = [
  { id: 0, short: "S", full: "Sunday" },
  { id: 1, short: "M", full: "Monday" },
  { id: 2, short: "T", full: "Tuesday" },
  { id: 3, short: "W", full: "Wednesday" },
  { id: 4, short: "T", full: "Thursday" },
  { id: 5, short: "F", full: "Friday" },
  { id: 6, short: "S", full: "Saturday" },
];

type EditorState = null | { mode: "create" } | { mode: "edit"; task: ScheduledTask };

export function ScheduledTasksPane({ agent }: { agent: AgentSummary }) {
  const tasks = useAgentTasks(agent.id);
  const [editor, setEditor] = useState<EditorState>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  useEffect(() => {
    void loadAgentTasks(agent.id);
  }, [agent.id]);

  if (editor) {
    return (
      <TaskForm
        key={editor.mode === "edit" ? editor.task.id : "new"}
        agent={agent}
        task={editor.mode === "edit" ? editor.task : null}
        onClose={() => setEditor(null)}
      />
    );
  }

  const agentBlocked = SCHEDULE_BLOCKED_HARNESSES.has(agent.harness);

  const openRunThread = (threadId: string) => {
    closeAgentPanel();
    openThread(threadId);
  };

  const runNow = async (task: ScheduledTask) => {
    setRunningId(task.id);
    const thread = await runScheduledTaskNow(task);
    setRunningId(null);
    if (thread) openRunThread(thread.id);
  };

  return (
    <div className="drawer-scroll tasks-pane">
      <div className="tasks-head">
        <p className="tasks-intro">
          Recurring or one-time runs for {agent.name}. Each run starts a new thread in your Inbox.
        </p>
        <button type="button" className="button primary tasks-new-btn" onClick={() => setEditor({ mode: "create" })}>
          <Icon name="plus" size={14} />
          New task
        </button>
      </div>

      {agentBlocked && (
        <p className="field-note tasks-warn">
          {agent.name} uses Gemini by default, which cannot run scheduled tasks yet. Pick ChatGPT or Claude on each
          task below.
        </p>
      )}

      {tasks.length === 0 ? (
        <div className="tasks-empty">
          <p>No scheduled tasks for {agent.name} yet.</p>
          <button type="button" className="button" onClick={() => setEditor({ mode: "create" })}>
            Create a scheduled task
          </button>
        </div>
      ) : (
        <div className="task-list">
          {tasks.map((task) => {
            const busy = runningId === task.id || task.lastRunStatus === "running";
            return (
              <article key={task.id} className={`task-card${task.enabled ? "" : " paused"}`}>
                <div className="task-card-top">
                  <div className="task-card-title">
                    <h3>{task.name}</h3>
                    <p className="task-schedule">{formatScheduleSummary(task.schedule)}</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={task.enabled}
                    aria-label={task.enabled ? `Pause ${task.name}` : `Resume ${task.name}`}
                    title={task.enabled ? "Pause task" : "Resume task"}
                    className="task-switch"
                    onClick={() => void toggleScheduledTask(task)}
                  >
                    <span className={`toggle${task.enabled ? " on" : ""}`} aria-hidden="true" />
                  </button>
                </div>

                <p className="task-prompt-preview">{task.prompt}</p>

                <div className="task-meta">
                  {task.enabled && task.nextRunAt ? (
                    <span>Next: {formatTimestamp(task.nextRunAt)}</span>
                  ) : (
                    <span>Paused</span>
                  )}
                  {task.lastRunStatus === "running" && <span className="task-status live">Running…</span>}
                  {task.lastRunStatus && task.lastRunStatus !== "running" && task.lastRunAt && (
                    <span>
                      Last run: {formatTimestamp(task.lastRunAt)}
                      {task.lastRunStatus === "failed" ? " (failed)" : task.lastRunStatus === "interrupted" ? " (stopped)" : ""}
                    </span>
                  )}
                  {task.lastRunThreadId && (
                    <button
                      type="button"
                      className="link task-run-link"
                      onClick={() => openRunThread(task.lastRunThreadId!)}
                    >
                      Open last run
                    </button>
                  )}
                </div>

                {task.lastRunError && <p className="field-note error task-error">{task.lastRunError}</p>}

                <div className="task-actions">
                  <button
                    type="button"
                    className="task-btn"
                    disabled={busy}
                    onClick={() => void runNow(task)}
                  >
                    <Icon name="play" size={13} />
                    {busy ? "Running…" : "Run now"}
                  </button>
                  <button
                    type="button"
                    className="task-btn"
                    onClick={() => setEditor({ mode: "edit", task })}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="task-btn danger"
                    onClick={() => {
                      if (confirm(`Delete scheduled task "${task.name}"?`)) void removeScheduledTask(task);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TaskForm({
  agent,
  task,
  onClose,
}: {
  agent: AgentSummary;
  task: ScheduledTask | null;
  onClose: () => void;
}) {
  const harnesses = useHarnesses();
  const models = useStore((s) => s.models);

  const agentBlocked = SCHEDULE_BLOCKED_HARNESSES.has(agent.harness);
  const fallbackHarness =
    harnesses.find((h) => !SCHEDULE_BLOCKED_HARNESSES.has(h.id) && h.ready)?.id ??
    harnesses.find((h) => !SCHEDULE_BLOCKED_HARNESSES.has(h.id))?.id ??
    "codex";

  const [name, setName] = useState(task?.name ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [scheduleType, setScheduleType] = useState<TaskSchedule["type"]>(task?.schedule.type ?? "daily");
  const [timeOfDay, setTimeOfDay] = useState(
    task?.schedule.type === "daily" ? task.schedule.timeOfDay : "07:00",
  );
  const [weekdays, setWeekdays] = useState<number[]>(
    task?.schedule.type === "daily" ? (task.schedule.weekdays ?? []) : [],
  );

  const initialMinutes = task?.schedule.type === "interval" ? task.schedule.everyMinutes : 60;
  const initialUnit: "minutes" | "hours" = initialMinutes >= 60 && initialMinutes % 60 === 0 ? "hours" : "minutes";
  const [intervalUnit, setIntervalUnit] = useState<"minutes" | "hours">(initialUnit);
  const [intervalCount, setIntervalCount] = useState(
    String(initialUnit === "hours" ? initialMinutes / 60 : initialMinutes),
  );
  const [runAtLocal, setRunAtLocal] = useState(() =>
    toLocalDateTimeInput(task?.schedule.type === "once" ? task.schedule.runAt : Date.now() + 60 * 60_000),
  );

  const [useAgentDefault, setUseAgentDefault] = useState(
    !agentBlocked && (task ? task.harness === null && task.model === null && task.effort === null && !task.fast : true),
  );
  const [harness, setHarness] = useState(
    task?.harness ?? (agentBlocked ? fallbackHarness : agent.harness),
  );
  const [model, setModel] = useState<string | null>(task?.model ?? null);
  const [effort, setEffort] = useState<string | null>(task?.effort ?? null);
  const [fast, setFast] = useState(task?.fast ?? false);
  const [busy, setBusy] = useState(false);

  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRoot = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number | null>(null);

  useEffect(() => {
    if (!useAgentDefault) void loadModels(harness);
  }, [useAgentDefault, harness]);

  useLayoutEffect(() => {
    if (!pickerOpen) return;
    const measure = () => {
      const box = pickerRoot.current?.getBoundingClientRect();
      if (!box) return;
      setRoom(Math.max(220, box.top - 128));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return;
    void loadModels(harness);
    const onDown = (event: PointerEvent) => {
      if (!pickerRoot.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPickerOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [pickerOpen, harness]);

  const toggleDay = (day: number) => {
    setWeekdays((current) =>
      current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort((a, b) => a - b),
    );
  };

  const buildSchedule = (): TaskSchedule | null => {
    if (scheduleType === "daily") {
      if (!timeOfDay) return null;
      return weekdays.length > 0 && weekdays.length < 7
        ? { type: "daily", timeOfDay, weekdays }
        : { type: "daily", timeOfDay };
    }
    if (scheduleType === "interval") {
      const parsed = Number(intervalCount);
      if (!Number.isFinite(parsed) || parsed <= 0) return null;
      const everyMinutes = Math.round(intervalUnit === "hours" ? parsed * 60 : parsed);
      return { type: "interval", everyMinutes };
    }
    const ms = new Date(runAtLocal).getTime();
    if (!Number.isFinite(ms)) return null;
    return { type: "once", runAt: ms };
  };

  const applyChoice = (change: Partial<ModelPickerValue>) => {
    if (change.harness !== undefined) setHarness(change.harness);
    if (change.model !== undefined) setModel(change.model);
    if (change.effort !== undefined) setEffort(change.effort);
    if (change.fast !== undefined) setFast(change.fast);
  };

  const save = async () => {
    const schedule = buildSchedule();
    if (!schedule) return;
    setBusy(true);
    const input: CreateScheduledTaskRequest = {
      name,
      prompt,
      schedule,
      enabled: task?.enabled ?? true,
      harness: useAgentDefault ? null : harness,
      model: useAgentDefault ? null : model,
      effort: useAgentDefault ? null : effort,
      fast: useAgentDefault ? false : fast,
    };
    const result = await saveScheduledTask(agent.id, task?.id ?? null, input);
    setBusy(false);
    if (result) onClose();
  };

  const info = harnesses.find((h) => h.id === harness);
  const list = models[harness];
  const defaultModel = list?.status === "ready" ? list.list.find((m) => m.isDefault) : undefined;
  const resolvedModel =
    modelName(models, harness, model) ?? (defaultModel ? `Default · ${defaultModel.name}` : "Provider's default");
  const pickerSummary = [
    info?.label ?? harness,
    resolvedModel,
    effort ? effortName(effort) : null,
    fast ? "Fast" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const canSubmit = !busy && name.trim().length > 0 && prompt.trim().length > 0 && buildSchedule() !== null;

  return (
    <form
      className="drawer-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="drawer-scroll">
        <div className="task-editor-head">
          <button type="button" className="task-back" onClick={onClose}>
            <Icon name="back" size={15} />
            Tasks
          </button>
          <h3>{task ? "Edit scheduled task" : "New scheduled task"}</h3>
        </div>

        <label className="field">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="For example, Morning Paper"
            maxLength={80}
            autoFocus
            required
          />
        </label>

        <div className="field">
          <span>Schedule</span>
          <div className="segments schedule-type-tabs" role="radiogroup" aria-label="Schedule type">
            {(
              [
                { id: "daily", label: "Daily / Weekly" },
                { id: "interval", label: "Every N…" },
                { id: "once", label: "One time" },
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={scheduleType === option.id}
                className={scheduleType === option.id ? "selected" : ""}
                onClick={() => setScheduleType(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {scheduleType === "daily" && (
            <div className="schedule-daily">
              <input
                type="time"
                value={timeOfDay}
                onChange={(e) => setTimeOfDay(e.target.value)}
                aria-label="Time of day"
                required
              />
              <div className="weekday-row" role="group" aria-label="Days of the week">
                {WEEKDAYS.map((day) => {
                  const active = weekdays.includes(day.id);
                  return (
                    <button
                      key={day.id}
                      type="button"
                      className={`weekday-pill${active ? " active" : ""}`}
                      aria-pressed={active}
                      aria-label={day.full}
                      title={day.full}
                      onClick={() => toggleDay(day.id)}
                    >
                      {day.short}
                    </button>
                  );
                })}
              </div>
              <p className="field-note">
                {weekdays.length === 0 || weekdays.length === 7
                  ? "Runs every day at the chosen local time."
                  : `Runs on ${weekdays.map((d) => WEEKDAYS[d]!.full).join(", ")}.`}
              </p>
            </div>
          )}

          {scheduleType === "interval" && (
            <div className="interval-row">
              <span className="interval-label">Every</span>
              <input
                type="number"
                min={intervalUnit === "minutes" ? 5 : 1}
                max={intervalUnit === "minutes" ? 10080 : 168}
                value={intervalCount}
                onChange={(e) => setIntervalCount(e.target.value)}
                aria-label="Interval count"
                required
              />
              <select
                value={intervalUnit}
                onChange={(e) => setIntervalUnit(e.target.value as "minutes" | "hours")}
                aria-label="Interval unit"
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
            </div>
          )}

          {scheduleType === "once" && (
            <input
              type="datetime-local"
              value={runAtLocal}
              onChange={(e) => setRunAtLocal(e.target.value)}
              aria-label="Run date and time"
              required
            />
          )}
        </div>

        <label className="field">
          <span>Prompt</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={6}
            placeholder="What should this agent do when this task runs?"
            required
          />
        </label>

        <div className="field">
          <span>Model</span>
          {!agentBlocked && (
            <label className="task-override-row">
              <input
                type="checkbox"
                checked={useAgentDefault}
                onChange={(e) => {
                  setUseAgentDefault(e.target.checked);
                  if (e.target.checked) setPickerOpen(false);
                }}
              />
              <span>Use {agent.name}'s default ({agent.harnessLabel})</span>
            </label>
          )}
          {!useAgentDefault && (
            <div className="agent-model-picker" ref={pickerRoot}>
              <button
                type="button"
                className={`model-trigger${pickerOpen ? " open" : ""}`}
                aria-haspopup="menu"
                aria-expanded={pickerOpen}
                onClick={() => setPickerOpen((open) => !open)}
              >
                <span className="model-trigger-label">
                  <span>{pickerSummary}</span>
                </span>
                <span className="model-trigger-chevron" aria-hidden="true">
                  <Icon name="down" size={15} />
                </span>
              </button>
              {pickerOpen && (
                <div
                  className="menu wide up agent-model-menu"
                  role="menu"
                  style={room ? { maxHeight: Math.min(440, room) } : undefined}
                >
                  <ModelPickerPanel
                    value={{ harness, model, effort, fast }}
                    harnesses={harnesses}
                    models={models}
                    allowUnreadyProviders
                    disabledProviders={SCHEDULE_BLOCKED_HARNESSES}
                    disabledProviderReason="Unavailable for schedules"
                    onChange={applyChoice}
                    footer={
                      <div className="menu-footer-row">
                        <button
                          type="button"
                          className="menu-footer-link"
                          onClick={() => {
                            setPickerOpen(false);
                            openSettings({ section: "providers" });
                          }}
                        >
                          <Icon name="settings" size={14} />
                          Provider settings
                        </button>
                        <button type="button" className="menu-footer-done" onClick={() => setPickerOpen(false)}>
                          Done
                        </button>
                      </div>
                    }
                  />
                </div>
              )}
            </div>
          )}
          <p className="field-note model-note">
            Scheduled tasks run on ChatGPT or Claude. Fast mode stays off unless you turn it on here.
          </p>
        </div>
      </div>

      <footer className="drawer-foot">
        <button type="button" className="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <span className="spacer" />
        <button type="submit" className="button primary" disabled={!canSubmit}>
          {task ? "Save task" : "Create task"}
        </button>
      </footer>
    </form>
  );
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function toLocalDateTimeInput(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
