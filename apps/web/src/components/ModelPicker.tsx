import type { HarnessInfo, ModelInfo } from "@staf/protocol";
import type { ReactNode } from "react";
import { effortName, type ModelList, modelInfo } from "../store.ts";
import { Icon } from "./Icon.tsx";

export interface ModelPickerValue {
  harness: string;
  model: string | null;
  effort: string | null;
  fast: boolean;
}

/**
 * Shared two-column provider, model, reasoning, and fast-mode picker body.
 * Used in both the composer pill menu and the agent settings panel.
 */
export function ModelPickerPanel({
  value,
  harnesses,
  models,
  allowUnreadyProviders = false,
  disabledProviders,
  disabledProviderReason,
  switching = false,
  onChange,
  footer,
}: {
  value: ModelPickerValue;
  harnesses: HarnessInfo[];
  models: Record<string, ModelList>;
  /** True in agent settings so defaults can be picked even before signing in. */
  allowUnreadyProviders?: boolean;
  /** Provider IDs that cannot be selected in this context (e.g. Antigravity for scheduled tasks). */
  disabledProviders?: ReadonlySet<string>;
  /** Short label shown next to blocked providers. */
  disabledProviderReason?: string;
  /** True inside an existing thread to explain how switching providers hands off history. */
  switching?: boolean;
  onChange: (change: Partial<ModelPickerValue>) => void;
  footer?: ReactNode;
}) {
  const harness = harnesses.find((h) => h.id === value.harness) ?? null;
  const list = models[value.harness];
  const defaultModel = list?.status === "ready" ? list.list.find((m) => m.isDefault) : undefined;
  const info = modelInfo(models, value.harness, value.model);

  /** Keeps reasoning level and fast mode when the new model offers them. */
  const pickModel = (next: string | null) => {
    const nextInfo = modelInfo(models, value.harness, next);
    onChange({
      model: next,
      effort: value.effort && nextInfo?.efforts?.includes(value.effort) ? value.effort : null,
      fast: value.fast && nextInfo?.fast === true,
    });
  };

  return (
    <>
      <div className="menu-columns">
        <div className="menu-column">
          <section>
            <h3>Provider</h3>
            {harnesses.map((h) => {
              const blocked = disabledProviders?.has(h.id) ?? false;
              const disabled = blocked || (!allowUnreadyProviders && !h.ready);
              const hint = blocked
                ? (disabledProviderReason ?? "Not available here")
                : !h.ready
                  ? (h.detail ?? "Not ready")
                  : undefined;
              return (
                <MenuItem
                  key={h.id}
                  selected={h.id === value.harness}
                  disabled={disabled}
                  hint={hint}
                  onClick={() => {
                    if (h.id !== value.harness) {
                      onChange({ harness: h.id, model: null, effort: null, fast: false });
                    }
                  }}
                >
                  {h.label}
                  {h.experimental && <span className="tag">Experimental</span>}
                  {!blocked && allowUnreadyProviders && !h.ready && <span className="muted"> · Not ready</span>}
                  {blocked && <span className="toggle-note">{disabledProviderReason ?? "Not available here"}</span>}
                </MenuItem>
              );
            })}
          </section>
          <section className="models">
            <h3>Model</h3>
            <MenuItem selected={value.model === null} onClick={() => pickModel(null)}>
              Default{defaultModel ? <span className="muted"> · {defaultModel.name}</span> : null}
            </MenuItem>
            {list?.status === "loading" && <p className="menu-status">Loading models…</p>}
            {list?.status === "error" && <p className="menu-status error">{list.error}</p>}
            {list?.status === "ready" &&
              list.list.map((m) => (
                <MenuItem key={m.id} selected={m.id === value.model} onClick={() => pickModel(m.id)}>
                  {m.name}
                </MenuItem>
              ))}
          </section>
        </div>
        <div className="menu-column side">
          {info?.efforts && (
            <section>
              <h3>Reasoning</h3>
              <EffortPicker info={info} value={value.effort} onChange={(next) => onChange({ effort: next })} />
            </section>
          )}
          {info?.fast && (
            <section>
              <FastSwitch info={info} value={value.fast} onChange={(next) => onChange({ fast: next })} />
            </section>
          )}
          <ProviderNote harness={harness} switching={switching} />
        </div>
      </div>
      {footer}
    </>
  );
}

/** A row of levels. "Default" names the model's own level when the harness reports it. */
export function EffortPicker({
  info,
  value,
  onChange,
}: {
  info: ModelInfo;
  value: string | null;
  onChange: (effort: string | null) => void;
}) {
  const levels = info.efforts ?? [];
  const current = value && levels.includes(value) ? value : null;
  return (
    <div className="segments" role="radiogroup" aria-label="Reasoning">
      <button
        type="button"
        role="radio"
        aria-checked={current === null}
        className={current === null ? "selected" : ""}
        title={info.defaultEffort ? `The model's default, ${effortName(info.defaultEffort)}` : "The model's default"}
        onClick={() => onChange(null)}
      >
        Default
      </button>
      {levels.map((level) => (
        <button
          key={level}
          type="button"
          role="radio"
          aria-checked={current === level}
          className={current === level ? "selected" : ""}
          onClick={() => onChange(level)}
        >
          {effortName(level)}
        </button>
      ))}
    </div>
  );
}

/** The fast mode switch, with what it costs. */
export function FastSwitch({
  info,
  value,
  onChange,
}: {
  info: ModelInfo;
  value: boolean;
  onChange: (fast: boolean) => void;
}) {
  return (
    <button type="button" role="switch" aria-checked={value} className="toggle-row" onClick={() => onChange(!value)}>
      <span className="menu-label">
        Fast mode
        {info.fastNote && <span className="toggle-note">{info.fastNote}</span>}
      </span>
      <span className={`toggle${value ? " on" : ""}`} aria-hidden="true" />
    </button>
  );
}

function ProviderNote({ harness, switching }: { harness: HarnessInfo | null; switching: boolean }) {
  if (!harness?.note && !switching) return null;
  return (
    <div className="menu-note">
      {harness?.note && <p>{harness.note}</p>}
      {switching && <p>A new provider gets the conversation so far as text, without the details of earlier steps.</p>}
    </div>
  );
}

function MenuItem({
  selected,
  disabled,
  hint,
  onClick,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  hint?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={`menu-item${selected ? " selected" : ""}`}
      disabled={disabled}
      title={hint}
      onClick={onClick}
    >
      <span className="menu-label">{children}</span>
      {selected && <Icon name="check" size={15} />}
    </button>
  );
}
