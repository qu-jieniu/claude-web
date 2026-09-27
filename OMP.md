# omp-web

Persistent omp terminals in a browser, rebuilt independently on the orphan branch
`rebuild/from-scratch`. The old working tree and production service are not part
of this branch and are not modified by its preview deployment.

## Architecture

```text
Browser: direct xterm DOM terminal
  HTTP /                     -> Caddy -> web/
  WebSocket /t/ws + /t/token  -> Caddy -> ttyd -> omp-launcher -> tmux -> omp/bash
  HTTP /composer/*           -> Caddy -> Python -> private Unix socket -> omp extension
Local terminal                         -> omp-launcher -> same tmux server
```

There is no iframe, session publisher, polling title watcher, patched WebSocket
constructor, custom terminfo, or copied host binary. The frontend speaks ttyd's
binary protocol directly. Its current stable tmux window ID supplies every
reconnect URL. xterm and fit-addon assets are local, not fetched from a CDN.

`omp-web-entry` supervises ttyd, Caddy and the loopback composer HTTP service.
Unexpected exit of any child stops its siblings and fails the appliance.
SIGTERM/SIGINT stops all three normally. Browser PTYs do not inherit a parent
tmux client identity. Native runs bind loopback by default; the image binds all
container interfaces for Podman forwarding. The image is Linux x86-64.

## Build and isolated preview

```sh
podman build -t localhost/omp-web-rebuild:18.3.2-7 .
podman run --rm -it --name omp-web-rebuild \
  -p 127.0.0.1:17685:8080 \
  -v omp-web-rebuild-home:/root \
  localhost/omp-web-rebuild:18.3.2-7
```

Open `http://127.0.0.1:17685/`. For a remote host, use an SSH tunnel, for example
`ssh -N -L 17685:127.0.0.1:17685 HOST`. The named volume keeps configuration,
authentication and saved sessions; it does not keep container-local processes
alive across container removal/restart. Authenticate using omp's `/login` when
needed. The image includes the real standalone omp executable, not a placeholder.

For a persistent isolated user service, install
`deploy/omp-web-rebuild.container` into `~/.config/containers/systemd/`, then run
`systemctl --user daemon-reload` and `systemctl --user start omp-web-rebuild`.
This unit has its own name, image, port and home volume. It does not replace
`omp-web.service`. Stop the foreground preview before starting it on the same port.

Pinned application inputs: omp 18.3.2, tmux 3.5a, ttyd 1.7.7, xterm 5.5.0,
fit-addon 0.10.0. Release archives/binary have SHA-256 checks; npm's lockfile
checks package integrity. Fedora 44 is the base; distro dependencies float to
build-day versions. Increment the image rebuild suffix after source changes.
Images are not published or promoted to production automatically.

## Native development

Requires Python 3, tmux 3.5a, ttyd 1.7.7, Caddy, bash and omp on PATH;
Node/npm is only needed to prepare static assets. `less` supplies the transcript
pager; `screen` is optional for attaching existing legacy sessions.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
OMP_TMUX_SOCKET=/tmp/omp-web-preview.sock \
  ./omp-web-entry --root "$PWD" --http-port 17685 --terminal-port 17682
```

Do not share a test socket or session directory with production. Available
settings:

| Setting | Default / meaning |
|---|---|
| `OMP_WEB_ROOT` / `--root` | `/opt/omp-web`; absolute application root |
| `OMP_HTTP_PORT` / `--http-port` | `8080`; complete HTTP front |
| `OMP_TERMINAL_PORT` / `--terminal-port` | `7682`; ttyd transport |
| `OMP_COMPOSER_PORT` / `--composer-port` | `7683`; loopback-only composer HTTP adapter |
| `OMP_COMPOSER_DIR` | `~/.omp/run/web-composer`; private IPC directory, shared at the same absolute path with host omp |
| `OMP_BIND_ADDRESS` / `--bind` | native `127.0.0.1`, image `0.0.0.0` |
| `OMP_TMUX_SOCKET` | explicit socket path; unset uses normal tmux discovery |
| `OMP_TMUX_SESSION` | `1`; session for newly created windows |
| `OMP_SESSION_DIR` | `~/.omp/agent/sessions`; custom storage is passed to omp |

Run `./omp-launcher` directly in a local terminal, or source `omp-web.sh` for
`omp-attach`. The shell integration uses `OMP_WEB_ROOT` when explicitly set,
otherwise the directory containing the sourced integration file.

## Sessions and keyboard controls

The picker groups live/dead tmux windows by session, followed by existing legacy
screen sessions. Numeric entries are gapless. `s` creates a shell, `t` attaches
raw tmux, `w`/`n` creates an omp window, `p` resumes a saved session, `q` exits.
Paths support Tab completion and confirmed directory creation. Names are
sanitized and deduplicated. Auto-approval is an explicit default-no prompt.
Paths and arguments are not interpolated into shell source.

New omp windows use `omp -c --allow-home --config omp-config.yml`. The per-run
overlay enables mouse input and preserves native scrollback on resize; it does
not rewrite the user's configuration. A clean omp exit returns to bash in the
same window. Failed processes remain as dead panes for recovery.

Saved-session discovery reads JSONL headers for actual cwd/UUID and names, not
lossy directory names. Missing projects are excluded. Resume accepts a listed
project/session or an unambiguous UUID prefix. A matching live launch command
selects its exact pane; otherwise a dead pane in the project is revived without
force-killing a newly revived process, or a new window is created. A fresh
`omp -c` process without a UUID in its launch command cannot be deduplicated this
way.

New servers load `tmux.conf`; existing servers retain their configuration.
The supplied configuration uses Ctrl-a as prefix, top clickable window tabs,
UTF-8, mouse input, smallest-client sizing, and 100,000 history lines:

- `Ctrl-a d`: detach back to the picker.
- `Ctrl-a n/p`: next/previous window; click the tmux tabs to switch.
- `Ctrl-a c`: new omp window in the current project; `Ctrl-a C`: plain bash.
- `Ctrl-a R`: revive a dead pane using its original command.
- `Ctrl-a [`: copy mode; `/` or `?` searches; Esc/q/Enter exits.
- `Ctrl-a j`: readable transcript snapshot in a popup.

Normal-screen wheel/touch scrolling enters tmux copy mode, not shell command
history. Alternate-screen applications receive mouse wheels themselves.
Copy-mode entry anchors the cursor to the top reading line unless a selection
exists. Selections keep their own anchor; width changes still reflow text.
Dragging in copy mode copies via OSC52 without exiting; browser-native selection
is available with xterm's platform selection modifier.

`?arg=tmux-N` attaches stable window `@N`, `?arg=tmux` attaches raw tmux, and a
legacy screen suffix attaches an existing `omp-SUFFIX` screen only. Invalid or
stale targets return to the picker. Titles synchronize window IDs to the URL;
reload, network reconnection, and browser Back/Forward use that ID. Returning
to the picker clears the argument. Closing a browser client detaches it rather
than killing its tmux window.

## Mobile and clipboard

The direct terminal has one layout owner. Safe areas, the connection bar and
coarse-pointer keybar are subtracted from the keyboard-aware available height.
Pinch zoom preserves layout columns; keyboard height updates are not suspended
while zoomed. Touch pointer capture survives xterm row redraws. Multi-touch is
reserved for native pinch zoom, and a swipe does not synthesize a terminal click.

The horizontally scrollable 44px keybar supplies Esc, Tab, arrows, Ctrl-C/D/L,
Ctrl-a prefix, Detach and Paste. Arrows respect application cursor mode. Paste
uses xterm's bracketed-paste support; clipboard denial opens a native-paste dialog.
Cancel sends nothing. OSC52 clipboard queries are ignored, UTF-8 writes are
supported, and refused copy permission produces a visible notice.

## Transcript tools

`omp-jsonl-pretty [--width N] FILE.jsonl` streams a readable transcript, including
string/array assistant content and tool/thinking blocks. Malformed records are
skipped. Terminal escape/control sequences are removed before output.

`omp-jsonl-view [FILE.jsonl | --cwd PROJECT] [--popup]` uses real header cwd to
select the newest matching JSONL by modification time, creates a snapshot, and
opens `less`. It is not a live stream and may not be the active conversation if
several sessions share one cwd. Explicit filenames avoid that ambiguity.

## Host integration and security

An authenticated or tailnet-restricted HTTPS reverse proxy can route the entire
origin to the image's port 8080. For the separate-port homelab contract, route
`/t/*` to 7682 and serve this branch's built `web/` at `/`; do not mix old static
assets with this launcher. Preserve the original Host header for ttyd origin
checks. Caddy's internal front does this automatically.

This is a writable terminal, not an authentication service. Origin checks are
not authentication. Publish only on loopback behind access control. Do not expose
the preview port publicly. Clipboard support outside localhost requires HTTPS.

Sharing host tmux requires a matching client version and a socket-directory mount
(not just the socket file). Mount projects/home at the same absolute paths, set
HOME appropriately, and make this branch's absolute application root visible on
both sides for the config overlay and popup executable. Host panes run the
host's omp. Sharing the default host socket does not replace its tmux settings;
use a dedicated server for the clean configuration, or explicitly migrate the
host configuration during cutover. Host tmux survives an appliance restart;
container-local tmux does not. User-systemd/bus mounts are optional and grant
host-user command execution; they are not a security boundary.

## Verification and history

2026-09-27: initial independent implementation; removed iframe integration and
rebuilt the frontend, launcher, viewer, tmux defaults and appliance supervision.

`python3 -m unittest discover -s tests -v`: four behavior regressions cover control
sequence sanitization, malformed-event recovery, header-based cwd selection, and
refusing to display unrelated sessions.

The final `localhost/omp-web-rebuild:18.3.2-2` image built and launched its pinned
omp binary in Chromium. Killing ttyd made the supervisor reap Caddy and exit 1;
a normal stop exited 0. A foreign-Origin WebSocket handshake was rejected by
ttyd (Caddy surfaces the upstream rejection as 502). A fresh isolated home has
no provider credentials until `/login` or API-key configuration.

Observed smoke checks: real omp startup, shell command execution, clickable tmux
tabs, reload and reconnect restoration, native service outage/reconnection, and
narrow 320px layout. On a physical Moto G7 Play / Android 15 WebView, swiping moved
back 28 history lines and forward 27; keyboard open/close changed 31 -> 15 -> 31
rows while keeping `PHONE_HISTORY_0194` at the top. Phone paste was executed by
the real shell and produced the expected file content. Physical iOS, other
Android keyboards, and screen-reader use remain unverified. No model request
was sent during smoke testing.

### Phone selection update

The first phone keybar button, **Select text**, opens a frozen copy of the visible
terminal in a read-only native text area. Long-press a word and adjust the native
selection, then tap **Copy**; **Select all** selects the complete snapshot.
Close and scroll the terminal before opening another snapshot to copy older text.
Copy attempts a gesture-bound browser copy first, so plain HTTP can work without
the secure-context Clipboard API; the native copy menu remains the fallback.
Verified on the physical Android device: long-press selected `persistent`, and
both partial-selection and Select-all copy commands reported success.
Image `localhost/omp-web-rebuild:18.3.2-3` includes this update.

### Host-connected preview

The initial `omp-web-rebuild-host-preview.service` exposed the host-connected
preview at `http://100.73.84.116:17688/` on all IPv4 interfaces at the user's
request. The domain cutover below replaces it with a persistent, loopback-only
upstream. The isolated preview on 17685 remains alive with its own home volume;
its running omp/shell processes were not stopped for this integration.

The host home is mounted at `/home/jieniu`, including the existing auth database,
config, extensions, projects and saved sessions. Credentials are shared in place,
not copied or logged. The tmux socket directory maps `/tmp/tmux-1000` to
`/tmp/tmux-0`; the launcher explicitly uses `/tmp/tmux-0/default`.
Both client and server are tmux 3.5a. New shell/omp windows therefore run on the
host, using the host's omp and configuration. The new launcher's per-run terminal
overlay still applies to newly launched omp processes. Existing panes and host
tmux configuration are untouched. User-systemd and bus mounts enable the
existing host-bridge integration.

`OMP_WEB_ROOT` points to this shared worktree, so the host and container resolve
the same launcher, overlay, frontend and viewer. Run `npm ci && npm run build`
when recreating the worktree: its generated `web/vendor/` must exist.

`deploy/omp-web-rebuild-host.container` records the persistent host deployment.
It is installed at `~/.config/containers/systemd/omp-web-rebuild-host.container`;
`omp-web-rebuild-host.service` starts with the lingering user manager's default
target. The old transient host preview is stopped. Adapt paths and UID before
using another host.

Verified: browser picker lists the existing host session; a new browser-created
shell ran as host UID 1000 outside the container; systemd bridge also returned
UID 1000; mounted config/auth files had identical host/container inode numbers;
eight auth records were visible without reading credential values. The eight
pre-existing pane PIDs remained unchanged. Only the temporary verification
shell window was removed. No provider API request was made.

### Connection bar

The connection bar is hidden while connected, giving its height back to the
terminal. It appears during connection/reconnection or failure with the manual
Reconnect action. Verified with a real WebSocket close: hidden while connected,
visible on disconnect, hidden again after automatic reconnect. Explicit grid
rows keep the mobile keybar below the terminal when the header is hidden.
Image `localhost/omp-web-rebuild:18.3.2-4` includes this behavior.

### Phone toolbar order

Image `18.3.2-5` prioritizes Select, Paste, Esc, Ctrl-C and Tab, followed by the
four arrows, Ctrl-A, Ctrl-L, Detach and Ctrl-D. The visible Select label is
shorter; its accessible label remains Select terminal text. The first five
actions fit the measured 360px Android viewport without horizontal scrolling.

### Local prompt composer

Image `localhost/omp-web-rebuild:18.3.2-7` adds **Compose** on desktop and phone.
Typing, multiline Enter, selection and IME composition happen in a native browser
textarea, without a terminal round trip. **Send to OMP** submits plain prompt text
through an extension API, never paste-plus-Enter. Terminal slash commands still
belong in the terminal.

The draft is pinned to its original window, pane and omp session. **Retarget**
explicitly changes that destination; **Check** refreshes readiness. Shells,
unbridged sessions, copy mode, busy omp, and nonempty terminal editors reject Send.
Switching the active pane or session invalidates the old target.

Only a matching omp message acknowledgement clears the draft. Hiding the panel,
submission errors and WebSocket reconnects retain it. An uncertain result says
to check the conversation before deliberately sending again; reconnect never
retries a POST. Drafts live in page memory, not localStorage: reloading or closing
the browser page discards them. The private SQLite ledger stores request hashes
and outcomes, not prompt text, and prevents replay of the same request ID across
adapter restarts. HTTP Origin checks are not authentication.

New omp processes launched by the rebuilt launcher load
`omp-web-composer-bridge.ts` explicitly. Existing host omp/tmux processes are
untouched and show Send unavailable. Omp 18.3.2 cannot hot-load this extension:
`/reload-plugins` does **not** enable it. When convenient, exit the old omp
process and resume its saved conversation with the rebuilt launcher's **Resume**
action, or from the same project directory:

```sh
omp -c --allow-home \
  --extension /home/jieniu/.containers/omp-web-rebuild/omp-web-composer-bridge.ts
```

Use `--resume SESSION_ID` instead of `-c` to select an exact saved conversation.
Do not run two processes against the same saved session simultaneously. No global
extension configuration is changed. Existing host tmux key bindings are also
untouched; use the rebuilt launcher rather than an old binding to enable Compose.

The host-connected preview on 17688 runs the composer-enabled image. Its web
container restart preserved all eight pre-existing host pane PIDs. The isolated
17685 container was not restarted; its next start uses the new image.

Verified in the deployed host-connected browser: a multiline prompt produced
`DEPLOYED_COMPOSER_OK`; matching HTTP acknowledgement cleared the draft; replaying
the accepted request did not add another message. Copy mode, a terminal draft,
an active shell pane and a foreign Origin rejected submission. Aborting a POST
retained the draft with an uncertain-delivery warning; closing and reopening the
panel and disconnecting/reconnecting its real WebSocket did not resend it.
Phone-size Chromium layout was observed; physical-phone IME behavior for this
new composer remains unverified. The real-model smoke used the configured account:
the first local-model attempt returned 401 and omp switched to its configured
fallback; the deployed smoke explicitly used that account-backed model.

### Domain cutover

`https://omp.jieniuu8.com/` now serves the rebuilt app through the host Caddy
reverse proxy to `127.0.0.1:17688`. The upstream is loopback-only, preventing
direct network access from bypassing the vhost's configured Tailscale-only rule.
The persistent quadlet uses image `18.3.2-7` and the existing shared host mounts.
The legacy `omp-web.service` remains running unchanged at
`http://127.0.0.1:7685/` (its ttyd transport remains `127.0.0.1:7682`).
No host omp or tmux process was restarted.

The editable proxy source `~/caddy/Caddyfile` is updated. The live route was
switched through Caddy's scoped admin API with an ETag precondition, without
changing unrelated vhosts. **Privileged persistence is still required:**

```sh
sudo ~/caddy/deploy.sh
```

That command copies the source to root-owned `/etc/caddy/Caddyfile`, regenerates
the dashboard, and reloads Caddy. Noninteractive sudo authentication was not
available during cutover. Until this step completes, a Caddy restart or reload
from `/etc/caddy/Caddyfile` restores the old route; its system unit does not use
`--resume`. The dashboard link itself remains `https://omp.jieniuu8.com/`.

Verified through the real HTTPS hostname: secure browser context, connected
terminal WebSocket, launcher menu, multiline local composer, and composer API.
The non-tailnet loopback HTTPS path returned 403. The legacy localhost app
returned 200, both legacy port mappings remained loopback-only, and all eight
pre-existing host pane PIDs were unchanged.
