# omp-web — Web Terminal for omp Sessions

> Dir name kept as `~/.containers/omp-web` (Caddy root + habit); everything in it is omp now.
> The domain is `omp.jieniuu8.com` (renamed from claude.jieniuu8.com, 2026-09-25).

## Overview

Web terminal exposing persistent **host tmux windows** running omp behind
`https://omp.jieniuu8.com` (Caddy + Cloudflare DNS + Tailscale). Browser and
local terminals use the same launcher and tmux windows. Legacy screen
sessions remain attachable, but the launcher creates only tmux windows.

The appliance bundles ttyd, tmux, screen, Python, Caddy and the standalone
omp binary for **Linux x86-64**. Without host mounts it uses container-local
tmux. The homelab quadlet is host-specific: home path, UID, user-systemd and
tmux socket mounts must be adapted on another machine. Host tmux settings
(prefix, mouse, copy-mode bindings) are not baked into the image.

**Ports:**
- `127.0.0.1:7682` → ttyd — the homelab contract: host Caddy serves the
  wrapper at `/` from `~/.containers/omp-web/web` and proxies `/t/*` here.
- `127.0.0.1:7685` → in-container Caddy (:8080) serving the wrapper at `/`
  and proxying `/t/*` — the **self-contained front** for machines without a
  host Caddy. One port = the whole app.

**Host-command hatch:** the container mounts `/run/user/1000/systemd` and
`/run/user/1000/bus` (both created by systemd at login on any Linux machine —
zero host setup). From inside, omp gets `systemctl --user` and
`systemd-run --user --pipe --wait <cmd>` = run commands as the user on the
host and capture output. These mounts grant host-user authority; they are
not a security boundary.

**Session lifetime:** host tmux windows survive container restarts. Any
container-local tmux/screen processes die with the container; recover their
saved sessions via `[pick]`.

## Architecture

```text
Browser → host Caddy → / wrapper from mounted web/
                    → /t/* → ttyd :7682 → omp-web-launch → omp-launcher
                                                           ↓
Local omp-attach ───────────────────────────────────→ host tmux windows

Standalone front: container Caddy :8080 → same wrapper and ttyd
```

- The entrypoint supervises both Caddy and ttyd. Either server exiting
  stops its sibling and fails the appliance; `Restart=on-failure` recovers it.
- A normal container stop shuts down both servers successfully.
- ttyd launches one picker per WebSocket connection; closing a browser tab
  detaches its client without closing host tmux windows.
- Host tmux windows run the host's `omp`. Container-local execution uses
  the baked `/usr/local/bin/omp`; mounting home does not change that PATH.

## Container / Deployment

- `~/.containers/omp-web/Containerfile` — appliance image. Pins the upstream
  **standalone omp release binary** (`omp-linux-x64` v18.3.2, sha-verified —
  omp lazily loads native addons from the bun cache, which fresh machines
  don't have, so a self-contained binary is the only portable shape).
  Fedora 44 supplies ttyd/screen/python3/caddy/git/systemd. The omp version
  and `OMP_SHA256` pin must be updated together.
- `~/.containers/omp-web/omp-web-entry` — supervises the internal Caddy front
  and ttyd on **0.0.0.0** (required for pasta port forwarding). Its generated
  Caddy disables the admin API and config persistence.
- `~/.containers/omp-web/omp-web-launch` — prefers the mounted repository's
  executable launcher, falling back to `/opt/omp-web/omp-launcher`.
- `~/.config/containers/systemd/omp-web.build` — build unit.
- `~/.config/containers/systemd/omp-web.container` — quadlet → user unit
  `omp-web.service`. Image from `registry.jieniuu8.com/omp-web:latest`
  (unauthenticated, tailnet-only per image-publish house rules).

Build numbering follows the image-publish skill. The polish build is
`localhost/omp-web:18.3.2-11`, built and smoke-tested locally; it has **not**
replaced the running image or been published. It predates the phone hotfix.
For a future rollout, rebuild current source under the next unused tag
(the example below uses `18.3.2-12`) during a maintenance window:

```bash
tag=18.3.2-12
podman build -t "localhost/omp-web:$tag" ~/.containers/omp-web
podman push "localhost/omp-web:$tag" "registry.jieniuu8.com/omp-web:$tag"
podman push "localhost/omp-web:$tag" registry.jieniuu8.com/omp-web:latest
podman pull registry.jieniuu8.com/omp-web:latest
systemctl --user restart omp-web.service
```

Restart disconnects browser clients and any container-local processes,
including agent tools running in this appliance. Host tmux windows survive.
ttyd `-O` rejects cross-origin WebSockets; this is not authentication.

Two custom terminfos (sources: `ttyd-256color.src`, `ttyd-256m.src`), both
copies of xterm-256color renamed, compiled into the image at /etc/terminfo and
into the host user's `~/.terminfo` (which rides with the bind-mounted home for
fresh machines):

- **`ttyd-256color`** (ttyd's default via `-T`) — stripped of `kmous`, so
  screen's D_CXT flag stays 0 and inner programs' `\e]0;<title>\007` don't get
  forwarded to the outer terminal (which would overwrite the browser-tab title
  with the chat topic every turn).
- **`ttyd-256m`** — same but **with `kmous=\E[<`**: tmux only enables and
  parses SGR mouse on the outer terminal when kmous is present, so without it
  the web client gets no mouse at all — the wheel falls back to xterm.js
  alternateScroll (up/down arrows = history rotation) and status-bar/TUI
  clicks are dead. The launcher exports `TERM=ttyd-256m` **only around `tmux
  attach`** (`tmux_attach` helper); screen sessions keep the stripped TERM
  (GNU screen has no mouse support anyway).

## Web UI extras

**Mobile** — the wrapper adds what ttyd/xterm.js lack on phones:
- **Touch bridge**: capture touch pointers on the stable xterm element.
  The DOM renderer replaces text rows during scrolling; raw TouchEvents
  keep targeting the detached original row and previously stopped after
  the first movement. Captured pointers survive those redraws. With mouse
  tracking, send wheel events to `.xterm-viewport` for tmux copy-mode;
  otherwise scroll xterm's own buffer directly without injecting keys.
  Finger down reads older history; finger up returns toward the bottom.
  Multi-touch is reserved for pinch zoom, and swipes do not act as clicks.
- **Key bar** (any coarse pointer, including hybrid devices): Esc/Tab/arrows/
  ^C/^D/^L/prefix/Detach/Paste, with 44px targets, accessible labels and
  visible keyboard focus. Actions refocus xterm's textarea rather than the
  iframe body. Arrows honor DECCKM; the prefix exposes its armed state.
- **Keyboard-aware sizing**: `interactive-widget=resizes-content` for Android;
  the visual-viewport path also covers browsers that do not resize layout
  for the keyboard. Normalize `visualViewport.height` by its scale, cap at
  layout height, then assign the iframe an explicit pixel height after
  safe-area padding and the key bar. Do not skip resize updates while
  zoomed: that can strand the terminal at its keyboard-open height.
- **Paste fallback:** denied or unavailable Clipboard API opens a modal for
  native keyboard/touch paste. Sending uses xterm's mode-aware `paste()`;
  cancelling sends nothing. OSC52 copy failures show a visible notice.
- **Magnification:** browser zoom is enabled; pinch zoom does not repeatedly
  refit terminal columns. Safe-area padding covers the top and both sides
  as well as the bottom toolbar.

**Status line (omp)** — stock defaults (no `statusLine:` block in
`~/.omp/agent/config.yml`): `π · model · mode · collab · stream · path · git ·
pr · context_pct · cost` left, `session_name` right, and the embedded
Context-Reactive meter in the separator (`▶──…┃…216K─`, percentage marker
proportional, can exceed 100% past auto-compact). `statusLine.contextLine`
enum: `off|percentage|annotated|embedded`. Removing the whole block restores
this; `preset: custom` + explicit `leftSegments` overrides it. (The bottom
`omp-test | ctx 102k | 6s` line users sometimes mean is the *screen caption*,
not this bar — see Screen caption.)

**Symbols & styling** — `symbolPreset: unicode` in `~/.omp/agent/config.yml`.
Renders rounded tool-use boxes (`╭──╮`, `╰──╯`), tool badges and metadata
brackets (`⟦Wall: 0.35s | Timeout: 300s⟧`), markdown quote borders (`▏`),
and clean status-line chevrons/dividers. Previously set to `ascii` under the
belief that browsers lacked font coverage, but the actual cause of the
`_` boxes was `client_utf8=0` in tmux (POSIX container locale rewriting
unicode to ACS). With `client_utf8=1` fixed, full Unicode styling renders
flawlessly in the web terminal without font fallback clipping. Running
sessions pick it up on resume/restart or via `/settings` -> Symbol Preset.

**Mouse** — `tui.mouse: true` in `~/.omp/agent/config.yml` (the aerc
`mouse-enabled` pattern): omp's TUI enables mouse reporting, so in the web
terminal clicks and wheel scroll reach the TUI. In the web terminal this needs
**`TERM=ttyd-256m` on tmux attach** (the launcher's `tmux_attach` — kmous
carries the SGR mouse sequences; see the terminfo notes above). Inside host
tmux windows the tmux status bar stays clickable (tmux handles its own status
line) while pane clicks go to omp. Running sessions pick the setting up on
next start. Container screen sessions have no mouse (GNU screen limitation) —
keyboard only.

**Session switching** — the tmux status bar (top row, `set-titles on`) is the
session/tab UI: mouse on makes its window tabs clickable and wheelable.
The wrapper chip bar (`sessions.json` polling) was removed 2026-09-26 on
request — it never worked on the prod origin (the publisher's `mkstemp`
wrote 0600 and host Caddy runs as `caddy` → 403 → bar silently hidden) and
the tmux bar made it redundant; the publisher (`omp-web-sessions`) is gone
too. Direct URLs still work and are how bookmarks restore sessions:
`?arg=tmux-<N>` attaches host tmux window `@N`, `?arg=<suffix>` attaches
container screen `omp-<suffix>`, `?arg=tmux` attaches raw tmux. Browser
Back reconnects the previous session via its `?arg=`.

**Reload-restore** — the wrapper keeps `?arg=` synced to the *current* tmux
window: `set-titles-string "#S:#{window_id}:#{W}"` makes tmux publish e.g.
`1:@3:trader-go` on every window switch; the wrapper's title watcher parses
the `@N` and replaceStates `?arg=tmux-<N>` (no reload), so a tab reload — or
a browser restart — reattaches exactly the window that was on screen. Window
*ids* (`@N`), not the visible numbers, because ids are stable while indexes
shift when windows die/close. At the launcher menu the title is `omp-launcher`
and the arg is cleared, so reload shows the menu.

**Sizing & scroll (host `~/.tmux.conf`)** — `window-size smallest` +
`aggressive-resize off` (the legacy option overrode `window-size` and left
wide panes clipped in narrow clients): every window sizes to the smallest
client viewing it, so the web terminal always fits and omp's status line stays
on one line; desktop re-expands when the phone detaches. `set-titles on` +
`set-titles-string "#S:#{window_id}:#{W}"` publish the current window into the
title (the wrapper's arg-sync reads it — see Reload-restore).
**Resize policy:** set `tui.resizeScrollback: preserve` in
`~/.omp/agent/config.yml`. OMP 18.3.2 defaults to `rebuild`, which clears native
history and replays the transcript after a settled resize. In an isolated
ttyd/tmux/OMP run, the same 1000×450 → 1000×650 resize emitted 707,101 bytes
and one history-clear command with `rebuild`, versus 10,358 bytes and no
history clear with `preserve`. The setting hot-reloaded in that run.
Preserve leaves old transcript formatting at its previous width. Separately,
tmux 3.5a re-anchors a resized copy-mode view around its cursor, not its top
visible line. A cursor left near the bottom made shallow reading jump to
offset zero even in a plain shell, without any history replay.

Host `~/.tmux.conf` installs `after-copy-mode[50]` to run `send -X top-line`
when entering copy-mode without an active/present selection. Wheel and page
scrolling then retain the top-left reading anchor through resize. Existing
selections are untouched; deliberate cursor movement/search still makes
that cursor the resize anchor. Width reflow is not pixel-identical.
The hook is loaded live with `tmux set-hook`, without restarting sessions or
re-sourcing plugins. Readers already in copy-mode should exit and re-enter
once to pick up the new anchor.

The wrapper has one sizing path: the smaller of layout height and
zoom-normalized visual height, with an explicit iframe height after safe
areas and the key bar. Visual-viewport scrolling tracks keyboard panning
at normal scale; resize events coalesce through animation frames.
No forced scroll-to-bottom or scroll-position polling. The earlier anchor fix was
checked with numbered shell history and a copied OMP session in Chromium,
Firefox, and a physical Android 15 WebView. On the phone, keyboard opening
changed the pane from 39×33 to 39×16: offset 2 became 19 while the same text
remained at the top, and closing restored offset 2. Repeated cycles, actual
swipe entry, keyboard page-up, selection preservation, and targeting an
inactive pane were exercised. Actual iOS keyboard behavior remains untested.

**Locale:** the container exports `LANG=C.UTF-8` (`ENV` + entrypoint) —
tmux marks a client non-UTF8 when its environment is POSIX and then rewrites
the inner apps' unicode (box drawing etc.) to ACS on output, which mangled
glyphs like `╰` into `_` on the web client while desktop clients looked fine.
**Wheel scrolling** — omp retires finished transcript lines into the
*terminal's* native scrollback, so reading history in the web terminal means
tmux copy-mode (xterm.js's own scrollback stays empty; the app redraws the
viewport). Root bindings: wheel up/down on a normal-screen pane (idle omp,
shells) opens `copy-mode -e` — `-e` auto-exits when scrolled back to the
bottom; deliberately no `-M`: that flag marks the triggering event as a button
drag, so a wheel notch started a text selection at the cursor and extended it
on every following move. Without it the wheel stays a wheel (the
copy-mode-vi WheelUp/Down bindings scroll; button-drag selection still works
because MouseDown/MouseDrag remain intact). On the alternate screen
(streaming turn, TUI overlays) the wheel is
forwarded to the app for its own wheel-aware components. `tui.mouse: true`
(omp click-to-focus) would otherwise swallow the wheel on the normal screen
too — omp's main transcript does not wheel-scroll itself, which is what
"can't scroll in some tabs" was: the stale omp processes predated the setting
and the live ones ate the wheel. Exit copy-mode with `Esc`/`q`/`Enter`
(rebound to plain cancel — the vi-table defaults were clear-selection and
copy-pipe) or by wheeling back down to the bottom. Unbound keys (letters)
are swallowed while in copy-mode — Esc first, then type.

**Robustness notes** — `mode-keys vi` is REQUIRED for every custom
`copy-mode-vi` binding: with the emacs default the vi table is dead and
Enter/Esc/wheel-in-copy-mode fall back to emacs behavior silently. If a
mouse handler ever eats a gesture you want the browser to have, hold **Shift**
while wheeling/dragging — that bypasses app mouse tracking in xterm/ttyd and
gives native selection/scroll. To search 100k lines of scrollback, enter
copy-mode and press `/` (vi search) instead of wheeling. `remain-on-exit
failed` (tmux ≥3.4) keeps a FAILED pane (non-zero exit — crashed omp) as
"[pane is dead]" so window ids and `?arg=` URLs survive, while a clean shell
`exit` closes the window normally; revive a dead pane with `prefix + R` or
`respawn-pane -k`. ttyd reconnects its websocket on network drops and
reattaches to the same window (the wrapper's `?arg=` sync covers bookmarks
and tab restore).

**Copy / paste / selection (audit-corrected)** — with mouse on, drags in the
*live* view are forwarded to omp (app-directed; `mouse_any_flag`), so to
select+copy tmux-side text you scroll into copy-mode first: drag = selection,
release = `copy-selection-no-clear` (stays put), and the copy reaches the
BROWSER clipboard via OSC52 — ttyd 1.7.7's xterm 5.4 registers no OSC52
handler, so the wrapper bridges it (`term.parser.registerOscHandler(52, …)` →
`clipboard.writeText`; UTF-8 decode, clipboard *queries* ignored). Write
permission rules still apply: Chrome grants it for focused tabs; Safari/
Firefox may refuse non-gesture writes — the key bar's **Paste** button
(`term.paste`, mode-aware bracketing) covers paste; for select-to-copy there
fallbacks are Shift+drag (browser-native selection; non-Mac — macOS uses
Option, `macOptionClickForcesSelection`) or the tmux buffer. NOTE: Shift+WHEEL
does nothing in xterm 5.4 (returns zero lines) — the wheel scroll path is
copy-mode only. Double-click in copy-mode word-copies without exiting now
(rebound away from `copy-pipe-and-cancel`). ttyd caches its initial `wsUrl`.
The wrapper adapts subsequent same-origin `/t/ws` WebSocket constructions
to use the current iframe `?arg=`, preserving the selected session after
network reconnects without reloading a live terminal.

**Keybinds (host tmux)** — `prefix+c` opens a NEW OMP tab in the current
project (`omp -c` continues its live session; a fresh dir starts one) — not a
bare shell; `prefix+C` still gives plain bash. `prefix+R` respawns the pane
with its original command (also how a running omp picks up edited
`config.yml`). The old `prefix+m` global mouse toggle was removed: mouse-off
silently killed every scroll/click in the web terminal, and native
selection/scroll is available with Shift anyway — `prefix+m` now just says
so.

## Launcher Menu

`~/.containers/omp-web/omp-launcher` — the single entry point (symlinked into
`~/.local/bin/omp-launcher`). Groups are separated by blank lines (tmux
windows per tmux session, then screen sessions, then the letter shortcuts);
entry numbers run gapless across separators.

**Screen caption** — legacy screens (created before the tmux migration) had a
bottom `omp-test | ctx 102k | 6s` caption + `omp-status` backtick; removed
from generated rcs and re-sourced live (`caption splitonly "%S"` — captions
only in split windows). New sessions are tmux windows and never had one.

| Option | Action |
|---|---|
| `[tmux <sess>:<idx>] <name> — <path>` | **Host tmux windows** (your live omp tabs, listed first; `*` = active). Attaches via `tmux attach -t @<id>` — the tmux top bar lists all windows; `Ctrl-a n/p/1-8` cycles, `Ctrl-a d` detaches back to the menu. |
| `(s) [shell] New host shell` | Plain bash as a tmux window — every tmux pane runs on the host, so this *is* a host shell (no systemd bridge needed). |
| `(t) [tmux] Attach host tmux` | Raw `tmux attach` — most recent session; `Ctrl-a s` lists sessions. |
| `(w) New omp window` / `(n) New in custom path` | Path (Tab-complete, Y/n mkdir), window name, auto-approve y/N; create a window in session `1` and attach its returned stable ID. Paths and flags are passed as argv, never interpolated into shell source. |
| `(p) Resume session` | Pick a project/session or UUID prefix. Searches panes across tmux sessions for a launch command containing that UUID; selects a matching live pane, otherwise revives a dead project pane or creates a new window. Fresh omp processes without a UUID in their launch command cannot be deduplicated by this method. |

New entries create tmux windows, using the host socket when mounted or a
local server otherwise. Legacy screen sessions remain attachable. Window
names are deduplicated with numeric suffixes. New windows use `-t =1:`;
stable `@window` and `%pane` IDs prevent index-shift mistakes during attach
and recovery. Dead-pane recovery does not force-kill a pane that became live.

Menus use the actual terminal width, single-column project/session pickers
and Unicode-aware label truncation. EOF cancels a prompt; numeric choices
are bounded before shell arithmetic.

**Window lifecycle** — omp windows live in host tmux, so they survive
container restarts, browser closes, and reboots (tmux resurrect restores the
windows; omp auto-continues the newest session per cwd via `omp -c`, or use
`[pick]` to resume explicitly). Exiting omp drops you to a plain shell in the
same window; exiting that shell closes the window (`remain-on-exit failed` —
only FAILED panes linger as "[pane is dead]"; `prefix + R` revives one with
the original command). To close a window outright: `tmux kill-window -t
=1:<name>` (or `prefix &` on it).

**Naming:** windows are named after the project (suffix sanitized
`[a-zA-Z0-9_-]`). Basenames already starting `omp-`/`claude-` get the prefix
stripped (`~/.containers/omp-web` → suffix `web`). omp updates the window
title itself while running (model > path > git).

**Keybindings** (printed on every menu redraw — the host-tmux ones, prefix is
`Ctrl-a`): `Ctrl-a d` detach (back to this menu), `Ctrl-a [` scroll mode
(PgUp/PgDn, `/` and `?` search, `q` exit), `prefix j` transcript snapshot
(tmux popup running `omp-jsonl-view --popup` over `omp-jsonl-pretty`).
The viewer resolves the newest JSONL whose header cwd matches the pane.
It is not a live stream and may not be the active session when several
sessions share a cwd. Malformed events and terminal control characters are
filtered; assistant string content and narrow separators render correctly.

## Project Session Discovery

The launcher reads `~/.omp/agent/sessions/` (omp's store). Dirs are keyed by
cwd with `$HOME` stripped and `/` → `-`: `/tmp` → `-tmp`,
`/home/jieniu/.containers/bank` → `-.containers-bank`, `$HOME` → `-`. Session
files are `<UTC-timestamp>_<uuid>.jsonl` plus a sidecar dir of tool logs. The
launcher scans the newest JSONL per dir for its `session` line's `cwd`; dirs
whose cwd no longer exists are filtered from `[pick]`. To drop an old
project's history: `rm -rf ~/.omp/agent/sessions/<munged>/`.

## Shell Integration

`~/.bashrc.d/omp-web.sh` → `~/.containers/omp-web/omp-web.sh`:

```bash
omp-attach() {
    local launcher="$HOME/.containers/omp-web/omp-launcher"
    [[ -x "$launcher" ]] || launcher=/opt/omp-web/omp-launcher
    "$launcher" "$@"
}
```

`omp-attach` in any local terminal = identical launcher as the browser.

## URL / Session Restore

`https://omp.jieniuu8.com/?arg=tmux-<N>` attaches stable host tmux window
`@N`. `?arg=tmux` attaches the most recent tmux session; legacy screen
suffixes remain supported. Invalid/stale targets return to the menu.

1. **ttyd `-a`** forwards `?arg=<x>` to the launcher's direct-attach guard.
2. **ttyd `-b /t`** mounts ttyd under `/t` so it lives behind the wrapper page
   at `/` (same-origin).
3. **`web/index.html`** polls the iframe title, recognizes tmux window IDs
   and launcher/screen titles, and updates both URLs with `replaceState`.
   A small WebSocket adapter applies that current arg to ttyd reconnects
   because ttyd itself caches its original URL.

Multiple tmux clients may attach simultaneously; host `window-size smallest`
fits the narrowest client. Legacy screen attaches still use `-A -D -RR`
and can detach another client. Missing windows require `[pick]` recovery.

## Flag Prompt

`[new]` and `[pick]` prompt:

```
Auto-approve all tool calls (--auto-approve)? [y/N]:
```

`y` → appends `--auto-approve`. Attaching to an existing screen skips the
prompt (its mode is fixed). Other flags (`--model`, `--plan-yolo`,
`--approval-mode`, …) aren't prompted — add by hand or use in-session commands.

## Files

```
~/.containers/omp-web/
├── OMP.md                    # this file
├── Containerfile             # image build (fedora + ttyd/screen/python3 + terminfo)
├── omp-launcher              # main bash launcher (source of truth; ~/.local/bin symlink)
├── omp-jsonl-view            # bash wrapper for Ctrl-A j (resolves JSONL, pipes to less)
├── omp-jsonl-pretty          # python formatter: omp JSONL → readable transcript
├── omp-web.sh                # omp-attach shell function
├── ttyd-256color.src         # terminfo source, kmous-stripped (screen safe)
├── ttyd-256m.src             # terminfo source, kmous present (tmux mouse)
└── web/
    ├── index.html            # wrapper page served by Caddy at / (title-sync + ?arg=)
    └── favicon.png

~/.local/bin/omp-launcher     → ~/.containers/omp-web/omp-launcher
~/.bashrc.d/omp-web.sh     → ~/.containers/omp-web/omp-web.sh
~/.config/containers/systemd/omp-web.build      # quadlet build unit
~/.config/containers/systemd/omp-web.container  # quadlet container unit
```

## Caddy

```caddyfile
# omp — Web terminal for omp agent sessions (tmux-backed) | dev
omp.jieniuu8.com {
	@nottailnet not remote_ip 100.64.0.0/10 fd7a:115c:a1e0::/48
	route {
		respond @nottailnet 403
		handle /t/* {
			reverse_proxy 127.0.0.1:7682
		}
		handle {
			root * /home/jieniu/.containers/omp-web/web
			file_server
		}
	}
}
```

The tailnet guard is staged in `~/caddy/Caddyfile`, **not yet deployed**.
Deploy with `sudo ~/caddy/deploy.sh` (requires host administrator access and
regenerates the dashboard). `route` is essential: a bare `respond` is sorted
after `handle` blocks and would not protect the terminal. The rule uses the
connection's remote IP, not spoofable forwarded headers. Devices must use
Tailscale. DNS alone does not protect a shared HTTPS listener.

## History

- 2026-09-27 — corrected phone regressions from the polish pass. Continuous
  Pointer Events capture replaces the detached-row TouchEvent path; zoom
  no longer freezes height updates, and iframe height is explicit.
  Verified on a physical Moto G7 Play / Android 15 WebView: swipes moved
  numbered tmux history 17 lines in each direction; keyboard open/close
  changed the frame 552 → 290 → 552px and terminal 33 → 17 → 33 rows,
  retaining the same top history line. Chromium also recovered full height
  across repeated viewport changes while zoomed to 1.4×. Physical iOS
  behavior remains untested.
- 2026-09-27 — cross-device polish: mobile focus/clipboard/prefix controls,
  zoom and safe-area sizing, session-aware WebSocket reconnects, narrow
  menus, argv-safe launches/recovery and repaired transcript viewer.
  Chromium exercised desktop, 320px/390px phones, Android emulation,
  landscape and iPad layouts; actual terminal key/paste/swipe events and
  reconnect handshakes were observed. A 390×844 → 390×440 viewport change
  refit 55 → 26 rows with the toolbar at the bottom. This is not physical
  iOS keyboard/IME or screen-reader certification.
- 2026-09-27 — appliance supervision and WebSocket origin checking verified
  with disposable containers; local image `18.3.2-11` builds with pinned omp
  checksum. Staged Caddy guard denies non-tailnet/forged-XFF requests with
  403 and permits a real tailnet-source request with 200. Production image
  and system Caddy were not restarted/reloaded during this review.

- 2026-09-26 — removed the wrapper chip bar + `sessions.json` publisher (user
  request; the tmux status bar covers session switching). Root cause of its
  prod breakage for the record: `mkstemp` mode 0600 vs host-Caddy user
  `caddy` → 403. `?arg=` direct-attach URLs are unaffected.
- 2026-09-26 — "tabs don't click / scroll rotates history / line still
  breaks" round 2, three distinct root causes:
  - **Chips bar 403**: `omp-web-sessions` wrote `sessions.json` via
    `tempfile.mkstemp` (mode 0600); host Caddy runs as user `caddy` and got
    EACCES → 403 → the wrapper's chip bar never rendered (fetch returned
    `!r.ok` → `renderBar(null)` → bar hidden). Fix: `os.chmod(fd, 0o644)`
    before rename. Symptom looked like "tab click does nothing" because there
    were no chips at all on the prod origin (the 127.0.0.1:7685 path worked —
    in-container Caddy runs as the same user that owns the file).
  - **Stale omp processes**: every tmux-window omp predated the
    `tui.mouse: true` config line (started 23:35–23:59, config saved 00:14).
    Without omp's mouse mode, tmux `alternate-scroll` sent ↑/↓ on wheel over
    alternate-screen overlays (= the "scroll rotates previous commands") and
    the composer's width sense went stale after client resizes (wrapped at
    ~118 cols in a 204-col pane, dropping characters). Fix: respawn every
    window with a fresh omp — `tmux respawn-window -t @ID -k -c <cwd>
    'bash -lc "exec omp --resume <session-id> --allow-home"'`. Two traps:
    `respawn-window` without `-c` starts in the *server's* cwd, and
    `omp -c` (continue) then resumes the wrong project's session — always
    pass both `-c <cwd>` and an explicit `--resume <id>`. Also `respawn-window
    -t 1:N` targets by *index*, which shifts when a window dies mid-rescue —
    target `@ID`s. Window ids are stable, so chip ids/`?arg=tmux-<N>` URLs
    follow the id, not the position.
  - omp auto-persists composer drafts per session, so test text typed during
    debugging survives respawns — clear with a single `C-c` (a second `C-c`
    cancels/exits omp and, with no `remain-on-exit`, closes the window).
- 2026-09-25 — mouse + UTF-8 in the web terminal: tmux attach now runs under
  `TERM=ttyd-256m` (kmous present → tmux enables/parses SGR mouse → wheel
  scroll + status-bar/TUI clicks work; the wheel previously fell back to
  alternateScroll arrows = history rotation) and the container exports
  `LANG=C.UTF-8` (POSIX locale made tmux mark web clients non-UTF8 and mangle
  unicode to ACS, e.g. `╰` → `_`). Image tag `18.3.2-2`.
- 2026-09-25 — replaced Claude Code with omp end to end; removed the Discord
  router (`claude-discord.service`, `claude-discord-start`,
  `claude-discord-clear`) and Claude's `--remote-control` injection.
- 2026-09-25 — portable appliance: standalone omp release binary baked into
  the image, in-container Caddy front on :7685, systemd/bus mounts as the
  host-command hatch, image published to `registry.jieniuu8.com/omp-web`.
See also: `skill://web-terminal` — the reusable recipe for ttyd + multiplexer + wrapper setups (this project and ~/.containers/mail/aerc follow it).
