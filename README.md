# Staf

Staf is a personal agent host for a household. It runs existing agent harnesses (ChatGPT
through Codex, Gemini through Antigravity, and Claude through Claude Code) and gives them
a simple chat interface in the browser and the terminal. Read the [specification](docs/spec.md) for the design and the delivery plan.

Status: slice 1, slice 2a, and slice 2b are done. Chat works in the web app and the CLI on
all three harnesses. Agents are managed from the sidebar in their own panel, appearance
and sidebar mode preferences sync on the host, threads support Inbox and Thread list modes
with settle/unsettle state and message attachments, and each thread can switch provider,
model, reasoning level, and fast mode.

## Documentation

- [Agents](docs/agents.md): agent folders, settings, harness apps, and examples
- [Running Staf](docs/deployment.md): where files live, backups, and the server plan
- [Specification](docs/spec.md): the design and the delivery slices
- [Decisions](docs/decisions.md): what was decided, and why
- [Memory](docs/memory.md): the planned design for agent memory

## Requirements

- macOS or Linux
- [Bun](https://bun.sh) 1.4 or later, to build from source
- At least one harness: the [Codex CLI](https://github.com/openai/codex) with a ChatGPT
  account, Antigravity's `agy` command, or [Claude Code](https://claude.com/claude-code)

## Quick start

```sh
bun install
bun run build                 # writes dist/staf
./dist/staf serve             # http://127.0.0.1:4280
./dist/staf login codex       # or sign in under Settings → Providers in the web app
```

In another terminal:

```sh
./dist/staf ask "Is it going to rain tomorrow?"
./dist/staf ask --harness claude --model haiku "And the day after?"
./dist/staf chat
./dist/staf apps              # list ChatGPT apps that an agent may be given
```

`staf login codex` keeps its login in `~/.staf/harness/codex`. Your everyday Codex setup
(its MCP servers, hooks, and instructions) does not affect Staf runs.

## Development

```sh
bun run dev                          # host with live reload of the web app
STAF_HARNESS=fake bun run dev        # same, with a fake harness that needs no login
bun test
bun run typecheck
```

## Data

Staf keeps everything in `~/.staf` (set `STAF_HOME` to change it). Edit
`~/.staf/agents/default/AGENTS.md` to change how Staf answers. See
[Running Staf](docs/deployment.md) for the full layout.

The host listens only on 127.0.0.1 and has no login yet. Do not expose the port to a
network until slice 6 adds sign-in.

## License

[MIT](LICENSE). Staf runs Codex, Claude Code, and Antigravity, which you install and sign
in to yourself. Their own licenses and terms apply to them.
