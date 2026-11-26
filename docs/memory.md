# Memory (Planned)

This is the design for how a Staf agent remembers things across conversations. Nothing
here is built yet. Memory v1 is planned for slice 3, together with the Staf MCP server.

Memory v1 copies the built-in memory of Hermes, which has worked well in daily use.
Larger systems, such as one modeled on Hindsight, are planned for later (see the end).

## Goals

- An agent remembers what matters: names, places, preferences, routines, and decisions.
  It does not need to be told again in every conversation.
- Memory works the same way on every harness. An agent that moves from Codex to Claude
  keeps the same memory.
- People can see, correct, and delete every memory, in the web app and the CLI.
- Text that arrives from outside, such as email and web pages, cannot write memory on its
  own. That would let a prompt injection plant instructions that last.

## Memory belongs to one agent

Each agent has its own memory. Two agents never read each other's memory, even when the
same person owns both. There is no household or shared memory for now; it can be added
later if a real need appears.

Why: per-agent memory is the easiest to understand. What an agent knows is what it was
told in its own conversations. Because memory lives in Staf and not in a harness, it
still follows the agent to any provider.

## Harness memory stays off

Each harness has its own memory feature. Those features belong to the harness account or
data folder, not to a Staf agent, and Staf cannot see or scope them. Slice 1d turns them
off:

| Harness | Its memory feature | Status |
|---|---|---|
| Codex | `memories` feature | Off: Staf sets it off on every thread. |
| Claude | Auto-memory | Off: Staf passes `autoMemoryEnabled: false` in `--settings` and `--setting-sources ""` so that Staf's MCP bridge still loads while personal settings and auto-memory stay off. |
| Antigravity | Automatic knowledge in `implicit/` | **Cannot be turned off.** agy 1.5 controls it with a server-side flag, not a setting. It is shared by every conversation in Staf's Antigravity folder. `brain/` holds one folder per conversation and is deleted with the conversation. |

The Antigravity gap matters once a second person has agents (slice 5). Before then, either give
each person their own Antigravity folder or keep Antigravity for the account owner only.

## What the agent sees: two small blocks

Like Hermes, each agent has two blocks of short entries. Both go into the instructions
at the start of every conversation:

| Block | Holds | Default limit |
|---|---|---|
| **Notes** | What the agent learned about its work and surroundings: how a task is done, where things are, what failed before | 2,200 characters (about 800 tokens) |
| **Profile** | What the agent knows about its person: preferences, routines, people, places | 1,375 characters (about 500 tokens) |

These are the Hermes defaults (`memory_char_limit` and `user_char_limit`). The limits can
be changed per agent in the settings window. Small limits keep every message cheap and
force the agent to keep only what matters. When a block is full, the agent must merge or
remove entries before it adds one.

The blocks are copied into a conversation when it starts and do not change during it.
A memory saved in one conversation appears in the next one. This matches Hermes and
keeps each harness session's instructions stable.

## Looking things up: conversation search

The blocks are small on purpose. For anything else, the agent searches its own past
conversations with the Staf tool `conversation_search`, which uses SQLite's built-in
full-text search (FTS5) over the messages that Staf already stores. Hermes has the same
tool (`session_search`).

## How memory is written

1. **The agent saves it.** The Staf tool `memory` adds, changes, or removes an entry in
   one block, like the Hermes tool. The agent saves what the person asks it to remember,
   and what it judges worth keeping.
2. **A reminder.** Every 10 messages from the person, Staf adds a short reminder for the
   agent to consider saving something (Hermes's `nudge_interval`, adjustable in settings).
3. **Runs that read outside content can only propose.** A job that reads email, for
   example, cannot change memory directly. Its changes become proposals in the inbox,
   and the person approves, edits, or rejects them. Staf enforces this in the tool,
   based on the run's token, not on the model's judgment.
4. **People edit directly** in the agent's memory view in the web app, or with
   `staf memory`.
5. **Entries are checked before they reach the instructions.** Like Hermes, Staf scans
   entries for text that looks like injected instructions and shows a warning in their
   place instead of passing them to the model. The person still sees the original
   entry and can delete it.

## Storage

A `memories` table in `staf.db`:

| Column | Meaning |
|---|---|
| `id` | Unique ID |
| `agent_id` | The agent that owns the entry |
| `block` | `notes` or `profile` |
| `text` | The entry |
| `status` | `active` or `proposed` (waiting for approval) |
| `source` | Where it came from: a person, or a thread or job and its message |
| `created_at`, `updated_at` | Times |

Deleting an agent deletes its memory.

## Importing from another system (later)

Someone who comes from another assistant may want to bring their memories along. A later
`staf memory import` reads a simple file of entries (plain text or JSON) and adds them to
one agent as proposals to review. Staf will not import from Hermes automatically.

## Later: a larger memory system

Memory is what makes an agent more useful over time, so v1 is a starting point. A later
phase will:

1. Survey memory systems such as Hindsight, Mem0, Letta, Zep/Graphiti, and Supermemory:
   how each decides what to keep, how it recalls, and what it costs to run.
2. Set up benchmarks: public ones (LongMemEval, LoCoMo) and a small set of Staf
   scenarios. Does the agent recall the right fact when it matters, stay quiet when a
   memory is not relevant, notice a changed fact, and refuse a "memory" planted in an
   email?
3. Build a Hindsight-like system inside Staf, with middle options between v1 and that.
   Memory v1 sits behind a small interface so that a new system can replace it.

## Open questions

- How should old entries be retired once blocks are full and conversation search grows:
  by age, or only by the agent and by hand?
