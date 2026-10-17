# omp-web

Persistent omp terminals in a browser, rebuilt independently on the orphan branch
`main`. The host-connected deployment now serves
`https://omp.jieniuu8.com/` through `127.0.0.1:17688`. The legacy implementation
is archived at `~/.containers-arc/omp-web` (still serving its own
`omp-web.service`, and still the git repository this worktree hangs off); it was
moved there on 2026-10-08, which broke this worktree's `.git` pointer until
`git -C ~/.containers-arc/omp-web worktree repair` was run. The separate 17685
preview uses an isolated home volume.

The domain route is persisted in the host Caddy configuration; see
[Domain cutover](#domain-cutover) for the deployment path and access controls.

**Active persistent deployment:** production runs `18.3.2-65` and attaches to
the native host `omp-web-tmux.service`. OMP and shell processes survive web
container restarts; the browser reconnects to the same tmux window. The
full-history Select dialog and the window-scoped Artifacts window are included.

## Architecture

```text
  HTTP /                              -> Caddy -> web/
  POST /upload, /presence             -> Caddy -> Python service -> ~/.omp/{uploads,web-visible}
  GET/POST /artifacts                 -> Caddy -> same service -> ~/.omp/web-artifacts
  GET  /history, /history/search      -> Caddy -> same service -> tmux capture-pane
  GET  /windows, POST /windows/select -> Caddy -> same service -> tmux list-windows / select-window
  WebSocket /t/ws + /t/token          -> Caddy -> ttyd -> omp-launcher -> tmux -> omp/bash
  Local terminal                      -> omp-launcher -> same tmux server
```

There is no iframe, session publisher, polling title watcher, patched WebSocket
constructor, custom terminfo, or copied host binary. The frontend speaks ttyd's
binary protocol directly. Its current stable tmux window ID supplies every
reconnect URL. xterm and fit-addon assets are local, not fetched from a CDN.

`omp-web-entry` supervises ttyd, Caddy and `omp-web-upload`.
Unexpected exit of either child stops its sibling and fails the appliance.
SIGTERM/SIGINT stops both normally. Browser PTYs do not inherit a parent
tmux client identity. Native runs bind loopback by default; the image binds all
container interfaces for Podman forwarding. The image is Linux x86-64.

## Build and isolated preview

```sh
podman build -t localhost/omp-web:18.3.2-65 .
podman run --rm -it --name omp-web-preview \
  -p 127.0.0.1:17685:8080 \
  -v omp-web-home:/root \
  localhost/omp-web:18.3.2-65
```

Open `http://127.0.0.1:17685/`. For a remote host, use an SSH tunnel, for example
`ssh -N -L 17685:127.0.0.1:17685 HOST`. The named volume keeps configuration,
authentication and saved sessions; it does not keep container-local processes
alive across container removal/restart. Authenticate using omp's `/login` when
needed. The image includes the real standalone omp executable, not a placeholder.

For a persistent isolated user service, install
`deploy/omp-web-preview.container` into `~/.config/containers/systemd/`, then run
`systemctl --user daemon-reload` and `systemctl --user start omp-web-preview`.
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
| `OMP_BIND_ADDRESS` / `--bind` | native `127.0.0.1`, image `0.0.0.0` |
| `OMP_TMUX_SOCKET` | explicit socket path; unset uses normal tmux discovery |
| `OMP_ARTIFACTS_DIR` | `~/.omp/web-artifacts`; deduplicated terminal-image, upload and agent-download storage |
| `OMP_TMUX_REQUIRE_SERVER` | unset normally; `1` adds tmux `-N`, forbidding automatic server creation |
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

Creating an OMP window asks **Continue** (`omp -c`) or **Start new** (`omp`),
defaulting to new. Invalid answers repeat the question; `q` or Ctrl-C cancels.
Both choices add `--allow-home --config omp-config.yml`. The per-run overlay
enables mouse input and uses OMP's `tui.resizeScrollback: rebuild` mode. After
a settled resize, OMP clears terminal scrollback and replays one transcript at
the current width, so prose and tool-result rows do not retain their old-width
wrapping. Ctrl-a c uses the same chooser in the current project.
The separate **Resume saved session** action still selects an exact saved UUID.

Ordinary shells close their pane on exit, even when the last command failed.
New OMP wrappers enable `remain-on-exit failed` only while OMP runs, preserving
crash output for recovery. A clean OMP exit switches that pane back to
`remain-on-exit off` before opening bash, so the subsequent shell exit also closes
the pane. Closing the last window in a session returns its browser to the picker.

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
- `Ctrl-a c`: choose continue/new OMP in the current project; `Ctrl-a C`: plain bash.
- `Ctrl-a R`: revive a dead pane using its original command.
- `Ctrl-a [`: copy mode; `/` or `?` searches; Esc/q/Enter exits.
- `Ctrl-a j`: readable transcript snapshot in a popup.

Normal-screen wheel/touch scrolling enters tmux copy mode, not shell command
history. Alternate-screen applications receive mouse wheels themselves.
Copy-mode entry anchors the cursor to the top reading line unless a selection
exists. Selections keep their own anchor; width changes still reflow text.
Dragging in copy mode copies via OSC52 without exiting. A plain browser drag is
intercepted before tmux mouse reporting, copied synchronously on release, then
cleared; an unmoved click is replayed to tmux and wheel reports remain
unchanged. This gesture-bound path produces the browser/desktop copy feedback
that asynchronous OSC52 cannot.

Every terminal host pixel-size or device-pixel-ratio change now forces a full
xterm repaint even when the fitted column/row count is unchanged. This prevents
stale DOM row backgrounds and old-scale canvas glyphs after resizing while the
existing ttyd pixel-size report continues to keep tmux geometry synchronized.

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
while zoomed. Zoom is measured as layout width divided by visual-viewport width,
not the raw visual-viewport scale, which also includes Safari's page zoom.
This keeps reduced page-zoom settings from shrinking the application's height
twice. Touch pointer capture survives xterm row redraws. Multi-touch is reserved
for native pinch zoom, and a swipe does not synthesize a terminal click.

Wheel and touch scrolling integrate with tmux copy-mode. A touch drag downward
emits mouse wheel-up reports to tmux, which enters copy-mode with `copy-mode -e`
and moves upward through scrollback. Dragging upward toward the live prompt
emits `scroll-down-and-cancel`, automatically exiting copy-mode when it reaches
the bottom. Tracked events are capped at 15 reports per pointer move; coalesced
overflow remains in the gesture accumulator and is flushed, up to one terminal
height, when the finger lifts. Touch movement scales at 4.5 reports per terminal
row, preserving distance without allowing runaway momentum.

The horizontally scrollable 44px keybar supplies Select, Paste, Attach, Esc, Enter,
Backspace (⌫), Ctrl-C, Tab, arrows (↑, ↓, ←, →), Ctrl-A prefix, Ctrl-L,
Zoom Out (A−), Zoom In (A+), Detach, and Ctrl-D. Buttons feature immediate visual
feedback upon press. All input keys (arrows, Backspace, Tab, Enter, Esc, Ctrl-C,
Ctrl-D, Ctrl-L, A−, A+) support long-press auto-repeat: on touch, holding for
300ms triggers rapid repetition (every 60ms) for fast cursor positioning, deletion,
and continuous font zooming. Swiping to scroll the toolbar (>8px movement)
immediately cancels repeat timers, preventing accidental keypresses while scrolling.
Font zoom buttons (A− / A+) adjust terminal font size between 9px and 32px
(default 14px), immediately refit columns and rows with xterm FitAddon, notify the
server pty/tmux, and persist the user's preferred zoom level in localStorage across
page reloads. Non-repeating modal/toggle actions (Select, Paste, Attach, Ctrl-A prefix,
Detach) fire once per gesture. On touch devices (`any-pointer: coarse`), toolbar
preventing the iPad floating/docked on-screen keyboard from popping open unless
the terminal surface is explicitly tapped or Composer is opened. Arrows respect
application cursor mode. Paste uses xterm's bracketed-paste support; clipboard
denial opens a native-paste dialog. Cancel sends nothing. OSC52 clipboard
queries are ignored, UTF-8 writes are supported, and refused copy permission
produces a visible notice.

### Mobile file attachments

The **Attach** button (available on both the keybar and in Composer actions)
opens the device's native file selection sheet (Photo Library, Take Photo, or
Files app on iOS). Selected files (single or multiple) are uploaded via `POST /upload`
to `~/.omp/uploads/` with unique timestamped filenames.

Upon upload completion:
- If Composer is open, the path(s) are inserted at the cursor: `@/home/jieniu/.omp/uploads/... `
- If Composer is closed, the path(s) are pasted directly into the active terminal prompt.
- A brief confirmation notice appears indicating the uploaded filename and inserted path.
- Files are immediately accessible to OMP for multimodal prompt inspection.
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
origin to the image's port 8080. A split deployment must route `/t/*` to ttyd
on 7682 and serve this branch's built `web/` at `/`. Composer input uses the
same terminal WebSocket as keyboard and clipboard input; no HTTP composer
adapter or OMP extension is needed. Preserve the original Host header for
ttyd's origin checks. Caddy's internal front does this automatically.

This is a writable terminal, not an authentication service. Origin checks are
not authentication. Publish only on loopback behind access control. Do not expose
the preview port publicly. Clipboard support outside localhost requires HTTPS.

Sharing host tmux requires a matching client version and a shared socket
directory, not just a socket-file mount. A shared pathname alone does **not**
make the server host-owned: a container client can otherwise start its own
server there when the host server is absent.

The host deployment uses `omp-web-tmux.service`, a native user-systemd service
running tmux 3.5a in foreground mode. Its private socket is
`~/.omp/run/host-tmux/default`, visible at the same absolute path through the
home mount. `OMP_TMUX_REQUIRE_SERVER=1` makes the appliance fail closed if that
server is unavailable. Restarting the web appliance does not restart this
service or its panes; restarting the tmux service does terminate its sessions.
The tmux user service is enabled and user lingering is enabled, so logging out
does not stop the server. A host reboot still terminates live processes; saved
OMP conversations remain under `~/.omp/agent/sessions` and can be resumed.

Mount projects/home at the same absolute paths, set HOME appropriately, and
make this branch's absolute application root visible on both sides for the
config overlay and popup executable. User-systemd/bus mounts grant host-user
command execution; they are not a security boundary.

## Verification and history

2026-09-27: initial independent implementation; removed iframe integration and
rebuilt the frontend, launcher, viewer, tmux defaults and appliance supervision.

`python3 -m unittest discover -s tests -v`: four behavior regressions cover control
sequence sanitization, malformed-event recovery, header-based cwd selection, and
refusing to display unrelated sessions.

The final `localhost/omp-web:18.3.2-2` image built and launched its pinned
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
Image `localhost/omp-web:18.3.2-3` includes this update.

### Host-connected preview

The initial `omp-web-rebuild-host-preview.service` exposed the host-connected
preview at `http://100.73.84.116:17688/` on all IPv4 interfaces at the user's
request. The domain cutover below replaces it with a persistent, loopback-only
upstream. The isolated preview on 17685 remains alive with its own home volume;
its running omp/shell processes were not stopped for this integration.

The host home is mounted at `/home/jieniu`, including the existing auth database,
config, extensions, projects and saved sessions. Credentials are shared in place,
not copied or logged. The original integration mapped `/tmp/tmux-1000` to
`/tmp/tmux-0` and used `/tmp/tmux-0/default`. It ran host processes only while
a host-owned server already existed. Later container-local fallback creation
caused the unexpected-exit defect documented below.

The `18.3.2-9` unit instead requires the dedicated host tmux service and uses
`/home/jieniu/.omp/run/host-tmux/default`. Both client and server are tmux 3.5a.
New panes on this server run the host's omp and configuration; the per-run
terminal overlay still applies. Existing panes are not migrated or restarted.
User-systemd and bus mounts enable the existing host-bridge integration.

`OMP_WEB_ROOT` points to this shared worktree, so the host and container resolve
the same launcher, overlay, frontend and viewer. Run `npm ci && npm run build`
when recreating the worktree: its generated `web/vendor/` must exist.

`deploy/omp-web-host.container` records the appliance deployment;
`deploy/omp-web-tmux.service` owns the persistent host server. Install them into
`~/.config/containers/systemd/` and `~/.config/systemd/user/`, respectively,
then run `systemctl --user daemon-reload` and
`systemctl --user enable --now omp-web-tmux.service`. Start the appliance with
`systemctl --user start omp-web-host.service`. Both start with the
lingering user manager's default target. Adapt paths and UID for another host.
The old transient host preview is stopped.

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
Image `localhost/omp-web:18.3.2-4` includes this behavior.

### Phone toolbar order

Image `18.3.2-5` prioritizes Select, Paste, Esc, Ctrl-C and Tab, followed by the
four arrows, Ctrl-A, Ctrl-L, Detach and Ctrl-D. The visible Select label is
shorter; its accessible label remains Select terminal text. The first five
actions fit the measured 360px Android viewport without horizontal scrolling.

### Local paste composer (`18.3.2-10`)

**Compose** opens a compact native textarea on desktop and phone. Typing,
multiline Enter, selection and IME composition remain local until **Paste**.
There are no action modes, readiness checks, or target selection.

**Paste** uses the same xterm paste path as clipboard paste, inserting at the
current terminal cursor. It neither interprets slash commands nor adds Enter.
OMP, shells, selectors and the launcher receive normal terminal input. Existing
input can combine with the pasted text. Bracketed paste follows the application's
terminal mode; applications without bracketed-paste support may interpret
embedded newlines as commands. Inspect the terminal before pasting sensitive text.

After transmission the panel clears and closes, releasing screen space and
textarea focus. Use the terminal's **Enter** key when ready to submit. Closing
without pasting retains the draft. Disconnect disables Paste, preserves the
draft and never triggers a resend. WebSocket transmission is not an application
acknowledgement. Reloading or closing the page discards the in-memory draft.

The panel is 121px tall at the measured 390×440 keyboard-height viewport, down
from 264px. The terminal grows from 121px to 264px with Compose open and to 385px
when closed. Textarea text scrolls instead of growing the panel. The grid has an
explicit shrinkable column and terminal row; safe-area and visual-viewport
handling remain enabled.

The old HTTP adapter, OMP bridge, action-mode UI and their adapter-specific tests
were removed. New OMP launches no longer load an extension; existing OMP processes
need no restart for paste. Only the obsolete Ctrl-a c extension argument was
removed from the current and dedicated host tmux servers' bindings; neither
server nor any conversation was restarted during that change. The subsequent
production rollout removed the legacy adapter process as well.

The deployment on 17688 runs `18.3.2-20` with host-owned tmux sessions. Its
original composer rollout preserved eight then-host-owned panes, but a later
container-local fallback did not survive restart; the active host service
and required-server guard now prevent that fallback.
The isolated 17685 container was not restarted and still runs image `18.3.2-2` under the
transient `omp-web-rebuild-preview.service`, publishing `0.0.0.0:17685`.
The isolated quadlet checked into this tree selects `18.3.2-20` and loopback
binding, but is not installed on this host. The running preview has no
application authentication and should not be exposed to untrusted networks.
Installing the checked-in quadlet requires stopping the transient preview
first to release the container name and port; simply restarting the transient
service does not adopt the checked-in image or bindings.

Initial `18.3.2-7` verification in the deployed host-connected browser: a multiline prompt produced
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
The installed quadlet selects `18.3.2-9`; the currently running appliance remains
on `18.3.2-8` until the deferred lifetime-fix activation below.
The legacy `omp-web.service` remains running unchanged at
`http://127.0.0.1:7685/` (its ttyd transport remains `127.0.0.1:7682`).
No host omp or tmux process was restarted.

The live route was initially switched through Caddy's scoped admin API with an
ETag precondition, without changing unrelated vhosts. Final review confirmed
that the editable source `~/caddy/Caddyfile` and root-owned
`/etc/caddy/Caddyfile` are now byte-identical and both route this hostname to
`127.0.0.1:17688`. The earlier privileged-persistence blocker is resolved.
For future proxy changes, use:

```sh
~/caddy/deploy.sh
```

That command copies the source to `/etc/caddy/Caddyfile`, regenerates the
dashboard, and reloads Caddy. The dashboard link remains
`https://omp.jieniuu8.com/`.

Verified through the real HTTPS hostname: secure browser context, connected
terminal WebSocket, launcher menu, multiline local composer, and composer API.
The non-tailnet loopback HTTPS path returned 403. The legacy localhost app
returned 200, both legacy port mappings remained loopback-only, and all eight
pre-existing host pane PIDs were unchanged.

### Final documentation and implementation review

Rechecked the deployed HTTPS app in Chromium: the launcher connected, the
composer refused Send without a selected OMP target, and a multiline draft
survived hiding and reopening the panel. Desktop and 360px layouts were
observed. All four transcript regressions passed. Host probes returned 200
through the tailnet HTTPS route and 403 through non-tailnet loopback HTTPS;
the legacy localhost app returned 200. No model prompt was submitted, and no
service or existing host pane was restarted during this review.

Findings from that review:

- Resolved in `18.3.2-8`: composer prompts now use user-role delivery instead of
  custom messages that OMP converted to developer-role instructions.
- Resolved in `18.3.2-8`: explicit terminal keybar and paste actions work while
  the composer retains focus; local draft typing still stays out of the terminal.
- The isolated transient preview remains unauthenticated on all IPv4 interfaces
  at 17685; its tailnet HTTP endpoint returned 200 without authentication.
  The production hostname's access rule does not protect that separate port.
  External Internet reachability was not tested.

### Composer actions and faster scrolling (`18.3.2-8`)

Real OMP 18.3.2 smoke in a separate tmux server verified Send, active Queue,
active Steer, and idle Queue. Persisted conversation records contained user-role
messages, including `steering: true` for steering; assistant replies included
`COMPOSER_USER_OK`, `STEERED_OK`, `QUEUED_OK` and `IDLE_QUEUE_OK`.
These checks made real model requests using the configured account.

Native `/model` opened a selector and blocked further composer actions until
Esc closed it. In touch-emulated Chromium, the Esc keybar action emitted terminal
input while the composer kept focus and its unsent draft remained intact.
The shell Run action created a file containing `SHELL_COMPOSER_OK`.

Scrolling proof: one tracked wheel event emitted three terminal mouse reports
and entered tmux copy mode seven lines back; a 100px touch swipe then moved
54 more history lines. A one-line untracked wheel event moved local xterm
history three lines. Physical-phone behavior for this update remains unverified.

The four transcript regressions and five new isolated-tmux shell regressions
passed. Shell checks cover paste without execution (including multiline paste
with Bash mode announcements disabled), multiline Run and replay deduplication,
control-sequence rejection, stale targets and foreground jobs.

### Persistent host server (`18.3.2-9`)

The unexpected OMP exits were caused by web-service restarts killing a
container-local tmux server and its OMP children. The journal's restart times
matched the interrupted `host_run` call; `podman top` showed both tmux and
the conversation's OMP process inside `omp-web-rebuild-host`. The socket's
host-directory mount had hidden the lifetime mismatch.

The new native `omp-web-tmux.service` is installed, enabled and running.
Its `tmux -D` process is a direct child of the host user manager and stays alive
even with no windows. The new appliance unit requires it and sets
`OMP_TMUX_REQUIRE_SERVER=1`; missing-server tests confirm that the launcher
does not create a container fallback.

Verified with a separate `18.3.2-9` smoke appliance: host tmux PID 2412485
and OMP PID 2421766 remained unchanged through an appliance restart. Chromium
reconnected to the same session and retained `UNSENT_PERSISTENCE_DRAFT`.
All 11 regression tests passed, including the two server-ownership cases.
No production web container or existing conversation was restarted during
this fix; the user explicitly chose to keep the current session alive.

**Web restarts are now safe for the active host-owned sessions:**

```sh
systemctl --user restart omp-web-host.service
```

Production now uses the dedicated host socket. Browser clients automatically
reconnect after a web-service restart; no OMP exit or Resume action is needed.
Do not restart `omp-web-tmux.service` unless intentionally terminating its live
sessions. After a host reboot, use **Resume** to reopen a saved conversation;
do not run two OMP processes against the same saved conversation.
For local attachment:

```sh
OMP_TMUX_SOCKET="$HOME/.omp/run/host-tmux/default" \
  OMP_TMUX_REQUIRE_SERVER=1 ./omp-launcher
```

Final production check: HTTPS connected to the launcher and the live OMP target
advertised Queue/Steer/Command while busy. All temporary smoke appliances,
their test panes and generated session files were removed. The persistent host
tmux service stayed active with no test windows, and the production container's
start time remained unchanged.

### Compact paste verification (`18.3.2-10`)

The live HTTPS frontend was exercised in Chromium at 390×844, 390×440,
844×390 and 1280×800. There was no horizontal page overflow. With Compose
closed, the portrait terminal measured 789px of the 844px viewport.
The compact panel recovered space in keyboard-height emulation, but did not fix
the subsequently reported iPhone page-zoom defect; see the `18.3.2-11` entry below.
Physical iPhone Safari and its native keyboard/IME were not exercised here.

In an isolated shell pane, a two-line composer paste did not create its output
file until the toolbar's Enter was pressed; the resulting file contained
`one two`. `/model` pasted literally at the shell prompt. In a separate fresh
OMP process, `/model` stayed in the native editor until Enter opened the model
selector. These checks did not submit a model prompt.

A multiline Unicode draft survived hiding/reopening Compose and an offline
disconnect/reconnect. Paste was disabled while disconnected and reconnect did
not submit the draft. The six remaining launcher/transcript regressions passed,
as did the frontend JavaScript syntax check. The new image's supervised isolated
appliance served `/t/token`; temporary panes, generated sessions and smoke
containers were removed afterward. The production container start time remained
`2026-09-27 11:31:28.968522134 -0400 EDT`.

### Reduced page-zoom height (`18.3.2-11`)

The user's `IMG_7535.PNG` and `IMG_7536.PNG` showed the entire page and toolbar
ending halfway down the available area, both with and without the keyboard.
The compact composer was closed. These were retrieved from HDD2 after a
recent-photo iCloud sync; the sync service was not restarted.

Reproduced at 50% scale in Chromium: a 430×932 device had an 860×1864 CSS
viewport, but the old `visualViewport.height * visualViewport.scale` calculation
set the app height to only 932 CSS pixels. The corrected calculation uses
layout-relative pinch zoom and fills all 1864 CSS pixels.

At a simulated 430×450 keyboard-visible area and 50% scale, the app and toolbar
fill 900 CSS pixels. xterm reports 100×52 cells and the real tmux pane 100×51,
accounting for tmux's status line. Pinching to scale 1 preserves those columns
and rows rather than reflowing the terminal. The static fix is served live;
refresh to load it. Physical iPhone verification remains with the user.

### Production restart proof (`18.3.2-12`)

Rebuilt the current sources and installed the resulting numbered image in the
production quadlet. The cache reused the `18.3.2-11` image content, SHA-256
`38c34c292d3da080102262aeb63a3352c2687501ec3769ff4a43dd69dfc2e7eb`.
At this rollout the host service was already active; the prior staged-status
notes no longer described the running deployment.

Restarted `omp-web-host.service` twice. Both times host tmux PID 2644,
the current OMP PID 272051, and test shell PID 284005 retained their original
start times. Both panes remained alive. The HTTPS browser recorded two
disconnected → connecting → connected transitions at the same window URL;
its unsent `UNSENT_RESTART_DRAFT` survived both.

After the second restart, the test shell printed
`AFTER_SECOND_RESTART=HOST_SESSION_SURVIVED` from a variable set before either
restart, proving live shell state persisted rather than a new process being
started. The production `/t/token` endpoint responded successfully. All six
launcher/transcript regressions passed, including fail-closed behavior when
the required tmux server is absent. Host and container tmux are both 3.5a.
The temporary test session was removed; the user's OMP session was untouched.

### Shell exit and OMP creation choice (`18.3.2-13`)

The reported zombie was a plain `/bin/bash -il` pane that exited with status 127.
The global `remain-on-exit failed` policy kept it because a bare shell exit can
inherit the previous command's failure. Shells now default to `off`; new OMP
wrappers opt into `failed` only while OMP is running and reset to `off` before
opening the post-OMP shell. The already-dead shell pane was removed. Existing
OMP processes were left running with the new default; only newly launched
wrappers perform the scoped failure-retention transition.

The picker and Ctrl-a c both ask whether to continue or start fresh, defaulting
to fresh. The shortcut invokes `omp-launcher --new-omp` instead of duplicating
OMP argument construction in tmux configuration. Exact-UUID Resume is unchanged.
Only the exit policy and Ctrl-a c binding were migrated on the live host server;
the server itself was not restarted.

Seven regressions passed, including an actual Bash `false` followed by bare
`exit` disappearing from tmux. An isolated PTY smoke launched real OMP, created
one saved conversation with a short model request, exited cleanly into Bash,
and verified that `false; exit` returned to the picker without a dead pane.
Continue reopened that conversation and its `CHOICE_SAVED_OK` reply; the shortcut's
default New opened an empty editor instead. Invalid choices repeated the prompt,
and cancelling the shortcut closed its temporary pane.

The rebuilt image was deployed and the web service restarted. Existing OMP
PIDs 315319 and 355566 retained their original start times. The HTTPS picker
displayed the new choice and cancellation returned to the menu without creating
a window. All isolated smoke processes and their temporary session files were
removed; no user conversation was deleted or restarted.

### Mobile long-press buttons and Backspace (`18.3.2-14`)

Added a Backspace button (`⌫`, `\x7f`) to the mobile keybar immediately following
Enter, providing one-tap deletion without opening software keyboards.

All terminal input buttons support long-press auto-repeat:
- **Touch hold**: holding a button down for 300ms enters auto-repeat mode at
  60ms intervals (16.7 repeats/sec) until release. Single taps fire upon release
  (<300ms), matching standard touch keyboard responsiveness.
- **Scroll safety**: swiping across the scrollable keybar (>8px displacement)
  cancels any pending timer or active repeat, ensuring horizontal toolbar
  scrolling never triggers accidental keypresses.
- **Desktop mouse**: mouse clicks fire immediately at 0ms and repeat if held.
- **Visual feedback**: pressed keys display an immediate active highlight
  (`#3c4f68` with border `#6d8ba8`) across taps and sustained holds.
- **Non-repeating actions**: modal/stateful buttons (Select, Paste, Ctrl-A prefix,
  Detach) fire once and do not repeat when held.

Exercised in Chromium mobile emulation:
1. Single tap on Backspace deleted exactly 1 character (`J` -> `I`).
2. Long-press on Backspace held for 650ms deleted 6 characters smoothly.
3. Swiping 30px horizontally across the Enter button triggered no keypresses.
4. Long-press on Arrow Left moved the cursor left across a command line, allowing
   subsequent insertion in the middle of existing text.
5. Long-press on Backspace in the middle of a line deleted the inserted text cleanly.

All seven launcher and transcript regressions passed. Image `18.3.2-14` was built
and deployed to `omp-web-host.service`; all running host OMP and shell
processes remained alive with their original PIDs.

### Terminal font zoom buttons (`18.3.2-15`)

Added **A−** (`zoom-out`) and **A+** (`zoom-in`) buttons to the mobile keybar
following Ctrl-L, providing quick font scaling on mobile without pinch-zooming
or resizing viewport columns.

- **Refit and server sync**: adjusting font size immediately calls `fit.fit()`,
  recalculating terminal character cells, column count, and row count.
  `term.onResize` sends the new window dimensions to ttyd and the server's pty,
  reflowing tmux and interactive programs cleanly.
- **Single tap & long press**: tapping changes font size by 1px. Holding for 300ms
  smoothly increments or decrements font size every 60ms across the 9px–32px range.
- **Persistence**: the selected font size is stored in `localStorage('terminal-font-size')`
  and restored on subsequent visits or reloads, taking precedence over server defaults.

Exercised in Chromium mobile emulation:
1. Initial state at 390×844: font size 14px, 44 cols × 49 rows.
2. Two taps on `A+`: font size increased to 16px (38 cols × 41 rows); stored `"16"`.
3. Three taps on `A−`: font size decreased to 13px (47 cols × 52 rows); stored `"13"`.
4. Page reload: verified font size 13px and 47×52 layout persisted.
5. Long-press on `A+` (held 550ms): smoothly increased font size from 13px to 17px (36 cols × 39 rows).

Unit tests (7/7) passed. Image `18.3.2-15` was built and deployed to
`omp-web-host.service`; all host tmux sessions and OMP PIDs remained alive.

### Mobile file attachments and upload service (`18.3.2-16`)

Implemented in-browser file and photo attachment for mobile devices:

- **Backend service (`omp-web-upload`)**:
  - Lightweight Python HTTP daemon running on loopback (default port 7684), supervised
    by `omp-web-entry` alongside `ttyd` and `Caddy`.
  - Reverse-proxied via Caddy under `/upload*`.
  - Accepts `multipart/form-data` and raw binary payloads with `X-Filename` headers.
  - Sanitizes filenames against path traversal (POSIX and Windows-style separators),
    replaces unsafe characters, prefixes UTC timestamps (`YYYYMMDD_HHMMSS_<name>`),
    and reserves the name atomically (`open(..., 'xb')`), so two same-second
    uploads of one name cannot truncate each other.
  - Stores uploads in `~/.omp/uploads/` (bind-mounted identically on host and container).
  - Enforces a 100 MB upload size limit, caps a body read at 30 s so a stalled
    client cannot pin a worker thread, and returns clean JSON responses.

- **Frontend UI & auto-paste**:
  - **Keybar**: added an **Attach** button between Paste and Esc.
  - **Composer**: added an **Attach** button between Clear and Paste.
  - Hidden multi-file input triggers native mobile picker (iOS Photo Library, Camera, Files).
  - Uploads with live progress notice (`Uploading <filename>…`).
  - Automatically formats and inserts `@/home/jieniu/.omp/uploads/<filename> ` into the
    composer draft (if open) or pastes directly into the terminal (if closed).

Exercised and verified:
1. Unit tests in `tests/test_upload.py` (13/13 passing): filename sanitization,
   path traversal prevention, multipart upload parsing, raw stream parsing, 404 on invalid paths.
2. Chromium mobile emulation:
   - Verified Attach button presence on keybar and composer.
   - Uploaded test image with Composer open: verified composer value received
     `@/home/jieniu/.omp/uploads/...` and success notice was displayed.
   - Uploaded test file with Composer closed: verified terminal received
     direct paste of `@/home/jieniu/.omp/uploads/...`.
   - Verified exact file contents on disk (`~/.omp/uploads/`).

Image `18.3.2-16` was built and deployed to `omp-web-host.service`; all host
tmux sessions and OMP processes remained active without interruption.

### Viewport resize stabilization and copy-mode auto-exit (`18.3.2-17`)

Investigated and resolved duplicate text appearing in scrollback during mobile scrolling:

- **Root cause analysis**:
  1. The user's screenshot showed tmux copy-mode (`[64/10713]`) with the iOS software
     keyboard open. Inspecting `~/.omp/agent/sessions/` verified that the assistant message
     existed only once in the JSONL transcript; however, inspecting tmux's scrollback
     with `tmux capture-pane -S -500` revealed that the text had been duplicated in
     tmux's pane history itself.
  2. When a tmux pane's height shrinks (e.g. when the mobile keyboard slides up, or
     Safari's dynamic address bar expands), tmux pushes the top rows of the active screen
     into pane scrollback history. OMP then repainted the active streaming message in the
     smaller viewport, which scrolled again upon filling up, pushing the full message
     below the previously pushed fragment.
  3. In addition, `window.visualViewport?.addEventListener('scroll', scheduleFit)` was
     firing on every single touch move on iOS Safari, causing minor sub-pixel viewport
     fluctuations to trigger `fit.fit()` and spam tmux with `SIGWINCH` resize signals
     during touch scrolling.
  4. In `tmux.conf`, `copy-mode-vi WheelDownPane` was bound to `scroll-down` instead of
     `scroll-down-and-cancel`, which kept the user trapped inside copy mode at a stale
     scrollback position (e.g. `[64/10713]`) even after scrolling down to the bottom.

- **Remediation**:
  1. Removed the `visualViewport.scroll` listener in `web/app.js`: viewport scroll/pan
     offsets never alter terminal dimensions.
  2. Debounced terminal `onResize` by 80ms and deduplicated `cols`/`rows`: intermediate
     animation frames during keyboard slide-up/down no longer emit bursts of resize
     signals to tmux.
  3. Calibrated touch scroll speed in mouse-tracking mode: reduced multiplier from 3×
     to 1.5× (tmux already applies `-N 3`) and capped per-move event count to 15,
     preventing single swipes from jumping 60+ lines into history.
  4. Updated `tmux.conf` and the live host tmux server: bound `WheelDownPane` in both
     normal and `copy-mode-vi` tables to `scroll-down-and-cancel`, so scrolling down
     automatically exits copy-mode upon reaching the bottom of history.

Verified with unit tests (13/13 passing), verified copy-mode auto-exit in tmux,
built image `18.3.2-17`, and deployed to `omp-web-host.service` without
interrupting active host tmux panes.

### Touch focus suppression and iPad keyboard handling (`18.3.2-18`)

- **Touch-device focus suppression**:
  - Modified `focusTerminal()` in `web/app.js` to avoid programmatically focusing the
    hidden xterm `<textarea>` on touch devices when the virtual keyboard is closed.
  - Tapping toolbar buttons (`Esc`, `Enter`, `Attach`, `A+`, `A−`, arrows) or closing
    dialogs no longer forces iPadOS to pop open the floating or docked keyboard over the
    terminal content.
  - Tapping directly on the terminal surface still calls `focusTerminal(true)` so the
    software keyboard opens when explicitly requested.
  - If the software keyboard is already open, toolbar interactions maintain focus without
    closing or flickering the keyboard.

Built image `18.3.2-18`, deployed to `omp-web-host.service`; all host tmux panes
and running OMP processes remained active without interruption.

### iOS backgrounding resize protection and detached default dimensions (`18.3.2-19`)

Investigated and resolved streamed output rendering at narrow/half width (e.g. 46 columns)
when leaving the app to run in the background on iOS:

- **Root cause analysis**:
  1. When a user swipes away or locks an iPad/iPhone, iOS WebKit animates the browser
     window shrinking into the app-switcher thumbnail before suspending the tab.
  2. During this animation, Safari fired `resize` events with thumbnail dimensions.
     `web/app.js` calculated `cols = 46` and sent a resize packet to `ttyd` and `tmux`
     immediately before backgrounding.
  3. The client then detached, leaving the tmux pane running in the background at **46 columns**.
  4. While running in the background, OMP streamed its output formatted to fit the 46-column
     pane. When the user returned to Safari, the window expanded back to full width (84 columns),
     leaving the background-streamed output permanently wrapped at 46 columns on the left.

- **Remediation**:
  1. **Lifecycle guards in `web/app.js`**: `scheduleFit()`, `term.onResize`, and the window
     resize listeners now strictly check `if (document.hidden || leaving) return;`.
     The browser will never calculate or transmit shrunken thumbnail dimensions when
     transitioning to the background.
  2. **Pagehide timer cleanup**: `pagehide` and `visibilitychange` immediately clear any pending
     resize debounce timers so no delayed resize can fire after backgrounding.
  3. **Pageshow/visibility restoration**: when returning to the tab (`visibilitychange` or
     `pageshow`), the terminal only refits once the window is fully visible and settled.
  4. **Tmux detached default size**: configured `default-size 84x50` in `tmux.conf` and on the
     live host server so that even if all clients detach, panes retain their full 84-column width.

Verified with unit tests (13/13 passing), built image `18.3.2-19`, and deployed to
`omp-web-host.service`; all host tmux panes and OMP processes remained active.

### Window-size manual override clearance (`18.3.2-19`)

Resolved an issue where dynamic font resizing (`A+` / `A−`) functioned on other tabs
(`web-rebuild`, `trader-go`) but failed on `strategy` (`@0`), displaying a grid of dots
(`· · · ·`) around the pane:
- In tmux, invoking `resize-window` explicitly sets the window's `window-size` option to `manual`.
  When set to `manual`, tmux locks the window dimensions to fixed coordinates and refuses
  to adapt when the connected client's font size changes, filling the excess terminal area with dots.
- Cleared the per-window manual lock via `tmux set-window-option -u -t @0 window-size`,
  restoring window `@0` to inherit global dynamic sizing (`window-size latest`).
- Verified in Chromium that tapping `A−` on the `strategy` tab immediately refits `cols` and
  `rows` dynamically without locking or generating fill dots.

### Session takeover and single-display detachment (`18.3.2-20`)

Implemented session takeover semantics (`tmux attach-session -d`), matching the
single-display architecture established in `aerc web` (`screen -d -R`):

- **Cross-device conflict eliminated**:
  - When multiple devices (e.g. an iPad at 84–107 columns and an iPhone at 54–65 columns)
    connected to the same server, having both attached simultaneously caused tmux to
    constrain window dimensions to the smaller device whenever the active device
    was backgrounded.
  - `omp-launcher` now attaches with `tmux attach-session -d -t <target>`.
  - When a new device or tab connects, it cleanly takes over the active display and
    soft-detaches any prior attached client (which returns cleanly to the interactive
    launcher menu with return code 0, without closing or terminating any session).
  - The active window is guaranteed to have exactly one attached client, ensuring
    it is sized 100% to the active device's screen width.
  - A previously detached client can reclaim the session at any time simply by
    re-selecting it from the menu.

Verified with unit tests (14/14 passing, including explicit takeover and detachment
verification in `tests/test_launcher.py`), built image `18.3.2-20`, and deployed to
`omp-web-host.service` without interrupting live host panes.

### Discord alerts and visibility-based presence (`18.3.2-21`)

Added a new global OMP extension, `~/.omp/agent/extensions/discord-alert/index.ts`
(registered in `~/.omp/agent/config.yml`'s `extensions:` list alongside
`host-bridge`, so it loads for every OMP process — host or web, any project —
not just this one):

- **`discord_alert` tool**: the model can call this directly for a finished
  verdict or notable finding. No approval prompt (same class as `todo`/`think`)
  — a tool meant to fire while unattended cannot require an approval nobody is
  there to grant. Skips sending (and says so) when the user looks present;
  `force: true` overrides.
- **`agent_end` hook**: fires automatically once per completed top-level turn
  (skipping turns that will auto-continue), pulling the last assistant message
  as the alert body — no explicit tool call needed for "the agent finished."
- **Delivery**: a Discord embed posted via the Discord bot REST API
  (`POST /channels/{id}/messages`, `Authorization: Bot …`) — not a per-channel
  incoming webhook. Reuses the bot token and channel already configured for
  omp's built-in Discord bridge at `~/.config/omp-discord/.env`
  (`PI_DISCORD_BOT_TOKEN`, `PI_DISCORD_CHANNEL_IDS`), so there is no separate
  credential to create or store; `$OMP_DISCORD_BOT_TOKEN` /
  `$OMP_DISCORD_CHANNEL_ID` override it. Credentials are not read at
  extension-load time, so a missing/invalid config degrades to a clear tool
  error or a single logger warning instead of crashing extension load.

**Presence detection** — "is the user actively monitoring" — initially used
only `tmux list-clients` on the session's socket. That has a real gap: desktop
browsers don't fire `pagehide` on a plain window minimize (only on tab close or
navigation), so the WebSocket — and the tmux client it drives — stays attached
while minimized. A naive tmux-only check would wrongly treat a minimized window
as "watching" and stay silent.

Fixed with a visibility heartbeat:
- `web/app.js` POSTs `/presence` every 5s **only** while
  `document.visibilityState === "visible"`, stopping immediately on hide,
  minimize, backgrounding, or `pagehide`.
- `omp-web-upload` (renamed in spirit to a general web-helper service) touches
  `~/.omp/web-visible`'s mtime on each heartbeat.
- `discord-alert`'s `isAttended()` now prefers this file's mtime age
  (fresh = attended, stale beyond 15s = away) whenever the file exists at all;
  `tmux list-clients` is only a bootstrap fallback before any web session has
  ever written it (e.g. a pure native-terminal setup with no browser involved).

This correctly distinguishes a minimized desktop window (socket open, heartbeat
stale → away) from an actually-visible tab (socket open, heartbeat fresh →
present), and still falls back sanely for terminal-only access.

Verified live end-to-end against the real production domain (not just an
isolated smoke container): `POST https://omp.jieniuu8.com/presence` returned
200 and touched the real `~/.omp/web-visible`. A dedicated isolated smoke
appliance proved the full freshness/staleness cycle: a fresh heartbeat read
back as `attended: true` (860ms old); 16 seconds with no further heartbeats
(simulating a minimized tab) read back as `attended: false` (>15s threshold),
confirming the exact scenario this was built to catch. Added
`test_presence_heartbeat_touches_file` to `tests/test_upload.py`; all 15 tests
pass. Built image `18.3.2-21` and deployed to `omp-web-host.service`
without restarting any live host pane.

Delivery itself was verified live against the real Discord API, not mocked:
authenticated as the existing `ompBot` application (id
`1551063496849096776`, bot account, verified) using the token already on
disk, then posted a real embed to the configured channel
(`1551063327705268284`) and got back a genuine message id. No new credential
was created — `discord-alert` reuses the bot already wired into omp's Discord
bridge rather than requiring an incoming-webhook URL from the user. Like
`host-bridge`, the extension loads at OMP process startup; it is not
available in the currently-running conversation without a restart.

### Window-scoped presence (`18.3.2-22`)

A gap found by a direct question, fixed live:

**"Will I get pinged if I'm chatting in one tmux window while a *different*
project's session finishes?"** No, under the original design — fixed now.
The presence heartbeat was a bare touch of one flat file, shared by every
project on the same tmux server. A visible browser tab kept it fresh
regardless of *which* tmux window that tab was actually showing, so any
session on the server (e.g. `strategy` in window `@0`) would see "someone's
watching" and suppress its own alert even while the user was looking at a
totally different window (e.g. `web-rebuild` in window `@2`) — a false
suppress, exactly backwards from what a per-project alert should do. Fixed
by making the heartbeat window-scoped:
- `web/app.js`'s heartbeat now sends `POST /presence?window=<id>`, reusing
  `currentArg` (the same `tmux-N` id already used for reconnect URLs) — the
  single-display architecture means at most one window is ever attached
  browser-side, so this always names *the* window currently on screen, not
  just "some tab is open somewhere."
- `omp-web-upload`'s presence handler now writes `{"window": "tmux-N", "ts":
  …}` JSON (atomic write-then-rename) instead of a bare mtime touch.
- `discord-alert`'s `isAttended()` resolves its *own* session's window via
  `tmux display-message -t $TMUX_PANE '#{window_id}'` ($TMUX_PANE is
  pane-specific, unlike the session-level $TMUX) and compares it against the
  heartbeat's `window` field. Match + fresh → attended (suppress). Anything
  else — different window, no window (e.g. heartbeat sent from the launcher
  menu), or this session's own window undeterminable — → not attended
  (send), consistent with the module's existing "never silently lose an
  alert" bias.

Verified against real, not simulated, data: attached a real browser tab to
`web-rebuild` (window `@2`/`tmux-2`) through the live production domain,
confirmed the on-disk heartbeat read `{"window": "tmux-2", "ts": …}` fresh at
under 2 seconds old, then ran the actual compiled `discord-alert` module (not
a reimplementation) twice against that same real file: once with
`$TMUX_PANE=%0` (`strategy`'s real pane) — returned `"sent (user away)"` and
posted a genuine Discord message; once with `$TMUX_PANE=%2` (`web-rebuild`'s
own pane) — returned `"skipped: …"` with no message sent. Added
`test_presence_heartbeat_records_window` to `tests/test_upload.py`; all 16
tests pass. Built image `18.3.2-22`, deployed to
`omp-web-host.service`; all three pre-existing host panes (`strategy`,
`web-rebuild`, `trader-go`) remained unchanged throughout.

### Canvas renderer, replacing jittery DOM rendering (`18.3.2-23`)

**"The text appears jittery, and scrolling is jittery too."** xterm.js 5.x's
default renderer (used because only `@xterm/addon-fit` was loaded) is the DOM
renderer: every cell is a real DOM node, repainted/reflowed on every update —
visibly janky under rapid output or scroll, especially on mobile. Added
`@xterm/addon-canvas` (0.7.0, matches the `^5.0.0` peer range of the bundled
xterm 5.5.0) and load it right after `term.open(host)`, guarded so a missing
script or failed 2D context falls back to the DOM renderer silently rather
than breaking the terminal. Deliberately *not* `@xterm/addon-webgl`: the
web-terminal skill already documents WebGL glyph mangling as a known
pitfall — canvas is the safe middle ground, far faster than DOM without that
risk. Vendored the same way as `addon-fit` (`build-web.mjs` copies it from
`node_modules` into `web/vendor/` at build time).

Verified live against the real production domain: `#terminal` now contains 4
canvas layers (xterm's text/selection/link/cursor layers) and zero per-cell
`<span>` elements — definitive proof the canvas renderer is active, not just
present in the bundle. Screenshotted the live terminal (clean text, no
rendering artifacts) and scrolled into real tmux scrollback (copy-mode
`[7/250]` indicator, content rendered correctly) to confirm both static
rendering and scroll are visually correct under the new renderer. 16/16 unit
tests pass (unaffected — this is frontend-only). Built image `18.3.2-23`,
deployed to `omp-web-host.service`; all three pre-existing host panes
(`strategy`, `web-rebuild`, `trader-go`) remained unchanged.

### Astigmatism-friendly palette (`18.3.2-24`)

The previous dark theme (`#11151b` background, `#e4e8ef` foreground) measured
a ~14.9:1 WCAG contrast ratio — close to the pure-black/pure-white extreme.
For astigmatic eyes this pairing causes halation (blooming/ghosting around
characters): a wide-dilated pupil plus very bright text creates light
scatter the lens can't resolve sharply. Confirmed against published
accessibility guidance (avoid pure black/white, lower contrast, avoid
saturated blue) and calibrated against reference low-eye-strain themes
(One Dark ~6.6:1, Gruvbox ~10.75:1, Solarized Dark ~4.75:1 — picked a point
in that band rather than guessing).

New triad: background `#161a21` (was `#11151b`), foreground `#b4bcca` (was
`#e4e8ef`), cursor `#9bb4d4` (was the more saturated `#c5e3ff`) — ~9.1:1
contrast. Applied consistently everywhere the old colors appeared, not just
the xterm theme: `index.html`'s `theme-color` meta, `style.css`'s
`:root`/composer/dialog backgrounds, and the `#prefix` active-state text
color, so there's no visible seam between the terminal canvas and the
surrounding chrome. The elevated dialog/composer-panel surface tone
(`#1b222c`) was shifted by the same delta to `#202732` to preserve its
relative lightness over the new base.

Verified live against the real production domain, not just computed: opened
the actual deployed terminal and read the background pixel directly off the
xterm canvas via `getImageData` — `#161a21`, an exact match, confirming the
rendered output (not just the source) carries the new palette. 16/16 unit
tests pass (frontend-only change). Built image `18.3.2-24`, deployed to
`omp-web-host.service`; all pre-existing host panes remained
unchanged throughout.

### Key bar on all devices, not just touch (`18.3.2-25`)

The key bar (Select/Paste/Attach/Esc/Enter/Backspace/^C/Tab/arrows/^A/^L/
zoom/Detach/^D) was CSS-gated to `@media (any-pointer: coarse)` — hidden on
desktop entirely. Wanted on desktop too, e.g. to use Attach for uploading a
screenshot from a Mac without a terminal paste path for images. Its click
handling already had a dedicated mouse path (`pointerdown`'s `isMouse`
branch — its own key-repeat timing, separate from the touch path's
scroll-friendly delay) — this was a pure visibility gate, not touch-only
logic, so the fix is CSS-only: `#keybar` now defaults to `display: flex`;
the `any-pointer: coarse` block keeps only the unrelated 44px touch-target
sizing for the connection/notice buttons.

Verified on a real desktop viewport (1280×800, `isMobile: false,
hasTouch: false`, confirmed `matchMedia('(any-pointer: coarse)')` is false)
against the live production domain: key bar renders with all 18 buttons.
Clicked Attach and confirmed the click reaches the hidden file input
(instrumented listener fired) — the same `openFilePicker()` path the
composer's existing Attach button already used, so screenshot/file upload
now works via mouse exactly like it did via touch. 16/16 unit tests pass
(frontend-only change). Built image `18.3.2-25`, deployed to
`omp-web-host.service`; all six pre-existing host panes remained
unchanged.

### Compact keybar on mouse, muted ANSI palette (`18.3.2-26`)

Two gaps surfaced right after the previous change:

**"On computer web it appears larger than mobile."** The key bar's buttons
(and the Compose toggle next to it) carried an unconditional 44px touch
target — correct for touch, chunky for a mouse pointer now that the bar
shows on desktop too. Flipped the default to a compact 32px/4px-8px padding,
and moved the 44px sizing into the existing `any-pointer: coarse` block so
only touch devices get it.

**"The code block is color irritating."** The xterm `theme` only set
background/foreground/cursor — the 16 ANSI colors (used by syntax
highlighting, diffs, `ls --color`, etc.) were xterm's unset defaults, an
uneven mix: normals like red/blue/magenta sit at only ~3:1 contrast against
the dark background (muddy, hard to read), while brights like `brightYellow`
hit ~14:1 (glaring next to the now-muted base) — the opposite problem from
the one just fixed. Added an explicit 16-color palette calibrated the same
way: every color ~5.5–11:1, no color either too dim to read or neon-bright
against the rest.

Verified live against the real production domain: on a desktop viewport
(1280×800, `isMobile:false, hasTouch:false`) the Select button measured
32px tall with `any-pointer: coarse` false; on an iPhone-sized touch
viewport (390×844, `hasTouch:true`) the same button measured 44px with
`any-pointer: coarse` true — both sizes confirmed on the live page, not
assumed from the CSS. Read `window.term.options.theme` off the live xterm
instance and confirmed it carries the exact new hex values (not just present
in the source bundle). 16/16 unit tests pass (frontend-only). Built image
`18.3.2-26`, deployed to `omp-web-host.service`; all six
pre-existing host panes remained unchanged.

### Stuck drag-selection auto-scroll on desktop (`18.3.2-27`)

**"On Mac Safari, clicking near the top starts selecting from the cursor and
keeps scrolling up."** Root-caused by reading two real sources, not guessed:
- `tmux.conf`: `bind -n MouseDrag1Pane … 'copy-mode -M -t ='` — outside a
  full-screen app, a mouse drag enters copy-mode with an active, mouse-driven
  selection; copy-mode's own near-edge auto-scroll continues until
  `MouseDragEnd1Pane` (the drag's release) fires.
- The bundled `vendor/xterm.js`: both its selection and mouse-reporting
  subsystems bind their move/up drag-tracking listeners at the `document`
  level (confirmed via `document.addEventListener("mouseup"…)` /
  `screenElement.ownerDocument.addEventListener("mouseup"…)` call sites in
  the shipped bundle) — so a release is only recognized if `document` itself
  receives a `mouseup`.

With the connection bar hidden (normal connected state) the terminal sits at
the page's very top edge, so a small upward drag near the top row easily
carries the cursor into the browser's own chrome (Safari's tab/URL bar).
Release there and `document` never sees `mouseup` — the drag/auto-scroll has
nothing to stop it.

Fix: track `mousedown` inside `#terminal`; on the next `document` `mousemove`
reporting `event.buttons === 0` (proof a release happened without us
observing it), replay a synthetic `mouseup` on `document` so whichever real
subsystem (xterm's local selection, or its mouse-report pass-through to
tmux) runs its own normal cleanup path — not a hand-rolled one.

**Verification is partial, stated plainly:** confirmed from the actual
shipped source that both plausible mechanisms key off a `document`-level
`mouseup`, which is exactly the recovery's target — this is a real trace
through shipped code, not a guess. Could not get an isolated sandbox session
to reproduce the drag-into-copy-mode behavior at all through Puppeteer/CDP
synthetic mouse input, even with a complete, normally-released, realistic
multi-step drag — a tooling-fidelity gap (synthetic input apparently doesn't
carry whatever real trackpad/mouse hardware characteristics tmux's
mouse-tracking pipeline keys on), not evidence against the fix. 16/16 unit
tests pass (frontend-only change, unaffected). Built image `18.3.2-27`,
deployed to `omp-web-host.service`; all six pre-existing host panes
remained unchanged. Please confirm directly on your Mac after refreshing —
if it still happens, the next step is capturing the WebSocket bytes during a
real drag to see exactly what tmux receives.


### Pointer Capture replaces the stuck-drag heuristic (`18.3.2-28`)

`18.3.2-27`'s fix for the stuck drag-autoscroll was reactive: it only
recovered once some *future* mousemove happened to report no button held —
if the user clicked elsewhere directly instead of moving the mouse first,
nothing triggered it. Reported "still finicky."

Replaced with the actual browser mechanism built for this exact problem:
**Pointer Capture**. Calling `host.setPointerCapture(pointerId)` in a
`pointerdown` handler (mouse only — touch keeps its own Select-button flow)
makes the browser retarget *all* subsequent events for that pointer to the
capturing element — not just `pointerup`, but the compatibility
`mousemove`/`mouseup` events xterm and tmux's mouse-reporting actually
listen for — regardless of where the cursor physically ends up, even outside
the page. This is immediate and guaranteed by the browser, not a guess about
what might happen next.

Verified empirically against the live deployed bundle, not just by spec:
dispatched a real press inside `#terminal` then a release physically over a
*different* element (the key bar). Without capture, the release's `mouseup`
targets the key bar's button — confirmed first as a baseline, proving these
are genuinely distinct elements. With the shipped `app.js`'s own
`pointerdown` listener active (no test scaffolding around the capture call
itself), the identical release retargeted to `#terminal` instead — exactly
the guarantee needed to recover a release that lands on Safari's own chrome.
The old reactive mousemove check stays as a defensive fallback in case
capture is ever lost mid-drag. 16/16 unit tests pass (frontend-only). Built
image `18.3.2-28`, deployed to `omp-web-host.service`; all six
pre-existing host panes remained unchanged.

### `18.3.2-28` made it worse; reverted, fixed at the real root (`18.3.2-29`)

`18.3.2-28`'s Pointer Capture caused a new, worse regression: "clicking
anywhere selects everything above the cursor." Exact interaction unconfirmed
(xterm's own mouse-to-cell math uses a fixed reference element via
`getCoords(event, element, …)`, not target-relative `offsetX/Y`, so it
shouldn't have been coordinate corruption from retargeting — most likely
culprit is the kept-as-"defensive-fallback" reactive mousemove check
misfiring against a retargeted event's `buttons` state and injecting a
premature synthetic `mouseup` mid-drag). Not fully root-caused, because the
fix is: stop layering clever browser-side JS on an interaction this fragile.

**Reverted entirely**: removed all custom `pointerdown`/`mousedown`/
`mouseup`/`mousemove` handling from `app.js` — back to vanilla xterm.js
mouse behavior, zero interception.

**Simpler fix, at the actual root**: the chain was always
`tmux.conf`'s `MouseDrag1Pane` → `copy-mode -M` (outside a full-screen app) →
copy-mode's own near-edge auto-scroll, stuck without a release. Rather than
catching a lost release after the fact, stop the accidental *entry*: for
plain-shell panes a mouse drag is now a no-op —
`bind -n MouseDrag1Pane if-shell -F -t = '#{alternate_on}' 'send-keys -M'`
(else-branch dropped; no else means no-op when `#{alternate_on}` is false).
Full-screen apps (anything in the alternate screen buffer - omp/pi-tui, vim,
etc.) still get raw mouse bytes forwarded via `-M`, unchanged. Deliberately
entering copy-mode first (wheel-scroll or prefix-[) still supports drag-select
there via the untouched `copy-mode-vi` table - that's a bounded, deliberate
action, not an accidental one, and lower-risk by construction. For routine
text selection/copy on any device, the existing Select-button -> dialog flow
(frozen snapshot, native `<textarea>` selection) remains the robust path -
fully decoupled from the live PTY/mouse-report pipeline, so none of this
class of bug can reach it.

Applied to `tmux.conf` (future server starts) and pushed directly to the
already-running host tmux server via `tmux bind-key` (confirmed with
`list-keys`) - no server restart, no pane disruption. Confirmed the deployed
`app.js` no longer carries the reverted code (the one remaining
`setPointerCapture` match is pre-existing, unrelated touch-surface code for
the key bar's own multitouch handling, filtered to `pointerType === 'touch'`
- verified by reading it, not assumed). 16/16 unit tests pass. Built image
`18.3.2-29`, deployed to `omp-web-host.service`; all six pre-existing
host panes remained unchanged throughout this and the prior two releases.

### Select dialog captures the full buffer, not just the viewport (`18.3.2-30`)

The Select-button dialog only ever froze the currently *visible* `term.rows`
lines (`buffer.getLine(viewportY)` through `viewportY + rows`), with its own
help text admitting the gap: "To copy older text, close this and scroll the
terminal first." Changed the loop to `0` through `buffer.length` - the full
buffer xterm is holding, not just what's on screen - and open the dialog
scrolled to wherever that content was actually visible (the bottom at the
live tail; proportionally estimated if already scrolled back, since the
textarea reflows independently of the terminal's fixed column grid so exact
pixel mapping isn't possible) instead of always dumping you at line 1.

**Scope, stated precisely, not oversold**: "full buffer" means everything
*this browser tab's current connection* has received - not tmux's full
server-side history. Confirmed directly: a fresh connection to a window with
9,000-16,000 lines of real tmux `history_size` still starts with
`buffer.length === term.rows` exactly, because tmux replays only the current
screen redraw on attach, not its deeper scrollback, over the raw PTY stream.
Reaching that would need seeding xterm's buffer from `tmux capture-pane`
before the live stream begins - a real architecture change to the
attach/connect path, out of scope here. Updated both the dialog copy and the
code comment to say exactly this ("everything this tab has shown so far, not
older history from before you connected") rather than imply more.

Verified live, not assumed: wrote 100+ local-only lines directly into a test
tab's xterm buffer (`term.write`, never sent to the real session) to push it
to 122 lines against 39 visible rows, then confirmed the dialog's textarea
held all 122 lines including content from well before the current viewport,
and opened scrolled to the bottom. Measured full-buffer extraction cost
beforehand (~0.04ms/line on the live buffer, so ~400ms worst case at the
10000-line cap) before committing to the design, rather than guessing it
was fast enough. 16/16 unit tests pass. Built and deployed to
`omp-web-host.service`; all six pre-existing host panes remained
unchanged.

### Vanilla tmux mouse config - and the real bug was ours (`18.3.2-31`)

Asked for a more basic/vanilla setup instead of continuing to patch custom
mouse bindings. Digging into tmux's actual stock defaults (compared a
zero-config throwaway tmux instance's `list-keys` output against ours)
surfaced the real root cause: tmux's own `MouseDrag1Pane`/`WheelUpPane`/
`DoubleClick1Pane` defaults branch on `#{mouse_any_flag}` (does the
*running app* want mouse input?); ours branched on `#{alternate_on}`
(is the app using the alternate screen buffer?) - a different question.
omp/pi-tui - this very chat - runs with `alternate_on=0` but
`mouse_any_flag=1` (confirmed live via `display-message -p`), so our check
was *misrouting* its drags into tmux's own copy-mode-select instead of
forwarding them to pi-tui, every time, regardless of our 18.3.2-29 fix.
Going vanilla isn't just simpler, it fixes a real bug we introduced.

Deleted all custom mouse bindings from `tmux.conf` (`WheelUp/DownPane`,
`MouseDrag1Pane`, `DoubleClick1Pane`, the `copy-mode-vi` table overrides,
the `after-copy-mode` auto-top-line hook) - down to bare `set -g mouse on`,
nothing else. Tmux's real stock defaults apply everywhere now, including
things our overrides had been silently shadowing: the built-in right-click
context menu (search/copy/split/kill), middle-click paste, and status-bar
click-to-switch-window.

Applied to the already-running host tmux server by replaying the exact
stock binding strings (captured from a disposable zero-config tmux
instance) via `bind-key`/`set-hook -u` - not a restart, which would have
killed all panes. Confirmed every restored binding byte-for-byte matches
the throwaway vanilla instance's `list-keys` output, and that
`WheelDownPane`'s root-table entry is genuinely absent (tmux has no stock
binding for it there - scrolling down at the root has no default meaning).
16/16 unit tests pass (tmux-only change, untested by the suite but verified
by direct comparison instead). Built image `18.3.2-31`, deployed to
`omp-web-host.service` and pushed live to the running tmux server;
all six pre-existing host panes remained unchanged throughout.


### `18.3.2-31` broke scroll/select for omp itself; restored two bindings (`18.3.2-32`)

Reported "doesn't look like I'm able to scroll or select" - immediately
after the vanilla-tmux change. Root cause confirmed live: vanilla tmux's
stock mouse rule forwards wheel/drag/double-click straight to whichever app
last requested mouse tracking (`#{mouse_any_flag}`), skipping tmux's own
copy-mode entirely. omp's own TUI (this chat) sets that flag but does
nothing with forwarded wheel or double-click events - confirmed by reading
`window.term.modes.mouseTrackingMode` (`"any"`, correctly active - ruling
out a tracking-mode failure) and then checking tmux's own
`#{pane_in_mode}`/`#{scroll_position}` before and after real wheel events:
unchanged, confirming the bytes reached omp and were silently dropped there.
Pure vanilla was correct per spec, but assumed every app that asks for mouse
actually handles it - omp doesn't, for these two gestures.

Fix: force wheel-scroll and double-click-to-copy-word through tmux's own
copy-mode unconditionally (`bind -n WheelUpPane copy-mode -e`, similarly for
`DoubleClick1Pane`), restoring working scroll/word-copy in any pane
regardless of what's running. **Drag deliberately stays on vanilla's
app-forwarding rule** - it's the one gesture with an actual stuck-forever
failure mode if mishandled (the entire reason this thread started), while
wheel and double-click are bounded, single-shot actions with nothing to get
stuck. The Select button remains the one universally reliable path for
selecting text regardless of which rule governs drag in a given pane.

Applied directly to the running tmux server (`bind-key`, no restart) and
verified on the real production domain: sent real wheel events into the
live chat window, confirmed `#{scroll_position}` moved from empty to `145`
and `#{pane_in_mode}` flipped to `1` - then immediately cancelled
copy-mode on the real session to restore the live view before anything was
missed. 16/16 unit tests pass (tmux-only change). Built image `18.3.2-32`,
deployed to `omp-web-host.service`; all seven pre-existing host
panes remained unchanged.



### Why selection "bounces to text box", and why there's no simpler protocol (`18.3.2-33`)

Reported "selecting anything bounces back to text box". Traced to the real
shipped xterm.js source, not guessed: `handleMouseDown` calls `this.focus()`
(the hidden keyboard-input textarea) before deciding whether to forward the
click to the app or select locally - and `shouldForceSelection(e){ return
isMac ? e.altKey && macOptionClickForcesSelection : e.shiftKey }` governs
that decision. `macOptionClickForcesSelection` defaults to `false` and was
never set, so on Mac **no modifier forced local selection at all** - every
click, whenever the pane's mouse-reporting happened to be active, just
focused the hidden textarea and selected nothing. That focus-call is the
literal "text box" being bounced to.

Asked whether a simpler cross-platform design exists instead of continuing
to chase this. Direct answer: no - this exact tension (the running app
wants mouse clicks vs. the user wants to select text) exists in every
terminal emulator that supports mouse reporting (iTerm2, Terminal.app,
Windows Terminal, kitty, alacritty): there is no way to distinguish "click
the menu" from "select this text" without the user signaling intent via a
modifier key, so all of them use exactly this convention. It's inherent to
the terminal mouse-reporting protocol, not a gap in this stack.

Confirmed live (controlling for a real confound first - mouse-tracking mode
toggles with whatever's currently drawn in that specific window, so an
isolated, fresh, freshly-attached test was required to get a trustworthy
read rather than a stale/transitional one): with
`macOptionClickForcesSelection` enabled and genuinely-active mouse tracking
confirmed via `window.term.modes.mouseTrackingMode`, an Option+drag produced
a real `term.getSelection()` result pulled from live terminal content.
Enabled the option - one line, matches the convention every Mac terminal
user already expects, zero custom mouse JS added.

**The actually-simpler, truly cross-platform path was already shipped**: the
Select button opens a plain native `<textarea readonly>` - no mouse-report
protocol, no modifier keys, no xterm internals, identical UX on iPhone,
Android, Mac, Windows, any browser, regardless of what the live app's mouse
mode happens to be at that instant. That remains the one universally
reliable path, especially on mobile where there is no Option/Shift key at
all. 16/16 unit tests pass (frontend-only addition). Built image
`18.3.2-33`, deployed to `omp-web-host.service`; all seven
pre-existing host panes remained unchanged.



### Deliberate Scroll button replaces ambient wheel/swipe scroll (`18.3.2-34`)

Asked to disable scroll and add a scroll button instead. Ambient gestures
(wheel, touch-swipe) were the root of most of this thread's inconsistency:
they sometimes scrolled locally and sometimes forwarded mouse-report bytes
to tmux depending on momentary state, with platform-specific delta
normalization on top. Removed both actuation paths from `app.js` -
`attachCustomWheelEventHandler` now unconditionally swallows every wheel
event (deterministic no-op regardless of platform, trackpad-vs-mouse, or
mouse-tracking state), and the touch-swipe scroll math is gone while
keeping the pieces that aren't scroll-related (tap-to-focus, suppression of
xterm's own native touch handling so pinch-zoom stays native).

Added a `Scroll` keybar button that enters tmux copy-mode by sending the
prefix byte + `[` (the same binding as pressing prefix-`[` manually) - pure
PTY bytes, no mouse protocol involved, so it behaves identically on every
device/browser. It's a client-local toggle (same pattern as the existing
`prefixArmed` state): pressed again (or after Enter/Escape) it sends `q` to
exit. The existing Up/Down keybar buttons navigate once in copy-mode.
Deliberately left `tmux.conf`'s own wheel/double-click bindings untouched -
those also serve native terminal clients attached to the same tmux server,
where no browser is involved and the gesture is unambiguous.

### tmux mishandles raw arrow escape sequences in copy-mode (`18.3.2-35`)

Testing the new Scroll button surfaced a real, deterministic tmux bug,
isolated in a minimal throwaway instance: sending a single literal `ESC [ A`
(the standard cursor-up sequence, exactly what any real terminal client
transmits for the Up key) to a pane in copy-mode makes tmux **exit copy-mode
entirely**, rather than moving the cursor. Reproduced with both
`default-terminal` values (`tmux-256color`, `xterm-256color`), so it isn't
terminfo-specific; tmux's own named `Up` key (its internal key-dispatch,
bypassing byte-level escape parsing) works correctly, and a literal `k`
(vi-mode cursor-up, a plain character requiring no escape parsing) also
works correctly. Not something fixable in our layer - it's in tmux's
escape-sequence parser - so the fix is client-side: while scroll mode is
armed, Up/Down send `k`/`j` instead of arrow escape sequences, which is also
the natural binding for `mode-keys vi` anyway. Escape and Enter also reset
the client toggle, since both commonly end a scroll session.

Verified live end-to-end on a quiet, uncontested window (window `@9`, not
this conversation's own window - testing against the live chat's window
turned out to be a self-inflicted race, since every tool call competes with
the test tab for the single-display attachment slot and evicts it): Scroll
button enters copy-mode (`pane_in_mode=1`), Up moves the cursor without
exiting (verified against a clean instance where `k` moves 1->0 and `j`
moves 0->1->2, clamping at boundaries), Scroll again exits
(`pane_in_mode=0`), and wheel input produces no mode change at all. 16/16
unit tests pass (frontend-only). Built images `18.3.2-34` and `18.3.2-35`,
deployed to `omp-web-host.service`; all seven pre-existing host
panes remained unchanged and none were left in copy-mode.

### Drag-select inside scroll mode keeps the toggle in sync (`18.3.2-36`)

Reported: selecting something while in scroll mode exits scroll mode. Checked
against stock tmux rather than assuming - `MouseDragEnd1Pane` in
`copy-mode-vi` is `send-keys -X copy-pipe-and-cancel`, so exiting on release
*is* the intended, correct behavior ("drag to select and copy" naturally
completes and closes the mode). Not a bug to fix in tmux.

What it did break was our client-side `scrollModeArmed` toggle: it had no
way to know the mode ended, so the button kept showing "scrolled back" until
pressed again (sending a stray `q`). Can't detect this from xterm's own
mouse events - with mouse-reporting active those get forwarded to tmux as
bytes rather than exposed to JS - so added a capture-phase `mouseup`
listener on the terminal surface that clears the toggle, the same treatment
Enter and Escape already get. Verified live: enter scroll mode (toggle
`true`), drag-select inside it, toggle resets to `false` and tmux's own
`pane_in_mode` is `0` - client and server agree. 16/16 unit tests pass.
Built image `18.3.2-36`, deployed to `omp-web-host.service`; all
seven pre-existing host panes unchanged.
### Drag-select restored, and copy now reaches the browser clipboard (`18.3.2-37`)

Reported "can't select text now". Root-caused by measuring the live server
rather than guessing: every pane reports `#{mouse_any_flag}=1` (omp's TUI
enables mouse reporting in all of them) and stock tmux's `MouseDrag1Pane`
branches on exactly that flag:

    if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" { send-keys -M } { copy-mode -M }

With the flag always set, the forward branch always wins, so drag is sent to
omp - which ignores it entirely (verified earlier: forwarded wheel and drag
produce no response). So drag could never select anywhere. This was a
regression from `18.3.2-31`'s vanilla pass, which adopted that stock binding;
the pre-`18.3.2-29` binding branched on `#{alternate_on}` instead, which is
the correct discriminator here.

Proved with an A/B against a real tmux client (scripted pty attach on an
isolated session, pane running an app that enables mouse reporting - i.e.
`alt=0, mouse_any=1`, exactly the live condition):

    STOCK binding : alt=0 mouse_any=1 | mid-drag in_mode=0 sel_present=
    OUR binding   : alt=0 mouse_any=1 | mid-drag in_mode=1 sel_present=1

and on release the selected text was in tmux's buffer (`'183\n184\n185'`).
`MouseDrag1Pane`, `WheelUpPane` and `DoubleClick1Pane` therefore all branch on
`#{alternate_on}` again: real full-screen apps (vim, less) keep raw mouse
forwarding, normal panes get tmux's own drag-select/wheel/double-click.

Second half of the same problem: xterm core has **no OSC 52 handler**
(checked the bundled build - handlers registered for 0,1,2,4,8,10,11,12,104,
110-112 only), so although tmux copies the selection to its buffer and emits
OSC 52 (the image sets `set-clipboard on`), the text never reached the
browser clipboard - select-then-paste would have done nothing. Vendored the
official `@xterm/addon-clipboard` (0.2.0) the same way as addon-fit/canvas
and loaded it, bridging OSC 52 to `navigator.clipboard`. Fails soft: tmux's
own buffer still holds the text.

Verified: a pane emitting a real OSC 52 write (`printf '\033]52;c;%s\a'
"$(printf OSC52SECOND | base64)"`) produced an actual
`navigator.clipboard.writeText("OSC52SECOND")` call, captured by
instrumenting the page - i.e. the pane-to-clipboard chain is intact
end-to-end. Clipboard writes are still best-effort per browser policy (Safari
can decline without a direct user gesture); the tmux buffer is the fallback,
and the Select button remains the guaranteed native path. 16/16 unit tests
pass. Built image `18.3.2-37`, deployed to `omp-web-host.service`;
all seven pre-existing host panes unchanged, none left in copy-mode, and the
test sessions/clients used for verification were removed.
### Web-terminal UX research batch (`18.3.2-37`, frontend only)

Four parallel research slices (xterm.js options/addons; mainstream web-terminal
architectures; selection/clipboard/mouse protocols; mobile+latency), every
claim cited to a primary source, then cross-checked against this repo. Applied
the low-risk fixes it surfaced:

- `touch-action: pinch-zoom` -> `pan-y pinch-zoom` on `.xterm`,
  `.xterm-screen`, `.xterm-viewport`. `pinch-zoom` alone DISABLES panning;
  xterm.css sets no touch-action itself, so this was our own block. Proven in
  isolation with identical synthetic swipes: `pinch-zoom` -> scrollTop 0,
  `pan-y pinch-zoom` -> scrollTop 291.
- `altClickMovesCursor: false`. xterm defaults it true, which makes Option+click
  also reposition the cursor - directly competing with the
  `macOptionClickForcesSelection: true` gesture we enable for selecting inside
  mouse mode. Documented as "pick one".
- Selection highlight was unset (renderer default barely registers on this dim
  base): added `theme.selectionBackground '#2b4a6b'` and
  `selectionInactiveBackground '#243040'`. Deliberately no
  `selectionForeground` - overriding it would flatten syntax colours inside
  the selection.
- `.xterm-viewport` background: xterm.css hard-codes `#000`, which flashed
  pure black in the scrollbar gutter/overscroll against our `#161a21` palette.
  Overridden.

**Correction to the research's main mobile promise.** "Native touch panning for
free" does not apply here. Measured on a real attached pane: streamed 400 lines
of output, the client's visible tail showed the new lines (`398/399/400`) while
`term.buffer.active.length` stayed exactly `== term.rows` - under tmux the
client's xterm buffer never accumulates scrollback, because tmux repaints the
pane region with cursor addressing instead of streaming scroll-inducing
newlines. All history is in tmux. So `pan-y` removes a block but has nothing to
pan; touch users scroll history with the Scroll button (copy-mode), not by
panning. The app.js comment was corrected to state this measured reality rather
than the research's assumption. A real touch-scroll would need a gesture ->
copy-mode bridge (swipe distance -> the vi-mode `k`/`j` path already verified),
which is a separate design decision, not a CSS flag.

Two operational facts confirmed while verifying:
- The container serves the frontend **directly from the shared worktree**
  (`Caddyfile`: `root * {$OMP_WEB_ROOT}/web`), so `web/` edits are live on
  reload with **no image rebuild**. Image rebuilds are only needed for
  container-side files (tmux.conf, omp-launcher, Containerfile). This batch
  changed no container-side file, so the image version is unchanged at
  `18.3.2-37`.
- Our frontend calls `term.reset()` on reconnect (app.js:435), matching ttyd's
  own client - which is why synthetic buffer content cannot survive in a test
  tab that keeps reconnecting under single-display takeover.

Also verified (not changed): the OSC 52 chain is complete on this host -
`infocmp -x` shows `Ms=\E]52;%p1%s;%p2%s\007` for both `xterm-256color` and
`tmux-256color`, server has `set-clipboard on` plus
`terminal-features[0] xterm*:clipboard:...`, client TERM is `xterm-256color`,
and `history-limit` is already 100000 (50x tmux's 2000 default). Flow control
was already correct (we implement ttyd's PAUSE/RESUME with 256 KB/64 KB
watermarks; the xterm.js guide's ceiling is ~500 KB).
### Touch-swipe scrolling restored, via direct mouse reports (`18.3.2-37`, frontend)

Mobile reported "doesn't really work on the phone". Compared against the
pre-today version by extracting it from an image: **nothing is committed**
(last commit 2026-09-27), but every build baked a snapshot of `web/` into the
image, so `18.3.2-23` (3 days old) is the last build before today and
`18.3.2-24..-37` are all today. Diff of the extracted snapshot vs the working
tree:

    old23/app.js  sendTrackedScroll=3  touchRemainder=5
    web/app.js    sendTrackedScroll=0  touchRemainder=0

The touch-swipe scroll bridge was removed in `18.3.2-34` along with the
desktop wheel change, so mobile went from *swipe to scroll* to *press Scroll,
then tap Up/Down*. Restored - and fixed, because the old implementation had a
latent mode-dependency:

**Why the old bridge silently did nothing on some panes.** It synthesized DOM
`WheelEvent`s on `.xterm-viewport` and relied on xterm forwarding them to the
app. xterm only forwards wheels in *some* mouse modes: instrumenting
`WebSocket.send` while dispatching synthetic wheels measured **0 bytes
forwarded** in mode `drag` (1002) - the mode tmux uses for a plain shell pane -
while the same test in mode `any` did forward. The restored version instead
emits the SGR (1006) wheel report straight into the input stream
(`\x1b[<64|x;yM`), which tmux parses from the client regardless of the mode.
Button 64 = wheel up (older history), 65 = wheel down, matching natural touch
scrolling (finger down reveals older content). Coordinates come from the touch
point mapped to terminal cells via `cellAt()`.

`touch-action` reverted to `pinch-zoom`: with the bridge owning the vertical
gesture, allowing native panning (`pan-y`) would let the browser start a scroll,
cancel our pointer stream, and produce no scroll at all - and under tmux there
is no local scrollback to pan anyway.

Verified on a phone-sized viewport against the live deployment, with tmux's own
state as the oracle (a bash pane in mode `drag`, 265 lines of history):
- swipe **down** (older content) -> `pane_in_mode=1 scroll_position=165` - entered
  copy-mode and scrolled 165 lines into history
- swipe **up** -> `pane_in_mode=0` - returned to the live tail and auto-exited
  copy-mode (tmux `copy-mode -e` semantics, unchanged)
- real mouse-wheel events -> `pane_in_mode` stays `0` - desktop wheel remains a
  deliberate no-op

No image rebuild was needed: the container serves the frontend from the shared
worktree (`root * {$OMP_WEB_ROOT}/web`), so `web/` edits are live on reload.
16/16 unit tests pass. Test sessions/containers removed; the seven pre-existing
host panes were untouched.
### Rolled back to the pre-today frontend, then re-added the key-bar buttons

Owner preference: the pre-today version felt better on the phone, so the
frontend and tmux config were rolled back to **18.3.2-23** (the last build
before 2026-10-07), then the key-bar button work was ported back on top.

**How "pre-today" was established.** Nothing is committed (last commit
2026-09-27), but every image build baked a snapshot of `web/` into the image,
so the images are the version history: `18.3.2-23` is 3 days old, `-24..-37`
are all from 2026-10-07. The whole `/opt/omp-web` tree was extracted from the
`18.3.2-23` image and diffed against the worktree. Only four runtime files had
changed: `web/app.js`, `web/style.css`, `web/index.html`, `tmux.conf`
(everything else - launcher, entry, upload service, Caddyfile - was identical,
so no image rebuild was involved).

**Restored** (byte-identical to the image, verified with `cmp`): those four
files, plus `web/vendor/` regenerated to the pre-today set (addon-canvas +
addon-fit + xterm; the clipboard addon removed) and the matching
`package.json` / `build-web.mjs` lines reverted. `tmux.conf` was applied to the
**running** server with `tmux source-file` - no restart, so all panes kept
running.

**Then re-added, on request** ("would like those buttons back") - only the
button work, nothing else:
- key bar visible on **all** devices again (`#keybar { display: flex }`), with
  compact 32px buttons for mouse and 44px under `any-pointer: coarse`
  (`#composer-toggle` matched)
- the **Scroll** button (`data-key="scroll"`) with its pressed-state styling,
  the `scrollModeArmed` toggle + `setScrollMode()`, `'scroll'` in
  `NON_REPEATING_KEYS`, the mouse-release/Enter/Escape toggle syncs, and the
  vi-key navigation (`k`/`j`) while scroll mode is armed

**Still at pre-today values** (not restored, since only buttons were asked
for): the astigmatism palette, clipboard/OSC52 bridging, the full-buffer Select
dialog (back to viewport-only), `macOptionClickForcesSelection`,
`altClickMovesCursor`, the selection highlight colours, and the *fixed*
touch-swipe path - so the swipe bridge is the original mode-dependent one
(it relies on xterm forwarding synthesized wheel events, which was measured not
to happen in tmux's `drag` mode; the mode-independent fix is documented above
and can be re-applied alone if the phone swipe proves unreliable).

Verified live (scratch session, desktop and phone viewports): key bar
`display:flex` with 19 buttons, Scroll button 32px on mouse / 44px on touch;
pressing Scroll entered tmux copy-mode (`pane_in_mode=1`), five Up presses
scrolled five lines of history (`scroll_position=0 -> 5`), pressing Scroll
again exited (`pane_in_mode=0`) and cleared `aria-pressed`; no JS errors.
16/16 unit tests pass. The seven pre-existing host panes were untouched.

A snapshot of the superseded 2026-10-07 version is kept at
`~/omp-web-after-2026-10-07/` with a `RESTORE-README.txt` giving the exact
commands to put it back.
### Applied the recommended items one at a time (on top of the pre-today base)

Each was applied and verified individually against the live deployment. Two of
the six turned out to need no change at all - both corrections to my own
earlier claims, caught by measuring instead of assuming:

| # | item | outcome |
|---|---|---|
| 1 | touch-swipe implementation | **applied** - swipe now emits SGR wheel reports directly (`sendSwipeScroll`/`cellAt`) instead of synthesizing DOM wheel events for xterm to forward. Verified live in the previously-failing case (`mouseTrackingMode: 'drag'`): swipe down -> `pane_in_mode=1 scroll_position=100`; swipe up -> `pane_in_mode=0` (back to live). Scoped to touch only: `sendTrackedScroll` and the desktop wheel handler are untouched. |
| 2 | Select dialog scope | **applied** - iterates the whole buffer and opens at the user's position (verified `scrollTopAtBottom: true`). Correction: under tmux the client buffer is exactly `rows` (measured `textareaLines == bufferLength == 37 == rows`), so "full buffer" and "viewport" hold identical text here; the real gain is opening at the bottom instead of line 1. Correct in principle, effectively a no-op in this deployment. |
| 3 | selection highlight | **applied** - `selectionBackground #2b4a6b` / `selectionInactiveBackground #243040`. Verified by forcing a real local selection: `getSelection()` returned content and the highlight renders. |
| 4 | clipboard (OSC 52) | **NO CHANGE NEEDED - my earlier claim was wrong.** The pre-today frontend already implements OSC 52 itself via `term.parser.registerOscHandler(52, ...)`: decodes with `TextDecoder`, calls `navigator.clipboard.writeText`, shows a notice when denied, and deliberately never answers clipboard *queries*. Verified end-to-end: a pane emitting `ESC ] 52 ; c ; <b64>` produced a real `clipboard.writeText("OSC52-LIVE-TEST")`. (Today's addon-based version was an implementation swap, not a capability gain.) |
| 5 | `macOptionClickForcesSelection` + `altClickMovesCursor:false` | **applied** - both options verified live; Shift+drag (non-Mac path) selects locally. The Option+drag half cannot be exercised in the Linux-reporting test browser (xterm only honours Option when it detects macOS), so that needs confirmation on the actual Mac. |
| 6 | astigmatism palette | **applied** - theme bg/`b4bcca` fg/calibrated ANSI 16, `theme-color`, page/composer/dialog surfaces, and the `.xterm-viewport` `#000` -> `#161a21` override. Verified: canvas pixel sampled at two points is `#161a21`, viewport bg `rgb(22,26,33)`, theme values correct. |
| 7 | `touch-action` | **NO CHANGE** - today's snapshot is already `pinch-zoom` too (it was reverted when the swipe bridge was restored), so there was no difference to apply. |

16/16 unit tests pass; no JS errors; scratch session removed and the eight
pre-existing host panes untouched.

### Full history in the Select dialog, paged from tmux (`18.3.2-38`)

Owner asked for the whole history to be available in the Select window (rather
than the one screen the browser can see), with scroll-to-top loading more.

**Why it needed a server endpoint.** Under tmux the client's xterm buffer never
grows beyond one screen - tmux repaints the pane region with cursor addressing
instead of streaming scroll-inducing newlines (measured repeatedly:
`textareaLines == bufferLength == term.rows`). So the browser cannot see history
at all; it has to be captured from tmux. The container can: the socket is
mounted and `tmux` is in the image.

**New `GET /history`** on the existing upload/presence service (routed by a new
`handle /history*` in the Caddyfile):

    /history?window=@N&offset=<lines back from the end>&count=<page size>

Returns `{ok, window, offset, count, total, start, more, lines[]}`. Implemented
on `tmux capture-pane` with absolute-to-tmux offset mapping
(`-S {start-history_size}`, `-E {end-1-history_size}`), verified against
`-S -`/`-S -N`/`-S -N -E -1` semantics before writing any code. Guard rails: the
window target must match `^[A-Za-z0-9_@:.+-]{1,64}$` (never a shell string -
args are passed as a list), `count` is capped at 5000, a negative `offset` is
rejected rather than clamped, and an unknown target returns 404. Notably tmux
answers an unknown target with **exit 0 and empty expansions**, so the endpoint
validates the resolved `#{window_id}` rather than the exit status.

**Dialog** (`web/app.js`): opens with the newest 1000 lines scrolled to the
bottom; scrolling to the top fetches the next older page and prepends it,
adjusting `scrollTop` by the height added so the line being read stays put.
Falls back to the local one-screen snapshot when there is no window (launcher
menu) or the service is unreachable.

Verified live on a scratch session (3002 lines total = 2885 history + 117
screen, matching tmux's own count): dialog opened with 1000 lines at the
bottom; scroll-to-top gave 2000 (`first 2002 -> 1002`, `scrollTop` exactly
`newHeight - oldHeight`); further pages 3000 -> 3002, then "Start of history."
with no further requests. Touch scrolling in the textarea confirmed on a phone
viewport. 22/22 tests pass, including new integration tests that page a real
throwaway tmux server and assert pages are adjacent, capped, and that a dead
socket yields 404 rather than a 500.

**Security note:** the endpoint exposes a window's full scrollback over HTTP,
and the container has no authentication (tailnet-gated at Caddy only). Approved
by the owner ("entire history is fine"); scoped to an explicit window target and
line cap.

Still plain text - colour capture (`-e`) is available in the endpoint but not
requested by the client yet.

### History: colour, no wrapping, and search (`18.3.2-39`)

Three requests against the history dialog.

**Colour.** `/history` already supported `capture-pane -e`; the client now
requests `color=1` and renders the SGR runs as spans. Written as a hand-rolled
scanner (`splitSgr`) rather than a regex - scanning for `ESC [ ... m` by
character code avoids an escape-laden pattern entirely. Colours 0-15 come from
the live xterm theme (so the dialog matches the terminal exactly); 16-255 use
the standard xterm cube/greys, the same values xterm renders for those indices.

**No wrapping.** The dialog body moved from `<textarea>` to `<pre>` with
`white-space: pre` and `overflow: auto`, so long lines scroll sideways instead
of wrapping and breaking the line-per-row mapping. A `<pre>` also means the
history is real DOM text, so native selection works (and `user-select: text`
applies).

**Search.** New `GET /history/search?window=@N&q=…&limit=…&case=0|1` searches the
**whole** scrollback server-side - the client only ever holds a few pages, so a
client-side find could not reach anything older than what has been paged in.
Returns absolute line indices, newest match first; `limit` capped at 500, and
`truncated` reports when the cap was hit. The client debounces input, shows
`n/total`, and jumps between matches with the ↑/↓ buttons or Enter/Shift+Enter.

**Bug found and fixed while verifying:** next/previous did not advance. The jump
correlated DOM marks with results by *full line text*, but marks hold only the
matched substring, so it always resolved to the first match. Fixed by rendering
one addressed element per line (`<span class="line" data-line="N">`), so a
result's absolute index maps straight to its line and then to its mark - no text
correlation. The match counter now reflects the result set, not marks in view.

Verified live on scratch sessions:
- colour: 403-line history rendered as 400 styled spans, hues matching the
  terminal behind it; `white-space: pre`, horizontal overflow present
- search: `marker-250` -> `1/1`, jumped to that line, highlighted; `marker-25`
  -> 11 matches, navigation advanced 1/11 -> 2/11 -> 3/11 -> 4/11 and back, each
  step moving to the right line (258 -> 257 -> 256)
- copy: `Copied 403 lines.`
- load-more still correct with the new renderer: 1000 -> 2000 lines, first line
  `2002` -> `1002`, scroll position preserved exactly

26/26 tests pass (new: search indices round-trip into page offsets, newest-first
ordering, case sensitivity, cap + truncation, and rejection of a missing query).

### Cross-surface scroll/select: browser, Electron (Ferdium), iPhone, iPad

The surfaces differ in pointer type, modifier availability and clipboard
permissions, so each was checked against what it actually reports rather than
assumed. The one real defect found was shared by three of the four:

**Scroll was dead on every non-touch surface.** The wheel path still went
through the old DOM-wheel synthesis (`sendTrackedScroll`), which depends on
xterm forwarding wheel events - and xterm forwards none in tmux's usual `drag`
(1002) mode (measured 0 bytes earlier). So a desktop browser, an Electron shell
and an iPad *trackpad* all silently did nothing, while the touch swipe (fixed to
emit SGR reports directly) worked. Both paths now use one sender,
`sendScrollReports`, which writes `ESC [ < 64|65 ; x ; y M` straight into the
input stream; `sendTrackedScroll` and its `repeatedWheels` WeakSet are gone. The
`shiftKey` special case was dropped too: under tmux there is no local scrollback
for Shift+wheel to scroll, so it now scrolls history like any other wheel. The
no-mouse-reporting branch (launcher menu) still scrolls xterm's own buffer, and
Ctrl+wheel still returns `false` so trackpad pinch-zoom stays native.

Measured per surface (tmux `pane_in_mode` / `scroll_position` as the oracle):

| surface | pointer profile | scroll gesture | result |
|---|---|---|---|
| desktop browser (mouse) | `any-pointer: coarse` false, 32px buttons | wheel up x6 | `in_mode=1 scroll=52` |
| Electron / Ferdium | same Chromium code path as desktop; cannot be launched here | wheel | same path as desktop |
| iPhone (390x844, touch) | coarse, 44px buttons, composer 16px | touch drag down | `in_mode=1 scroll=99` |
| iPad (820x1180, touch) | coarse, 44px buttons, `<dialog>` OK | touch drag down | `in_mode=1 scroll=100` |
| iPad + trackpad | wheel events, not touch | wheel up x6 | `in_mode=1 scroll=52` |

**Selection is already surface-appropriate**, and was re-verified: desktop drag
goes to tmux copy-mode (the `alternate_on` binding), Shift/Option+drag forces a
local selection; on touch a drag scrolls (the bridge marks the gesture as moved
and suppresses the synthetic mouse events, so it cannot accidentally select) and
copying goes through the Select button. In the dialog the history is now real
DOM text (`user-select: text`, `touch-action: auto`), so native long-press
selection works there; verified on a phone viewport that Select all selects
17991 chars and Copy reports "Copied selection.", and that search finds
`surface-line-2500` on exactly line 2500.

Two things could not be verified here and are flagged rather than assumed:
native long-press selection inside the dialog and the macOS Option+drag gesture
both need real hardware (synthetic events do not drive the browser's native
selection UI), and Ferdium itself cannot be launched in this environment - its
scroll path is the same Chromium code verified on desktop, but its clipboard
permission behaviour is untested. The copy path is defensive for exactly that
reason: `navigator.clipboard.writeText` first, then a real selection plus
`document.execCommand('copy')`, then a visible notice - so a denied write in
Electron or iOS degrades to "select and copy manually" instead of silently
failing.

26/26 tests pass.

### A click no longer becomes a drag (runaway selection fix)

Reported: "when i scroll and click on any text, and when i scroll again, it
selects all the text on the way."

Root cause, reproduced on a throwaway server and then through the real UI:

1. tmux's copy-mode-vi binds `MouseDrag1Pane` to `begin-selection`, which sets a
   selection **anchor** (state `selection_active`), not just a visible selection.
2. Real mice jitter a pixel or two between press and release, and xterm reports
   that motion as a mouse drag - so an ordinary click reached tmux as
   `MouseDrag1Pane`. Measured: a 2px jitter gave `in_mode=1 sel_active=1`.
3. Scroll moves copy-mode's cursor, and tmux **extends an active selection** as
   the cursor moves. Measured on the throwaway server: `begin-selection` then 5
   `scroll-up` produced a selection spanning exactly 5 lines - one per scroll.

Note `clear-selection` does not help: it clears the visible selection but leaves
the anchor (`selection_active` stays set), so the next scroll extends it again -
verified by the control run, which still produced a 5-line selection.

Fix (client-side): a mouse drag dead-zone, mirroring the touch bridge's 8px
threshold. `mousedown` inside the terminal records the press point; a
window-level *capture-phase* `mousemove` swallows motion reports until the
pointer has moved 4px, then lets them through. Capture on `window` is required
because xterm binds its drag tracking on `document`, and same-node capture
listeners fire in registration order - xterm's is registered first, so a
document listener would run too late. A genuine drag still reports normally
after the threshold, and mousedown outside the terminal (e.g. inside the dialog)
never arms the dead-zone, so text selection there is unaffected.

Verified through the real UI against tmux state as the oracle:
- jittery click (2px): `in_mode=0`, no anchor (was `in_mode=1 sel_active=1`)
- genuine 120px drag: `in_mode=1 sel_active=1 sel_present=1`, and the copied
  buffer held real text (`click-line-274` / `click-line-275`) - drag-select
  still works
- the reported sequence (scroll -> click -> scroll): `in_mode=1 sel_active=0
  sel_present=0 scroll=88` - scrolling still works and **no** selection appears

Also worth recording: the first attempt at this fix placed the code before
`const surface = term.element`, so `surface.addEventListener` hit the temporal
dead zone and threw `ReferenceError: Cannot access 'surface' before
initialization`, leaving the page stuck on "Connecting…" - which made an
intermediate "drag produced no selection" observation meaningless. Caught by
checking for page errors and the connection state rather than trusting the tmux
reading; the block was moved after the declarations and re-verified.

26/26 tests pass.

### Scrolling cancels the selection; clipboard denial is now actionable

**Scrolling cancels an in-progress selection.** Follow-up to the click fix: a
*deliberate* drag still sets a selection anchor, and tmux extends an active
selection as the cursor moves, so scrolling after selecting dragged the
selection along with it. The copy-mode wheel bindings now clear the selection
first:

    bind -T copy-mode-vi WheelUpPane   send-keys -X clear-selection \; send-keys -X -N 3 scroll-up
    bind -T copy-mode-vi WheelDownPane send-keys -X clear-selection \; send-keys -X -N 3 scroll-down-and-cancel

Applied to `tmux.conf` and to the running server. Verified through the UI:
drag-select (`active=1 present=1`) then five wheel notches -> `active=0
present=0 scroll=45`, i.e. the selection is cancelled and scrolling still works.
(Touch swipes send the same wheel reports, so they behave identically.)

Correction to an earlier note in this file: `clear-selection` *does* reset the
anchor (`selection_active` 1 -> 0). The earlier "control" test that suggested
otherwise was reading a stale tmux buffer left over from the previous run.

**Clipboard denial is no longer a dead end.** tmux copies asynchronously, so the
page has no user gesture and browsers (Safari especially, and Chrome when the
tab is unfocused) refuse `navigator.clipboard.writeText`. Previously that only
produced "Clipboard copy was denied - select terminal text and copy it
manually". Now the text is kept and the notice offers a **Copy** button that
performs the write inside a real gesture, falling back to a scratch selection
plus `document.execCommand('copy')` if the async API still refuses.

Verified with the async write stubbed to reject (as Safari does): the notice
appeared with the button (`writes: ["async-denied"]`), clicking it retried the
async API, fell through to `execCommand:copy`, and reported "Copied to
clipboard." With the real API the write succeeds silently and no notice appears
(`NORMAL-COPY-PATH` written, notice hidden).

The virtual-cursor idea was dropped at the owner's request; not implemented.
### Review batch: upload corruption, races, and dead code (`18.3.2-40`)

A full review of the appliance (frontend, service, build, deployment) produced a
prioritised finding list. This batch applies the mechanical fixes; the items that
need a policy decision are listed at the end and remain open.

**Uploads no longer corrupt each other.** `unique_filename` checked
`path.exists()` and then opened with `'wb'`, so two same-second uploads of the
same name chose one path and truncated each other's writes. The file is now
reserved with `open(path, 'xb')` and a collision advances the counter, making the
reservation atomic. Verified live: six concurrent uploads of `same-name.txt`
produced six distinct files with intact bodies (the responses interleave, the
contents do not).

**Multipart framing is removed exactly.** `raw_body.rstrip(b'\r\n')` stripped
every trailing CR/LF byte, silently eating a file's own trailing newline and
truncating any binary payload ending in 0x0A. The parser now removes only the
CRLF that frames the part. Verified live through the HTTPS route (an 18-byte
body ending in `\n` round-trips byte-identically) and through the browser's
**Attach** button at a 420x860 mobile viewport (29 bytes in, 29 bytes out, the
draft receiving `@/home/jieniu/.omp/uploads/<name>`).

**A stalled client can no longer pin a thread.** The declared `Content-Length`
was read with no socket timeout, so a half-open connection held a worker thread
and a part-written file indefinitely. Body reads now carry a 30 s timeout; on
timeout or disconnect the partial file is deleted and the client gets 408 (raw)
or 400 (incomplete).

**`/presence` is race-free and validated.** Concurrent heartbeats shared one
`<path>.tmp` name, so the second `os.replace` raced the first
(`FileNotFoundError`, or an in-place write to the published file). Each request
now uses its own `mkstemp` file. The `window` label - which the Discord alert
trusts - is validated against `WINDOW_RE` (400 otherwise); an absent window is
still accepted.

**Paging past the oldest line returns an empty page.** tmux clamps `-S`/`-E` to
the oldest row, so an offset past the end returned one unrelated line with
`more: true`. It now returns `lines: []`, `more: false`.

**Frontend.** `renderAnsi` rebuilt the 240-entry palette per line (~1.2M colour
strings on a 5000-line history); the palette and default colours are now built
once per render batch. The copy button no longer trims the selection - leading
indentation and trailing newlines are part of what the user selected - and its
fallback carries exactly that payload instead of selecting the whole history.
The stale `mouseup` reset is gone: it assumed tmux's `copy-pipe-and-cancel`, but
the binding is `copy-selection-no-clear`, which stays in copy-mode, so the toggle
was being cleared while copy-mode was still active. Search matches carry an
explicit foreground: the inherited colour was 3.8:1 against the match background,
now 6.2:1. Removed as dead: the `keyMoved` flag (set true and then immediately
nulled by `stopKeyRepeat`, never observed - `activePointerId` already gates the
release), `applyHighlights`' unused return, the unreachable
`#connection[data-state="connected"]` rule, and `do_OPTIONS` (the frontend never
preflights, so the permissive CORS advertisement was pure attack surface).

**Tests.** 29/29 pass. Three regressions added: multipart trailing-newline
preservation, the empty page past history, and `/presence` window validation. The
search test no longer depends on the shell's prompt text (it searched for
`BASH-5.2`, which fails on other bash versions); it searches a mixed-case marker
written into the fixture. `package-lock.json` was regenerated - it still listed
`@xterm/addon-clipboard` and `js-base64`, removed from `package.json` earlier.

Image `18.3.2-40`, deployed to `omp-web-host.service`. Verified after the
restart: the same host tmux window reconnects, the dialog lists 402 lines and 111
matches with the new 6.2:1 match colour, the keybar still sends its key
(`[48, 9]` = Tab), and all nine pre-existing pane PIDs are unchanged - the
restart disturbed no host process.

**Left open (policy, not mechanical):** the appliance has no authentication of
its own, so any tailnet device that reaches `127.0.0.1:17688` gets an interactive
shell as host UID 1000 with `$HOME` and the user systemd bus mounted. Adding a
CSP/`frame-ancestors` header and capping concurrent request threads (the 30 s
timeout bounds each request, but a flood can still spawn unbounded threads) are
the two follow-ups worth taking next.

### Desktop wheel scroll slowed to a normal rate (`18.3.2-41`, frontend)

One mouse-wheel notch moved 9 lines of history - measured through the UI as
`scroll_position` 9 -> 18 per notch - because a wheel event emitted `SCROLL_SPEED`
(3) SGR wheel reports and each report is bound to `-N 3` `scroll-up` inside
copy-mode (`tmux.conf`). Desktop wheel events now emit a single report
(`WHEEL_REPORTS`), so a notch moves 3 lines - the usual terminal rate, a 3x
reduction. The touch path keeps its own multipliers (`SCROLL_SPEED` for the
launcher, 1.5 with mouse reporting), so phone swipe distance is unchanged, and so
is the launcher-menu wheel path.

Verified through the UI against tmux's own counter: one notch at `deltaY` -100
emits 1 report and moves `scroll_position` 18 -> 21; wheel-down moves 21 -> 18;
two notches move 0 -> 6. A 100px touch swipe still emits 7 reports along the
untouched path. Image `18.3.2-41`, deployed to `omp-web-host.service`;
all nine pre-existing pane PIDs unchanged.

### Scroll button removed and keybar arrows fixed (`18.3.2-42`, frontend)

**The Scroll button is gone**, along with all of its client-side mode state
(`scrollModeArmed`, `setScrollMode`, the `scroll` key branch, the `k`/`j`
remapping, the `#scroll-toggle` styling rule). It had become redundant:

- the wheel/trackpad enters copy-mode by itself through tmux's own root binding
  (`WheelUpPane` -> `copy-mode -e; scroll-up`) and scrolls 3 lines per notch;
- a touch swipe sends the same reports, so phone scrolling is unaffected;
- keybar Up/Down keep scrolling history in copy-mode with no client-side mode
  tracking at all - measured `mode=1`, `scroll_position` 1 -> 2 for a keybar Up
  after a wheel entry, which is exactly what the button's `k`/`j` remapping
  existed to provide (tmux resolves the browser's arrow to its named `Up` and
  runs `cursor-up`; `copy-mode-vi` already binds `Up`/`Down`);
- Escape still leaves copy-mode, scrolling to the bottom still cancels it, and
  the Select dialog remains the full-history/search/clipboard surface.

**Keybar arrows were also broken at a shell prompt** (pre-existing, independent
of the button). The frontend sent CSI arrows (`ESC [ A`) whenever DECCKM was
off, but both terminfo entries in this stack declare the SS3 form - the client's
`TERM=xterm-256color` and the pane's `tmux-256color` both say `kcuu1=\EOA` - and
tmux parses client input against the client's entry. Measured by injecting raw
bytes into the live socket: CSI up is passed through untouched and types `[A` at
a bash prompt, while SS3 up recalls the history entry. Arrows are now always SS3.

Verified live after deploy: Up recalls `seq 1 300 | sed "s/^/final-/"`, Left /
Right / Down insert nothing, a `less` pane scrolls one line per arrow (Enter
1 -> 2, Down -> 3, Up -> 2), a wheel notch still moves 3 lines (0 -> 1 -> 4), and
the keybar has 18 buttons with no console errors. Image `18.3.2-42`, deployed to
`omp-web-host.service` (200 locally; both the served and in-image
frontends are free of `scroll-toggle`); all eight pre-existing pane PIDs
unchanged.

### Wheel scroll slowed to one line per notch (`18.3.2-43`)

Follow-up to `18.3.2-41`, which took a notch from 9 lines to 3 (one report per
notch x tmux's `-N 3` copy-mode binding). The frontend was already at its floor -
one report is the fewest a wheel event can send - so the remaining factor came
from tmux: the wheel bindings now use `-N 1`. The root binding that runs before
copy-mode already scrolled one line, so a notch is now **1 line** on every
surface of the terminal, which also makes the first notch and the rest uniform.

The touch multiplier moved from 1.5 to `TOUCH_REPORTS_PER_ROW = 4.5` so the phone
keeps exactly the distance it had: reports-per-row x lines-per-report stays 4.5.
Measured after the change, a 10-terminal-row finger swipe moves 35 lines - the
same 35 the old code produced (11.7 reports x 3 lines) - while four wheel notches
move `scroll_position` 0 -> 4.

Applied to `tmux.conf` and to the running host server (`tmux source-file`), so
native clients attached to that server inherit the slower rate too. Verified
after deploy: keybar arrows still recall history, and all eight pre-existing pane
PIDs unchanged. Image `18.3.2-43`.

### Copy in Safari: gesture-safe ordering, and Command-C (`18.3.2-44`, frontend)

Reported: selected text could not be copied in Safari. Both copy paths tried
`navigator.clipboard.writeText` first and only fell back to the synchronous
`document.execCommand('copy')` after awaiting that promise. WebKit honours a user
gesture only inside the task that started it, and Safari's clipboard rejection
arrives in a *later* task, so the fallback ran with no gesture left and failed as
well - the one path that works was disabled by the await. The synchronous command
now runs first (`copyInGesture`), inside the click's guaranteed gesture, with the
async API as the fallback. Measured with the async API stubbed to refuse in a
later task: both the notice's Copy button and the Select dialog's Copy button
succeed through the synchronous path and never touch the async one
(`execCommand:copy -> true`, one async attempt, the OSC 52 one).

Command-C after a tmux copy also did nothing, which is what a Mac user tries
first: tmux copies on its own, so the OSC 52 write has no gesture and the browser
refuses it (the notice covers that, but only if its button is pressed). A `copy`
listener now honours that gesture - `clipboardData.setData` in a copy event needs
no permission - when a refused tmux copy is pending, no DOM selection exists, and
the pending copy is under two minutes old. Verified with a synthetic copy event:
`text/plain` receives the tmux text and the event is cancelled, while a real
selection is left to the browser. Gated to Apple platforms, since elsewhere
Ctrl-C is the terminal's interrupt; measured on a Linux user agent that the gate
is inert and that Ctrl-C still reaches the pty (`^C` twice in the pane).

Safari itself could not be exercised here - there is no Safari on this host - so
the failure mode was reproduced against WebKit's documented per-task gesture
rule, not in Safari. Image `18.3.2-44`, deployed to `omp-web-host.service`.

### The copy notice refreshes on every terminal copy (`18.3.2-45`, frontend)

Reported from Safari: the copy notice appeared once and then stopped, and the
browser's own Copy was greyed out. The latter is expected - with tmux owning the
drag there is no DOM selection, so macOS Edit > Copy has nothing to copy and the
notice *is* the copy affordance. The former was the bug: the notice was only
raised when the async clipboard write *rejected*, so once a write was accepted
the app said nothing and left the previous notice - and its Copy button - frozen,
making the next selection look like the option had disappeared.

Every terminal copy now refreshes the notice. A write that lands shows
"Copied to clipboard." for four seconds with the Copy button still available; a
refused write keeps the persistent notice and its button. The bar is an absolute
overlay (`position: absolute`, z-index 5), so showing it does not reflow the
terminal or resize the tmux pane.

Verified with the async API stubbed both ways: silent success -> the notice
appears on the first and the second copy and clears itself after 4s; refusal ->
it appears on both copies and is still present after 4.5s with the button
visible. Image `18.3.2-45`, deployed to `omp-web-host.service`.

### A scissors flash for a copy that lands (`18.3.2-46`, frontend)

A brief scissors pill replaces the success notice: centred at the top in the
notice's palette, 850 ms of fade and scale via the Web Animations API (so a
repeat copy restarts it cleanly instead of fighting a CSS animation). It is an
absolute overlay with `pointer-events: none`, so it neither reflows the terminal
nor resizes the tmux pane, and a successful copy no longer raises the notice bar
at all. A refused write still raises the persistent notice with its Copy button.

Wired to every path that puts text on the clipboard: the terminal's OSC 52 copy,
the notice's Copy button, the Command-C handler, and the Select dialog's Copy.
Also fixed here: the notice's Copy button still updated the notice by hand - the
`18.3.2-45` patch to that handler never matched its source - so it left the bar
on screen instead of clearing it.

Verified through the UI: a terminal copy shows the pill (36x36 px, top centre,
`opacity: 1`) and it clears itself within ~1 s; a refused write shows no pill and
keeps the notice with its button; that button flashes the pill and hides the bar;
Command-C does the same under a macOS user agent and stays inert under a Linux
one; the dialog's Copy flashes it alongside "Copied 33 lines.". A screenshot of
the pill was captured for the visual check. Image `18.3.2-46`, deployed to
`omp-web-host.service`.

### Inline images render instead of a blank block (`18.3.2-47`)

omp supports three terminal graphics protocols (Kitty `ESC _ G`, iTerm2
`ESC ] 1337;File=`, SIXEL `ESC P q`) and, once it decides the terminal has one,
reserves rows for an image and emits it. This terminal rendered none of them, so
the reservation arrived as the large blank block.

Two layers were missing:

- **The client**: xterm.js has no image support of its own. `@xterm/addon-image`
  (SIXEL + iTerm2 IIP) is vendored and loaded after the canvas renderer.
- **tmux**: `allow-passthrough` was unset, and tmux 3.3+ defaults it *off*, so it
  discarded the DCS passthrough envelope an application must wrap graphics in.
  It is now `on` in `tmux.conf` and applied to the running server. Tradeoff,
  noted in the file: a program in a pane can then emit sequences straight to the
  browser terminal - acceptable for a single-user terminal, and required for
  images at all.

omp additionally gates SIXEL emission on two variables
(`PI_FORCE_IMAGE_PROTOCOL=sixel`, `PI_ALLOW_SIXEL_PASSTHROUGH=1`), so the
launcher passes both to every window it creates. It passes them with tmux `-e`
rather than through its own environment, because panes inherit the *server's*
environment and not the creating client's - measured: a launcher-created pane
showed the server's `TERM` while the launcher sets `xterm-256color`. `os.environ`
still wins, so an operator can pin another protocol or switch images off without
editing the launcher.

Verified: `tmux new-window -e ...` puts both variables into the pane's
`/proc/<pid>/environ`; a 96x72 SIXEL emitted through the real path renders as a
red/blue image in the browser (`.xterm-image-layer` present, screenshot
captured) where the same sequence produced nothing before. The addon renders
SIXEL and iTerm2, not Kitty, so forcing SIXEL keeps both ends agreed. Existing
omp processes keep their old environment - a new window is needed.

### Web-rendered window bar replaces tmux's status line (`18.3.2-48`)

tmux's status line was a single terminal row (`status-position top`), hard to tap
accurately, and it cost a row on every client including native ones. It is now
off (`set -g status off`; the `window-status-*` formats became inert and were
dropped), and the frontend draws its own bar:

- `GET /windows` lists every session's windows (session, index, name, id, active,
  dead, path) through the service's existing tmux helper, with the same field set
  as `omp-launcher`'s own listing.
- `POST /windows/select?window=@N` runs `select-window`, so the client attached to
  that session follows. Both validate the target against `WINDOW_RE`: a malformed
  one is a 400, an unknown one a 502 (tmux refuses it).
- The bar is 36px of real buttons, scrolls horizontally, marks the active window
  per session, dims dead panes, and scrolls the tapped tab into view. It polls
  every 3s while the tab is visible and stops when hidden, mirroring the presence
  heartbeat's lifecycle, and stays hidden on the launcher page where no session
  is attached.

Caddy needs a `/windows*` route to the service, added next to `/upload`,
`/presence` and `/history`.

Verified: 33 unit tests pass, including four new endpoint tests (listing fields,
switching makes the window current, 400 on a malformed target, 502 on an unknown
one). In the browser on a session with three windows: the bar lists all twelve,
tapping `bartest:2 three` moves tmux's active window to three and the client
follows (the pane's `I-AM-WINDOW-THREE` marker fills the screen), and tmux's own
status row is gone. Image `18.3.2-48`.

### Paste handles an image on the clipboard (`18.3.2-49`, frontend)

The Paste button read only `readText()`, so a clipboard holding an image (a
screenshot, a copied picture) pasted nothing and the user had to reach for
Attach. Paste now falls through to `navigator.clipboard.read()` when there is no
text: the first `image/*` item becomes a File and goes through the same
upload-and-insert path as Attach, so omp receives `@/home/jieniu/.omp/uploads/…`
and can open it. Text still wins when both are present - a clipboard copied from
a page carries both, and a terminal expects the text there. A clipboard with
neither now says so instead of silently doing nothing.

The upload tail was extracted into `uploadFiles(files)`, shared by the file
picker and the clipboard path.

Verified with a real `ClipboardItem`: a 172-byte PNG on the clipboard was
uploaded byte-identically (matching SHA-256) and its `@path` was inserted into
the terminal; text still pastes as text; an empty clipboard shows the notice.
Image `18.3.2-49`.

### Pasting an image works in Safari too (`18.3.2-50`, frontend)

`18.3.2-49` read clipboard images with `navigator.clipboard.read()`, which Safari
does not implement at all, so on Safari the Paste button still did nothing for an
image. Safari exposes clipboard images only through a **paste event**, so that is
now handled directly: a `paste` listener in the capture phase (before xterm sees
it) uploads the first `image/*` item and inserts its `@path`, exactly like Attach.
Text pastes are untouched - ⌘V of text still reaches the shell - and the button
keeps working for text everywhere. Where the button cannot read an image (no
`clipboard.read`), the notice now says what to do instead: "Nothing to paste as
text. Press the paste shortcut (⌘V) for an image, or use Attach."

Verified: a synthetic paste event carrying a 113-byte PNG was intercepted
(`defaultPrevented`) and uploaded byte-identically (matching SHA-256, original
filename preserved) with its `@path` inserted into the terminal; a text-only paste
event was not intercepted; with `clipboard.read` removed (Safari's shape) the
button shows the guidance notice. Image `18.3.2-50`.

### iPhone: paste guidance, and the path that works there (`18.3.2-51`, frontend)

Safari on iOS has no `navigator.clipboard.read()` (as on macOS) and no Command-V,
so the notice `18.3.2-50` added was giving advice that cannot be followed on a
phone. It is now platform-aware: Apple touch devices - iPhone/iPad, where iPadOS
reports itself as a Mac so `maxTouchPoints` is the tell - are told to use
**Attach**, which opens the photo library; other platforms keep the ⌘V hint.

The `paste` listener still applies on iOS: if the platform offers its paste menu
over the terminal, an image lands exactly as it does on macOS. The reliable path
there is Attach, and that is now what the app says.

Verified at a 390x844 touch viewport with an iPhone user agent: the Paste button
shows "Nothing to paste as text. Use Attach to pick a photo or a file.", and
picking a file through the hidden input uploaded it and inserted
`@/home/jieniu/.omp/uploads/20261008_211641_iphone-photo.png` into the shell.
Image `18.3.2-51`.

### Window bar: finished-turn highlight, and drag-and-drop upload (`18.3.2-52`)

**A finished turn is visible again.** tmux's status line highlighted a window when
something happened in it - for omp that is the bell it rings when a turn
completes. `/windows` now reports tmux's `window_activity_flag` and
`window_bell_flag`; the bar outlines and dots those tabs, and a tab that *becomes*
flagged scrolls itself into view, since an off-screen highlight is not a
notification. tmux clears both flags when the window is selected, so viewing a
window dismisses it - measured: a bell in a non-current window set `bell=1` and
selecting it cleared it. `monitor-activity` is off by default, so activity flags
appear only if it is turned on; the bell does not depend on it.

**Drag and drop uploads.** Dropping files anywhere on the app uploads them through
the same `uploadFiles` path as Attach and Paste, with a "Drop to upload" overlay
while dragging; dropping a link or a selection types it into the terminal.
`dragover`/`drop` are cancelled, which is also what stops the browser navigating
away from the session and opening the file.

Verified: 34 unit tests pass, including a new one that rings a bell in a
non-current window, sees the flag, and watches it clear on select. In the browser:
a dropped 28x18 PNG uploaded byte-identically (SHA-256 match) with its `@path`
inserted; the drag overlay appeared during the drag and cleared after the drop;
a bell set `data-bell` with the amber outline and dot, and scrolled the flagged
tab into view (`scrollLeft` 314 -> 471) when it was off-screen; tapping it cleared
the flag. Image `18.3.2-52`.

### Renamed to omp-web, branches consolidated (`18.3.2-52`)

The rebuild is now simply `omp-web`: this directory, the deployment unit
(`omp-web-host.service`, container `omp-web-host`), the image
(`localhost/omp-web:18.3.2-56`, retagged from `localhost/omp-web-rebuild:...`) and
the preview quadlet (`omp-web-preview`). The legacy ttyd + screen implementation
moved to `~/.containers-arc/omp-web-screen` and lives on the branch
`legacy-screen`, recorded exactly as it last ran - its worktree had nine
uncommitted files that were never captured while it served traffic.

`main` is now the rebuild (it was the orphan `rebuild/from-scratch`), so a clone
gives the current implementation and the legacy history is one branch away. Both
branches are on `origin`; earlier sections of this file name the image as
`localhost/omp-web-rebuild:18.3.2-N` because that is what it was called then.

Two things this turned up:

- **The quadlet generator had been failing silently.**
  `~/.config/containers/systemd/` is a directory of symlinks into each project;
  nine pointed at deleted projects (`n8n`, `radicale`, `windmill-media`,
  `x_scrape`), and one dangling symlink makes the generator abort *and emit
  nothing* - so no quadlet unit was being generated at all, while running
  containers kept going and `daemon-reload` reported success. The dangling links
  are parked in `~/.config/containers/systemd.broken/`; generation now emits 93
  units. Check it with
  `rm -rf /tmp/genout && mkdir -p /tmp/genout && /usr/libexec/podman/quadlet -user /tmp/genout`.
- Because of that, the container was started once by hand to restore service
  while the generator was fixed, then replaced by the unit-managed one.

### Sharp text on high-DPI and fractionally-scaled displays (`18.3.2-53`, frontend)

xterm.js's canvas renderer rasterises glyphs at `devicePixelRatio` device pixels
per CSS pixel. When that ratio is fractional - a 4K display at 125%/150% scaling,
or any browser zoom level - each glyph lands on a fractional device pixel and the
canvas smooths it, which reads as soft text. Text also stayed soft after dragging
the window onto such a display, because a ratio change need not change the
terminal's CSS size, so nothing re-measured: the old canvas kept rendering at the
old scale until a reload.

The frontend now picks the renderer from the ratio: **canvas when the ratio is a
whole number** (crisp at 1:1 or 2:1 device pixels, and worth its speed there), and
the **DOM renderer otherwise**, which lays out real text and lets the browser
rasterise at the true device resolution. A `matchMedia('(resolution: Ndppx)')`
listener re-applies the choice and refits when the ratio changes, so moving the
window between displays no longer leaves text soft until reload.

Verified the decision for the ratios that matter (1, 2, 3 -> canvas; 1.1, 1.25,
1.5 -> DOM) and that `(resolution: 1.5dppx)` is a valid media query. **Not**
verified in a browser: the CDP Chrome used for UI checks is wedged, so the runtime
switch itself is unexercised - it is a pure function of `devicePixelRatio` plus a
standard media-query listener.

Other levers, both live without a redeploy since the frontend is served from this
worktree: the A-/A+ keybar buttons for font size (stored per browser), and ttyd
`-t` options for anything else (`fontFamily`, `fontWeight`, `letterSpacing`,
`lineHeight`) - `omp-web-entry` builds the ttyd command line.

### Renderer override for judging sharpness (`18.3.2-54`, frontend)

`18.3.2-53` switched to the DOM renderer only when the device ratio is fractional,
so on a display with a whole ratio it changes nothing - reported as "didn't notice
anything different", which is the expected result if the ratio is 1 or 2 and means
the softness has another cause (display scaling, font, size, or a taste for the
DOM renderer's crisper glyphs).

Rather than guess again, the choice is now overridable on the live site:
`?renderer=dom`, `?renderer=canvas` or `?renderer=auto` (append with `&` when the
URL already carries `?arg=...`). The choice is remembered in localStorage, so the
page can be reloaded and compared without editing the URL again; `auto` returns
to the ratio-based rule. DOM is sharper - real text at the device resolution -
while canvas is steadier under rapid output, and which matters more is a
judgement only the person in front of the display can make.

### Renderer default follows the input device (`18.3.2-55`, frontend)

Asked "didn't we make it dom by default before?" - correct: the DOM renderer was
the default until `18.3.2-23`, which replaced it with canvas because rapid output
and scrolling were jittery, "especially on mobile". Both observations are real and
pull opposite ways. The DOM renderer lays out real text and lets the browser
rasterise at the device resolution, with per-glyph font fallback - sharp. Canvas
is far steadier under rapid output - smooth - but rasterises each glyph itself.

So the default now follows the input device: a **coarse** pointer (a phone) keeps
canvas, a **fine** pointer (a desk, a TV) gets the DOM renderer back. A fractional
device ratio rules canvas out in either case, since that is the softness
`18.3.2-53` aimed at. `?renderer=dom|canvas` still forces one and remembers it,
and `?renderer=auto` clears the choice.

This also removes the mistake in the `18.3.2-53` default: it only ever changed
the renderer at a fractional ratio, so a display with a whole ratio - the common
case - saw no change at all, which is exactly what was reported back.

Decision, as pointer/ratio -> renderer: fine/1 dom, fine/2 dom, fine/1.5 dom,
coarse/3 canvas; an explicit preference always wins.

### Duplicated text after a resize (`18.3.2-56`, frontend)

Reported with a phone screenshot: the same transcript visible twice at two cell
sizes, the older copy faint and smaller behind the newer one, and whole blocks
repeated. `tui.resizeScrollback` is `preserve` here ("repaint only the viewport,
keep history wrapped at its old width"), so omp is *not* replaying the
transcript - the older copy is the terminal's own renderer keeping rows from a
previous geometry.

Two changes, one of which is mine to own:

- **`scrollIntoView` on a window-bar tab** (`18.3.2-52`) can move the *visual
  viewport* on iOS, which resizes the terminal. That runs whenever a tab becomes
  flagged, so it fired often. The bar now scrolls itself with `scrollLeft`
  (`revealTab`), which cannot touch the page or the viewport.
- **Glyph and row caches are now dropped when the geometry changes**: after a fit
  that actually changes cols/rows, and after a font-size change, the app calls
  `term.clearTextureAtlas()` and repaints the viewport. Cached glyphs are keyed by
  size, so without this a resize or a zoom can leave text drawn at the old size.

Not reproduced: the phone is the user's, the CDP Chrome used for UI checks is
wedged and SSH to that workstation is denied, so this is a diagnosis from the
screenshot plus the code paths, not a verified fix. The reasoning that makes it
likely: the faint copy is *smaller* than the real text, which only happens when
two cell sizes are on screen at once.

### SIXEL receives the browser's pixel geometry (`18.3.2-57`)

Reported images still appeared as a rectangle of `+`/`X` cells after
`18.3.2-47`. The missing layer was not the image addon, pane environment, or
tmux passthrough setting. ttyd 1.7.7 sent only character columns and rows in its
resize ioctl, leaving `ws_xpixel` and `ws_ypixel` at zero. tmux 3.5a parsed omp's
raw SIXEL and stored the image, but its client renderer deliberately substituted
`SIXEL IMAGE (...)` plus a grid of `+` cells when it could not derive a pixel
size. Both attached browser clients confirmed `#{client_cell_width}x
#{client_cell_height}` was `0x0`.

The earlier `18.3.2-47` smoke test used a hand-built SIXEL sequence already
wrapped in a tmux passthrough DCS. That bypassed tmux's native image renderer and
therefore did not exercise omp's real raw-SIXEL path. Capturing omp's actual
protocol test showed unwrapped `ESC P9;1;0q` data. Setting the scratch client's
PTY dimensions to 1350x665 changed tmux's reported cell geometry from `0x0` to
`10x19` and immediately replaced the fallback grid with the image, isolating the
cause before code changes.

The frontend now includes the `.xterm-screen` CSS width and height with columns
and rows in ttyd's initial and resize messages. A small pinned-source patch to
ttyd carries those values into Linux `winsize.ws_xpixel/ws_ypixel`; CSS pixels
are intentional because the xterm image addon reports the same coordinate
space to omp. Pixel-only geometry changes are sent too, even when the character
grid is unchanged.

Built and deployed `localhost/omp-web:18.3.2-57`. After a fresh page load, the
real deployed tmux client reported `10x19` cells. Omp's `/debug` terminal
protocol test rendered its gradient SIXEL instead of fallback characters; the
xterm image canvas contained 70,374 non-transparent pixels in bounds
`0,285-316,506`. All 34 unit tests and the frontend syntax check passed. The
service restart preserved all eight pre-existing pane IDs and PIDs.

### Inline images survive terminal resize (`18.3.2-58`)

tmux 3.5a unconditionally frees every stored image when its screen's character
grid changes. `18.3.2-58` therefore changed the overlay from `preserve` to
`rebuild`, based on the assumption that OMP's viewport-only repaint would not
re-emit a visible SIXEL image. The clean preserve-mode check in `18.3.2-59`
disproved that assumption; this policy is superseded below.

The `18.3.2-58` overlay set `tui.resizeScrollback: rebuild`. After the
resize settles, omp clears the stale terminal scrollback and replays one copy
of its transcript at the new width, including each inline image. `append` was
not used because it would retain and duplicate the old-width transcript on
every resize.

Built and deployed `localhost/omp-web:18.3.2-58`. A real omp bash-tool result
rendered a 240x120 gradient through SIXEL; resizing the deployed browser from
135x35 cells to 98x32 and back kept 199,704 non-transparent image-canvas pixels.
The image addon's last ID advanced from 16 to 20 to 33, confirming transcript
replay rather than a stale canvas. All 34 unit tests and the frontend syntax
check passed. The service restart preserved all eight existing pane IDs and
PIDs, including the isolated smoke pane.

### Tab switches no longer replay the transcript (`18.3.2-59`)

Reported after `18.3.2-58`: selecting another terminal tab visibly replayed an
OMP session from its first message to the live tail. That was the configured
`tui.resizeScrollback: rebuild` behavior, triggered whenever tmux resized a
window as the web client selected it. It was not an xterm or window-bar
rendering bug.

The overlay is back to `tui.resizeScrollback: preserve`. OMP now repaints only
the current viewport after a resize, leaving native tmux history untouched. A
clean OMP pane rendered a real 240x120 SIXEL bash-tool result and then resized
from 160x43 cells to 116x38: the image remained visible with 201,612
non-transparent canvas pixels, while the image ID advanced from 1 to 4. This
demonstrated that OMP's forced viewport repaint does re-emit a visible image;
full transcript replay was unnecessary.

Built and deployed `localhost/omp-web:18.3.2-59`. After deployment, switching
between two differently sized OMP windows showed the destination's final tail
in samples taken 80, 260, and 910 ms after selection, never the transcript
start. Resizing the selected pane from 116x38 to 160x42 cells retained the same
201,612 image pixels and one stored image; its ID advanced from 10 to 12 as the
viewport repaint re-emitted it. All 34 unit tests and the frontend syntax check
passed. The restart preserved all eleven existing pane IDs and PIDs, including
the four isolated smoke panes.

### Durable terminal image gallery (`18.3.2-60`)

The resize fix above keeps a visible image on screen, but tmux still discards
its own image object when geometry changes and cannot provide old inline images
from scrollback. The frontend now captures each image canvas exposed by
`@xterm/addon-image` after terminal writes settle. **Images** opens a
window-scoped HTML gallery; its count follows the selected tmux window. The
gallery survives terminal resize, tab switching, WebSocket reconnects and page
reloads. Capture necessarily starts when a browser renders the image; output
produced only while no web client is attached cannot be recovered from tmux.

`POST /artifacts?window=@N` accepts a bounded 25 MB PNG body. The Python service
validates the PNG signature and IHDR dimensions while streaming to a temporary
file, keys the final name by SHA-256, and atomically links it into
`~/.omp/web-artifacts/<tmux-server-start>-<window-id>/`. Repaints and reconnects
therefore deduplicate instead of growing the gallery. Pairing the window ID with
tmux's server start time prevents an `@N` reused after a tmux restart from
inheriting unrelated images. `GET /artifacts` lists newest first and
`GET /artifacts/<sha256>.png` serves the image.

Built and deployed `localhost/omp-web:18.3.2-60`
(`d7ed014b745dc76c83d3c2f042a22694c06a19418d93d97887251b6de684cf4f`).
All 36 unit tests, the JavaScript syntax check and Caddy validation passed. The
restart preserved all eight existing pane IDs and PIDs. In an isolated deployed
browser smoke, a 240x120 SIXEL gradient produced one deduplicated 240x132
rendered-canvas artifact and an **Images (1)** gallery card. Resizing the
terminal from 78x26 to 108x33 cells kept the count at one. Switching to a second
scratch window showed no artifacts, switching back restored **Images (1)**, and
a full page reload still showed the same single card. The scratch windows,
artifact and browser page were removed afterward.

### One Artifacts window for images, uploads and agent downloads (`18.3.2-61`)

The **Images** gallery is now **Artifacts**. It contains three window-scoped
sources: raster images rendered by xterm, files sent through the browser's
Attach/paste/drop upload path, and completed files the agent explicitly
provides for download. Raster PNG/JPEG/GIF/WebP files preview inline. Every
type has its original name, source, size, creation time and a Download link;
all non-preview types are served with `Content-Disposition: attachment` and
`X-Content-Type-Options: nosniff`, so HTML/SVG or arbitrary agent output cannot
execute in the terminal page's origin.

Storage is shared by `omp_artifacts.py`: immutable `<sha256>.blob` data plus a
small JSON metadata record under the existing tmux-generation/window
directory. Browser uploads are copied into it only after their bounded upload
completes. `omp-artifact` performs the same bounded copy for a local file. The
launcher loads `omp-artifact-extension.ts` explicitly for every new or resumed
OMP process; its essential `provide_artifact` tool tells agents to register a
file whenever the user asks them to create, export, deliver or provide a
download. Ordinary project files that an agent merely edits are deliberately
not registered. The frontend refreshes the count with the existing three-second
window-bar poll, so an agent-created file appears without reopening the page.

Built and deployed `localhost/omp-web:18.3.2-61`
(`fdd43775468ef37c0a2403601b14e3329ca039d9e32f6a3db53c2ec655769dd5`).
All 37 unit tests, the JavaScript syntax check and Caddy validation passed; the
restart preserved all eight existing pane IDs and PIDs. A deployed scratch OMP
session loaded the extension and used `provide_artifact` to register a 20-byte
CSV. Browser Attach registered a 25-byte text file, and reading a generated
gradient produced a third, previewable terminal-image artifact. The live
Artifacts window showed all three cards with Agent, Uploaded and Terminal image
sources. Deployed downloads returned the exact CSV/text bytes with attachment
headers; another tmux window showed no artifacts, switching back restored
**Artifacts (3)**, and a full page reload retained the same count. The browser
tab, tmux session, source files, upload copy, persisted artifacts and screenshots
were removed afterward.

### Artifact capture no longer scans on every scroll repaint (`18.3.2-62`)

Reported that scrolling no longer behaved like it did before the image/artifact
work. The wheel/touch handlers, tmux bindings and `tui.resizeScrollback:
preserve` setting were unchanged, but the artifact implementation had added a
cost directly behind them: `term.onWriteParsed(scheduleArtifactScan)`. tmux
implements history scrolling by repainting the terminal, so every wheel notch
caused the artifact scanner to inspect every visible cell. The deployed
78-column by 26-row diagnostic measured exactly **2,028 image lookups per
notch**, even in a pane containing no image.

Ordinary output no longer schedules an artifact scan. A small allocation-free
streaming detector now recognizes SIXEL DCS and iTerm2 IIP headers across
WebSocket frame boundaries; only output that can add an image schedules the
post-parse scan. Explicit resize and tab-switch scans remain, covering images
already held by the addon without putting work in the scroll path.

Built and deployed `localhost/omp-web:18.3.2-62`
(`c1bf752e0aa5a43e608e0382d4f000d6b66fa85fcd8c8d497700b469972ea364`).
All 37 unit tests, JavaScript syntax checking and Caddy validation passed. On
the deployed page, one wheel notch entered tmux copy mode and moved exactly one
line while performing zero artifact lookups. A real ImageMagick SIXEL gradient
then triggered one 2,028-cell scan and appeared as one previewable Terminal
image artifact; another wheel notch moved one line and left the lookup count
unchanged at 2,028. The restart preserved all eight pre-existing pane IDs and
PIDs. The browser page, scratch tmux session and persisted artifact were removed.

### Artifacts matches key sizes; Compose scrolls with the keybar (`18.3.2-63`)

The standalone Artifacts control now uses the same padding and height rules as
the keybar buttons: 32px on a fine pointer and 44px on a coarse pointer. Compose
is no longer pinned at the left edge. It moved into the horizontally scrollable
keybar after Attach, leaving Artifacts as the sole fixed control.

Verified on the deployed page at desktop and iPhone-sized touch layouts:
Artifacts, Compose and Select measured 32px high on desktop and 44px high with a
coarse pointer. Compose's parent is `#keybar`, at index 3 after Select, Paste and
Attach; opening it set `aria-expanded=true` and exposed the composer, and closing
it reversed both states. All 37 tests, the JavaScript syntax check and Caddy
validation passed. Built and deployed `localhost/omp-web:18.3.2-63`
(`7a90556df203ed6e801b2b21953baa86daef8acb3c12b2abd60625e89ae12fde`).

### Larger iPhone window and key bars (`18.3.2-64`)

Coarse-pointer layouts now use a 60px top window bar with 52px window buttons,
and a 65px bottom tools row with 52px Artifacts/keybar buttons. Gaps, horizontal
padding and the window-label font grow with the touch targets. Fine-pointer
desktop dimensions remain unchanged.

Verified on the deployed page at an emulated 390x844 iPhone viewport: the top
bar measured 60px, its buttons 52px, the bottom bar 65px and every visible
control 52px. The terminal still fit 40 columns by 37 rows in the remaining
719px. At 900x700 with a fine pointer, the original 36px top bar and 32px
controls remained unchanged. All 37 tests, JavaScript syntax checking and Caddy
validation passed. Built and deployed `localhost/omp-web:18.3.2-64`
(`50f5c7c62088b5f94093b1f2360e95b3cbf13712ec670aef1e47f0c6fec3afa2`).

### File drops are captured before terminal descendants (`18.3.2-65`)

Reported that drag-and-drop attachment stopped working. Follow-up comparison
found that the drag handlers themselves had not changed between the pre-today
frontend and `18.3.2-64`; the only adjacent upload-path change was adding
`?window=@N` so successful uploads also become Artifacts. Replaying the exact
`18.3.2-64` JavaScript against the current deployed Chromium page successfully
completed a native file drop, so that change was not a general Chromium
regression and the original trigger was not proven. The first diagnosis
overstated the evidence.

The old path did contain two latent cross-surface assumptions: a drop had to
bubble from the xterm/image-renderer descendants to `#app`, and
`DataTransfer.types` had to implement `.includes()` even though WebKit may expose
a DOM string-list shape. The app now owns drag enter/over, leave and drop in the
capture phase, normalizes `types` with `Array.from`, falls back to file-kind
`items`, and stops an owned drop before a descendant can consume or duplicate
it. Attach and clipboard-paste still use the unchanged `uploadFiles` tail.

Verified through the deployed browser with a native CDP file drag onto the
xterm screen: drag enter displayed the drop overlay; drop cleared it, uploaded
the exact 19-byte file, inserted its `@/home/jieniu/.omp/uploads/...` path into
the live shell prompt, showed the Attached notice and registered one
`browser-upload` artifact for the tmux window. All smoke files, the upload copy,
artifact, browser page and scratch session were removed. All 37 tests,
JavaScript syntax checking and Caddy validation passed. Built and deployed
`localhost/omp-web:18.3.2-65`
(`63c162bb218852fa543911b53c8c362bb34ef6bfe0c15b425c9b9348ae9116f6`).

### Discord alerts deep-link to the notifying window

`discord-alert` now resolves its own `$TMUX_PANE` to the stable tmux window id
and adds `https://omp.jieniuu8.com/?arg=tmux-N` to each Discord embed. The embed
title is clickable and the message includes an **Open OMP session** link button.
Opening it bypasses the launcher and attaches directly to the window that sent
the notification. The existing tailnet restriction still applies; no credential
or access token is placed in the URL. `OMP_WEB_BASE_URL` can override the site
root if this extension is reused elsewhere.

The extension compiled successfully. A credential-free mocked delivery from pane
`%6` produced both an embed URL and link-button URL ending in `?arg=tmux-6`.
A deployed-browser smoke link to isolated window `@30` opened with
`arg=tmux-30`, reported connected and showed that window's tmux title; the tab
and scratch session were removed. New OMP processes load the change
automatically. Existing long-running OMP processes must run `/reload` once
because extension source is loaded into each process.

### Mail, calendar, and omp share one terminal shell

Host Caddy now serves `terminal-shell.js` and `terminal-shell.css` on all three
terminal origins. The shell generates the common Copy/Paste and terminal-key
controls and owns gesture-aware clipboard fallback, notice presentation, font
zoom, keyboard lock, touch-safe repeat/cancellation, connection-state display,
and resize triggers. omp supplies a direct-xterm adapter and retains its
WebSocket flow control, tmux window bar, pixel-size resize frames, renderer
selection, wheel/touch copy-mode bridge, composer, uploads, selection history,
and artifacts.

The resize boundary deliberately combines lessons from both implementations:
the shell observes window, visual-viewport, terminal-element and font-ready
changes and performs bounded startup retries; omp's adapter still coalesces each
request through `requestAnimationFrame`, fits with `FitAddon`, invalidates the
canvas atlas after metric changes, and reports rows, columns and nonzero pixel
dimensions to the PTY. Mail's explicit `FontFaceSet.load()` and font-family
reassignment remain local because omp uses platform fonts rather than lazy
webfonts.

Live verification used isolated tmux window `@35`. Shared Paste delivered
terminal input, Enter executed it, and SS3 Up recalled it. Prefix state changed
to armed after Ctrl-A and reset after the following key. Copy captured the xterm
selection. Resizing from 1280x800 to 800x500 changed xterm from 140x39 to 86x22
and the PTY `TIOCGWINSZ` result from `39 140 1260 702` to
`22 86 774 396`. Wheel input still entered tmux copy mode. Composer, selection
history, and Artifacts dialogs remained operational.

### OMP owns transcript reflow; shared copy feedback keeps its scissors

OMP exposes three resize modes through `tui.resizeScrollback`: `append` keeps
old history and replays at the new width below it, `preserve` repaints only the
viewport while retaining native tmux history, and `rebuild` erases terminal
scrollback before replaying one current-width transcript. The web launcher uses
`preserve`. In `pi-tui`, the `rebuild` branch runs before its width-only guard,
so every settled height change triggers the destructive replay even though the
implementation's own contract says height-only changes reflow nothing. Mobile
keyboard and visual-viewport transitions produce several such heights.

Deferring rebuild until scroll is not a sound boundary here: tmux consumes the
wheel/touch reports in copy-mode, so OMP never receives a scroll event, and
erasing/replaying history while it is being read would reset that position.
Preserving tmux history avoids the repeated buffers without introducing a
browser-to-OMP control protocol or mutating scrollback during navigation.

Mail and calendar get their white scissors from ttyd 1.7.7 itself: its
`onSelectionChange` handler runs `document.execCommand("copy")`, then its
`OverlayAddon` renders the text glyph `✂` at terminal centre with `#101010` on
`#f0f0f0`, 0.75 opacity, a 15px radius, 200ms hold and 180ms fade. OMP bypasses
the ttyd frontend and therefore had neither that handler nor the overlay addon.
The shared shell now gives OMP the same glyph, styling, terminal-centred
position and timing after a successful copy. Mail and calendar leave this
optional replica disabled so their original ttyd overlay remains the sole icon.
Clipboard refusal still leaves the actionable error notice.

### Coalesced mobile swipes retain their full distance

The touch bridge used to subtract the complete calculated scroll distance from
its accumulator before `sendScrollReports()` capped transmission at 15 reports.
Mobile browsers coalesce fast gestures into fewer pointer moves, so the result
depended on event cadence: a 22-row swipe delivered as three moves calculated
99 reports but sent only 45; the same return swipe delivered as one move sent
15 and left tmux copy-mode 30 lines above the live OMP editor.

The sender now returns the signed report count it actually transmitted. The
pointer path subtracts only that count, retains capped overflow, and flushes the
remaining physical swipe distance on `pointerup`, bounded to one terminal
height. It does not add inertial scrolling or focus the hidden xterm textarea,
so returning to the live editor does not unexpectedly open a mobile keyboard.

Live verification used an iPhone-emulated 390x844 viewport and isolated tmux
window `@36` with 500 history lines and an `ENTRY>` tail. Before the change, a
three-event swipe followed by a one-event return left
`pane_in_mode=1 scroll_position=30`, with `ENTRY>` absent. After the change the
same gestures moved all 99 requested lines, returned
`pane_in_mode=0`, and rendered `ENTRY>` as the last terminal row. One-event and
12-event gesture pairs also returned to the live row, proving behavior no
longer depends on browser pointer-event coalescing.

### Compose synchronizes the live OMP editor

Opening an empty Compose panel in a running OMP pane invokes OMP's built-in
**Copy prompt** action (`Alt-Shift-C`, encoded by xterm as `ESC C`). OMP reads
its semantic editor with `getText()` and returns UTF-8 through OSC 52; while the
request is pending, the browser routes that one response into the textarea
instead of the system clipboard. `/windows` exposes only an `editor` boolean,
derived from the pane's current and start commands, so post-exit shells and
unrelated full-screen applications never receive the shortcut.
Drafts containing OMP image, video, large-paste, skill, or model chips stay in
the terminal: `getText()` exposes their display labels but not attached bytes or
submit-time expansions, so importing them would silently degrade semantic data.

Synchronization is non-destructive: OMP retains its original draft while the
textarea is edited. **Replace** re-reads the OMP draft and proceeds only if it
still exactly matches the imported source and the same tmux window is active.
It then sends OMP's normal clear action before bracketed-pasting the replacement,
preventing duplication. A changed window, changed live draft, failed response,
or changed textarea aborts without modifying either draft. Existing local
Compose text is never overwritten; shell panes keep the original append-only
Paste behavior.

Live verification used an iPhone-emulated 390x844 browser and isolated tmux
session `omp-compose-smoke`. A two-line Unicode OMP draft synchronized exactly,
remained visible in OMP, and an edited two-line replacement returned without the
source text being duplicated. A concurrent external edit was detected and left
both drafts intact. Empty OMP input opened an empty disabled panel; a shell pane
was marked `editor: false` and received no bytes. The textarea retained focus on
the coarse-pointer surface. The helper-service restart preserved every
pre-existing pane PID.

### Explicit Reflow button clears scrollback and replays transcript

A new **Reflow** button in the tools keybar next to Compose triggers an
on-demand display reset. In an OMP session (`activeOmpEditorWindow`), it emits
`Alt-L` (`\x1bl`). OMP responds by issuing `ED2+ED3` (`\x1b[2J\x1b[3J`), which
clears tmux's pane scrollback history, and replays the entire conversation
cleanly wrapped to the current column width. In plain shell or non-OMP panes, it
sends `Ctrl-L` (`\x0c`) for standard shell redraw.

In `tmux.conf`, `bind -T copy-mode M-l` and `bind -T copy-mode-vi M-l` cancel
copy-mode and forward `M-l`, so tapping Reflow while scrolled back into history
automatically returns to the live tail and re-renders the clean transcript.
This avoids the involuntary churn of `resizeScrollback: rebuild` while giving
the user deliberate, one-tap control over transcript rewrapping after phone
rotation or font size changes.

### Two-row toolbar layout and A0 zoom reset

The bottom tools area now renders in two independent, horizontally scrollable
rows instead of crowding service actions and terminal keys together:

- **Row 1 (Service actions)**: `Artifacts`, `Select`, `Attach`, `Compose`,
  `Reflow`.
- **Row 2 (General terminal keys)**: `Copy`, `Paste`, `Esc`, `Enter`, `⌫`, `^C`,
  `Tab`, `↑`, `↓`, `←`, `→`, `^A`, `A−`, `A0`, `A+`, `Detach`.

`^L` (which collided with OMP voice mode) and `^D` (accidental EOF/exit) were
removed from the default keybar. `A0` resets terminal font zoom to default
(14px), removes any stored `terminal-font-size` override from localStorage,
re-fits the terminal, and shows a brief confirmation notice.

The tools area adds `padding-bottom: max(12px, env(safe-area-inset-bottom, 0px))`
and `padding-left/right: max(8px, env(safe-area-inset-left/right, 0px))` on mobile,
lifting the buttons above iPhone display corner radii and the iOS home indicator bar.

### Mobile tap-to-focus calibration and copy-mode exit

Tapping the terminal on mobile touchscreens sometimes closed the software
keyboard automatically or failed to return to the live prompt line:

1. **Tap wobble detection**: A thumb contact area naturally wobbles 8–12px on
   retina screens. The 8px drag threshold classified minor wobbles as a scroll,
   skipping `focusTerminal(true)`. The browser saw a tap on a non-input element
   without synchronous focus, prompting WebKit to dismiss the keyboard. The drag
   threshold is raised to 14px and taps are judged by whether any lines were
   actually scrolled (`touch.scrolled`).
2. **Pointer capture completion**: In WebKit, `lostpointercapture` can fire
   ahead of `pointerup`. Checking `event.type !== 'pointerup'` treated this
   normal release as a cancellation (`cancelled = true`), skipping focus.
   Only `pointercancel` now marks a gesture as cancelled.
3. **Direct prompt return**: In `tmux.conf`, `MouseDown1Pane` in `copy-mode-vi`
   and `copy-mode` is bound to `select-pane ; send-keys -X cancel`. A clean tap
   while scrolled back into history cancels copy-mode, snaps the terminal back
   to the live prompt row, and focuses the editor.

### Unified Catppuccin Mocha theme across homelab web terminals

Unified the color scheme across all three web terminals (OMP, Mail, and
Calendar) using the ergonomic **Catppuccin Mocha** palette:

- **Astigmatism ergonomics**: Eliminates pitch-black (`#000000`) halation and
  high-contrast glare. Background is soft charcoal-indigo (`#1e1e2e`), panels and
  bars use mantle (`#181825`), and text is soft lavender-cream (`#cdd6f4`).
- **ADHD visual calm**: Replaced saturated neon ANSI colors with muted pastels
  (soft pink `#f5c2e7`, peach `#fab387`, sage green `#a6e3a1`, sky blue
  `#89b4fa`).
- **Stack unification**:
  - `terminal-common/terminal-shell.css`: `--terminal-shell-*` variables set to
    Catppuccin tokens.
  - `omp-web/web/style.css`: All backgrounds, buttons, composer, dialogs, and
    search match Catppuccin Mocha.
  - `omp-web/web/app.js`: xterm ANSI 16 palette matches Catppuccin Mocha.
  - `omp-web/omp-config.yml`: Sets `theme.dark: dark-catppuccin` for OMP TUI.
  - `mail/aerc`: ttyd configured with Catppuccin Mocha JSON theme.
  - `mail/calendar`: Shared shell and Calcure calendar align with the identical
    palette.

### Prevent iOS Safari keyboard blur on terminal touch

On iOS Safari, touching any non-input DOM element (`<div>`, `<canvas>`) while an
input is focused triggers WebKit's default tap behavior: it immediately blurs the
active input and begins dismissing the software keyboard. Because touch listeners
used `passive: true` and deferred focus to `pointerup`, quick taps (<200ms) had
their keyboard closed before `pointerup` could re-focus, requiring a longer hold
to keep the keyboard open.

1. **Touchstart blur prevention**: On `touchstart`, when `term.textarea` is
   focused, calling `event.preventDefault()` prevents WebKit from executing its
   default blur action, keeping the software keyboard open across touches.
2. **Synchronous focus on touch-down**: When keyboard is active, `pointerdown`
   synchronously re-asserts focus on `term.textarea`.
3. **Deferred pointer capture**: `surface.setPointerCapture` is deferred until
   swipe movement past `TOUCH_DRAG_THRESHOLD` begins, eliminating premature
   capture release and lost-pointer-capture cancellations on quick taps.
4. **Tap-to-prompt SGR dispatch**: Clean taps on mouse-tracked panes emit a
   `MouseDown1Pane` SGR sequence, triggering tmux's copy-mode cancel binding
   and snapping directly to the live prompt.
