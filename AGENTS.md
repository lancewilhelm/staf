# Working on Staf

Staf is a personal agent host. Read [docs/spec.md](docs/spec.md) before you change
behavior, and update it when a decision changes.

## Commands

```sh
bun install            # install dependencies
bun run dev            # run the host with the web app on http://127.0.0.1:4280
bun test               # run all tests
bun run typecheck      # type-check every package
bun run build          # compile the single binary to dist/staf
```

## Layout

- `packages/protocol`: types shared by the server, the web app, and the CLI, plus the
  platform-neutral API client. It must not import Bun or Node modules.
- `apps/server`: the host, the harness adapters, and the CLI.
- `apps/web`: the React web app. Bun bundles it, and the binary embeds it.

## Rules

- Keep the footprint small. Add a dependency only when it removes real work, and say
  why in the commit message.
- The web app and the CLI only see normalized events from `packages/protocol`. Do not
  pass harness-specific payloads to them.
- Harness adapters must not depend on a person's own harness setup. Use Staf's harness
  homes under `~/.staf/harness/`.
- Never commit credentials. Never copy a harness's credentials file; sign in separately.
- Tests must not start a real harness. Use the fake harness, or recorded Codex messages.
- Build in slices, as described in the spec, and use each slice live before the next.

## Writing

For docs, commit messages, and UI text, write plain English: keep connecting words such
as "that" and "which", break up chains of nouns, and use literal verbs for code ("returns
an error", not "swallows it").
