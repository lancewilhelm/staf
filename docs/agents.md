# Agents

An agent is a folder with instructions, settings, and a workspace. Every conversation
belongs to one agent. Staf creates an agent named `default` on first run.

## Where agents live

```
~/.staf/agents/<agent-id>/
├─ agent.json      settings (you edit this; the agent cannot)
├─ AGENTS.md       instructions (you edit this; the agent cannot)
└─ workspace/      the agent's working folder
```

The agent ID is the folder name. It uses lowercase letters, digits, and dashes, such as
`travel` or `kids-homework`.

**The workspace** is where the harness runs. The agent can create, edit, and run files
there: notes, scripts, skills, and outputs such as reports. Files that the agent makes
stay there between conversations.

**`agent.json` and `AGENTS.md` sit outside the workspace on purpose.** The harness sandbox
only lets the agent write to its workspace, so a prompt injection in an email or a web
page cannot make the agent grant itself more access or rewrite its own instructions.

## Settings

`agent.json` holds one JSON object. Every field is optional; missing fields use the
defaults shown.

| Field | Default | Meaning |
|---|---|---|
| `name` | `"Staf"` | The name shown for the agent. |
| `harness` | `"codex"` | The default harness for new conversations: `codex`, `antigravity`, or `claude`. See below. |
| `model` | `null` | The default model, such as `"gpt-6.2-sol"`, `"sonnet"`, or `"gemini-4-neon"`, or `null` for the harness's default. |
| `effort` | `null` | The default reasoning level, such as `"low"` or `"high"`, or `null` for the model's default. A level that the model does not offer is ignored. |
| `fast` | `false` | Whether to use the harness's fast mode. It costs more; see below. |
| `network` | `true` | Whether commands that the agent runs can reach the network. Web search works either way. |
| `harnessApps` | `[]` | Apps that come with the harness account, by name or ID. See below. |
| `writableFolders` | `[]` | Extra folders that the agent may write to, as absolute paths or paths starting with `~/`. |

If `agent.json` has a problem, Staf refuses to start a conversation with that agent and
says what is wrong.

### Harnesses

| `harness` | Runs | Sign-in |
|---|---|---|
| `codex` | ChatGPT through `codex app-server` | Staf's own: `staf login codex` |
| `antigravity` | Gemini through `agy acp` | Your Antigravity sign-in (run `agy` once) |
| `claude` | Claude through `claude -p` | Your Claude Code sign-in (run `claude` once) |

The harnesses do not support every setting in the same way:

| Setting | Codex | Antigravity | Claude |
|---|---|---|---|
| `network` | Yes | **No**: commands never reach the network. Its own web search still works. | Yes |
| `harnessApps` | Yes | Not applicable | Not applicable |
| `writableFolders` | Yes | **No**: the agent can write only to its workspace, and the answer shows a note. | Yes |

In every harness, commands run in the harness's sandbox, file changes outside the
workspace and the writable folders are refused, and the agent's own instructions come
from `AGENTS.md`. Staf keeps the person's own setup for each harness (global
instructions, hooks, skills, plugins, and MCP servers) out of Staf runs.

When Staf refuses a step on Antigravity, Antigravity ends the answer there. The answer
then says which step Staf refused.

### Harness apps

The ChatGPT account that Codex signs in with can have apps connected to it, such as
Gmail, Google Drive, or Expedia. **Staf turns all of them off by default.** These apps
belong to the account, not to a person in Staf, so they would give every agent, including
a second person's, access to the account owner's mail and files. Staf also cannot put its own
approvals in front of them.

To allow some of them for one agent:

1. Run `staf apps` to list the connected apps. The first run can take a minute.
2. Add the names to `harnessApps`, for example `["Expedia"]`.

Allowed apps cannot take actions that the app marks as destructive, such as sending or
deleting. Searching and reading still work. If a name does not match a connected app,
the answer shows a "Skipped the app" step, and the conversation continues without it.

Codex's computer use, browser use, and plugin features are always off in Staf. For
Claude, Staf allows only these built-in tools: Bash, Read, Edit, Write, WebSearch,
WebFetch, and Skill. Claude account features such as publishing pages, remote triggers,
and push notifications are off.

### Writable folders

A folder in `writableFolders` must exist, and it cannot be Staf's data folder, a folder
inside it, or a folder that contains it. Use this for an agent that maintains files
somewhere else, such as a builder agent that edits a project:

```json
{
  "name": "Builder",
  "writableFolders": ["~/projects/Staf"]
}
```

## Examples

A travel agent that can search Expedia:

```json
{
  "name": "Travel",
  "harnessApps": ["Expedia"]
}
```

An agent that only answers from the web, with no network access for its own commands:

```json
{
  "name": "Researcher",
  "network": false
}
```

A Gemini agent that thinks less, for faster answers:

```json
{
  "name": "Gemini",
  "harness": "antigravity",
  "model": "gemini-4-neon",
  "effort": "low"
}
```

## Creating and editing agents

Open **Settings → Agents** in the web app. There you can create an agent, and change an
agent's name, default provider, model, reasoning level, fast mode, and instructions. Staf names the folder
after the agent, for example `morning-paper` for "Morning Paper".

**Access settings** (`network`, `writableFolders`, and `harnessApps`) are shown there but
can only be changed in `agent.json`. Staf's web API has no sign-in yet, so a command that
an agent runs could call it. If the API could change access, a prompt injection could make
an agent widen its own access.

You can also create an agent by hand:

```sh
mkdir -p ~/.staf/agents/travel
echo '{ "name": "Travel", "harnessApps": ["Expedia"] }' > ~/.staf/agents/travel/agent.json
echo "You help plan trips. Prefer refundable options." > ~/.staf/agents/travel/AGENTS.md
staf ask --agent travel "Find a hotel in Lisbon for December 12."
```

Staf creates the `workspace/` folder the first time the agent runs. Changes to
`agent.json` and `AGENTS.md` apply to the next message; you do not need to restart Staf.

**Deleting an agent** deletes its conversations, including the harnesses' copies, and
moves its folder, with its workspace, to `~/.staf/trash/agents/`. The default agent cannot
be deleted.

## Choosing the provider and model for one conversation

The pill under the message box shows the model or provider, and the reasoning level and
fast mode when they are set, such as "Opus 5.5 · High · Fast". Once there is more than one
agent, it starts with the agent's name. Its menu picks:

- **The agent,** for a new chat.
- **The provider, model, reasoning level, and fast mode,** for this conversation. The
  menu shows only the levels and the fast mode that the chosen model offers.

A new chat starts with the provider, model, and level that were last picked for the agent
in this browser, or with the agent's defaults before anything is picked. Fast mode does
not carry over, so that a forgotten switch cannot keep costing. Saving the agent in
Settings resets the choice to the new defaults.

During a conversation:

- **Another model, level, or fast setting on the same provider** applies from the next
  message.
- **Another provider** starts a new session on that provider. Staf passes it the earlier
  questions and answers as text, but not the details of earlier steps, such as command
  output. A divider in the conversation marks the switch.

In the terminal, `staf ask` and `staf chat` take `--harness`, `--model`, `--effort`, and
`--fast` or `--no-fast`:

```sh
staf ask --harness claude --model haiku --effort low "Summarize today's weather in Lisbon."
staf ask --thread <id> --model gpt-6.2-astra "Now in two sentences."
```

Model IDs come from each harness, and Settings lists them:

- **ChatGPT** lists its models and the levels of each, from `low` to `ultra`.
- **Claude** lists aliases such as `opus` (the newest Opus) and full model IDs such as
  `claude-opus-4-8`. An alias moves to the next model when Anthropic releases one.
- **Gemini** lists each level as a separate model, such as `gemini-4-neon-high`. Staf
  shows one model, `gemini-4-neon`, with its levels, and asks Antigravity for the matching
  one.

### Fast mode costs more

| Provider | Fast mode | Cost |
|---|---|---|
| ChatGPT | Codex's "Fast" service tier, 1.5–2× faster | Uses more of the ChatGPT plan's limits on most models |
| Claude | Claude Code's fast mode, on Opus and Fable models | **Billed to usage credits on top of the Claude plan**, so it costs money |
| Gemini | None | |

Fast mode is off unless an agent or a conversation turns it on. Staf shows what it costs
next to the switch.

## What Staf adds to the instructions

Each run gets Staf's own short guidance first (answer first, use Markdown, the current
date and time zone), then the agent's `AGENTS.md`.
