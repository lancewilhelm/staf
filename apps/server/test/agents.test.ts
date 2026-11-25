import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConfigError, Agents, chatInstructions, DEFAULT_SETTINGS } from "../src/agents.ts";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "staf-agents-"));
  const root = join(home, "agents");
  mkdirSync(root);
  const agents = new Agents(root, home);
  const write = (id: string, settings: unknown) => {
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, "agent.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  };
  return { home, root, agents, write };
}

describe("Agents", () => {
  test("creates the default agent with a separate workspace", () => {
    const { agents, root } = setup();
    const agent = agents.ensureDefault();
    expect(agent).toMatchObject({
      id: "default",
      name: "Staf",
      harness: "codex",
      dir: join(root, "default"),
      workspace: join(root, "default", "workspace"),
      access: { network: true, harnessApps: [], writableFolders: [] },
    });
    expect(existsSync(agent.workspace)).toBe(true);
    expect(agent.instructions).toContain("You are Staf");
  });

  test("fills in defaults for settings that an older agent.json leaves out", () => {
    const { agents, write } = setup();
    write("older", { name: "Older", harness: "codex", model: null });
    expect(agents.get("older")!.access).toEqual({
      network: DEFAULT_SETTINGS.network,
      harnessApps: [],
      writableFolders: [],
    });
  });

  test("accepts existing folders outside Staf's data and expands ~", () => {
    const { agents, write } = setup();
    const notes = mkdtempSync(join(tmpdir(), "staf-notes-"));
    write("builder", { writableFolders: [notes] });
    expect(agents.get("builder")!.access.writableFolders).toEqual([notes]);

    // The test's Staf home is in the temp folder, not under the home folder.
    write("tilde", { writableFolders: ["~/"] });
    expect(agents.get("tilde")!.access.writableFolders).toEqual([homedir()]);
  });

  test("refuses settings that are wrong or unsafe", () => {
    const { agents, write, home } = setup();
    const cases: Array<[unknown, string]> = [
      ["{not json", "not valid JSON"],
      [[], "JSON object"],
      [{ network: "yes" }, '"network" must be true or false'],
      [{ harnessApps: "Gmail" }, '"harnessApps" must be a list'],
      [{ writableFolders: ["relative/path"] }, "absolute paths"],
      [{ writableFolders: [home] }, "overlaps Staf's data folder"],
      [{ writableFolders: [join(home, "agents")] }, "overlaps Staf's data folder"],
      [{ writableFolders: [join(home, "..")] }, "overlaps Staf's data folder"],
      [{ writableFolders: ["/definitely/not/here"] }, "not an existing folder"],
    ];
    cases.forEach(([settings, message], index) => {
      write(`bad-${index}`, settings);
      expect(() => agents.get(`bad-${index}`)).toThrow(AgentConfigError);
      expect(() => agents.get(`bad-${index}`)).toThrow(message);
    });
  });

  test("returns null for unknown or unsafe agent IDs", () => {
    const { agents } = setup();
    expect(agents.get("missing")).toBeNull();
    expect(agents.get("../etc")).toBeNull();
  });

  test("puts the agent's own instructions after Staf's", () => {
    const text = chatInstructions({ instructions: "Speak like a pirate." });
    expect(text).toContain("running inside Staf");
    expect(text.endsWith("Speak like a pirate.")).toBe(true);
    expect(chatInstructions({ instructions: "  " })).not.toContain("own instructions");
  });
});
