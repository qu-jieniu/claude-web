# omp-web — Web Terminal for omp Sessions

> Dir name kept as `~/.containers/omp-web` (Caddy root + habit); everything in it is omp now.
> The domain is `omp.jieniuu8.com` (renamed from claude.jieniuu8.com, 2026-09-25).

## Overview

Web terminal exposing persistent `screen` sessions running **omp** behind
`https://omp.jieniuu8.com` (Caddy + Cloudflare DNS + Tailscale). Both the
browser and a local terminal attach to the same named screen sessions, so
state survives terminal crashes, SSH drops, and browser closes. A bash-based
launcher picks which project/session to resume and what screen name to assign.

**Portable appliance container** (since 2026-09-25): everything runs inside a
rootless podman container — ttyd, screen, python, Caddy (in-container front)
and a **standalone omp binary** baked into the image. Starting the container
on any machine = fully working web terminal, no host setup. `$HOME` is
bind-mounted (state/projects ride along, e.g. via syncthing); everything
missing falls back to baked copies.

**Ports:**
- `127.0.0.1:7682` → ttyd — the homelab contract: host Caddy serves the
  wrapper at `/` from `~/.containers/omp-web/web` and proxies `/t/*` here.
- `127.0.0.1:7685` → in-container Caddy (:8080) serving the wrapper at `/`
  and proxying `/t/*` — the **self-contained front** for machines without a
  host Caddy. One port = the whole app.

**Host-command hatch:** the container mounts `/run/user/1000/systemd` and
`/run/user/1000/bus` (both created by systemd at login on any Linux machine —
zero host setup). From inside, omp gets `systemctl --user` and
`systemd-run --user --wait <cmd>` = run commands as the user on the host
(with `--wait` capturing output). Verified: a container-spawned transient unit
wrote to the host filesystem.

**Tradeoff:** screens live inside the container's PID namespace — restarting
`omp-web.service` kills running omp sessions (recover via `[pick]`; the
session JSONLs live in the mounted home and survive everything).

## Architecture

```
Browser (omp.jieniuu8.com)                CLI (terminal)
        │                                          │
        │ HTTPS                                    │ bash
        ▼                                          ▼
Caddy (host) ─ /t/* reverse_proxy ─► quadlet omp-web.service        omp-attach function
   (/ serves ~/.containers/omp-web/web wrapper      = podman container localhost/omp-web
    → iframes /t/ and syncs URL ?arg=)         │ bind-mounts %h → /home/jieniu
                                               │  + %t/systemd, %t/bus (host cmds)
                                               ▼
                        entrypoint: caddy :8080 (front) + ttyd :7682
                                               │ spawns per-connection
                                               ▼
                            omp-web-launch → omp-launcher (home copy
                                               or baked /opt/omp-web)
                                               │
                                     screen -S omp-<name> … omp
```

- Browser and CLI both invoke the same launcher; they share the same screen
  sessions via `screen -A -D -RR -S <name>`.
- ttyd spawns the launcher *per WebSocket connection* — closing a browser tab
  just kills one launcher instance; the screen session survives as a detached
  daemon.
- Sessions are named `omp-<suffix>` (`omp-myapp`, `omp-shell`, …).

## Container / Deployment

- `~/.containers/omp-web/Containerfile` — appliance image. Pins the upstream
  **standalone omp release binary** (`omp-linux-x64` v18.3.2, sha-verified —
  omp lazily loads native addons from the bun cache, which fresh machines
  don't have, so a self-contained binary is the only portable shape).
  Also bakes ttyd/screen/python3/caddy/git + the custom terminfo.
- `~/.containers/omp-web/omp-web-entry` — entrypoint: generates the front Caddyfile
  (webroot prefers the mounted home's `.containers/omp-web/web`, falls back to baked
  `/opt/omp-web/web`), runs Caddy in background, execs ttyd **on 0.0.0.0**
  (pasta delivers published ports to the container's eth0, not loopback —
  binding 127.0.0.1 inside yields 502 through the host Caddy).
- `~/.containers/omp-web/omp-web-launch` — ttyd's launcher entry: prefers the mounted
  home's `~/.local/bin/omp-launcher`, falls back to the baked copy.
- `~/.config/containers/systemd/omp-web.build` — build unit.
- `~/.config/containers/systemd/omp-web.container` — quadlet → user unit
  `omp-web.service`. Image from `registry.jieniuu8.com/omp-web:latest`
  (unauthenticated, tailnet-only per image-publish house rules).

Build + publish (tag scheme per image-publish skill — `18.3.2-1` = omp
version 18.3.2, rebuild 1; bump both OMP_VERSION in the Containerfile and the
tag when omp releases; re-push `latest` and restart):

```bash
podman build -t localhost/omp-web:18.3.2-1 -t localhost/omp-web:latest ~/.containers/omp-web
podman push localhost/omp-web:18.3.2-1 registry.jieniuu8.com/omp-web:18.3.2-1
podman push localhost/omp-web:latest registry.jieniuu8.com/omp-web:latest
podman pull registry.jieniuu8.com/omp-web:latest   # refresh the local ref!
systemctl --user restart omp-web.service
```

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
- **Touch bridge**: xterm.js ignores swipes under mouse tracking, so history
  was unreadable on touch. The wrapper translates vertical swipes into real
  WheelEvents dispatched on xterm's `.xterm-viewport` (the node its wheel
  handler is bound to — textarea/element events bubble around it and are
  silently ignored). Finger down = into history (tmux copy-mode), finger up =
  back to the bottom, which auto-exits copy-mode (`copy-mode -e`).
  `touch-action: none` kills pull-to-refresh/rubber-banding.
- **Key bar** (coarse pointers only): Esc/Tab/arrows/^C/^D/^L — the keys soft
  keyboards don't have. Arrows honor DECCKM (`ESC O x` vs `ESC [ x`); keys go
  through xterm's `input()` so the pty sees real keystrokes. Desktop never
  renders it (`pointer: coarse` media query).
- **Keyboard-aware sizing**: `interactive-widget=resizes-content` for Android;
  iOS ignores it, so the wrapper resizes the iframe element to
  `visualViewport.height` on keyboard open/close — the iframe's own window
  resize then triggers ttyd's refit (iOS never fires window resize for the
  keyboard). Plus `viewport-fit=cover` + safe-area padding so the key bar
  clears the notch/home indicator.

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
**Reading freeze**: tmux re-anchors copy-mode to the bottom on ANY pane resize
(pos N → 0, even height-only; no tmux option preserves it), which yanked the
reader back to the live view on every window resize/rotation. Two-layer fix:
(1) iframe sizing is **JS-owned with explicit px at all times** — CSS `100%`
let the browser resize the iframe during layout *before* any handler ran
(the residual yank path in Chrome/Ferdium/keyboard); the wrapper's
`applyLiveSize()` computes px from window/visualViewport minus the key bar,
and nothing else ever touches the size. (2) While reading (mouse tracking on,
no composer visible), `freezeCheck()` pins the frame at its current pixels:
the pty never resizes, the position survives exactly, black bars show until
copy-mode exits. The freeze arms instantly on the first wheel (listener
inside the iframe — parent never sees those events), holds through
keyboard-open (typing is impossible in copy-mode anyway), and releases the
moment the composer returns. The conditional pin still guards live-view
refits (only scrolls if it was at the bottom).
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
(rebound away from `copy-pipe-and-cancel`). ttyd's reconnect caches its
`wsUrl` (does not re-read `location.search`), so the iframe `?arg=` mirror is
not relied on for reconnects — bookmarks/tab restore + the title-watcher sync
carry the session.

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
| `(w) [new tmux] New omp tab in host tmux...` | Prompts for path + name → `tmux new-window -t =1: -n <name> -c <path>` running `omp --allow-home` (creates session `1` if absent), then attaches. Preferred spawn path — joins the same tabbed universe as the other live sessions (mouse, tabs). |
| `(n) [new] Start in custom path...` | Path (Tab-complete, Y/n mkdir) → window name → auto-approve y/N → same tmux-window flow as `(w)` with `omp --allow-home`. |
| `(p) [pick] Resume a session...` | Pick a project → pick a session (UUID + preview) or type a UUID (≥8-char prefix). Reads omp's global store. Placement: if the session is **already running** in a window → selects it (never two omp processes on one uuid); if the project's window is dead → resumes *into* it (id stays stable); otherwise a new window with an auto-deduped name. |

All entries create/attach host-tmux windows; the launcher no longer creates
GNU screen sessions (screen stays in the image as the portable-appliance
fallback only). Legacy screens were migrated: find the running omp's cwd +
newest session jsonl, `tmux new-window -t '=1:' -n <name> -c <cwd>` with
`omp --resume <uuid> --allow-home`, then `screen -S <name> -X quit` — never
run two omp processes on one session uuid. Window names must be unique in session 1 — collisions select
the existing window instead of spawning a duplicate. Note: `tmux new-window
-t 1` is ambiguous with session "1" named "1" (parses as window *index* 1 →
"index in use") — always target `-t =1:` for new windows and `-t =1` for
list/has-session.

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
(PgUp/PgDn, `/` and `?` search, `q` exit), `prefix j` live JSONL view of the
current pane (tmux popup running `omp-jsonl-view --popup` over
`omp-jsonl-pretty`: `YOU`/`OMP` blocks, tool calls as one-liners, tool
results truncated, compaction markers, session titles).

## Project Session Discovery

The launcher reads `~/.omp/agent/sessions/` (omp's store). Dirs are keyed by
cwd with `$HOME` stripped and `/` → `-`: `/tmp` → `-tmp`,
`/home/jieniu/.containers/bank` → `-.containers-bank`, `$HOME` → `-`. Session
files are `<UTC-timestamp>_<uuid>.jsonl` plus a sidecar dir of tool logs. The
launcher scans the newest JSONL per dir for its `session` line's `cwd`; dirs
whose cwd no longer exists are filtered from `[pick]`. To drop an old
project's history: `rm -rf ~/.omp/agent/sessions/<munged>/`.

## Status Bar

`~/.containers/omp-web/omp-status <screen-name>` feeds screen's `backtick 0 30 30 …`
in each session's rc — output like `ctx 100k │ $1.23 │ 5m`:
- **ctx** — most recent assistant turn's `input + cacheRead + cacheWrite`
  from the session JSONL (no cap/percentage: omp sessions span models with
  different context windows).
- **$** — cumulative `usage.cost`.
- **age** — time since the last message.

Resolution: find the screen server PID via `pgrep` (never `screen -ls` from
inside a backtick — one wedged server deadlocks every attach; seen 2026-06-06),
BFS its descendants for the `omp` process, read its cwd, take the newest
JSONL in that cwd's dir. Degrades to `ctx -` / `—`, never fails the bar.

Unlike the old Claude Code version there are **no network calls** — no OAuth
usage endpoint, no 5h-cap segment (provider-agnostic).

## Shell Integration

`~/.bashrc.d/omp-web.sh` → `~/.containers/omp-web/omp-web.sh`:

```bash
omp-attach() { "$HOME/.local/bin/omp-launcher"; }
```

`omp-attach` in any local terminal = identical launcher as the browser.

## URL / Session Restore

`https://omp.jieniuu8.com/?arg=<suffix>` attaches straight to
`omp-<suffix>`; the address bar tracks the active session automatically.

1. **ttyd `-a`** forwards `?arg=<x>` as the launcher's `$1`; the direct-attach
   guard sanitizes it and only acts if a live `omp-<x>` screen exists (bogus
   args just show the menu).
2. **ttyd `-b /t`** mounts ttyd under `/t` so it lives behind the wrapper page
   at `/` (same-origin).
3. **`web/index.html`** iframes `/t/`, polls the iframe's `document.title`
   (driven by the launcher's OSC 0 `set_title` → `omp-<suffix>`), parses the
   leading `/^omp-([A-Za-z0-9_-]+)/` token, and `history.replaceState`s the
   arg onto **both** the address bar and the iframe URL — the iframe copy is
   what makes ttyd's WS-reconnect (e.g. after a Caddy reload) re-attach
   instead of kicking back to the menu.

Limitation: one title at a time (multiple browser clients boot each other via
`-A -D -RR`). Direct-attach only attaches existing screens; after a reboot,
`[pick]` is the way back.

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
├── CLAUDE.md                 # this file
├── Containerfile             # image build (fedora + ttyd/screen/python3 + terminfo)
├── omp-launcher              # main bash launcher (source of truth; ~/.local/bin symlink)
├── omp-status                # python status-bar feed (ctx/cost/age) + --jsonl resolver
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
# omp — Web terminal for omp agent sessions (screen-backed) | dev
omp.jieniuu8.com {
	handle /t/* { reverse_proxy 127.0.0.1:7682 }
	handle { root * /home/jieniu/.containers/omp-web/web; file_server }
}
```

Deploy edits with `sudo ~/caddy/deploy.sh` (regenerates the dashboard from
the annotation comment).

## History

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
