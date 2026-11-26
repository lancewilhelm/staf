import { describe, expect, test } from "bun:test";
import type { ThreadSummary } from "@staf/protocol";
import { activeAgentId, agentInitial, groupThreads, runningAgents, visibleThreads } from "../src/sidebar.ts";
import { DEFAULT_HERO_FONT, parseHeroFont } from "../src/theme.ts";

function makeThread(overrides: Partial<ThreadSummary> & { id: string }): ThreadSummary {
  return {
    title: "Chat",
    agentId: "default",
    harness: "codex",
    model: null,
    effort: null,
    fast: false,
    status: "idle",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("sidebar helpers", () => {
  test("activeAgentId follows the open thread's agent and falls back to the selected agent", () => {
    const threads = [
      makeThread({ id: "t1", agentId: "default" }),
      makeThread({ id: "t2", agentId: "travel" }),
    ];
    expect(activeAgentId(threads, null, "default")).toBe("default");
    expect(activeAgentId(threads, "t2", "default")).toBe("travel");
    expect(activeAgentId(threads, "missing", "travel")).toBe("travel");
  });

  test("visibleThreads filters to one agent unless showAll is set", () => {
    const threads = [
      makeThread({ id: "t1", agentId: "default" }),
      makeThread({ id: "t2", agentId: "travel" }),
      makeThread({ id: "t3", agentId: "default" }),
    ];
    expect(visibleThreads(threads, "default", false).map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(visibleThreads(threads, "travel", false).map((t) => t.id)).toEqual(["t2"]);
    expect(visibleThreads(threads, "paper", false)).toEqual([]);
    expect(visibleThreads(threads, "travel", true).map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  test("runningAgents collects only agents with a running thread", () => {
    const threads = [
      makeThread({ id: "t1", agentId: "default", status: "idle" }),
      makeThread({ id: "t2", agentId: "travel", status: "running" }),
      makeThread({ id: "t3", agentId: "paper", status: "running" }),
    ];
    expect(runningAgents(threads)).toEqual(new Set(["travel", "paper"]));
  });

  test("agentInitial returns the first uppercase character or a fallback", () => {
    expect(agentInitial("Staf")).toBe("S");
    expect(agentInitial("  travel")).toBe("T");
    expect(agentInitial("")).toBe("?");
  });

  test("groupThreads buckets conversations by recency and drops empty buckets", () => {
    const noon = new Date(2026, 10, 25, 12, 0, 0).getTime();
    const day = 24 * 60 * 60 * 1000;
    const threads = [
      makeThread({ id: "today", updatedAt: noon - 60_000 }),
      makeThread({ id: "yesterday", updatedAt: noon - day }),
      makeThread({ id: "week", updatedAt: noon - 4 * day }),
      makeThread({ id: "older", updatedAt: noon - 14 * day }),
    ];
    expect(groupThreads(threads, noon).map(([label, items]) => [label, items.map((t) => t.id)])).toEqual([
      ["Today", ["today"]],
      ["Yesterday", ["yesterday"]],
      ["Previous 7 days", ["week"]],
      ["Older", ["older"]],
    ]);
    expect(groupThreads([threads[0]!, threads[3]!], noon).map(([label]) => label)).toEqual(["Today", "Older"]);
  });

  test("parseHeroFont accepts known fonts and falls back to the default", () => {
    expect(parseHeroFont("bricolage")).toBe("bricolage");
    expect(parseHeroFont("space-grotesk")).toBe("space-grotesk");
    expect(parseHeroFont("sans")).toBe("sans");
    expect(parseHeroFont("fraunces")).toBe("fraunces");
    expect(parseHeroFont("serif")).toBe("serif");
    expect(parseHeroFont("unknown")).toBe(DEFAULT_HERO_FONT);
    expect(parseHeroFont(null)).toBe(DEFAULT_HERO_FONT);
  });
});
