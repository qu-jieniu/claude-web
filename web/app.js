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
  const pasteDialog = document.getElementById('paste-dialog');
  const pasteText = document.getElementById('paste-text');
  const sendPaste = document.getElementById('send-paste');

  if (!window.Terminal || !window.FitAddon) {
    connection.textContent = 'Terminal assets could not load. Reload this page to try again.';
    connection.dataset.state = 'disconnected';
    reconnect.addEventListener('click', () => location.reload());
    return;
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const term = new Terminal({
    fontFamily: 'ui-monospace, "DejaVu Sans Mono", "Liberation Mono", Menlo, Consolas, monospace',
    fontSize: 14,
    cursorBlink: true,
    scrollback: 10000,
    scrollOnUserInput: false,
    disableStdin: true,
    theme: { background: '#11151b', foreground: '#e4e8ef', cursor: '#c5e3ff' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
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
  const HIGH_WATER = 256 * 1024;
  const LOW_WATER = 64 * 1024;
  const MAX_PENDING = 8 * 1024 * 1024;

  function showNotice(message) {
    noticeText.textContent = message;
    notice.hidden = false;
  }

  document.getElementById('dismiss-notice').addEventListener('click', () => {
    notice.hidden = true;
    focusTerminal();
  });

  function focusTerminal() {
    if (!document.querySelector('dialog[open]')) term.textarea.focus({ preventScroll: true });
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
  }

  // Layout width deliberately comes from the layout viewport, not visualViewport:
  // a pinch magnifies existing columns, while the keyboard still reduces height.
  function scheduleFit() {
    if (fitFrame !== null) return;
    fitFrame = requestAnimationFrame(() => {
      fitFrame = null;
      const viewport = window.visualViewport;
      const layoutHeight = document.documentElement.clientHeight;
      const height = viewport ? Math.min(layoutHeight, viewport.height * viewport.scale) : layoutHeight;
      app.style.height = `${Math.max(1, Math.floor(height))}px`;
      app.style.top = `${viewport && viewport.scale <= 1.01 ? viewport.offsetTop : 0}px`;
      if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
    });
  }

  window.addEventListener('resize', scheduleFit);
  window.visualViewport?.addEventListener('resize', scheduleFit);
  window.visualViewport?.addEventListener('scroll', scheduleFit);
  new ResizeObserver(scheduleFit).observe(host);
  document.fonts.ready.then(scheduleFit);
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

  function sendInput(data) {
    const ctx = active;
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
  term.onResize(({ cols, rows }) => {
    if (active) sendControl(active, '1', JSON.stringify({ columns: cols, rows }));
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
      if (Object.hasOwn(preferences, name)) term.options[name] = preferences[name];
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
    currentArg = new URL(location.href).searchParams.get('arg');
    retryCount = 0;
    connect(true);
  });
  window.addEventListener('pagehide', () => {
    leaving = true;
    retireConnection();
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    leaving = false;
    currentArg = new URL(location.href).searchParams.get('arg');
    connect();
  });

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
      term.paste(text);
      focusTerminal();
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
    term.paste(pasteText.value);
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
      if (!navigator.clipboard?.writeText) {
        showNotice('Clipboard copy is unavailable. Select terminal text and copy it manually.');
      } else {
        navigator.clipboard.writeText(text).catch(() => {
          showNotice('Clipboard copy was denied. Select terminal text and copy it manually.');
        });
      }
    } catch {
      showNotice('The terminal clipboard request could not be decoded.');
    }
    return true;
  });

  const selectionDialog = document.getElementById('selection-dialog');
  const selectionText = document.getElementById('selection-text');
  const selectionStatus = document.getElementById('selection-status');

  function openSelection() {
    const buffer = term.buffer.active;
    let text = '';
    for (let row = buffer.viewportY; row < buffer.viewportY + term.rows; row++) {
      const line = buffer.getLine(row);
      if (!line) break;
      if (row > buffer.viewportY && !line.isWrapped) text += '\n';
      text += line.translateToString(true);
    }
    selectionText.value = text;
    selectionStatus.textContent = '';
    selectionDialog.showModal();
    selectionText.scrollTop = 0;
  }

  document.getElementById('select-all').addEventListener('click', () => {
    selectionText.focus();
    selectionText.select();
  });
  document.getElementById('copy-selection').addEventListener('pointerdown', event => event.preventDefault());
  document.getElementById('copy-selection').addEventListener('click', async () => {
    const start = selectionText.selectionStart;
    const end = selectionText.selectionEnd;
    if (start === end) {
      selectionStatus.textContent = 'Long-press to select text, or tap Select all first.';
      return;
    }
    const text = selectionText.value.slice(start, end);
    // The synchronous copy command retains the user gesture on plain HTTP.
    selectionText.focus({ preventScroll: true });
    selectionText.setSelectionRange(start, end);
    let copied = false;
    try { copied = document.execCommand('copy'); } catch {}
    if (!copied && navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); copied = true; } catch {}
    }
    selectionStatus.textContent = copied ? 'Copied selected text.' : 'Use Copy in your phone’s native selection menu.';
  });
  document.getElementById('close-selection').addEventListener('click', () => selectionDialog.close());
  selectionDialog.addEventListener('close', () => {
    selectionText.value = '';
    focusTerminal();
  });

  // Cancel focus transfer, not the click: tapping a terminal key keeps the
  // actual xterm textarea (and the phone keyboard) focused.
  keybar.addEventListener('pointerdown', event => {
    if (event.target.closest('button')) event.preventDefault();
  });
  keybar.addEventListener('click', event => {
    const button = event.target.closest('button[data-key]');
    if (!button || button.disabled) return;
    const key = button.dataset.key;
    if (key === 'paste') { pasteClipboard(); return; }
    if (key === 'select') { openSelection(); return; }
    if (key === 'prefix') {
      const armed = !prefixArmed;
      if (sendInput('\x01')) setPrefix(armed);
    } else if (key === 'detach') {
      sendInput(prefixArmed ? 'd' : '\x01d');
    } else {
      const arrows = { up: 'A', down: 'B', right: 'C', left: 'D' };
      const keys = { escape: '\x1b', tab: '\t', interrupt: '\x03', eof: '\x04', clear: '\x0c' };
      sendInput(arrows[key] ? `\x1b${term.modes.applicationCursorKeysMode ? 'O' : '['}${arrows[key]}` : keys[key]);
    }
    focusTerminal();
  });

  function lineHeight() {
    const screen = term.element.querySelector('.xterm-screen');
    return screen.clientHeight / term.rows || term.options.fontSize * term.options.lineHeight;
  }

  let wheelRemainder = 0;
  term.attachCustomWheelEventHandler(event => {
    if (event.ctrlKey) return false; // Browser pinch/trackpad zoom remains native.
    if (term.modes.mouseTrackingMode !== 'none') return true;
    // xterm's alternate-scroll fallback sends cursor keys. Scrolling here must
    // never rotate the command history, even in an alternate-screen TUI.
    const amount = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaY * term.rows
        : event.deltaY / lineHeight();
    wheelRemainder += amount;
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
    touchRemainder += (touch.lastY - event.clientY) / lineHeight();
    touch.lastY = event.clientY;
    const lines = Math.trunc(touchRemainder);
    if (!lines) return;
    touchRemainder -= lines;
    if (term.modes.mouseTrackingMode !== 'none') {
      surface.querySelector('.xterm-viewport').dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaMode: WheelEvent.DOM_DELTA_LINE, deltaY: lines,
        clientX: event.clientX, clientY: event.clientY,
      }));
    } else {
      term.scrollLines(lines);
    }
  });

  function endTouch(event) {
    const touch = touches.get(event.pointerId);
    if (!touch) return;
    const cancelled = event.type !== 'pointerup';
    if (touch.moved || multitouch || cancelled) suppressMouseUntil = Date.now() + 800;
    else focusTerminal();
    touches.delete(event.pointerId);
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
    if (!touches.size) multitouch = false;
  }
  surface.addEventListener('pointerup', endTouch);
  surface.addEventListener('pointercancel', endTouch);
  surface.addEventListener('lostpointercapture', endTouch);

  connect();
})();
