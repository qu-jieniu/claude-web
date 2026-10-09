# omp-web (rebuild)

Persistent omp terminals in a browser: ttyd + tmux behind Caddy, served at
`https://omp.jieniuu8.com/`. The full history, per-change rationale and the
measurements behind each fix live in [OMP.md](OMP.md) - read the relevant
section before changing behaviour, and add a section when you change it.

## Layout

| path | what it is |
|---|---|
| `web/` | frontend: xterm.js plus local canvas/image addons, hand-written `app.js`/`style.css`/`index.html` |
| `omp-web-entry` | supervises Caddy, ttyd and `omp-web-upload`; any child exiting fails the appliance |
| `omp-web-upload` | Python service: `/upload`, `/presence`, `/history*`, `/windows*` |
| `omp-launcher` | TUI that lists, attaches to and creates tmux windows |
| `tmux.conf` | server config - the host server runs `tmux -f` on this very file |
| `Caddyfile` | `/upload*`, `/presence*`, `/history*`, `/windows*` -> service; `/t/*` -> ttyd |
| `tests/` | `python3 -m unittest discover -s tests` |
| `deploy/` | quadlets: `omp-web-rebuild-host.container` is production, `omp-web-tmux.service` owns the tmux server |

**Runtime is the worktree, not the image.** `OMP_WEB_ROOT` points at this
directory, so a frontend edit is live on reload - but the service, launcher and
`tmux.conf` are read by already-running processes, so those need a rebuild *and*
a container restart (or `tmux source-file` for tmux itself).

## Deploy

On the **host** (`host_run` tool, not the container shell):

```sh
podman build -t localhost/omp-web-rebuild:18.3.2-N .
# bump Image= in BOTH deploy/*.container files first, then:
cp deploy/omp-web-rebuild-host.container ~/.config/containers/systemd/
systemctl --user daemon-reload && systemctl --user restart omp-web-rebuild-host.service
```

Then confirm the restart disturbed no host process - the tmux server is shared
with the user's live sessions:

```sh
tmux -S ~/.omp/run/host-tmux/default list-panes -a -F '#{pane_id} #{pane_pid}'   # before / after
podman exec omp-web-rebuild-host sh -c 'cd /opt/omp-web && sha256sum <changed files>'
```

## Invariants that are easy to break

- **Arrow keys must be SS3** (`\x1bOA`). Both terminfo entries in this stack
  (`xterm-256color` for the client, `tmux-256color` for the pane) declare
  `kcuu1=\EOA`, and tmux parses client input against the former. CSI is passed
  through untouched and types `[A` into the shell.
- **tmux's status line is deliberately off.** The frontend draws the window bar
  from `/windows`. Re-enabling `status` costs a row and duplicates the bar.
- **Inline images need all three layers**: `@xterm/addon-image` (SIXEL + iTerm2),
  `allow-passthrough on` in `tmux.conf`, and `PI_FORCE_IMAGE_PROTOCOL=sixel` +
  `PI_ALLOW_SIXEL_PASSTHROUGH=1` on the pane. The launcher passes those with
  `tmux -e`, because panes inherit the *server's* environment, never the creating
  client's.
- **Clipboard writes need a user gesture**, and WebKit honours one only inside
  the task that started it - so copy paths run the synchronous
  `execCommand('copy')` first, never after an `await`. Safari has no
  `navigator.clipboard.read()` at all: clipboard images arrive through the
  `paste` event, iPhone reaches them only via Attach.
- **Uploads**: reserve the name with `open(path, 'xb')` (check-then-open races),
  and strip exactly the framing CRLF from multipart parts. Body reads are
  bounded; a partial file is deleted on failure.
- **Never build a shell command from a request.** tmux targets are validated
  against `WINDOW_RE` and passed as argv.

## Verifying

Exercise the real surface, not only the tests: drive the deployed page in
Chromium (the `browser` tool, CDP at `http://100.73.84.116:9223`), read tmux
state with `-S ~/.omp/run/host-tmux/default`, and use scratch sessions/windows
for anything that mutates state - never the user's live windows. Clean up the
scratch sessions, test uploads (`~/.omp/uploads`) and browser tabs afterwards.

## Repo

This directory is a git **worktree** of an archived repository: the main repo
lives at `~/.containers-arc/omp-web` and this directory's `.git` file points into
it. If git says "not a git repository", the parent moved - run
`git -C ~/.containers-arc/omp-web worktree repair <this directory>`.

The working branch is `rebuild/from-scratch`, an orphan branch that shares no
history with `main` (the legacy implementation, still archived rather than
deleted). Push it to `origin` after committing; it was local-only for a while
and only survived a directory move by luck.
