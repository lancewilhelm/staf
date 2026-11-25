// Antigravity lists each reasoning level as its own model, such as "Gemini 4 Neon (High)"
// with the ID "gemini-4-neon-high". Staf shows one model with a list of levels instead, so
// that the menu works the same way for every harness.

import type { ModelInfo } from "@staf/protocol";

/** Reasoning levels that model names can end with, lowest first. */
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const LEVEL_NAME = /^(.*) \((Minimal|Low|Medium|High|XHigh|Max)\)$/i;

interface Variant {
  /** The harness's own model ID. */
  rawId: string;
  level: string;
}

interface Group {
  info: ModelInfo;
  variants: Variant[];
}

function split(model: ModelInfo): { baseId: string; baseName: string; level: string } | null {
  const match = LEVEL_NAME.exec(model.name);
  if (!match) return null;
  const level = match[2]!.toLowerCase();
  if (!model.id.endsWith(`-${level}`)) return null;
  return { baseId: model.id.slice(0, -level.length - 1), baseName: match[1]!, level };
}

function groups(raw: ModelInfo[]): Group[] {
  const defaultLevel = raw.find((model) => model.isDefault)?.id.split("-").pop() ?? "medium";
  const byId = new Map<string, Group>();
  const order: Group[] = [];
  for (const model of raw) {
    const parts = split(model);
    const key = parts?.baseId ?? model.id;
    let group = byId.get(key);
    if (!group) {
      group = { info: { id: key, name: parts?.baseName ?? model.name }, variants: [] };
      byId.set(key, group);
      order.push(group);
    }
    group.variants.push({ rawId: model.id, level: parts?.level ?? "" });
    if (model.isDefault) group.info.isDefault = true;
  }
  for (const group of order) {
    if (group.variants.length < 2 || group.variants.some((variant) => !variant.level)) {
      // Nothing to choose between, so the model keeps its own ID and name.
      const model = raw.find((m) => m.id === group.variants[0]!.rawId)!;
      group.info = { id: model.id, name: model.name, ...(model.isDefault ? { isDefault: true } : {}) };
      group.variants = [{ rawId: model.id, level: "" }];
      continue;
    }
    group.variants.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level));
    const efforts = group.variants.map((variant) => variant.level);
    const isDefaultRaw = raw.find((m) => m.isDefault && group.variants.some((v) => v.rawId === m.id));
    const defaultEffort = isDefaultRaw
      ? group.variants.find((v) => v.rawId === isDefaultRaw.id)!.level
      : efforts.includes(defaultLevel)
        ? defaultLevel
        : efforts[Math.floor((efforts.length - 1) / 2)]!;
    group.info = { ...group.info, efforts, defaultEffort };
  }
  return order;
}

/** The harness's model list with the levels of each model merged into one entry. */
export function groupLevels(raw: ModelInfo[]): ModelInfo[] {
  return groups(raw).map((group) => group.info);
}

/**
 * The harness's own model ID for a model and level that Staf shows. An ID that the harness
 * lists itself is used as it is. Returns null when the model is not in the list.
 */
export function resolveLevel(raw: ModelInfo[], model: string | null, effort: string | null): string | null {
  if (model && raw.some((m) => m.id === model)) return model;
  const list = groups(raw);
  const group = model ? list.find((g) => g.info.id === model) : list.find((g) => g.info.isDefault);
  if (!group) return model;
  if (!model && !effort) return raw.find((m) => m.isDefault)?.id ?? null;
  const level = effort && group.info.efforts?.includes(effort) ? effort : group.info.defaultEffort;
  return (group.variants.find((variant) => variant.level === level) ?? group.variants[0]!).rawId;
}
