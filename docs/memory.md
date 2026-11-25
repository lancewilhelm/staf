# Memory (Planned)

This is a design for how Staf agents remember things across conversations. Nothing here
is built yet. It is planned for slice 3, together with the Staf MCP server. Open
questions are listed at the end.

## Goals

- An agent remembers facts that matter to the household: names, places, preferences,
  routines, and decisions. It does not need to be told again in every conversation.
- Memory works the same way on every harness, so moving an agent from Codex to Claude
  does not make it forget.
- Each person has private memory, and the household has shared memory. the second person's agents
  never read the owner's private memory, and the other way around.
- People can see, correct, and delete every memory, in the web app and the CLI.
- Text that arrives from outside, such as email and web pages, cannot write memory on its
  own. That would let a prompt injection plant instructions that last.

## Harness memory stays off

Each harness has its own memory feature, but those features belong to the harness
account, which the household shares, and Staf cannot see or scope them.

| Harness | Its memory feature | Status in Staf |
|---|---|---|
| Codex | `memories` feature | Off (the default in Staf's Codex home). Staf should set it off explicitly. |
| Claude | Auto-memory | Off, because Staf runs Claude with `--safe-mode`. |
| Antigravity | Knowledge in `brain/` and `implicit/` | On, and shared by every Antigravity agent through Staf's Antigravity folder. Turn it off, or give each person their own folder, before slice 5 adds the second person. |

## Scopes

| Scope | Who can read it | Example |
|---|---|---|
| Household | Every agent of every person | "We live in Lisbon." "Trash pickup is Tuesday morning." |
| Personal | The agents of one person | "the owner runs in the morning and avoids uneven trails." |
| Agent | One agent | Notes that the agent keeps for its own job. These are files in its workspace, so they need no new system. |

Until slice 5 adds people, everything belongs to the household's one account.

## Storage

A `memories` table in `staf.db`:

| Column | Meaning |
|---|---|
| `id` | Unique ID |
| `scope` | `household`, or `person:<id>` |
| `text` | One fact in one or two sentences |
| `status` | `active`, `proposed` (waiting for approval), or `archived` |
| `source` | Where it came from: a person, or a thread or job and its message |
| `created_at`, `updated_at`, `last_used_at` | Times, for review and cleanup |

SQLite's built-in full-text search (FTS5) handles lookups. Embeddings can come later if
full-text search turns out not to be enough; they would add a model call and storage.

## How agents read memory

1. **A short profile in every run.** Staf adds the most important active memories for the
   person and the household to the instructions that it already passes to every harness,
   up to a fixed size (about 2,000 tokens). This needs no tools, so it works on every
   harness from the start.
2. **Search when needed.** A Staf MCP tool, `memory_search`, lets the agent look up
   anything beyond the profile.

## How memory is written

1. **The person asks.** "Remember that the dentist is Dr. Reyes." The agent calls the
   Staf tool `memory_save`. Because the request came from the person in chat, the memory
   is saved as active.
2. **The agent notices something.** The agent calls `memory_propose`. The proposal
   becomes an inbox item, and the person approves, edits, or rejects it.
3. **Jobs that read outside content,** such as inbox monitoring, can only propose. Staf
   enforces this in the tool, based on the run's token, not on the model's judgment.
4. **People edit directly** on a Memory page in the web app, or with `staf memory`.

## Order of work

1. The table, the profile in the instructions, and the Memory page, so that people can
   add memories by hand. This could come before the MCP server.
2. The MCP tools (`memory_search`, `memory_save`, `memory_propose`) with slice 3.
3. Proposals in the inbox with slice 2's inbox.
4. Personal scopes with slice 5.

## Open questions

- Should Staf import memories from Hermes (`~/.hermes/memories`) once, as proposals to
  review?
- How should old memories be retired: by age, by `last_used_at`, or only by hand?
- When a household fact and a personal fact disagree, which one wins in the profile?
- Is the profile's fixed size right, or should it depend on the harness's context size?
