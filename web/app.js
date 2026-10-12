(() => {
  'use strict';

  const app = document.getElementById('app');
  const host = document.getElementById('terminal');
  const connection = document.getElementById('connection');
  const reconnect = document.getElementById('reconnect');
  const keybar = document.getElementById('keybar');
  const prefix = document.getElementById('prefix');
  const notice = document.getElementById('notice');
  const noticeText = document.getElementById('notice-text');
  const noticeCopy = document.getElementById('notice-copy');
  const copiedFlash = document.getElementById('copied-flash');
  const pasteDialog = document.getElementById('paste-dialog');
  const pasteText = document.getElementById('paste-text');
  const sendPaste = document.getElementById('send-paste');
  const composer = document.getElementById('composer');
  const composerToggle = document.getElementById('composer-toggle');
  const composerText = document.getElementById('composer-text');
  const composerStatus = document.getElementById('composer-status');
  const composerPaste = document.getElementById('composer-paste');
  const composerClear = document.getElementById('composer-clear');
  const composerAttach = document.getElementById('composer-attach');
  const fileUploader = document.getElementById('file-uploader');

  if (!window.Terminal || !window.FitAddon) {
    connection.textContent = 'Terminal assets could not load. Reload this page to try again.';
    connection.dataset.state = 'disconnected';
    reconnect.addEventListener('click', () => location.reload());
    return;
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const MIN_FONT_SIZE = 9;
  const MAX_FONT_SIZE = 32;
  const DEFAULT_FONT_SIZE = 14;

  function getStoredFontSize() {
    try {
      const stored = parseInt(localStorage.getItem('terminal-font-size'), 10);
      if (Number.isInteger(stored) && stored >= MIN_FONT_SIZE && stored <= MAX_FONT_SIZE) {
        return stored;
      }
    } catch {}
    return DEFAULT_FONT_SIZE;
  }

  function adjustFontSize(delta) {
    const current = term.options.fontSize || DEFAULT_FONT_SIZE;
    const target = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, current + delta));
    if (target === current) return;
    term.options.fontSize = target;
    try {
      localStorage.setItem('terminal-font-size', String(target));
    } catch {}
    // Glyphs are cached per size: without dropping the cache, text can appear at
    // the old size behind the new one.
    term.clearTextureAtlas?.();
    scheduleFit();
  }

  const term = new Terminal({
    fontFamily: 'ui-monospace, "DejaVu Sans Mono", "Liberation Mono", Menlo, Consolas, monospace',
    fontSize: getStoredFontSize(),
    cursorBlink: true,
    scrollback: 10000,
    scrollOnUserInput: false,
    disableStdin: true,
    // On macOS, Option+click/drag forces a normal local selection even while
    // the running app (tmux) has mouse reporting on - the same convention
    // every other Mac terminal uses. altClickMovesCursor defaults to true,
    // which would make Option+click ALSO reposition the cursor; documented as
    // "pick one", so selection wins.
    macOptionClickForcesSelection: true,
    altClickMovesCursor: false,
    theme: {
      background: '#161a21', foreground: '#b4bcca', cursor: '#9bb4d4',
      black: '#2a2f3a', red: '#d2777d', green: '#9fc584', yellow: '#d9bc82',
      blue: '#9bb4d4', magenta: '#bb93c7', cyan: '#7ec3c9', white: '#b4bcca',
      brightBlack: '#6b7384', brightRed: '#e0959a', brightGreen: '#b5d6a0',
      brightYellow: '#e6cfa0', brightBlue: '#b2c8e6', brightMagenta: '#d0b0dc',
      brightCyan: '#9ad6dc', brightWhite: '#c8ccd6',
      // xterm leaves selection unset by default: a barely-visible translucent
      // grey. Set explicitly so a drag-selection is actually legible.
      selectionBackground: '#2b4a6b',
      selectionInactiveBackground: '#243040',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  // Rendering. The canvas addon avoids the DOM renderer's jitter under rapid
  // output/scroll, but it rasterises glyphs at `devicePixelRatio` device pixels
  // per CSS pixel - so whenever that ratio is fractional (a 4K display at 125%
  // or 150% scaling, or any browser zoom level) each glyph lands on a
  // fractional device pixel and the canvas smooths it, which reads as soft text.
  // The DOM renderer lays out real text and lets the browser rasterise at the
  // true device resolution, so it is sharper at any ratio; canvas is only worth
  // its speed when the ratio is whole. WebGL would be faster still but is known
  // to mangle glyphs (see skill docs).
  let canvasAddon = null;

  /** ?renderer=dom | canvas picks one explicitly and remembers it; auto clears
   *  the choice. Which looks better is a judgement only the person in front of
   *  the display can make: DOM is sharper, canvas is steadier under output. */
  function rendererPreference() {
    const requested = new URLSearchParams(location.search).get('renderer');
    if (requested === 'dom' || requested === 'canvas' || requested === 'auto') {
      try {
        if (requested === 'auto') localStorage.removeItem('terminal-renderer');
        else localStorage.setItem('terminal-renderer', requested);
      } catch {}
      return requested === 'auto' ? null : requested;
    }
    try { return localStorage.getItem('terminal-renderer'); } catch { return null; }
  }

  function applyRenderer() {
    const preference = rendererPreference();
    // Both complaints so far are real and pull opposite ways: the DOM renderer is
    // sharper (real text, rasterised by the browser, per-glyph font fallback) -
    // it was the default until 18.3.2-23 - while 18.3.2-23 moved to canvas
    // because rapid output and scrolling were jittery, "especially on mobile".
    // So the default follows the input device: a coarse pointer means a phone,
    // where the jitter mattered; a fine pointer means a desk or a TV, where the
    // sharpness does. A fractional device ratio rules canvas out either way,
    // since that is exactly the softness being fixed. An explicit preference
    // wins over all of it.
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const wholeRatio = Number.isInteger(window.devicePixelRatio);
    const wantCanvas = (preference ? preference === 'canvas' : coarse && wholeRatio)
      && !!window.CanvasAddon;
    if (wantCanvas && !canvasAddon) {
      try {
        canvasAddon = new CanvasAddon.CanvasAddon();
        term.loadAddon(canvasAddon);
      } catch {
        canvasAddon = null;   // 2D context refused: the DOM renderer stays
      }
    } else if (!wantCanvas && canvasAddon) {
      try { canvasAddon.dispose(); } catch {}
      canvasAddon = null;
    }
    term.refresh(0, term.rows - 1);
  }

  applyRenderer();

  // Dragging the window to another screen or changing browser zoom changes the
  // device pixel ratio without necessarily changing the terminal's CSS size, so
  // nothing else would re-measure: the old canvas would keep rendering at the
  // old scale and the text would stay soft until a reload.
  let dprQuery = null;
  function watchDevicePixelRatio() {
    dprQuery?.removeEventListener('change', onDevicePixelRatioChange);
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprQuery.addEventListener('change', onDevicePixelRatioChange, { once: true });
  }
  function onDevicePixelRatioChange() {
    applyRenderer();
    scheduleFit();
    watchDevicePixelRatio();
  }
  watchDevicePixelRatio();
  // omp probes this terminal and, finding no graphics protocol, still emits
  // SIXEL for images - which a plain xterm.js drops, leaving the blank block it
  // had reserved. Render them instead (SIXEL + iTerm2 IIP); the addon manages
  // its own layers, so it works with either renderer.
  if (window.ImageAddon) {
    try {
      term.loadAddon(new ImageAddon.ImageAddon({
        sixelSupport: true,
        iipSupport: true,
        showPlaceholder: true,
      }));
    } catch {}
  }
  window.term = term;
  term.textarea.setAttribute('aria-label', 'Terminal input');
  term.textarea.setAttribute('autocapitalize', 'off');
  term.textarea.setAttribute('autocomplete', 'off');
  term.textarea.setAttribute('autocorrect', 'off');
  term.textarea.setAttribute('spellcheck', 'false');

  let active = null;
  let currentArg = new URL(location.href).searchParams.get('arg');
  let reconnectTimer = null;
  let retryCount = 0;
  let leaving = false;
  let prefixArmed = false;
  let fitFrame = null;
  let composerComposing = false;
  let composerMessage = '';
  let terminalAction = false;
  let uploading = false;
  let presenceTimer = null;
  const HIGH_WATER = 256 * 1024;
  const LOW_WATER = 64 * 1024;
  const MAX_PENDING = 8 * 1024 * 1024;
  const PRESENCE_INTERVAL_MS = 5000;
  // The window bar is navigation, so it can lag a little; tmux's list-windows is
  // a local call and this only runs while the tab is visible.
  const WINDOW_BAR_INTERVAL_MS = 3000;

  // Tells the discord-alert extension "this specific tmux window is on screen
  // right now", independent of whether the WebSocket/tmux client is still
  // attached: a minimized desktop window keeps the socket open but stops
  // firing this. Includes the attached window id (currentArg, e.g. "tmux-2")
  // so a session in a *different* tmux window on the same server can tell it
  // isn't the one actually being watched, instead of treating any visible
  // tab anywhere as "the whole server is attended".
  function sendPresenceHeartbeat() {
    const query = currentArg ? `?window=${encodeURIComponent(currentArg)}` : '';
    fetch(`/presence${query}`, { method: 'POST', keepalive: true, cache: 'no-store' }).catch(() => {});
  }

  function startPresenceHeartbeat() {
    if (presenceTimer !== null) return;
    sendPresenceHeartbeat();
    presenceTimer = setInterval(sendPresenceHeartbeat, PRESENCE_INTERVAL_MS);
  }

  function stopPresenceHeartbeat() {
    clearInterval(presenceTimer);
    presenceTimer = null;
  }

  // tmux's own status line is off (tmux.conf): this bar replaces it. Real
  // buttons, tall enough to tap, and it lists every session's windows, not just
  // the attached one. Hidden on the launcher page, where there is no session.
  const windowBar = document.getElementById('window-bar');
  let windowBarBusy = false;
  let windowBarTimer = null;
  let windowBarFlagged = new Set();

  /** Bring a tab into view by scrolling the bar, never the page: scrollIntoView
   *  can move the visual viewport on iOS, which resizes the terminal - and a
   *  resize mid-session is what leaves stale rows on screen. */
  function revealTab(button) {
    if (!button) return;
    const bar = windowBar.getBoundingClientRect();
    const tab = button.getBoundingClientRect();
    if (tab.left < bar.left) windowBar.scrollLeft -= bar.left - tab.left;
    else if (tab.right > bar.right) windowBar.scrollLeft += tab.right - bar.right;
  }

  async function refreshWindowBar() {
    if (windowBarBusy || !currentArg) return;
    windowBarBusy = true;
    try {
      const response = await fetch('/windows', { cache: 'no-store' });
      const data = await response.json();
      if (!data?.ok || !Array.isArray(data.windows) || !data.windows.length) return;
      windowBar.replaceChildren(...data.windows.map(entry => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.window = entry.id;
        if (entry.dead) button.dataset.dead = '1';
        if (entry.activity) button.dataset.activity = '1';
        if (entry.bell) button.dataset.bell = '1';
        button.textContent = `${entry.session}:${entry.index} ${entry.name}`;
        button.setAttribute('aria-current', entry.active ? 'true' : 'false');
        button.setAttribute('aria-label', `Switch to ${entry.session} window ${entry.index} (${entry.name})`);
        return button;
      }));
      windowBar.hidden = false;
      const flagged = new Set(data.windows.filter(entry => entry.bell || entry.activity)
        .map(entry => entry.id));
      const newlyFlagged = [...flagged].filter(id => !windowBarFlagged.has(id));
      windowBarFlagged = flagged;
      if (!windowBar.dataset.ready) {
        // First paint: bring the window this tab is attached to into view.
        windowBar.dataset.ready = '1';
        const mine = currentArg?.replace('tmux-', '@');
        const attached = data.windows.find(entry => entry.id === mine) ||
          data.windows.find(entry => entry.active);
        revealTab(windowBar.querySelector(`button[data-window="${attached?.id}"]`));
      } else if (newlyFlagged.length) {
        // A finished turn is only a notification if you can see it: a tab that
        // just got flagged scrolls itself into view, the way tmux's status line
        // showed it in place.
        revealTab(windowBar.querySelector(`button[data-window="${newlyFlagged[0]}"]`));
      }
    } catch {
      // Keep the last known list: the bar is navigation, not authoritative state.
    } finally {
      windowBarBusy = false;
    }
  }

  function startWindowBar() {
    if (windowBarTimer !== null) return;
    refreshWindowBar();
    windowBarTimer = setInterval(refreshWindowBar, WINDOW_BAR_INTERVAL_MS);
  }

  function stopWindowBar() {
    clearInterval(windowBarTimer);
    windowBarTimer = null;
  }

  windowBar.addEventListener('click', async event => {
    const button = event.target.closest('button[data-window]');
    if (!button || button.getAttribute('aria-current') === 'true') return;
    // Show the tap immediately, then let the next refresh confirm it.
    for (const other of windowBar.querySelectorAll('button')) {
      other.setAttribute('aria-current', 'false');
    }
    button.setAttribute('aria-current', 'true');
    revealTab(button);
    try {
      await fetch(`/windows/select?window=${encodeURIComponent(button.dataset.window)}`,
                  { method: 'POST', cache: 'no-store' });
    } catch {}
    refreshWindowBar();
  });

  // Text that a browser refused to put on the clipboard because the request had
  // no user gesture (which is what tmux's asynchronous OSC 52 copy looks like).
  // Kept so the notice's Copy button can retry inside a real gesture.
  let pendingClipboard = null;

  let noticeTimer = null;

  /** Show the notice bar. copyText keeps a Copy button available; autoHideMs
   *  clears it again after a confirmation (a blocked copy stays until
   *  dismissed, because it still needs an action). */
  function showNotice(message, copyText = null, autoHideMs = 0) {
    clearTimeout(noticeTimer);
    noticeTimer = autoHideMs ? setTimeout(hideNotice, autoHideMs) : null;
    noticeText.textContent = message;
    pendingClipboard = copyText;
    pendingClipboardAt = Date.now();
    noticeCopy.hidden = !copyText;
    notice.hidden = false;
  }

  let copiedFlashAnimation = null;

  /** Flash the scissors pill: something just landed on the clipboard. */
  function flashCopied() {
    copiedFlash.hidden = false;
    copiedFlashAnimation?.cancel();
    copiedFlashAnimation = copiedFlash.animate([
      { opacity: 0, transform: 'translateX(-50%) scale(0.85)' },
      { opacity: 1, transform: 'translateX(-50%) scale(1)', offset: 0.18 },
      { opacity: 1, transform: 'translateX(-50%) scale(1)', offset: 0.7 },
      { opacity: 0, transform: 'translateX(-50%) scale(0.95)' },
    ], { duration: 850, easing: 'ease-out' });
    copiedFlashAnimation.onfinish = () => {
      copiedFlash.hidden = true;
      copiedFlashAnimation = null;
    };
  }

  function hideNotice() {
    clearTimeout(noticeTimer);
    noticeTimer = null;
    notice.hidden = true;
    pendingClipboard = null;
    noticeCopy.hidden = true;
  }

  /** Put text on the clipboard inside a live user gesture. Returns true on
   *  success. The synchronous command runs first: WebKit only honours a gesture
   *  within the task that started it, and a real clipboard rejection from Safari
   *  arrives in a later task, so a fallback placed after an await has no gesture
   *  left and fails as well. */
  function copyInGesture(text) {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.position = 'fixed';
    scratch.style.top = '-1000px';
    document.body.appendChild(scratch);
    scratch.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch {}
    scratch.remove();
    return copied;
  }

  /** Put text on the clipboard. Returns true on success. */
  async function writeClipboard(text) {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); return true; } catch {}
    }
    return false;
  }

  noticeCopy.addEventListener('click', async () => {
    const text = pendingClipboard;
    if (!text) return;
    // Synchronous first, while this click's gesture is guaranteed to be live.
    const copied = copyInGesture(text) || await writeClipboard(text);
    if (copied) {
      hideNotice();
      flashCopied();
      return;
    }
    noticeText.textContent = 'Copy was refused by the browser. Select the text and copy it manually.';
  });

  // tmux copies on its own, so no gesture backs the OSC 52 write and browsers
  // refuse it - hence the notice. A Mac user's reflex after selecting is
  // Command-C, and the copy event *is* a gesture whose clipboardData accepts a
  // write, so honour that. Gated to Apple platforms: elsewhere Ctrl-C is the
  // terminal's interrupt and must reach the pty untouched.
  const applePlatform = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  let pendingClipboardAt = 0;
  document.addEventListener('copy', event => {
    if (!applePlatform || !pendingClipboard) return;
    if (Date.now() - pendingClipboardAt > 120000) { pendingClipboard = null; return; }
    const selection = window.getSelection();
    const hasDomSelection = !!selection && selection.rangeCount > 0 && !selection.isCollapsed;
    const active = document.activeElement;
    const hasInputSelection = (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)
      && active.selectionStart !== active.selectionEnd;
    if (hasDomSelection || hasInputSelection) return;   // the browser's own copy wins
    event.clipboardData?.setData('text/plain', pendingClipboard);
    event.preventDefault();
    hideNotice();
    flashCopied();
  });

  document.getElementById('dismiss-notice').addEventListener('click', () => {
    hideNotice();
    focusTerminal();
  });

  function focusTerminal(force = false) {
    if (!document.querySelector('dialog[open]') && !composer.contains(document.activeElement)) {
      if (!force && matchMedia('(any-pointer: coarse)').matches && document.activeElement !== term.textarea) {
        return;
      }
      term.textarea.focus({ preventScroll: true });
    }
  }

  function setPrefix(armed) {
    prefixArmed = armed;
    prefix.setAttribute('aria-pressed', String(armed));
    prefix.setAttribute('aria-label', armed
      ? 'Control A prefix armed; the next key is a multiplexer command'
      : 'Control A, multiplexer prefix');
  }

  function setConnection(state, message) {
    connection.dataset.state = state;
    connection.textContent = message;
    const connected = state === 'connected';
    connection.closest('.connection-bar').hidden = connected;
    term.options.disableStdin = !connected;
    for (const button of keybar.querySelectorAll('button')) {
      button.disabled = button.dataset.key !== 'select' && !connected;
    }
    sendPaste.disabled = !connected;
    if (!connected) setPrefix(false);
    renderComposer();
    scheduleFit();
  }

  // Measure pinch zoom relative to the layout viewport. visualViewport.scale
  // also includes Safari's page zoom: using it directly halves height at 50%.
  function scheduleFit() {
    if (document.hidden || leaving) return;
    if (fitFrame !== null) return;
    fitFrame = requestAnimationFrame(() => {
      fitFrame = null;
      if (document.hidden || leaving) return;
      const viewport = window.visualViewport;
      const layout = document.documentElement;
      const zoom = viewport ? Math.max(1, layout.clientWidth / viewport.width) : 1;
      const height = viewport ? Math.min(layout.clientHeight, viewport.height * zoom) : layout.clientHeight;
      app.style.height = `${Math.max(1, Math.floor(height))}px`;
      app.style.top = `${viewport && zoom <= 1.01 ? viewport.offsetTop : 0}px`;
      app.style.setProperty('--composer-max-height', `${Math.max(100, Math.min(190, height * .34))}px`);
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        const cols = term.cols;
        const rows = term.rows;
        fit.fit();
        if (term.cols !== cols || term.rows !== rows) {
          // A resize re-wraps and repaints. The canvas renderer can otherwise
          // keep rows from the previous geometry on screen - seen as the same
          // text twice, at two different cell sizes - so drop its glyph cache
          // and force a full repaint.
          term.clearTextureAtlas?.();
          term.refresh(0, term.rows - 1);
        }
      }
    });
  }

  window.addEventListener('resize', () => {
    if (!document.hidden && !leaving) scheduleFit();
  });
  window.visualViewport?.addEventListener('resize', () => {
    if (!document.hidden && !leaving) scheduleFit();
  });
  new ResizeObserver(() => {
    if (!document.hidden && !leaving) scheduleFit();
  }).observe(host);
  document.fonts.ready.then(() => {
    if (!document.hidden && !leaving) scheduleFit();
  });
  scheduleFit();

  function replaceArg(arg) {
    currentArg = arg;
    const url = new URL(location.href);
    if (arg === null) url.searchParams.delete('arg');
    else url.searchParams.set('arg', arg);
    if (url.href !== location.href) history.replaceState(history.state, '', url);
  }

  function receiveTitle(raw, frame = false) {
    if (!active?.acceptTitles || leaving) return;
    const title = raw.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 512);
    const tmux = title.match(/^[^:]+:@(\d+):/);
    const screen = title.match(/^omp-([A-Za-z0-9_-]+)$/);
    if (title === 'omp-launcher') {
      replaceArg(null);
      active.sessionTitle = true;
    } else if (tmux) {
      replaceArg(`tmux-${tmux[1]}`);
      active.sessionTitle = true;
    } else if (screen) {
      replaceArg(screen[1]);
      active.sessionTitle = true;
    } else if (frame && active.sessionTitle) {
      return;
    }
    if (title) document.title = `${title} · omp`;
  }

  term.onTitleChange(title => receiveTitle(title));

  function isCurrent(ctx) {
    return active === ctx && !leaving;
  }

  function sendControl(ctx, command, payload = '') {
    if (!isCurrent(ctx) || !ctx.ready || ctx.socket.readyState !== WebSocket.OPEN) return false;
    ctx.socket.send(encoder.encode(command + payload));
    return true;
  }

  function sendInput(data, intentional = false) {
    const ctx = active;
    if (!intentional && !terminalAction && composer.contains(document.activeElement)) return false;
    if (!ctx?.ready || ctx.socket.readyState !== WebSocket.OPEN || leaving) return false;
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    const packet = new Uint8Array(bytes.length + 1);
    packet[0] = 48;
    packet.set(bytes, 1);
    ctx.socket.send(packet);
    setPrefix(false);
    return true;
  }

  // These subscriptions live for the page, not the socket. Reconnecting must
  // never multiply input, resize, parser, or keybar handlers.
  term.onData(sendInput);
  term.onBinary(data => sendInput(Uint8Array.from(data, character => character.charCodeAt(0))));
  let resizeTimer = null;
  let lastSentCols = 0;
  let lastSentRows = 0;

  term.onResize(({ cols, rows }) => {
    if (document.hidden || leaving) return;
    if (cols === lastSentCols && rows === lastSentRows) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (document.hidden || leaving) return;
      if (active && (cols !== lastSentCols || rows !== lastSentRows)) {
        lastSentCols = cols;
        lastSentRows = rows;
        sendControl(active, '1', JSON.stringify({ columns: cols, rows }));
      }
    }, 80);
  });

  function retireConnection() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const ctx = active;
    active = null;
    if (!ctx) return;
    ctx.acceptTitles = false;
    ctx.abort.abort();
    clearTimeout(ctx.timeout);
    if (ctx.socket && ctx.socket.readyState < WebSocket.CLOSING) ctx.socket.close();
  }

  function connectionFailed(ctx, message, retry = true) {
    if (!isCurrent(ctx) || ctx.failed) return;
    ctx.failed = true;
    ctx.ready = false;
    ctx.abort.abort();
    clearTimeout(ctx.timeout);
    if (ctx.socket && ctx.socket.readyState < WebSocket.CLOSING) ctx.socket.close();
    if (retry) {
      const delay = Math.min(1000 * 2 ** Math.min(retryCount++, 4), 10000);
      setConnection('disconnected', `${message} Reconnecting in ${delay / 1000}s…`);
      reconnectTimer = setTimeout(() => {
        if (isCurrent(ctx)) connect();
      }, delay);
    } else {
      setConnection('disconnected', `${message} Use Reconnect to try again.`);
    }
  }

  function applyPreferences(bytes) {
    const preferences = JSON.parse(decoder.decode(bytes));
    // ttyd also sends client/plugin preferences. Only terminal presentation
    // options apply here; no preference can install a renderer or remote asset.
    const options = [
      'cursorBlink', 'cursorStyle', 'cursorInactiveStyle', 'cursorWidth',
      'drawBoldTextInBrightColors', 'fontFamily', 'fontSize', 'fontWeight',
      'fontWeightBold', 'letterSpacing', 'lineHeight', 'minimumContrastRatio',
      'scrollback', 'screenReaderMode', 'tabStopWidth', 'theme',
      'macOptionIsMeta', 'rightClickSelectsWord',
    ];
    for (const name of options) {
      if (Object.hasOwn(preferences, name)) {
        if (name === 'fontSize' && localStorage.getItem('terminal-font-size')) continue;
        term.options[name] = preferences[name];
      }
    }
    scheduleFit();
  }

  function receiveMessage(ctx, event) {
    if (!isCurrent(ctx) || ctx.failed) return;
    const bytes = typeof event.data === 'string' ? encoder.encode(event.data) : new Uint8Array(event.data);
    if (!bytes.length) return;
    const body = bytes.subarray(1);
    switch (bytes[0]) {
      case 48: {
        if (ctx.pending + body.byteLength > MAX_PENDING) {
          connectionFailed(ctx, 'Output exceeded the terminal buffer limit.', false);
          return;
        }
        ctx.pending += body.byteLength;
        if (!ctx.paused && ctx.pending >= HIGH_WATER) {
          ctx.paused = sendControl(ctx, '2');
        }
        term.write(body, () => {
          ctx.pending -= body.byteLength;
          if (isCurrent(ctx) && ctx.paused && ctx.pending <= LOW_WATER) {
            ctx.paused = false;
            sendControl(ctx, '3');
          }
        });
        break;
      }
      case 49:
        receiveTitle(decoder.decode(body), true);
        break;
      case 50:
        try {
          applyPreferences(body);
        } catch {
          showNotice('The server sent terminal preferences that could not be applied.');
        }
        break;
    }
  }

  function connect(fromNavigation = false) {
    if (leaving) return;
    const acceptPendingTitles = !fromNavigation && Boolean(active?.acceptTitles);
    retireConnection();
    const ctx = {
      abort: new AbortController(), socket: null, timeout: null,
      ready: false, failed: false, acceptTitles: acceptPendingTitles, sessionTitle: false,
      pending: 0, paused: false,
    };
    active = ctx;
    setConnection('connecting', 'Connecting…');
    // Drain old writes before resetting. Reconnects retain a final queued
    // session title; Back/Forward discards it in favor of the requested URL.
    term.write('', async () => {
      if (!isCurrent(ctx)) return;
      ctx.acceptTitles = false;
      ctx.sessionTitle = false;
      term.reset();
      term.options.disableStdin = true;
      ctx.timeout = setTimeout(() => connectionFailed(ctx, 'Connection timed out.'), 15000);
      try {
        const response = await fetch('/t/token', { cache: 'no-store', credentials: 'same-origin', signal: ctx.abort.signal });
        if (!response.ok) throw new Error(`Token request failed (${response.status}).`);
        const { token } = await response.json();
        if (!isCurrent(ctx) || ctx.failed) return;
        const url = new URL('/t/ws', location.href);
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        if (currentArg !== null) url.searchParams.set('arg', currentArg);
        const socket = new WebSocket(url, 'tty');
        ctx.socket = socket;
        socket.binaryType = 'arraybuffer';
        socket.addEventListener('open', () => {
          if (!isCurrent(ctx) || ctx.failed) { socket.close(); return; }
          lastSentCols = term.cols;
          lastSentRows = term.rows;
          socket.send(encoder.encode(JSON.stringify({ AuthToken: token ?? '', columns: term.cols, rows: term.rows })));
          clearTimeout(ctx.timeout);
          ctx.ready = true;
          ctx.acceptTitles = true;
          setConnection('connected', 'Connected');
          if (!matchMedia('(any-pointer: coarse)').matches) focusTerminal();
        });
        socket.addEventListener('message', event => {
          if (isCurrent(ctx) && !ctx.failed) retryCount = 0;
          receiveMessage(ctx, event);
        });
        socket.addEventListener('close', () => connectionFailed(ctx, 'Disconnected.'));
        socket.addEventListener('error', () => connectionFailed(ctx, 'Connection failed.'));
      } catch (error) {
        if (isCurrent(ctx) && !ctx.failed) connectionFailed(ctx, error.message || 'Connection failed.');
      }
    });
  }

  reconnect.addEventListener('click', () => { retryCount = 0; connect(); });
  window.addEventListener('online', () => { if (!active?.ready && !leaving) connect(); });
  window.addEventListener('popstate', () => {
    replaceArg(new URL(location.href).searchParams.get('arg'));
    retryCount = 0;
    connect(true);
  });
  window.addEventListener('pagehide', () => {
    leaving = true;
    clearTimeout(resizeTimer);
    stopPresenceHeartbeat();
    stopWindowBar();
    retireConnection();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(resizeTimer);
      stopPresenceHeartbeat();
      stopWindowBar();
    } else if (!leaving) {
      scheduleFit();
      startPresenceHeartbeat();
      startWindowBar();
    }
  });
  window.addEventListener('pageshow', event => {
    leaving = false;
    if (!document.hidden) {
      startPresenceHeartbeat();
      startWindowBar();
    }
    if (!event.persisted) {
      scheduleFit();
      return;
    }
    replaceArg(new URL(location.href).searchParams.get('arg'));
    connect();
  });
  if (!document.hidden) {
    startPresenceHeartbeat();
    startWindowBar();
  }

  function composerConnected() {
    return active?.ready && active.socket?.readyState === WebSocket.OPEN && !leaving;
  }

  function renderComposer() {
    const connected = composerConnected();
    composerStatus.textContent = connected ? composerMessage : 'Disconnected. Your draft is kept.';
    composerStatus.hidden = !composerStatus.textContent;
    composerPaste.disabled = !connected || composerComposing || !composerText.value.length;
    composerClear.disabled = composerComposing;
    composerAttach.disabled = uploading;
  }

  function setComposerOpen(open) {
    composer.hidden = !open;
    composerToggle.setAttribute('aria-expanded', String(open));
    composerToggle.textContent = open ? 'Close' : 'Compose';
    if (open) {
      setPrefix(false);
      renderComposer();
      composerText.focus({ preventScroll: true });
    } else {
      composerText.blur();
      composerToggle.focus({ preventScroll: true });
    }
    scheduleFit();
  }

  composerToggle.addEventListener('click', () => setComposerOpen(composer.hidden));
  composerText.addEventListener('input', () => {
    composerMessage = '';
    renderComposer();
  });
  composerText.addEventListener('compositionstart', () => {
    composerComposing = true;
    renderComposer();
  });
  composerText.addEventListener('compositionend', () => {
    composerComposing = false;
    renderComposer();
  });
  composerClear.addEventListener('click', () => {
    if (composerComposing) return;
    composerText.value = '';
    composerMessage = '';
    renderComposer();
    composerText.focus({ preventScroll: true });
  });
  composerPaste.addEventListener('click', () => {
    if (composerPaste.disabled || composerComposing) return;
    if (!pasteToTerminal(composerText.value)) {
      composerMessage = 'Paste could not be sent. Your draft is kept; check the terminal before trying again.';
      renderComposer();
      return;
    }
    composerText.value = '';
    composerMessage = '';
    renderComposer();
    setComposerOpen(false);
  });

  function pasteToTerminal(text) {
    if (!composerConnected()) return false;
    terminalAction = true;
    try {
      term.paste(text);
      return true;
    } catch {
      return false;
    } finally {
      terminalAction = false;
    }
  }

  // Drag a file anywhere onto the app to upload it, the same path as Attach.
  // dragover must be cancelled or the browser navigates away from the session and
  // opens the dropped file instead of uploading it.
  let dragDepth = 0;
  const appRoot = document.getElementById('app');
  appRoot.addEventListener('dragenter', event => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    dragDepth += 1;
    appRoot.classList.add('drag-over');
  });
  appRoot.addEventListener('dragover', event => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  appRoot.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) appRoot.classList.remove('drag-over');
  });
  appRoot.addEventListener('drop', event => {
    event.preventDefault();
    dragDepth = 0;
    appRoot.classList.remove('drag-over');
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length) {
      uploadFiles(files);
      return;
    }
    // Dragging a link or a selection types it into the terminal, which is what
    // dropping text on a terminal does anywhere else.
    const text = event.dataTransfer?.getData('text/plain');
    if (text) {
      pasteToTerminal(text);
      focusTerminal();
    }
  });

  function openFilePicker() {
    if (uploading) return;
    fileUploader.click();
  }

  composerAttach.addEventListener('click', openFilePicker);

  /** Upload files and insert their @paths into the composer or the terminal -
   *  the shared tail of Attach and of pasting an image from the clipboard. */
  async function uploadFiles(files) {
    if (!files.length || uploading) return;
    uploading = true;
    renderComposer();
    const count = files.length;
    const nameLabel = count === 1 ? files[0].name : `${count} files`;
    showNotice(`Uploading ${nameLabel}…`);

    const paths = [];
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file, file.name);
        const res = await fetch('/upload', {
          method: 'POST',
          body: formData,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(err.error || `Upload failed (${res.status})`);
        }
        const data = await res.json();
        if (!data.ok || !data.path) {
          throw new Error(data.error || 'Server rejected file');
        }
        paths.push(data.path);
      }

      const insertText = paths.map(p => '@' + p).join(' ') + ' ';

      if (!composer.hidden) {
        const start = composerText.selectionStart ?? composerText.value.length;
        const end = composerText.selectionEnd ?? composerText.value.length;
        const current = composerText.value;
        composerText.value = current.slice(0, start) + insertText + current.slice(end);
        const nextPos = start + insertText.length;
        composerText.setSelectionRange(nextPos, nextPos);
        composerText.focus({ preventScroll: true });
        renderComposer();
      } else {
        pasteToTerminal(insertText);
        focusTerminal();
      }

      showNotice(`Attached ${nameLabel} (@path inserted).`);
      setTimeout(() => {
        if (noticeText.textContent.startsWith('Attached ')) notice.hidden = true;
      }, 4000);
    } catch (err) {
      showNotice(`Upload failed: ${err.message}`);
    } finally {
      uploading = false;
      renderComposer();
    }
  }

  fileUploader.addEventListener('change', () => {
    const files = Array.from(fileUploader.files || []);
    fileUploader.value = '';
    uploadFiles(files);
  });

  // Safari has no navigator.clipboard.read() at all, so an image on the clipboard
  // is only visible through a paste event (Command-V / Ctrl-V). Intercept it in
  // the capture phase, before xterm sees it: a terminal has nowhere to put
  // pixels, so the image is uploaded and its @path inserted instead. Text pastes
  // fall through untouched.
  document.addEventListener('paste', event => {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind !== 'file' || !item.type?.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file) continue;
      event.preventDefault();
      event.stopPropagation();
      uploadFiles([file]);
      return;
    }
  }, true);

  /** The first image on the clipboard as a File, or null - also when the browser
   *  refuses clipboard.read() (it needs the clipboard-read permission). */
  async function readClipboardImage() {
    if (!navigator.clipboard?.read) return null;
    let items;
    try {
      items = await navigator.clipboard.read();
    } catch {
      return null;
    }
    for (const item of items) {
      const type = item.types?.find(candidate => candidate.startsWith('image/'));
      if (!type) continue;
      try {
        const blob = await item.getType(type);
        const extension = type === 'image/jpeg' ? 'jpg' : (type.split('/')[1] || 'png');
        return new File([blob], `clipboard.${extension}`, { type });
      } catch {}
    }
    return null;
  }

  function openPasteDialog() {
    if (pasteDialog.open || leaving) return;
    pasteText.value = '';
    pasteDialog.showModal();
    pasteText.focus({ preventScroll: true });
  }

  async function pasteClipboard() {
    const ctx = active;
    try {
      if (!navigator.clipboard?.readText) { openPasteDialog(); return; }
      const text = await navigator.clipboard.readText();
      if (!isCurrent(ctx) || !ctx.ready) {
        showNotice('The connection changed. Paste again when your session is connected.');
        return;
      }
      if (text) {
        pasteToTerminal(text);
        focusTerminal();
        return;
      }
      // No text: the clipboard may hold an image instead (a screenshot, a copied
      // picture). Upload it exactly like Attach - a terminal has nowhere to put
      // pixels, and omp takes a path it can open.
      const image = await readClipboardImage();
      if (image) {
        await uploadFiles([image]);
        return;
      }
      // Safari never reaches the branch above (it has no clipboard.read at all),
      // so say how to get an image in rather than only what failed. Apple touch
      // devices (iPhone/iPad - iPadOS reports itself as a Mac) have no Command-V,
      // so point at the picker, which opens the photo library there.
      const appleTouch = applePlatform && navigator.maxTouchPoints > 0;
      showNotice(navigator.clipboard?.read
        ? 'Nothing to paste: the clipboard holds no text or image. Use Attach for a file.'
        : appleTouch
          ? 'Nothing to paste as text. Use Attach to pick a photo or a file.'
          : 'Nothing to paste as text. Press the paste shortcut (⌘V) for an image, or use Attach.');
    } catch {
      if (!leaving) openPasteDialog();
    }
  }

  document.getElementById('cancel-paste').addEventListener('click', () => pasteDialog.close());
  pasteDialog.addEventListener('close', () => {
    pasteText.value = '';
    focusTerminal();
  });
  document.getElementById('paste-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!active?.ready) { showNotice('Reconnect before sending this paste.'); return; }
    pasteToTerminal(pasteText.value);
    pasteDialog.close();
  });

  term.parser.registerOscHandler(52, data => {
    const separator = data.indexOf(';');
    if (separator < 0) return true;
    const encoded = data.slice(separator + 1);
    // Clipboard queries are deliberately never answered with browser data.
    if (encoded === '?' || !active?.acceptTitles || leaving) return true;
    try {
      const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      const text = decoder.decode(bytes);
      writeClipboard(text).then(copied => {
        // Always refresh the notice. Reporting only failures left the previous
        // notice - and its Copy button - frozen after a silent success, so a
        // second selection looked like the copy option had disappeared.
        if (copied) {
          hideNotice();
          flashCopied();
          return;
        }
        showNotice('Clipboard copy was blocked. Press Copy to place it on the clipboard.', text);
      });
    } catch {
      showNotice('The terminal clipboard request could not be decoded.');
    }
    return true;
  });

  const selectionDialog = document.getElementById('selection-dialog');
  const historyJoin = document.getElementById('history-join');
  const selectionText = document.getElementById('selection-text');
  const selectionStatus = document.getElementById('selection-status');
  const historyQuery = document.getElementById('history-query');
  const historyCount = document.getElementById('history-count');

  // Real history comes from the server (`/history` -> tmux capture-pane),
  // because under tmux the client's xterm buffer never grows beyond one screen
  // - tmux repaints the pane region instead of streaming scroll-inducing
  // newlines - so the browser cannot see history on its own. Pages load
  // newest-first; scrolling to the top pulls in the next older page.
  const HISTORY_CHUNK = 1000;
  const ANSI_RE = /\x1b\[([0-9;]*)m/g;
  let historyRaw = [];          // loaded lines, raw (may contain SGR)
  let selectionOffset = 0;      // lines held, counted back from the end
  let historyBaseIndex = 0;     // absolute index of historyRaw[0]
  let selectionMore = false;
  let selectionLoading = false;
  let suppressLoadMore = false; // set while a search jump positions the view
  let searchMatches = [];
  let searchIndex = 0;
  let searchTotal = 0;

  const plainLine = line => line.replace(ANSI_RE, '');

  /** tmux target for the window this tab is attached to: "tmux-2" -> "@2". */
  function historyWindowArg() {
    const match = /^tmux-([0-9]+)$/.exec(currentArg || '');
    return match ? `@${match[1]}` : null;
  }

  // ---- ANSI -> HTML -------------------------------------------------------
  // The dialog shows captured output with its colours, so the SGR runs have to
  // be turned into spans. Colours 0-15 come from the live xterm theme, so the
  // dialog matches the terminal exactly; 16-255 use the standard xterm palette
  // (the same values xterm itself renders for those indices).
  const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];
  const toHex = n => n.toString(16).padStart(2, '0');

  function palette256() {
    const theme = term.options.theme || {};
    const base = [theme.black, theme.red, theme.green, theme.yellow, theme.blue,
      theme.magenta, theme.cyan, theme.white, theme.brightBlack, theme.brightRed,
      theme.brightGreen, theme.brightYellow, theme.brightBlue, theme.brightMagenta,
      theme.brightCyan, theme.brightWhite].map(c => c || '#000000');
    for (const r of CUBE_LEVELS) {
      for (const g of CUBE_LEVELS) {
        for (const b of CUBE_LEVELS) base.push(`#${toHex(r)}${toHex(g)}${toHex(b)}`);
      }
    }
    for (let i = 0; i < 24; i++) {
      const v = 8 + i * 10;
      base.push(`#${toHex(v)}${toHex(v)}${toHex(v)}`);
    }
    return base;
  }

  function escapeHtml(text) {
    return text.replace(/[&<>]/g, ch => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
  }

  /** Palette + default colours. Built once per render batch: palette256()
   *  generates 240 colour strings, and doing that per line cost ~1.2M strings
   *  on a 5000-line history. */
  function ansiContext() {
    const theme = term.options.theme || {};
    return {
      palette: palette256(),
      defaultFg: theme.foreground || null,
      defaultBg: theme.background || null,
    };
  }

  function renderAnsi(raw, context) {
    const { palette, defaultFg, defaultBg } = context;
    const out = [];
    let fg = null, bg = null, bold = false, dim = false, underline = false, reverse = false;
    let last = 0;
    const emit = text => {
      if (!text) return;
      let useFg = reverse ? (bg || defaultBg) : fg;
      let useBg = reverse ? (fg || defaultFg) : bg;
      const style = [];
      if (useFg) style.push(`color:${useFg}`);
      if (useBg) style.push(`background-color:${useBg}`);
      if (bold) style.push('font-weight:600');
      if (underline) style.push('text-decoration:underline');
      if (dim) style.push('opacity:.7');
      const html = escapeHtml(text);
      out.push(style.length ? `<span style="${style.join(';')}">${html}</span>` : html);
    };
    const sgr = params => {
      const codes = params === '' ? [0] : params.split(';').map(n => parseInt(n, 10) || 0);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0) { fg = bg = null; bold = dim = underline = reverse = false; }
        else if (code === 1) bold = true;
        else if (code === 2) dim = true;
        else if (code === 4) underline = true;
        else if (code === 7) reverse = true;
        else if (code === 22) { bold = false; dim = false; }
        else if (code === 24) underline = false;
        else if (code === 27) reverse = false;
        else if (code >= 30 && code <= 37) fg = palette[code - 30];
        else if (code === 39) fg = null;
        else if (code >= 40 && code <= 47) bg = palette[code - 40];
        else if (code === 49) bg = null;
        else if (code >= 90 && code <= 97) fg = palette[code - 90 + 8];
        else if (code >= 100 && code <= 107) bg = palette[code - 100 + 8];
        else if (code === 38 || code === 48) {
          const target = code === 38 ? 'fg' : 'bg';
          const mode = codes[i + 1];
          if (mode === 5) { const value = palette[codes[i + 2]] || null; if (target === 'fg') fg = value; else bg = value; i += 2; }
          else if (mode === 2) {
            const [r, g, b] = [codes[i + 2], codes[i + 3], codes[i + 4]];
            const value = `#${toHex(r || 0)}${toHex(g || 0)}${toHex(b || 0)}`;
            if (target === 'fg') fg = value; else bg = value;
            i += 4;
          }
        }
      }
    };
    ANSI_RE.lastIndex = 0;
    let match;
    while ((match = ANSI_RE.exec(raw))) {
      emit(raw.slice(last, match.index));
      sgr(match[1]);
      last = ANSI_RE.lastIndex;
    }
    emit(raw.slice(last));
    return out.join('');
  }

  function renderHistory() {
    const previousHeight = selectionText.scrollHeight;
    const context = ansiContext();
    // one addressed element per line: search needs to find the mark on a
    // specific absolute line, which plain text runs cannot express
    selectionText.innerHTML = historyRaw
      .map((line, i) => `<span class="line" data-line="${historyBaseIndex + i}">${renderAnsi(line, context)}</span>`)
      .join('\n');
    return previousHeight;
  }

  /** Fallback when no server history is available: what this tab has seen. */
  function localSnapshotLines() {
    const buffer = term.buffer.active;
    const parts = [];
    for (let row = 0; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      if (row > 0 && !line.isWrapped) parts.push('\n');
      parts.push(line.translateToString(true));
    }
    return parts.join('').split('\n');
  }

  // Rows an application laid out itself (a long URL in a transcript) are stitched
  // back into one line by the service; this turns that off to compare.
  const JOIN_PREF = 'terminal-join-lines';

  function joinLines() {
    try { return localStorage.getItem(JOIN_PREF) !== '0'; } catch { return true; }
  }

  async function fetchHistory(offset) {
    const window = historyWindowArg();
    if (!window) return null;
    try {
      const res = await fetch(`/history?window=${encodeURIComponent(window)}&count=${HISTORY_CHUNK}`
        + `&offset=${offset}&color=1&join=${joinLines() ? 1 : 0}`,
        { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.ok && Array.isArray(data.lines) ? data : null;
    } catch {
      return null;
    }
  }

  function clearHighlights() {
    for (const mark of selectionText.querySelectorAll('.match')) {
      mark.replaceWith(document.createTextNode(mark.textContent));
    }
    selectionText.normalize();
  }

  function applyHighlights(query) {
    clearHighlights();
    if (!query) return;
    const needle = query.toLowerCase();
    const walker = document.createTreeWalker(selectionText, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      let at = lower.indexOf(needle);
      if (at === -1) continue;
      const fragment = document.createDocumentFragment();
      let done = 0;
      while (at !== -1) {
        if (at > done) fragment.appendChild(document.createTextNode(text.slice(done, at)));
        const mark = document.createElement('span');
        mark.className = 'match';
        mark.textContent = text.slice(at, at + needle.length);
        fragment.appendChild(mark);
        done = at + needle.length;
        at = lower.indexOf(needle, done);
      }
      if (done < text.length) fragment.appendChild(document.createTextNode(text.slice(done)));
      node.parentNode.replaceChild(fragment, node);
    }
  }

  function setCurrentMatch(element) {
    for (const mark of selectionText.querySelectorAll('.match.current')) mark.classList.remove('current');
    historyCount.textContent = searchMatches.length ? `${searchIndex + 1}/${searchMatches.length}` : '0/0';
    if (!element) return;
    element.classList.add('current');
    // suppress the load-older trigger while the jump repositions the view
    suppressLoadMore = true;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    setTimeout(() => { suppressLoadMore = false; }, 400);
  }

  async function jumpToMatch(position) {
    const match = searchMatches[position];
    if (!match) return;
    const window = historyWindowArg();
    if (!window) return;
    // centre the match in its page so there is context either side
    const offset = Math.max(0, searchTotal - 1 - match.index - Math.floor(HISTORY_CHUNK / 2));
    const page = await fetchHistory(offset);
    if (!page) { selectionStatus.textContent = 'Could not load that match.'; return; }
    historyRaw = page.lines;
    historyBaseIndex = page.start;
    selectionOffset = offset + page.lines.length;
    selectionMore = !!page.more;
    renderHistory();
    applyHighlights(historyQuery.value.trim());
    const line = selectionText.querySelector(`.line[data-line="${match.index}"]`);
    setCurrentMatch(line ? line.querySelector('.match') : null);
  }

  async function reloadHistory() {
    const page = await fetchHistory(0);
    if (!page) {
      // No window (launcher menu) or the service is unreachable.
      historyRaw = localSnapshotLines();
      renderHistory();
      selectionText.scrollTop = selectionText.scrollHeight;
      return;
    }
    historyRaw = page.lines;
    historyBaseIndex = page.start;
    selectionOffset = page.lines.length;
    selectionMore = !!page.more;
    renderHistory();
    selectionText.scrollTop = selectionText.scrollHeight;
    if (!selectionMore) selectionStatus.textContent = 'Start of history.';
  }

  function renderJoinToggle() {
    const on = joinLines();
    historyJoin.setAttribute('aria-pressed', String(on));
    historyJoin.title = on
      ? 'Rows an application wrapped are joined into one line'
      : 'Showing rows exactly as drawn';
  }

  historyJoin.addEventListener('click', async () => {
    try { localStorage.setItem(JOIN_PREF, joinLines() ? '0' : '1'); } catch {}
    renderJoinToggle();
    await reloadHistory();
  });

  async function openSelection() {
    selectionStatus.textContent = '';
    historyCount.textContent = '';
    searchMatches = [];
    searchIndex = 0;
    selectionOffset = 0;
    selectionMore = false;
    selectionLoading = false;
    selectionDialog.showModal();
    renderJoinToggle();
    await reloadHistory();
  }

  selectionText.addEventListener('scroll', async () => {
    if (suppressLoadMore || selectionLoading || !selectionMore || selectionText.scrollTop > 0) return;
    selectionLoading = true;
    selectionStatus.textContent = 'Loading older output…';
    const page = await fetchHistory(selectionOffset);
    selectionLoading = false;
    if (!page) {
      selectionStatus.textContent = 'Could not load older output.';
      return;
    }
    historyRaw = page.lines.concat(historyRaw);
    historyBaseIndex = page.start;
    const previousHeight = renderHistory();
    // prepending shifts everything down by the height it added; undo that so
    // the line being read stays put
    selectionText.scrollTop = selectionText.scrollHeight - previousHeight;
    selectionOffset += page.lines.length;
    selectionMore = !!page.more;
    applyHighlights(historyQuery.value.trim());
    selectionStatus.textContent = selectionMore ? '' : 'Start of history.';
  });

  // ---- search ------------------------------------------------------------
  let searchTimer = null;
  async function runSearch() {
    const query = historyQuery.value.trim();
    const window = historyWindowArg();
    if (!query || !window) {
      clearHighlights();
      searchMatches = [];
      historyCount.textContent = '';
      return;
    }
    historyCount.textContent = '…';
    try {
      const res = await fetch(`/history/search?window=${encodeURIComponent(window)}&q=${encodeURIComponent(query)}`,
        { cache: 'no-store' });
      const data = res.ok ? await res.json() : null;
      if (!data || !data.ok) { historyCount.textContent = '—'; return; }
      searchMatches = data.matches;
      searchTotal = data.total;
      searchIndex = 0;
      historyCount.textContent = `${searchMatches.length}/${searchMatches.length}`;
      if (!searchMatches.length) {
        clearHighlights();
        historyCount.textContent = '0/0';
        selectionStatus.textContent = 'No matches in history.';
        return;
      }
      selectionStatus.textContent = data.truncated ? 'Showing the newest matches only.' : '';
      await jumpToMatch(0);
    } catch {
      historyCount.textContent = '—';
    }
  }

  historyQuery.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 350);
  });
  historyQuery.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      clearTimeout(searchTimer);
      if (searchMatches.length) {
        searchIndex = (searchIndex + (event.shiftKey ? -1 : 1) + searchMatches.length) % searchMatches.length;
        jumpToMatch(searchIndex);
      } else {
        runSearch();
      }
    }
  });
  document.getElementById('history-next').addEventListener('click', () => {
    if (!searchMatches.length) { runSearch(); return; }
    searchIndex = (searchIndex + 1) % searchMatches.length;
    jumpToMatch(searchIndex);
  });
  document.getElementById('history-prev').addEventListener('click', () => {
    if (!searchMatches.length) { runSearch(); return; }
    searchIndex = (searchIndex - 1 + searchMatches.length) % searchMatches.length;
    jumpToMatch(searchIndex);
  });

  document.getElementById('select-all').addEventListener('click', () => {
    const range = document.createRange();
    range.selectNodeContents(selectionText);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    selectionText.focus({ preventScroll: true });
  });
  // Tapping a line selects the whole line. Dragging a selection across a row
  // that is longer than the dialog (which scrolls sideways instead of wrapping)
  // is impractical, especially with a thumb - and the line most likely to be
  // copied that way is a URL.
  selectionText.addEventListener('click', event => {
    const line = event.target?.closest?.('.line');
    if (!line) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;   // a real drag-selection wins
    const range = document.createRange();
    range.selectNodeContents(line);
    selection.removeAllRanges();
    selection.addRange(range);
    selectionStatus.textContent = 'Line selected — press Copy.';
  });

  document.getElementById('copy-selection').addEventListener('pointerdown', event => event.preventDefault());
  document.getElementById('copy-selection').addEventListener('click', async () => {
    const selection = window.getSelection();
    const hasSelection = !!selection && selection.rangeCount > 0 && !selection.isCollapsed;
    // never trim: leading indentation and trailing newlines are part of what the
    // user selected
    const payload = hasSelection ? selection.toString() : historyRaw.map(plainLine).join('\n');
    if (!payload) {
      selectionStatus.textContent = 'Nothing to copy yet.';
      return;
    }
    // Synchronous first, carrying exactly the payload the user selected.
    const copied = copyInGesture(payload) || await writeClipboard(payload);
    if (copied) flashCopied();
    selectionStatus.textContent = copied
      ? (hasSelection ? 'Copied selection.' : `Copied ${historyRaw.length} lines.`)
      : 'Copy was denied — select the text and use your browser menu.';
  });

  document.getElementById('close-selection').addEventListener('click', () => selectionDialog.close());
  selectionDialog.addEventListener('close', () => {
    selectionText.innerHTML = '';
    historyRaw = [];
    selectionOffset = 0;
    selectionMore = false;
    selectionLoading = false;
    searchMatches = [];
    historyCount.textContent = '';
    focusTerminal();
  });

  const NON_REPEATING_KEYS = new Set(['select', 'paste', 'attach', 'prefix', 'detach']);

  function executeKey(key) {
    if (key === 'paste') { pasteClipboard(); return; }
    if (key === 'select') { openSelection(); return; }
    if (key === 'attach') { openFilePicker(); return; }
    if (key === 'zoom-in') { adjustFontSize(1); return; }
    if (key === 'zoom-out') { adjustFontSize(-1); return; }
    if (key === 'prefix') {
      const armed = !prefixArmed;
      if (sendInput('\x01', true)) setPrefix(armed);
    } else if (key === 'detach') {
      sendInput(prefixArmed ? 'd' : '\x01d', true);
    } else {
      // Arrows are plain escape sequences and work inside copy-mode as well:
      // measured against #{pane_in_mode}, a keybar Up with no client-side mode
      // tracked still resolves to tmux's named Up and moves the copy cursor
      // (mode=1, scroll 1 -> 2). The removed Scroll button sent vi k/j here.
      const arrows = { up: 'A', down: 'B', right: 'C', left: 'D' };
      const keys = { escape: '\x1b', enter: '\r', backspace: '\x7f', tab: '\t', interrupt: '\x03', eof: '\x04', clear: '\x0c' };
      // Always SS3 (application form). Both termininfo entries in this stack
      // declare it - the client's TERM=xterm-256color and the pane's
      // tmux-256color all say kcuu1=\EOA - and tmux parses client input against
      // the former. Measured: a CSI up (0x1b 5b 41) is passed through untouched
      // and types "[A" at the shell prompt, while SS3 recalls the history entry.
      // The old conditional sent CSI whenever DECCKM was off.
      const data = arrows[key] ? `\x1bO${arrows[key]}`
        : keys[key];
      sendInput(data, true);
    }
    focusTerminal();
  }

  let activeKeyButton = null;
  let activePointerId = null;
  let keyStartX = 0;
  let keyStartY = 0;
  let keyRepeatTimer = null;
  let keyRepeatInterval = null;
  let keyFiredCount = 0;
  let lastPointerHandledTime = 0;

  function stopKeyRepeat() {
    clearTimeout(keyRepeatTimer);
    clearInterval(keyRepeatInterval);
    keyRepeatTimer = null;
    keyRepeatInterval = null;
    if (activeKeyButton) {
      activeKeyButton.classList.remove('key-active');
      activeKeyButton = null;
    }
    activePointerId = null;
    keyFiredCount = 0;
  }

  // Cancel focus transfer, not the click: tapping a terminal key keeps the
  // actual xterm textarea (and the phone keyboard) focused.
  keybar.addEventListener('pointerdown', event => {
    const button = event.target.closest('button[data-key]');
    if (!button || button.disabled) return;
    event.preventDefault();

    stopKeyRepeat();

    const key = button.dataset.key;
    activeKeyButton = button;
    activePointerId = event.pointerId;
    keyStartX = event.clientX;
    keyStartY = event.clientY;
    keyFiredCount = 0;
    button.classList.add('key-active');

    const isMouse = event.pointerType === 'mouse';
    const isRepeatable = !NON_REPEATING_KEYS.has(key);

    if (isMouse) {
      executeKey(key);
      lastPointerHandledTime = Date.now();
      keyFiredCount++;
      if (isRepeatable) {
        keyRepeatTimer = setTimeout(() => {
          keyRepeatInterval = setInterval(() => {
            executeKey(key);
            lastPointerHandledTime = Date.now();
            keyFiredCount++;
          }, 60);
        }, 350);
      }
    } else {
      // Touch/pen: delay first repeat to allow horizontal toolbar scrolling.
      // If held for 300ms without moving > 8px, start auto-repeat:
      if (isRepeatable) {
        keyRepeatTimer = setTimeout(() => {
          executeKey(key);
          lastPointerHandledTime = Date.now();
          keyFiredCount++;
          keyRepeatInterval = setInterval(() => {
            executeKey(key);
            lastPointerHandledTime = Date.now();
            keyFiredCount++;
          }, 60);
        }, 300);
      }
    }
  });

  window.addEventListener('pointermove', event => {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    const distance = Math.hypot(event.clientX - keyStartX, event.clientY - keyStartY);
    if (distance > 8) stopKeyRepeat();
  });

  window.addEventListener('pointerup', event => {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    const button = activeKeyButton;
    const key = button?.dataset.key;
    const fired = keyFiredCount;
    stopKeyRepeat();

    if (button && fired === 0 && !button.disabled) {
      executeKey(key);
      lastPointerHandledTime = Date.now();
    }
  });

  window.addEventListener('pointercancel', event => {
    if (event.pointerId === activePointerId) {
      stopKeyRepeat();
    }
  });

  window.addEventListener('blur', stopKeyRepeat);

  keybar.addEventListener('contextmenu', event => {
    if (event.target.closest('button')) event.preventDefault();
  });

  keybar.addEventListener('click', event => {
    event.preventDefault();
    if (Date.now() - lastPointerHandledTime < 500) return;
    const button = event.target.closest('button[data-key]');
    if (!button || button.disabled) return;
    executeKey(button.dataset.key);
  });

  function lineHeight() {
    const screen = term.element.querySelector('.xterm-screen');
    return screen.clientHeight / term.rows || term.options.fontSize * term.options.lineHeight;
  }

  const SCROLL_SPEED = 3;
  // A desktop wheel notch used to emit SCROLL_SPEED (3) reports, and each report
  // scrolls 3 lines inside copy-mode (tmux.conf), so one notch jumped 9 lines -
  // measured 9/364 -> 18/364 history. A wheel event now emits one report, i.e.
  // 3 lines per notch like a normal terminal. The touch path keeps SCROLL_SPEED,
  // so phone swipe distance is unchanged.
  const WHEEL_REPORTS = 1;
  // One SGR report scrolls one line now that tmux.conf's wheel bindings use
  // `-N 1`, so the touch multiplier is 3x its old value to keep a swipe's
  // distance identical: reports per row x lines per report is unchanged at 4.5.
  const TOUCH_REPORTS_PER_ROW = 4.5;
  /** Terminal cell (1-based) under a client-space point, clamped in range. */
  function cellAt(clientX, clientY) {
    const screen = term.element.querySelector('.xterm-screen');
    const rect = screen.getBoundingClientRect();
    const cellWidth = rect.width / term.cols || 1;
    const cellHeight = rect.height / term.rows || 1;
    return {
      x: Math.min(term.cols, Math.max(1, Math.floor((clientX - rect.left) / cellWidth) + 1)),
      y: Math.min(term.rows, Math.max(1, Math.floor((clientY - rect.top) / cellHeight) + 1)),
    };
  }

  // History scrolling - for the wheel, a trackpad, a touch swipe or an iPad
  // trackpad - is done by emitting SGR (1006) wheel reports straight into the
  // input stream. Deliberately NOT by synthesizing DOM WheelEvents and letting
  // xterm forward them: xterm only forwards wheels to the app in some mouse
  // modes, and in tmux's usual 'drag' (1002) mode it forwards none (measured 0
  // bytes), so that path silently did nothing on every surface. tmux parses
  // mouse sequences from the client stream regardless of mode.
  // Button 64 = wheel up (older history), 65 = wheel down; a downward finger
  // drag and a downward wheel both reveal older content.
  function sendScrollReports(lines, source) {
    const count = Math.min(15, Math.abs(lines));
    const { x, y } = cellAt(source.clientX, source.clientY);
    const button = lines > 0 ? 65 : 64;
    sendInput(`\x1b[<${button};${x};${y}M`.repeat(count), true);
  }

  let wheelRemainder = 0;
  term.attachCustomWheelEventHandler(event => {
    if (event.ctrlKey) return false; // trackpad pinch / Ctrl+wheel stays browser zoom
    if (term.modes.mouseTrackingMode !== 'none') {
      sendScrollReports(Math.sign(event.deltaY) * WHEEL_REPORTS, event);
      event.preventDefault();
      return false;
    }
    // No mouse reporting (e.g. the launcher menu): scroll xterm's own buffer.
    // xterm's alternate-scroll fallback would send cursor keys instead, which
    // must never rotate the shell's command history.
    const amount = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaY * term.rows
        : event.deltaY / lineHeight();
    wheelRemainder += amount * SCROLL_SPEED;
    const lines = Math.trunc(wheelRemainder);
    wheelRemainder -= lines;
    if (lines) term.scrollLines(lines);
    event.preventDefault();
    return false;
  });

  const surface = term.element;
  const touches = new Map();
  let multitouch = false;
  let suppressMouseUntil = 0;
  let touchRemainder = 0;

  // A click must not count as a drag. Real mice jitter a pixel or two between
  // press and release, and xterm reports every motion as a mouse drag - so tmux
  // saw MouseDrag1Pane and began a selection on an ordinary click (measured:
  // a 2px jitter gave sel_active=1). Because scrolling moves copy-mode's
  // cursor, the next scroll then extended that selection one line per notch:
  // "it selects all the text on the way". Suppress motion reports until the
  // pointer has genuinely moved, mirroring the touch bridge's 8px threshold.
  // Registered on window in the capture phase so it runs before xterm's own
  // document-level drag tracking.
  const MOUSE_DRAG_THRESHOLD = 4;
  let mousePress = null;
  surface.addEventListener('mousedown', event => {
    mousePress = event.button === 0 ? { x: event.clientX, y: event.clientY, moved: false } : null;
  }, true);
  window.addEventListener('mousemove', event => {
    if (!mousePress || mousePress.moved) return;
    const distance = Math.hypot(event.clientX - mousePress.x, event.clientY - mousePress.y);
    if (distance < MOUSE_DRAG_THRESHOLD) {
      event.stopImmediatePropagation();
      return;
    }
    mousePress.moved = true;
  }, true);
  window.addEventListener('mouseup', () => { mousePress = null; }, true);


  // xterm's native TouchEvent handlers would also scroll the viewport. Keep
  // the browser's default pinch gesture but let this pointer bridge own swipes.
  for (const name of ['touchstart', 'touchmove', 'touchend']) {
    surface.addEventListener(name, event => event.stopImmediatePropagation(), { capture: true, passive: true });
  }
  for (const name of ['mousedown', 'mouseup', 'click', 'dblclick']) {
    surface.addEventListener(name, event => {
      if (Date.now() < suppressMouseUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }

  surface.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY, lastY: event.clientY, moved: false });
    if (touches.size > 1) multitouch = true;
    if (touches.size === 1) touchRemainder = 0;
    surface.setPointerCapture(event.pointerId);
  });

  surface.addEventListener('pointermove', event => {
    const touch = touches.get(event.pointerId);
    if (!touch || multitouch) return;
    if (!touch.moved && Math.hypot(event.clientX - touch.x, event.clientY - touch.y) < 8) return;
    touch.moved = true;
    suppressMouseUntil = Date.now() + 800;
    touchRemainder += (touch.lastY - event.clientY) / lineHeight() * (term.modes.mouseTrackingMode !== 'none' ? TOUCH_REPORTS_PER_ROW : SCROLL_SPEED);
    touch.lastY = event.clientY;
    const lines = Math.trunc(touchRemainder);
    if (!lines) return;
    touchRemainder -= lines;
    if (term.modes.mouseTrackingMode !== 'none') {
      sendScrollReports(lines, event);
    } else {
      term.scrollLines(lines);
    }
  });

  function endTouch(event) {
    const touch = touches.get(event.pointerId);
    if (!touch) return;
    const cancelled = event.type !== 'pointerup';
    if (touch.moved || multitouch || cancelled) suppressMouseUntil = Date.now() + 800;
    else focusTerminal(true);
    touches.delete(event.pointerId);
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
    if (!touches.size) multitouch = false;
  }
  surface.addEventListener('pointerup', endTouch);
  surface.addEventListener('pointercancel', endTouch);
  surface.addEventListener('lostpointercapture', endTouch);

  connect();
})();
