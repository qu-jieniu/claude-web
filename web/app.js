(() => {
  'use strict';

  const app = document.getElementById('app');
  const host = document.getElementById('terminal');
  const connection = document.getElementById('connection');
  const reconnect = document.getElementById('reconnect');
  const keybar = document.getElementById('keybar');
  let terminalShell = null;
  const composer = document.getElementById('composer');
  const composerToggle = document.getElementById('composer-toggle');
  const reflowToggle = document.getElementById('reflow-toggle');
  const composerText = document.getElementById('composer-text');
  const composerStatus = document.getElementById('composer-status');
  const composerPaste = document.getElementById('composer-paste');
  const composerClear = document.getElementById('composer-clear');
  const composerAttach = document.getElementById('composer-attach');
  const fileUploader = document.getElementById('file-uploader');
  const artifactButton = document.getElementById('artifact-toggle');
  const artifactDialog = document.getElementById('artifact-dialog');
  const artifactStatus = document.getElementById('artifact-status');
  const artifactGallery = document.getElementById('artifact-gallery');
  const refreshArtifacts = document.getElementById('refresh-artifacts');
  const closeArtifacts = document.getElementById('close-artifacts');

  if (!window.Terminal || !window.FitAddon || !window.TerminalShell) {
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
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      cursorAccent: '#1e1e2e',
      selectionBackground: '#585b70',
      selectionInactiveBackground: '#45475a',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8',
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
  let imageAddon = null;
  if (window.ImageAddon) {
    try {
      imageAddon = new ImageAddon.ImageAddon({
        sixelSupport: true,
        iipSupport: true,
        showPlaceholder: true,
      });
      term.loadAddon(imageAddon);
    } catch {
      imageAddon = null;
    }
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
  let fitFrame = null;
  let lastFitBox = { width: 0, height: 0, dpr: 0 };
  let composerComposing = false;
  let composerMessage = '';
  let composerSyncing = false;
  let composerSyncedText = null;
  let composerSyncedWindow = null;
  let composerDraftRequest = null;
  let activeOmpEditorWindow = null;
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
  const COMPOSER_SYNC_TIMEOUT_MS = 1200;
  const ARTIFACT_SCAN_DELAY_MS = 180;
  const IMAGE_PROTOCOL_HEADER_BYTES = 96;
  const IIP_MARKER = encoder.encode('\x1b]1337;File=');
  const seenArtifactCanvases = new WeakSet();
  let artifactScanTimer = null;
  let artifactListRequest = 0;
  let artifactCaptureErrorShown = false;
  let imageProtocolEscape = false;
  let sixelHeaderBytesRemaining = 0;
  let iipMarkerOffset = 0;

  let terminalState = 'connecting';
  const terminalStateListeners = new Set();
  const terminalAdapter = {
    focus: focusTerminal,
    send: data => sendInput(data, true),
    paste: pasteToTerminal,
    getSelection: () => term.getSelection(),
    clearSelection: () => term.clearSelection(),
    fit: scheduleFit,
    getFontSize: () => term.options.fontSize || DEFAULT_FONT_SIZE,
    setFontSize(size) {
      if (size === term.options.fontSize) return true;
      term.options.fontSize = size;
      // Mail exposed the failure mode: xterm can retain glyph metrics measured
      // before a font/size transition. Drop the atlas before every shared-shell
      // zoom, then let the existing fit path remeasure and send pixel geometry.
      term.clearTextureAtlas?.();
      scheduleFit();
      return true;
    },
    reconnect() {
      retryCount = 0;
      connect();
    },
    state: () => terminalState,
    subscribeState(listener) {
      terminalStateListeners.add(listener);
      listener(terminalState, terminalState === 'connected' ? 'Connected' : 'Connecting…');
      return () => terminalStateListeners.delete(listener);
    },
    whenReady(listener) { listener(term); },
  };
  terminalShell = TerminalShell.mount({
    host: app,
    fitTarget: host,
    selectionTarget: host,
    copyFlashHost: term.element,
    keybar,
    appActions: document.getElementById('service-bar'),
    connection,
    reconnect,
    adapter: terminalAdapter,
    minFontSize: MIN_FONT_SIZE,
    maxFontSize: MAX_FONT_SIZE,
    startupFitDelays: [100, 400, 1000],
    features: { copyFlash: true },
    actions: {
      select: openSelection,
      attach: openFilePicker,
    },
    onEmptyClipboard: async () => {
      const image = await readClipboardImage();
      if (image) {
        await uploadFiles([image]);
        return true;
      }
      const appleTouch = applePlatform && navigator.maxTouchPoints > 0;
      showNotice(navigator.clipboard?.read
        ? 'Nothing to paste: the clipboard holds no text or image. Use Attach for a file.'
        : appleTouch
          ? 'Nothing to paste as text. Use Attach to pick a photo or a file.'
          : 'Nothing to paste as text. Press the paste shortcut (⌘V) for an image, or use Attach.');
      return true;
    },
  });
  TerminalShell.enablePlainDragSelection(() => term);

  function artifactWindowTarget() {
    const match = currentArg?.match(/^tmux-(\d+)$/);
    return match ? `@${match[1]}` : null;
  }

  function setArtifactCount(count) {
    const safeCount = Number.isInteger(count) && count > 0 ? count : 0;
    artifactButton.dataset.count = String(safeCount);
    artifactButton.textContent = safeCount ? `Artifacts (${safeCount})` : 'Artifacts';
    artifactButton.disabled = !artifactWindowTarget();
  }

  async function fetchArtifacts(target) {
    const response = await fetch(`/artifacts?window=${encodeURIComponent(target)}`,
                                 { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data?.ok || !Array.isArray(data.artifacts)) {
      throw new Error(data?.error || `Artifact list failed (${response.status}).`);
    }
    return data;
  }

  async function refreshArtifactCount() {
    const target = artifactWindowTarget();
    if (!target) {
      setArtifactCount(0);
      return;
    }
    try {
      const data = await fetchArtifacts(target);
      if (target === artifactWindowTarget()) setArtifactCount(data.count);
    } catch {
      if (target === artifactWindowTarget()) {
        artifactButton.textContent = 'Artifacts';
        artifactButton.dataset.count = '0';
      }
    }
  }

  function formatArtifactSize(size) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function artifactCard(item) {
    const card = document.createElement('article');
    card.className = 'artifact-card';
    let preview;
    if (item.preview) {
      preview = document.createElement('a');
      preview.href = item.url;
      preview.target = '_blank';
      preview.rel = 'noopener';
      preview.setAttribute('aria-label', `Open ${item.name}`);
      const image = document.createElement('img');
      image.src = item.url;
      image.alt = item.name;
      image.loading = 'lazy';
      preview.appendChild(image);
    } else {
      preview = document.createElement('div');
      const icon = document.createElement('span');
      icon.className = 'artifact-file-icon';
      const extension = item.name.includes('.') ? item.name.split('.').pop() : 'FILE';
      icon.textContent = extension.slice(0, 8).toUpperCase();
      preview.appendChild(icon);
    }
    preview.classList.add('artifact-preview');
    const name = document.createElement('p');
    name.className = 'artifact-name';
    name.textContent = item.name;
    const metadata = document.createElement('div');
    metadata.className = 'artifact-meta';
    const description = document.createElement('span');
    const source = {
      agent: 'Agent',
      'browser-upload': 'Uploaded',
      'terminal-image': 'Terminal image',
    }[item.source] || 'Artifact';
    description.textContent = `${source} · ${formatArtifactSize(item.size)} · ${new Date(item.created).toLocaleString()}`;
    const download = document.createElement('a');
    download.href = item.downloadUrl;
    download.download = item.name;
    download.textContent = 'Download';
    metadata.append(description, download);
    card.append(preview, name, metadata);
    return card;
  }

  async function renderArtifactGallery() {
    const target = artifactWindowTarget();
    const request = ++artifactListRequest;
    artifactGallery.replaceChildren();
    if (!target) {
      artifactStatus.textContent = 'Open a terminal window to view its artifacts.';
      return;
    }
    artifactStatus.textContent = 'Loading artifacts…';
    try {
      const data = await fetchArtifacts(target);
      if (request !== artifactListRequest || target !== artifactWindowTarget()) return;
      setArtifactCount(data.count);
      artifactGallery.replaceChildren(...data.artifacts.map(artifactCard));
      artifactStatus.textContent = data.count
        ? `${data.count} artifact${data.count === 1 ? '' : 's'}, newest first.`
        : 'No artifacts for this terminal window yet.';
    } catch (error) {
      if (request !== artifactListRequest) return;
      artifactStatus.textContent = error.message || 'Artifacts could not be loaded.';
    }
  }

  function containsImageProtocol(bytes) {
    let found = false;
    for (const byte of bytes) {
      if (sixelHeaderBytesRemaining > 0) {
        if (byte === 0x71) {
          found = true;
          sixelHeaderBytesRemaining = 0;
        } else {
          sixelHeaderBytesRemaining -= 1;
        }
      }

      if (imageProtocolEscape && byte === 0x50) {
        sixelHeaderBytesRemaining = IMAGE_PROTOCOL_HEADER_BYTES;
      }
      imageProtocolEscape = byte === 0x1b;

      if (byte === IIP_MARKER[iipMarkerOffset]) {
        iipMarkerOffset += 1;
        if (iipMarkerOffset === IIP_MARKER.length) {
          found = true;
          iipMarkerOffset = 0;
        }
      } else {
        iipMarkerOffset = byte === IIP_MARKER[0] ? 1 : 0;
      }
    }
    return found;
  }

  function canvasPng(canvas) {
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  }

  async function saveArtifactCanvas(canvas, target) {
    const blob = await canvasPng(canvas);
    if (!blob) throw new Error('The rendered image could not be encoded.');
    const response = await fetch(`/artifacts?window=${encodeURIComponent(target)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'X-Artifact-Name': 'terminal-image.png',
        'X-Artifact-Source': 'terminal-image',
      },
      body: blob,
    });
    const result = await response.json();
    if (!response.ok || !result?.ok) {
      throw new Error(result?.error || `Artifact save failed (${response.status}).`);
    }
    artifactCaptureErrorShown = false;
    if (target === artifactWindowTarget()) {
      refreshArtifactCount();
      if (artifactDialog.open) renderArtifactGallery();
    }
  }

  function scanArtifactCanvases() {
    clearTimeout(artifactScanTimer);
    artifactScanTimer = null;
    const target = artifactWindowTarget();
    if (!imageAddon || !target || document.hidden || leaving) return;
    const buffer = term.buffer.active;
    const firstRow = buffer.viewportY;
    const lastRow = Math.min(buffer.length, firstRow + term.rows);
    for (let y = firstRow; y < lastRow; y += 1) {
      for (let x = 0; x < term.cols; x += 1) {
        const canvas = imageAddon.getImageAtBufferCell(x, y);
        if (!canvas || seenArtifactCanvases.has(canvas)) continue;
        seenArtifactCanvases.add(canvas);
        saveArtifactCanvas(canvas, target).catch(error => {
          if (artifactCaptureErrorShown) return;
          artifactCaptureErrorShown = true;
          showNotice(error.message || 'A rendered image could not be saved.');
        });
      }
    }
  }

  function scheduleArtifactScan() {
    clearTimeout(artifactScanTimer);
    artifactScanTimer = setTimeout(scanArtifactCanvases, ARTIFACT_SCAN_DELAY_MS);
  }

  // Ordinary terminal output includes every tmux scroll repaint. Scanning the
  // full grid after each write made one wheel notch perform cols*rows image
  // lookups. Only protocol-bearing writes can add an image; resize and tab
  // switch paths retain their explicit scans.
  term.onResize(scheduleArtifactScan);
  artifactButton.addEventListener('click', () => {
    artifactDialog.showModal();
    renderArtifactGallery();
  });
  refreshArtifacts.addEventListener('click', renderArtifactGallery);
  closeArtifacts.addEventListener('click', () => artifactDialog.close());
  artifactDialog.addEventListener('close', () => focusTerminal());
  setArtifactCount(0);

  refreshArtifactCount();

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
      const requested = currentArg?.replace('tmux-', '@');
      const attached = data.windows.find(entry => entry.id === requested) ||
        data.windows.find(entry => entry.active);
      const selected = attached &&
        data.windows.find(entry => entry.session === attached.session && entry.active);
      activeOmpEditorWindow = selected?.editor ? selected.id : null;
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
        const attached = data.windows.find(entry => entry.id === requested) ||
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
      refreshArtifactCount();
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
    // Persist any image still belonging to the old window before tmux replaces
    // its screen and title with the selected one.
    scanArtifactCanvases();
    const button = event.target.closest('button[data-window]');
    if (!button || button.getAttribute('aria-current') === 'true') return;
    // Show the tap immediately, then let the next refresh confirm it.
    for (const other of windowBar.querySelectorAll('button')) {
      other.setAttribute('aria-current', 'false');
    }
    button.setAttribute('aria-current', 'true');
    activeOmpEditorWindow = null;
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

  /** Present all status through the shared shell. copyText keeps a gesture-backed
   *  retry action for asynchronous OSC 52 requests. */
  function showNotice(message, copyText = null, autoHideMs = 0) {
    pendingClipboard = copyText;
    pendingClipboardAt = Date.now();
    if (copyText) {
      terminalShell.offerCopy(copyText, message);
      return;
    }
    terminalShell.notice.show(message, { timeout: autoHideMs });
  }

  function flashCopied() {
    terminalShell.flashCopied();
  }

  function hideNotice() {
    pendingClipboard = null;
    terminalShell.notice.hide();
  }

  async function writeClipboard(text) {
    return terminalShell.writeClipboard(text);
  }

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


  function focusTerminal(force = false) {
    if (!document.querySelector('dialog[open]') && !composer.contains(document.activeElement)) {
      if (!force && matchMedia('(any-pointer: coarse)').matches && document.activeElement !== term.textarea) {
        return;
      }
      term.textarea.focus({ preventScroll: true });
    }
  }

  function setPrefix(armed) {
    terminalShell?.setPrefix(armed);
  }

  function setConnection(state, message) {
    terminalState = state;
    term.options.disableStdin = state !== 'connected';
    if (state !== 'connected') setPrefix(false);
    for (const listener of terminalStateListeners) listener(state, message);
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
      const width = host.clientWidth;
      const hostHeight = host.clientHeight;
      if (width > 0 && hostHeight > 0) {
        const cols = term.cols;
        const rows = term.rows;
        const boxChanged = width !== lastFitBox.width
          || hostHeight !== lastFitBox.height
          || devicePixelRatio !== lastFitBox.dpr;
        lastFitBox = { width, height: hostHeight, dpr: devicePixelRatio };
        fit.fit();
        if (boxChanged || term.cols !== cols || term.rows !== rows) {
          // Rebuild even when the pixel box changed without crossing a whole
          // cell boundary. The DOM renderer otherwise retains stale row
          // backgrounds; canvas can retain glyphs at the old scale.
          term.clearTextureAtlas?.();
          term.refresh(0, term.rows - 1);
        }
        scheduleTerminalResize();
      }
    });
  }

  // The shared shell now owns window, visual-viewport, element, font-ready,
  // and bounded startup retry triggers. This direct-xterm path retains the
  // actual geometry calculation, atlas invalidation, and pixel-size reporting.
  scheduleFit();

  function replaceArg(arg) {
    const changed = currentArg !== arg;
    currentArg = arg;
    const url = new URL(location.href);
    if (arg === null) url.searchParams.delete('arg');
    else url.searchParams.set('arg', arg);
    if (url.href !== location.href) history.replaceState(history.state, '', url);
    if (changed) {
      activeOmpEditorWindow = null;
      refreshArtifactCount();
      scheduleArtifactScan();
      if (artifactDialog.open) renderArtifactGallery();
    }
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
  let lastSentSize = { columns: 0, rows: 0, width: 0, height: 0 };

  function terminalSize() {
    const screen = term.element.querySelector('.xterm-screen');
    const rect = screen.getBoundingClientRect();
    return {
      columns: term.cols,
      rows: term.rows,
      // ttyd normally leaves ws_xpixel/ws_ypixel at zero. tmux then replaces
      // SIXEL images with a grid of '+' fallback cells. CSS pixels match the
      // dimensions reported by the xterm image addon to the application.
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
  }

  function sameTerminalSize(left, right) {
    return left.columns === right.columns && left.rows === right.rows
      && left.width === right.width && left.height === right.height;
  }

  function scheduleTerminalResize() {
    if (document.hidden || leaving) return;
    if (sameTerminalSize(terminalSize(), lastSentSize)) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (document.hidden || leaving) return;
      const size = terminalSize();
      if (active && !sameTerminalSize(size, lastSentSize)) {
        lastSentSize = size;
        sendControl(active, '1', JSON.stringify(size));
      }
    }, 80);
  }

  term.onResize(scheduleTerminalResize);

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
        const containsImage = imageAddon ? containsImageProtocol(body) : false;
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
          if (containsImage) scheduleArtifactScan();
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
      imageProtocolEscape = false;
      sixelHeaderBytesRemaining = 0;
      iipMarkerOffset = 0;
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
          lastSentSize = terminalSize();
          socket.send(encoder.encode(JSON.stringify({ AuthToken: token ?? '', ...lastSentSize })));
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

  window.addEventListener('online', () => { if (!active?.ready && !leaving) connect(); });
  window.addEventListener('popstate', () => {
    replaceArg(new URL(location.href).searchParams.get('arg'));
    retryCount = 0;
    connect(true);
  });
  window.addEventListener('pagehide', () => {
    leaving = true;
    clearTimeout(artifactScanTimer);
    clearTimeout(resizeTimer);
    stopPresenceHeartbeat();
    stopWindowBar();
    retireConnection();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(artifactScanTimer);
      clearTimeout(resizeTimer);
      stopPresenceHeartbeat();
      stopWindowBar();
    } else if (!leaving) {
      scheduleFit();
      startPresenceHeartbeat();
      scheduleArtifactScan();
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

  function settleComposerDraftRequest(result) {
    const request = composerDraftRequest;
    if (!request) return;
    clearTimeout(request.timer);
    composerDraftRequest = null;
    request.resolve(result);
  }

  /** Ask OMP to copy its editor through its built-in Alt-Shift-C action. The
   * next OSC 52 response stays inside Compose instead of touching the system
   * clipboard. Shell panes never receive the shortcut: /windows marks only a
   * currently-running OMP process as editor-capable. */
  function requestOmpEditorText() {
    const windowId = activeOmpEditorWindow;
    if (!windowId || composerDraftRequest || !composerConnected()) {
      return Promise.resolve(null);
    }
    return new Promise(resolve => {
      const request = { windowId, resolve, timer: null };
      composerDraftRequest = request;
      request.timer = setTimeout(() => {
        if (composerDraftRequest === request) settleComposerDraftRequest(null);
      }, COMPOSER_SYNC_TIMEOUT_MS);
      // xterm emits ESC + uppercase C for Alt-Shift-C.
      if (!sendInput('\x1bC', true)) settleComposerDraftRequest(null);
    });
  }

  function hasOmpEditorTokens(text) {
    // OMP's getText() returns display labels for semantic chips, not their
    // submit-time expansions or attached image bytes. Never turn those labels
    // into plain text by round-tripping them through a browser textarea.
    return /[\uE000-\uF8FF]/u.test(text) ||
      /(?:^|\s)(?:🖼|🎞|📄|img|vid|txt) #[1-9]\d*(?=\s|$)/u.test(text) ||
      /(?:^|\s)(?:⬢|✦|\[M\]|SK) \S+/u.test(text);
  }

  function renderComposer() {
    const connected = composerConnected();
    composerStatus.textContent = connected ? composerMessage : 'Disconnected. Your draft is kept.';
    composerStatus.hidden = !composerStatus.textContent;
    composerPaste.textContent = composerSyncedText === null ? 'Paste' : 'Replace';
    composerPaste.disabled = !connected || composerComposing || composerSyncing || !composerText.value.length;
    composerClear.disabled = composerComposing || composerSyncing;
    composerAttach.disabled = uploading || composerSyncing;
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

  async function openComposer() {
    setComposerOpen(true);
    if (composerText.value.length || !activeOmpEditorWindow) return;
    composerSyncing = true;
    composerMessage = 'Syncing the current OMP draft…';
    renderComposer();
    const result = await requestOmpEditorText();
    composerSyncing = false;
    if (composer.hidden) {
      renderComposer();
      return;
    }
    if (!result || result.windowId !== activeOmpEditorWindow || !result.text) {
      composerMessage = '';
      renderComposer();
      return;
    }
    if (hasOmpEditorTokens(result.text)) {
      composerMessage = 'The OMP draft contains chips or attachments. Edit it in the terminal to preserve them.';
      renderComposer();
      return;
    }
    composerText.value = result.text;
    composerText.setSelectionRange(result.text.length, result.text.length);
    composerSyncedText = result.text;
    composerSyncedWindow = result.windowId;
    composerMessage = 'Synced from OMP. Replace updates the live entry when ready.';
    renderComposer();
  }

  composerToggle.addEventListener('click', () => {
    if (composer.hidden) void openComposer();
    else setComposerOpen(false);
  });
  reflowToggle.addEventListener('click', () => {
    if (!composerConnected()) return;
    // OMP's display reset (Alt-L / \x1bl) emits ED2+ED3 to clear tmux
    // scrollback and replays one clean transcript wrapped at current columns.
    // In copy-mode, tmux.conf binds M-l to cancel copy-mode and forward M-l.
    // Never send \x0c (Ctrl-L): in OMP, Ctrl-L toggles voice listening mode!
    sendInput('\x1bl', true);
  });
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
    if (composerComposing || composerSyncing) return;
    composerText.value = '';
    composerMessage = '';
    composerSyncedText = null;
    composerSyncedWindow = null;
    renderComposer();
    composerText.focus({ preventScroll: true });
  });
  composerPaste.addEventListener('click', async () => {
    if (composerPaste.disabled || composerComposing || composerSyncing) return;
    const draft = composerText.value;
    if (composerSyncedText !== null) {
      if (activeOmpEditorWindow !== composerSyncedWindow) {
        composerMessage = 'The terminal window changed. Close and reopen Compose before replacing its entry.';
        renderComposer();
        return;
      }
      composerSyncing = true;
      composerMessage = 'Checking that the OMP draft has not changed…';
      renderComposer();
      const current = await requestOmpEditorText();
      composerSyncing = false;
      if (!current || current.windowId !== composerSyncedWindow) {
        composerMessage = 'Could not verify the live OMP draft. Nothing was replaced.';
        renderComposer();
        return;
      }
      if (current.text !== composerSyncedText) {
        composerMessage = 'The live OMP draft changed. Close and reopen Compose to sync it again.';
        renderComposer();
        return;
      }
      if (composerText.value !== draft) {
        composerMessage = 'The Compose draft changed while checking. Press Replace again.';
        renderComposer();
        return;
      }
      // The synchronized source still matches exactly. Clear it before pasting
      // the edited replacement so text is never duplicated.
      if (!sendInput('\x03', true)) {
        composerMessage = 'The live OMP draft could not be cleared. Nothing was replaced.';
        renderComposer();
        return;
      }
    }
    if (!pasteToTerminal(draft)) {
      composerMessage = 'Paste could not be sent. Your draft is kept; check the terminal before trying again.';
      renderComposer();
      return;
    }
    composerText.value = '';
    composerMessage = '';
    composerSyncedText = null;
    composerSyncedWindow = null;
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
  // Own the gesture in the capture phase: xterm and image-renderer descendants
  // may otherwise consume the drop before it bubbles back to #app.
  let dragDepth = 0;
  const appRoot = document.getElementById('app');

  function isFileDrag(dataTransfer) {
    if (!dataTransfer) return false;
    if (Array.from(dataTransfer.types || []).includes('Files')) return true;
    return Array.from(dataTransfer.items || []).some(item => item.kind === 'file');
  }

  function droppedFiles(dataTransfer) {
    const files = Array.from(dataTransfer?.files || []);
    if (files.length) return files;
    return Array.from(dataTransfer?.items || [])
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter(Boolean);
  }

  appRoot.addEventListener('dragenter', event => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth += 1;
    appRoot.classList.add('drag-over');
  }, true);
  appRoot.addEventListener('dragover', event => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, true);
  appRoot.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) appRoot.classList.remove('drag-over');
  }, true);
  appRoot.addEventListener('drop', event => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    appRoot.classList.remove('drag-over');
    const files = droppedFiles(event.dataTransfer);
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
  }, true);

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

    const target = artifactWindowTarget();
    const uploadUrl = target ? `/upload?window=${encodeURIComponent(target)}` : '/upload';
    const paths = [];
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file, file.name);
        const res = await fetch(uploadUrl, {
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
      if (target === artifactWindowTarget()) {
        refreshArtifactCount();
        if (artifactDialog.open) renderArtifactGallery();
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

      showNotice(`Attached ${nameLabel} (@path inserted).`, null, 4000);
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


  term.parser.registerOscHandler(52, data => {
    const separator = data.indexOf(';');
    if (separator < 0) return true;
    const encoded = data.slice(separator + 1);
    // Clipboard queries are deliberately never answered with browser data.
    if (encoded === '?' || !active?.acceptTitles || leaving) return true;
    try {
      const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      const text = decoder.decode(bytes);
      if (composerDraftRequest) {
        const { windowId } = composerDraftRequest;
        settleComposerDraftRequest({ windowId, text });
        return true;
      }
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
      if (composerDraftRequest) settleComposerDraftRequest(null);
      else showNotice('The terminal clipboard request could not be decoded.');
    }
    return true;
  });

  const selectionDialog = document.getElementById('selection-dialog');
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

  async function fetchHistory(offset) {
    const window = historyWindowArg();
    if (!window) return null;
    try {
      const res = await fetch(`/history?window=${encodeURIComponent(window)}&count=${HISTORY_CHUNK}&offset=${offset}&color=1`,
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

  async function openSelection() {
    selectionStatus.textContent = '';
    historyCount.textContent = '';
    searchMatches = [];
    searchIndex = 0;
    selectionOffset = 0;
    selectionMore = false;
    selectionLoading = false;
    selectionDialog.showModal();
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
    const copied = await terminalShell.copyText(
      payload,
      hasSelection ? 'Copied selection' : `Copied ${historyRaw.length} lines`,
    );
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
  const MAX_REPORTS_PER_MOVE = 15;
  function sendScrollReports(lines, source, limit = MAX_REPORTS_PER_MOVE) {
    const count = Math.min(limit, Math.abs(lines));
    if (!count) return 0;
    const { x, y } = cellAt(source.clientX, source.clientY);
    const button = lines > 0 ? 65 : 64;
    sendInput(`\x1b[<${button};${x};${y}M`.repeat(count), true);
    return Math.sign(lines) * count;
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

  const TOUCH_DRAG_THRESHOLD = 14;
  surface.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') return;
    touches.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      lastY: event.clientY,
      moved: false,
      scrolled: false,
    });
    if (touches.size > 1) multitouch = true;
    if (touches.size === 1) touchRemainder = 0;
    surface.setPointerCapture(event.pointerId);
  });

  surface.addEventListener('pointermove', event => {
    const touch = touches.get(event.pointerId);
    if (!touch || multitouch) return;
    if (!touch.moved && Math.hypot(event.clientX - touch.x, event.clientY - touch.y) < TOUCH_DRAG_THRESHOLD) return;
    touch.moved = true;
    touchRemainder += (touch.lastY - event.clientY) / lineHeight() * (term.modes.mouseTrackingMode !== 'none' ? TOUCH_REPORTS_PER_ROW : SCROLL_SPEED);
    touch.lastY = event.clientY;
    const lines = Math.trunc(touchRemainder);
    if (!lines) return;
    touch.scrolled = true;
    suppressMouseUntil = Date.now() + 800;
    if (term.modes.mouseTrackingMode !== 'none') {
      // A browser may coalesce a fast swipe into a few large pointer moves.
      // Retain reports beyond the per-move cap instead of silently dropping
      // distance; endTouch flushes the bounded remainder.
      touchRemainder -= sendScrollReports(lines, event);
    } else {
      touchRemainder -= lines;
      term.scrollLines(lines);
    }
  });

  function endTouch(event) {
    const touch = touches.get(event.pointerId);
    if (!touch) return;
    const cancelled = event.type === 'pointercancel';
    if (touch.scrolled || multitouch || cancelled) {
      suppressMouseUntil = Date.now() + 800;
    } else {
      suppressMouseUntil = 0;
      focusTerminal(true);
    }
    if (touch.scrolled && !multitouch && !cancelled && term.modes.mouseTrackingMode !== 'none') {
      const pending = Math.trunc(touchRemainder);
      if (pending) {
        // At most one terminal-height of coalesced movement is flushed. This
        // preserves a real fast swipe without reviving runaway momentum.
        const limit = Math.ceil(term.rows * TOUCH_REPORTS_PER_ROW);
        touchRemainder -= sendScrollReports(pending, event, limit);
      }
    }
    touches.delete(event.pointerId);
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
    if (!touches.size) multitouch = false;
  }
  surface.addEventListener('pointerup', endTouch);
  surface.addEventListener('pointercancel', endTouch);
  surface.addEventListener('lostpointercapture', endTouch);

  connect();
})();
