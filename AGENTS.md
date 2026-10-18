# omp-web (rebuild)

Persistent omp terminals in a browser: ttyd + tmux behind Caddy, served at
`https://omp.jieniuu8.com/`. The full history, per-change rationale and the
measurements behind each fix live in [OMP.md](OMP.md) - read the relevant
section before changing behaviour, and add a section when you change it.

## Layout

| path | what it is |
|---|---|
| `web/` | frontend: direct xterm.js/WebSocket client plus local canvas/image addons; app-specific `app.js`/`style.css`/`index.html` consume the host-served shared terminal shell |
| `omp-web-entry` | supervises Caddy, ttyd and `omp-web-upload`; any child exiting fails the appliance |
| `omp-web-upload` | Python service: `/upload`, `/presence`, `/history*`, `/windows*` |
| `omp-launcher` | TUI that lists, attaches to and creates tmux windows |
| `tmux.conf` | server config - the host server runs `tmux -f` on this very file |
| `Caddyfile` | `/upload*`, `/presence*`, `/history*`, `/windows*` -> service; `/t/*` -> ttyd |
| `tests/` | `python3 -m unittest discover -s tests` |
| `deploy/` | quadlets: `omp-web-host.container` is production, `omp-web-tmux.service` owns the tmux server |

**Runtime is the worktree, not the image.** `OMP_WEB_ROOT` points at this
directory, so a frontend edit is live on reload - but the service, launcher and
`tmux.conf` are read by already-running processes, so those need a rebuild *and*
a container restart (or `tmux source-file` for tmux itself).

## Deploy

On the **host** (`host_run` tool, not the container shell):

```sh
podman build -t localhost/omp-web:18.3.2-N .
# bump Image= in BOTH deploy/*.container files first, then:
cp deploy/omp-web-host.container ~/.config/containers/systemd/
systemctl --user daemon-reload && systemctl --user restart omp-web-host.service
```

Then confirm the restart disturbed no host process - the tmux server is shared
with the user's live sessions:

```sh
tmux -S ~/.omp/run/host-tmux/default list-panes -a -F '#{pane_id} #{pane_pid}'   # before / after
podman exec omp-web-host sh -c 'cd /opt/omp-web && sha256sum <changed files>'
```

## Invariants that are easy to break

- **Arrow keys must be SS3** (`\x1bOA`). Both terminfo entries in this stack
  (`xterm-256color` for the client, `tmux-256color` for the pane) declare
  `kcuu1=\EOA`, and tmux parses client input against the former. CSI is passed
  through untouched and types `[A` into the shell.
- **tmux's status line is deliberately off.** The frontend draws the window bar
  from `/windows`. Re-enabling `status` costs a row and duplicates the bar. The
  bar stays active and visible even in detached mode (`currentArg === null`),
  where tapping any window tab attaches directly to that session (`connect(true)`).
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
- **Shared controls are transport-neutral.** Host Caddy serves
  `~/.containers/terminal-common/terminal-shell.{js,css}` on this origin. The
  shell owns the baseline keybar, clipboard fallback, plain-drag local selection
  with gesture-bound auto-copy and success feedback, notices, font zoom and
  resize triggers; `web/app.js` keeps xterm construction, socket flow control,
  pixel-size reporting, tmux windows, history, composer, uploads and artifacts.
  The local adapter must preserve stationary mouse clicks and wheel reports.
  Do not move transport or wheel/touch copy-mode behavior into the shell.
- **Uploads**: reserve the name with `open(path, 'xb')` (check-then-open races),
  and strip exactly the framing CRLF from multipart parts. Body reads are
  bounded; a partial file is deleted on failure.
- **Never build a shell command from a request.** tmux targets are validated
  against `WINDOW_RE` and passed as argv.
- **Resize scrollback is `preserve`; transcript reflow is on-demand via `Reflow` (`Alt-L`).**
  Automatic `rebuild` erases and replays the transcript on every settled resize,
  churning tmux scrollback with duplicate history blocks during mobile software keyboard
  open/close (height changes). An explicit `Reflow` button in `#service-bar` emits `Alt-L`
  (`\x1bl`), issuing `ED2+ED3` to clear tmux scrollback and replay all markdown tables and
  prose rewrapped at current width. `tmux.conf` binds `M-l` in copy-mode to cancel copy-mode
  and forward `M-l`.
- **Never send `\x0c` (`Ctrl-L`) for reflow.** In OMP, `Ctrl-L` is mapped to
  `app.live.toggle` (voice listening mode). Reflow exclusively sends `\x1bl` (`Alt-L`).
- **Compose synchronization is non-destructive.** Opening an empty Compose drawer imports
  the live OMP draft using OMP's `Copy prompt` action (`Alt-Shift-C` / OSC 52). `Replace`
  re-verifies the live draft before sending `\x03` (clear) and bracketed-pasting the
  replacement. Drafts with semantic chips or attachments stay in the terminal.
- **Mobile tap-to-focus and iOS Safari blur prevention.** On `touchstart`, if
  `term.textarea` is focused, calling `event.preventDefault()` prevents WebKit from
  executing its default tap blur on non-input elements, keeping the keyboard open.
  Drag threshold is 14px, and pointer capture is deferred until swipe movement begins.
  A clean tap emits SGR mouse click, triggering `MouseDown1Pane` in tmux copy-mode to
  cancel copy-mode and return directly to the live prompt row.
- **Desktop trackpad and wheel scroll speed.** Accumulate `deltaY / lineHeight()` into
  `wheelRemainder` before emitting SGR reports to keep trackpad scrolling 1:1 with finger
  motion without runaway acceleration.
- **Theme is unified to Catppuccin Mocha.** All services share `#1e1e2e` base,
  `#cdd6f4` text, and `#181825` panels. OMP uses `theme.dark: dark-catppuccin` in
  `omp-config.yml`.
- **Two-row toolbar layout.** Row 1 (`#service-bar` / `.terminal-app-actions`) holds
  service actions (`Artifacts`, `Select`, `Attach`, `Compose`, `Reflow`). Row 2
  (`#keybar` / `.terminal-keybar`) holds general terminal keys with `A0` zoom reset,
  prioritizing typing keys (`Esc`, `Enter`, `⌫`, `Tab`, `^C`) on the left. Bottom padding
  uses `max(12px, env(safe-area-inset-bottom, 0px))` for iPhone display corner radii.
## Verifying

Exercise the real surface, not only the tests: drive the deployed page in
Chromium (the `browser` tool, CDP at `http://100.73.84.116:9223`), read tmux
state with `-S ~/.omp/run/host-tmux/default`, and use scratch sessions/windows
for anything that mutates state - never the user's live windows. Clean up the
scratch sessions, test uploads (`~/.omp/uploads`) and browser tabs afterwards.

## Repo

This directory is a git **worktree**. The repository it hangs off is the legacy
project, now archived at `~/.containers-arc/omp-web-screen`, and this directory's
`.git` file points into it. If git says "not a git repository", that parent moved:

```sh
git -C ~/.containers-arc/omp-web-screen worktree repair ~/.containers/omp-web
```

Two branches, both on `origin`:

| branch | what it holds |
|---|---|
| `main` | this implementation (the orphan rebuild, checked out here) |
| `legacy-screen` | the previous ttyd + screen implementation, as it last ran |

They share no history - `main` was created as an orphan branch, and the legacy
tree was recorded on `legacy-screen` when the two were consolidated. Push after
committing.

## Quadlet generation

The deployment units are quadlets, generated by the podman user generator from
`~/.config/containers/systemd/` - a directory of symlinks into each project's
`quadlet/` folder. **A single dangling symlink makes the generator abort and emit
nothing at all**, silently: every quadlet unit then reports `not-found` while its
container keeps running from before, and `systemctl --user daemon-reload` appears
to succeed. Check with:

```sh
rm -rf /tmp/genout && mkdir -p /tmp/genout && /usr/libexec/podman/quadlet -user /tmp/genout; echo exit=$?
ls /tmp/genout | wc -l    # 0 means generation is broken
```
