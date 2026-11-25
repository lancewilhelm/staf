# Decisions

A short record of decisions and why they were made. Add an entry when a decision changes
how Staf is built or used. Newest first.

## 2026-11-25: Memory belongs to one agent and starts with the Hermes design

Each agent has its own memory, and nothing is shared between agents or people for now.
Memory v1 copies Hermes's built-in memory: a notes block of 2,200 characters and a
profile block of 1,375 characters in every conversation's instructions, plus full-text
search over past conversations. The limits can be changed in settings. A
Hindsight-like system comes later.

Why: shared memory makes it hard to tell why an agent knows something. The Hermes limits
have worked well in daily use and give a known starting point to measure against.

## 2026-11-25: An agent is a profile with its own provider and model

An agent is a named assistant: instructions, a workspace, memory, and the provider and
model behind it. People create and edit agents in the settings window, and a pill next
to the composer picks the agent for a new conversation. To use another provider, a
person makes or picks another agent; a conversation does not switch providers on its
own.

Why: an agent is something a person talks to and gives jobs to, not a provider
setting. Agents that differ only by provider would split memory for no reason.

## 2026-11-25: No scheduled jobs on Antigravity for now

Jobs run on Codex or Claude. Antigravity is for conversations that a person starts, and
the web app marks it as experimental.

Why: there are reports of Google suspending Antigravity access for automated use,
including one case that used only the official `agy` program started by another local
program. Steady scheduled traffic is the pattern that these reports describe.

## 2026-11-25: Deleting a conversation deletes the harness's copy too

Each harness keeps its own transcript of a conversation. When a person deletes a
conversation in Staf, Staf deletes that transcript as well.

Why: a person who deletes a conversation expects it to be gone. Claude's copy lives in
`~/.claude/projects/`, where nobody would think to look.

## 2026-11-25: Antigravity and Claude use the person's own sign-in

Codex has a separate Staf sign-in. Antigravity and Claude use the sign-in that already
exists on the machine, and Staf keeps the person's own setup out in another way:

- Antigravity runs with `--gemini-dir ~/.staf/harness/antigravity`. Its sign-in comes
  from the system keychain, so a separate data folder needs no new login, and the
  person's global GEMINI.md, hooks, and skills do not load.
- Claude runs with `--safe-mode`, which leaves out the person's CLAUDE.md, skills,
  plugins, hooks, and MCP servers while the sign-in keeps working.

Why: both keep a person's own setup out of Staf runs without a second login, and neither
copies a credentials file. The cost is that Claude's transcripts live in `~/.claude`,
outside Staf's data folder. Check `--safe-mode` again when Staf adds its own MCP server,
because safe mode also turns off MCP servers.

## 2026-11-25: Text before a tool call is commentary

Claude and Antigravity stream plain text with no label for commentary. Staf streams text
into the answer at once, and when a tool call follows, it moves that text into a step
and starts the answer again. Codex labels commentary itself.

Why: the answer should hold the answer, as it does with Codex, while text still appears
as soon as it streams.

## 2026-11-25: Staf answers ACP permission requests itself

ACP agents ask the client before they run commands or change files. Staf allows reads,
searches, and sandboxed commands, allows file changes only inside the workspace (and,
where the harness supports it, the writable folders), and always refuses Antigravity's
requests to run a command outside its sandbox.

Why: when a command fails in the sandbox, the model asks to rerun it outside. Allowing
that would undo the sandbox. On Antigravity, commands therefore never reach the network.

## 2026-11-25: Claude runs one process per turn

Each Claude turn starts `claude -p` with `--resume`, and the process exits when the turn
ends.

Why: it is the simplest way to drive Claude Code, it holds no memory between turns, and
stopping an answer is a signal to one process. Startup adds about a second per turn.

## 2026-11-24: Agents write only to their workspace

An agent's `agent.json` and `AGENTS.md` live outside its `workspace/` folder, and Staf
passes the instructions to the harness itself. The harness sandbox lets the agent write
only to its workspace and to folders listed in `writableFolders`, which may not overlap
Staf's data folder.

Why: if the agent could edit its own settings, a prompt injection could make it grant
itself apps or folders.

## 2026-11-24: Harness account apps are off by default

Codex brings every app connected to the ChatGPT account (Gmail, Drive, Expedia, and
more). Staf turns them off, along with computer use, browser use, and plugins. An agent
can allow specific apps by name in `harnessApps`, and those apps cannot take destructive
actions.

Why: the household shares one login, so these apps would give every agent, including
a second person's, the account owner's data. Staf cannot put approvals in front of them, and
they exist only on Codex, so an agent would change behavior when it moves to another
harness. Integrations that Staf depends on, such as Gmail, will be Staf's own tools.

## 2026-11-24: Commands can use the network by default

The `network` setting defaults to true, so code that an agent writes can call APIs.

Why: building small tools is one of the main uses of the coding harness. Plugin
credentials stay out of agent folders, which limits what a misled command could leak.
Set `network` to false for agents that do not need it.

## 2026-11-24: Staf keeps its own harness homes

Staf signs in to Codex separately and keeps that sign-in in `~/.staf/harness/codex`.

Why: a person's everyday Codex setup (MCP servers, hooks, global instructions) should not
change Staf runs, and two copies of one credentials file would invalidate each other's
refresh token.

## 2026-11-24: TypeScript on Bun, one binary, React

Staf is written in TypeScript, runs on Bun, and compiles to one executable that embeds
the web app. The web app uses React.

Why: one language for the server, web app, CLI, and a future Expo phone app, with shared
types. The reference SDKs for MCP, ACP, and Claude are TypeScript. Go would give a
smaller binary, but the difference is small next to the harness processes.

## 2026-11-24: Staf hosts harnesses instead of running its own agent loop

Staf drives existing harnesses (Codex first, then Antigravity and Claude) and adds what
they lack: household integrations, schedules, an inbox, approvals, and a simple
interface.

Why: subscriptions only work through the official harnesses, and the agent loop is the
part that improves fastest. Staf v1 spent most of its effort rebuilding that loop.
