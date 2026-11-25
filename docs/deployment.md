# Running Staf

This guide covers where Staf keeps its files, how to run it today, and the plan for an
always-on server. Sections marked **Planned** describe work that is not built yet.

## Where files live

Staf keeps all of its data in one folder, `~/.staf` by default. Set `STAF_HOME` to use a
different folder, for example on a server's data disk.

| Path | Contents | Written by |
|---|---|---|
| `staf.db` | Conversations and messages (SQLite) | Staf |
| `agents/<id>/agent.json` | An agent's settings | You |
| `agents/<id>/AGENTS.md` | An agent's instructions | You |
| `agents/<id>/workspace/` | Files that the agent creates: notes, scripts, skills, reports | The agent |
| `harness/codex/` | Staf's own Codex sign-in, Codex's session logs, and the cached list of apps | Codex and Staf |
| `harness/antigravity/` | Antigravity's settings and conversations for Staf runs, and Staf's cached list of its models | Antigravity and Staf |
| `trash/agents/` | Folders of deleted agents, with their workspaces. Delete them by hand when you no longer need them. | Staf |

The harnesses keep their own transcript of each conversation. Treat these folders as
private, like `staf.db`:

- Codex: `harness/codex/sessions/`
- Antigravity: `harness/antigravity/`
- Claude: **outside `STAF_HOME`**, in `~/.claude/projects/`, in a folder named after the
  agent's workspace path. Claude runs use your own Claude Code sign-in, which lives with
  your Claude Code settings.

Deleting a conversation in Staf deletes the harness's copy too. If a harness cannot delete
its copy, for example because Codex is signed out, Staf keeps the conversation and says
why, so that you can try again.

Apart from Claude's transcripts, nothing outside `STAF_HOME` is written, except folders
that you list in an agent's `writableFolders` and the temporary folder that the harness
sandboxes allow.

### Backups

Stop Staf, then copy the whole `STAF_HOME` folder. That captures conversations, agents
and their workspaces, and Staf's Codex sign-in. Antigravity and Claude sign in again on
a new machine. To restore, copy it back before
starting Staf.

## Running on your Mac today

```sh
./dist/staf serve
```

Sign Staf in to ChatGPT under **Settings → Providers** in the web app, or with
`./dist/staf login codex`. The browser sign-in sends its answer to Codex on this computer,
so do it in a browser on the same machine.

Staf listens on `http://127.0.0.1:4280`. Only programs on the same machine can reach it,
and it has no sign-in yet. It stops when you close the terminal.

## An always-on server (Planned)

The harnesses run on the same machine as Staf, because Staf starts them as child
processes. That machine therefore needs Staf, the harness command-line tools (`codex`,
`agy`, and `claude`), and each harness's sign-in. On macOS, Antigravity and Claude keep
their sign-ins in the system keychain; how they sign in on a headless Linux server needs
testing.

### Mac (a Mac mini, or your Mac)

- Run `staf serve` as a launchd agent that starts at login and restarts after a crash.
- Keep data in `~/.staf`.
- A future `staf service install` command will write the launchd file.

### Linux desktop

- Run `staf serve` as a systemd user service, with the same data layout.
- Sign in to harnesses with `staf login codex --device-auth`, which works without a
  browser on the server.

### Unraid

- Run Staf in a Docker container. The image would contain the `staf` binary and the
  harness command-line tools.
- Map an appdata share, such as `/mnt/user/appdata/staf`, to `/data` in the container,
  and set `STAF_HOME=/data`. All data, including harness sign-ins, then survives
  container updates.
- Sign in from the Unraid terminal: `docker exec -it staf staf login codex --device-auth`.
- **Open question:** the Codex sandbox on Linux uses kernel features that may need extra
  container privileges. This needs testing before Unraid is a supported target.

## Reaching Staf from other devices (Planned, slice 6)

Today Staf refuses any connection that does not come from the same machine. Remote access
needs three things first:

1. **Sign-in.** Each person signs in, and every request carries a
   token for that person. The CLI and apps keep the token after the first sign-in.
2. **HTTPS.** Passwords and tokens must not travel over plain HTTP.
3. **A private route to the server.** The recommended option is
   [Tailscale](https://tailscale.com): the server and your devices join one private
   network, `tailscale serve` adds HTTPS, and nothing is exposed to the internet. A
   reverse proxy on the home network, such as the ones that Unraid apps provide, is
   the alternative for access at home only. Do not forward a router port to Staf.

All clients talk to the same API, so remote access only changes the address:

- **Web app and PWA:** open the server's address in a browser and add it to the home
  screen.
- **CLI:** set `STAF_URL` to the server's address.
- **Phone app (later):** an Expo app that uses the same API client as the web app.

The check that rejects non-local connections will then be replaced by sign-in and a list
of allowed addresses.
