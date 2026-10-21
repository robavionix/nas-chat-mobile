// Computer-browser view: the whole two-pane WeChat window, driven with mouse and keyboard.
// The picture uses the phone stream protocol (changed strips, moved rows, one picture ahead);
// clicks, scrolling, sending and uploads go through the same checked server actions as the phone.
'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const view = $('#view'), ctx = view.getContext('2d'), draft = $('#draft');
  const attach = $('#attach'), picker = $('#picker'), toast = $('#toast');
  const mirror = document.createElement('canvas'), mctx = mirror.getContext('2d');
  const shift = document.createElement('canvas'), sctx = shift.getContext('2d');
  const LAN = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
  const QUALITY = LAN ? 'lossless' : 'clear';
  // The client's own name (WeChat or QQ) arrives with the first layout.
  let label = document.body.dataset.label || '';
  // WeChat's input area (toolbar row plus text box) and chat header, in desktop pixels. QQ reports its own.
  const INPUT = 258, TOOLBAR = 56, HEADER = 90;
  // `rect` is the captured screen area; the picture may be reduced by `unit` (QQ at triple scale).
  let box = null, rect = null, size = null, unit = 1, key = null, fit = null, epoch = 0, socket = null, retry = 0;
  let busy = false, paintQueued = false, toastTimer = 0, tapChain = Promise.resolve(), usingLan = false;

  try { const v = new URLSearchParams(location.search).get('view'); if (v) localStorage.setItem('nas-chat-view', v); } catch {}

  function message(text, error = false) {
    clearTimeout(toastTimer);
    toast.textContent = text; toast.classList.toggle('visible', !!text); toast.classList.toggle('error', error);
    if (text) toastTimer = setTimeout(() => toast.classList.remove('visible'), error ? 6000 : 2500);
  }
  async function call(path, data) {
    let response;
    try {
      response = await fetch('/mobile-api/' + path, {method: data === undefined ? 'GET' : 'POST',
        headers: data === undefined ? {} : {'Content-Type': 'application/json', 'X-Mobile-Control': '1'},
        body: data === undefined ? undefined : JSON.stringify(data), cache: 'no-store', signal: AbortSignal.timeout(path === 'send' ? 20000 : 9000)});
    } catch { throw Error('连接暂时中断，请稍后重试'); }
    if (response.status === 401) { location.replace('/mobile/login'); throw Error('请重新登录'); }
    let result; try { result = await response.json(); } catch { throw Error('连接暂时繁忙，请稍后再试'); }
    if (!response.ok) { const error = Error(result.error || '操作暂时失败'); error.layout = result.layout; throw error; }
    return result;
  }
  function setStatus(on) {
    $('#dot').classList.toggle('on', on);
    $('#status').textContent = (label || '聊天') + ' · 电脑视图' + (on ? (usingLan ? ' · 家里直连' : '') : ' · 连接中');
  }
  function acceptLayout(next) {
    if (!next) return;
    box = next;
    if (next.clientLabel && !document.body.dataset.label && label !== next.clientLabel) {
      label = next.clientLabel; document.title = label + ' · 电脑视图'; document.body.dataset.client = next.client || '';
    }
    placeDraft();
    if (syncBack && !next.popups?.length) { syncBack = false; setTimeout(() => readNative(true), 150); }
    // Viewers, dialogs and menus get a visible way back, besides Esc.
    const popup = box.popups?.[0], bar = $('#popupbar');
    bar.hidden = !popup;
    if (popup) {
      $('#popup-name').textContent = popup.kind === 'menu' ? '菜单已打开' : (popup.name || '弹出窗口');
      $('#popup-close').textContent = popup.kind === 'menu' ? '取消' : '关闭';
    }
  }
  function closePopup() {
    const popup = box?.popups?.[0]; if (!popup) return;
    call('window', {action: popup.kind === 'menu' ? 'escape' : 'close', window: popup.id})
      .then(r => acceptLayout(r.layout), error => { if (error.layout) acceptLayout(error.layout); message(error.message, true); });
  }

  // ---- picture stream ----
  function decode(blob) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, image) => { if (done) { image?.close?.(); return; } done = true; clearTimeout(timer); error ? reject(error) : resolve(image); };
      const timer = setTimeout(() => finish(Error('画面解码超时')), 4000);
      const fallback = () => {
        const url = URL.createObjectURL(blob), img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); finish(null, img); };
        img.onerror = () => { URL.revokeObjectURL(url); finish(Error('图片解码失败')); };
        img.src = url;
      };
      if (window.createImageBitmap) createImageBitmap(blob).then(image => finish(null, image), fallback); else fallback();
    });
  }
  function moveRows(moves, left, width) {
    // Same-direction scrolls copy in place starting at the far end; mixed directions use a snapshot.
    const up = moves.every(([d]) => d > 0), down = moves.every(([d]) => d < 0);
    if (up || down) {
      for (const [d, s, e] of [...moves].sort((a, b) => up ? b[1] - a[1] : a[1] - b[1]))
        mctx.drawImage(mirror, left, s - d, width, e - s, left, s, width, e - s);
      return;
    }
    shift.width = width; shift.height = mirror.height;
    try {
      sctx.drawImage(mirror, left, 0, width, mirror.height, 0, 0, width, mirror.height);
      for (const [d, s, e] of moves) mctx.drawImage(shift, 0, s - d, width, e - s, left, s, width, e - s);
    } finally { shift.width = shift.height = 1; }
  }
  async function apply(header, bytes, valid) {
    if (header.layout) acceptLayout(header.layout);
    if (!header.key) { key = null; schedulePaint(); return; }
    if (header.full || header.key !== key) {
      const [w, h] = header.size || header.rect.slice(2);
      if (mirror.width !== w || mirror.height !== h) { mirror.width = w; mirror.height = h; }
    } else if (header.moves?.length) moveRows(header.moves, header.moveLeft || 0, header.moveWidth || mirror.width);
    let offset = 0;
    const pictures = header.strips.map(([, , size, , , mime = 'image/jpeg']) => decode(new Blob([bytes.subarray(offset, offset += size)], {type: mime})));
    for (const picture of pictures) picture.catch(() => {});
    try {
      for (const [index, [top, height, , left = 0, width = mirror.width]] of header.strips.entries()) {
        if (!valid()) return;
        const image = await pictures[index]; pictures[index] = null;
        try { mctx.drawImage(image, left, top, width, height); } finally { image.close?.(); }
      }
    } finally { for (const picture of pictures) picture?.then(image => image.close?.(), () => {}); }
    key = header.key; rect = header.rect; size = header.size || header.rect.slice(2); unit = header.scale || 1;
    $('#waiting').hidden = true;
    schedulePaint();
  }
  async function connect() {
    if (document.hidden) return;
    const my = ++epoch, aspect = shape().toFixed(3);
    // At home the picture may come straight from the NAS; the page itself stays on this address.
    const lan = await globalThis.nasLan?.stream();
    if (my !== epoch || document.hidden) return;
    usingLan = !!lan;
    const ws = new WebSocket((lan ? lan.base : (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host) +
      '/mobile-api/ws?quality=' + (lan ? 'lossless' : QUALITY) + '&pipeline=2&layout=desktop&aspect=' + aspect +
      (lan ? '&token=' + encodeURIComponent(lan.token) : ''));
    ws.binaryType = 'arraybuffer'; socket = ws;
    let queue = Promise.resolve(), queued = 0, last = performance.now(), closed = false;
    const current = () => !closed && my === epoch && !document.hidden;
    const watchdog = setInterval(() => {
      if (!current()) return finish();
      const idle = performance.now() - last;
      if (idle > (key ? 15000 : 8000)) return finish('画面连接超时，正在重连…');
      if (ws.readyState === 1 && idle > 10000) ws.send('ping');
    }, 5000);
    function finish(error) {
      if (closed) return;
      closed = true; clearInterval(watchdog);
      try { ws.close(); } catch {}
      if (socket === ws) socket = null;
      setStatus(false);
      if (my !== epoch || document.hidden) return;
      // A failed home-network stream falls back to the public address straight away.
      if (lan) { globalThis.nasLan.failed(); usingLan = false; error = null; retry = 0; }
      if (error) message(error, true);
      retry = Math.min(retry + 1, 6);
      if (retry >= 3) call('layout').then(r => acceptLayout(r.layout)).catch(() => {});
      setTimeout(() => { if (my === epoch) connect(); }, 500 * retry);
    }
    ws.onopen = () => { retry = 0; };
    ws.onmessage = event => {
      if (!current()) return finish();
      // The server may send one picture ahead; pictures are applied strictly in arrival order.
      if (++queued > 3) return finish('画面队列不同步，正在重连…');
      const buffer = event.data;
      queue = queue.then(() => show(buffer)).finally(() => queued--);
    };
    async function show(buffer) {
      if (closed) return;
      try {
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8) throw Error('画面格式无效');
        const lengths = new DataView(buffer), hl = lengths.getUint32(0), bl = lengths.getUint32(4);
        if (hl > 65536 || 8 + hl + bl !== buffer.byteLength) throw Error('画面长度无效');
        const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, hl)));
        await apply(header, new Uint8Array(buffer, 8 + hl, bl), current);
        if (!current()) return finish();
        last = performance.now(); setStatus(true);
        await new Promise(requestAnimationFrame);
        if (current() && ws.readyState === 1) ws.send('ack ' + header.seq);
      } catch (error) { finish(error.message || '画面出错，正在重连…'); }
    }
    ws.onerror = () => finish();
    ws.onclose = () => finish(current() ? '连接已断开，正在重连…' : null);
  }
  function reconnect() { epoch++; socket?.close(); socket = null; connect(); }
  addEventListener('nas-lan-change', () => { if (!document.hidden) reconnect(); });

  // ---- drawing and coordinates ----
  function schedulePaint() { if (!paintQueued) { paintQueued = true; requestAnimationFrame(paint); } }
  function paint() {
    paintQueued = false;
    // The layout viewport, which the canvas fills: an on-screen keyboard shrinks innerHeight but not this.
    const dpr = devicePixelRatio || 1, w = document.documentElement.clientWidth, h = document.documentElement.clientHeight;
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (view.width !== pw || view.height !== ph) { view.width = pw; view.height = ph; }
    ctx.fillStyle = '#e9edf1'; ctx.fillRect(0, 0, pw, ph);
    if (!rect || !key) { fit = null; placeDraft(); return; }
    const scale = Math.min(w / size[0], h / size[1]), dw = size[0] * scale, dh = size[1] * scale;
    fit = {scale, left: (w - dw) / 2, top: (h - dh) / 2};
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(mirror, 0, 0, size[0], size[1], fit.left * dpr, fit.top * dpr, dw * dpr, dh * dpr);
    placeDraft();
  }
  function toScreen(cx, cy) {
    if (!fit || !rect) return null;
    const x = (cx - fit.left) / fit.scale * unit, y = (cy - fit.top) / fit.scale * unit;
    if (x < 0 || y < 0 || x >= rect[2] || y >= rect[3]) return null;
    return {x: Math.round(rect[0] + x), y: Math.round(rect[1] + y)};
  }
  const toClient = (x, y) => ({x: fit.left + (x - rect[0]) / unit * fit.scale, y: fit.top + (y - rect[1]) / unit * fit.scale});
  function inputArea() {
    if (!fit || !box || !box.chatReady || box.popups?.length || box.inlineDialog) return null;
    if (box.editorRect) { const [x, y, width, height] = box.editorRect; return {x, y, width, height}; }
    if (box.compact || !box.split) return null;
    return {x: box.x + box.split + 2, y: box.y + box.height - INPUT + TOOLBAR, width: box.width - box.split - 2, height: INPUT - TOOLBAR};
  }
  function headerArea() {
    if (box.headerRect) { const [x, y, width, height] = box.headerRect; return {x, y, width, height}; }
    return {x: box.x + box.split + 2, y: box.y + 48, width: Math.min(900, box.width - box.split - 2), height: HEADER};
  }

  // ---- typing: a local text box laid exactly over the client's own typing area ----
  // Typing stays on this computer (instant, with its own input method). The box takes the client's
  // background, font size and position, found in the live picture, so it reads as the client's own.
  // Sending uses the checked send action; each chat keeps its own draft.
  const drafts = new Map();
  let typing = null, draftChat = null, inputScan = {key: '', at: 0, value: null}, syncBack = false, busySync = false;
  function controls() { attach.disabled = busy; draft.readOnly = busy; }
  function pixelRows(x, y0, y1) {
    // One picture column as luminance values, screen rows y0..y1 (top to bottom).
    const px = Math.round((x - rect[0]) / unit), top = Math.round((y0 - rect[1]) / unit), height = Math.round((y1 - y0) / unit);
    if (px < 0 || px >= mirror.width || top < 0 || height <= 0 || top + height > mirror.height) return null;
    const data = mctx.getImageData(px, top, 1, height).data, out = [];
    for (let i = 0; i < data.length; i += 4) out.push([data[i], data[i + 1], data[i + 2]]);
    return out;
  }
  const luminance = ([r, g, b]) => .299 * r + .587 * g + .114 * b;
  function wechatSeparator(left, right, bottom) {
    // The thin grey line between the messages and the input box: most columns darker than the box itself.
    const columns = [], span = right - left;
    for (let i = 1; i <= 24; i++) {
      const values = pixelRows(left + span * (.08 + .84 * i / 25), bottom - 620, bottom - 70);
      if (values) columns.push(values);
    }
    if (columns.length < 12) return null;
    const rows = columns[0].length, base = luminance(columns[0][rows - 40]);
    for (let y = rows - 60; y > 8; y--) {
      const dark = columns.filter(column => luminance(column[y]) <= base - 14 && luminance(column[y]) >= base - 60).length;
      if (dark >= columns.length * .6) return bottom - 620 + (y + 1) * unit;
    }
    return null;
  }
  function nativeInput() {
    if (!fit || !box || !box.chatReady || box.popups?.length || box.inlineDialog || !rect) return null;
    let text, send;
    if (box.client === 'qq') {
      if (!box.editorRect) return null;
      const [x, y, width, height] = box.editorRect, s = box.uiScale || 1;
      text = {x: x + 10 * s, y: y + 2 * s, width: width - 20 * s, height: height - 56 * s};
      send = {x: x + width - 150 * s, y: y + height - 54 * s, width: 150 * s, height: 54 * s};
    } else {
      if (box.compact || !box.split) return null;
      const left = box.x + box.split + 2, right = box.x + box.width - 20, bottom = box.y + box.height;
      const scanKey = [box.id, box.width, box.height, box.split, box.conversation].join(':');
      if (inputScan.key !== scanKey || performance.now() - inputScan.at > 1500) {
        inputScan = {key: scanKey, at: performance.now(), value: wechatSeparator(left, right, bottom)};
      }
      const top = inputScan.value ?? bottom - 243;
      text = {x: left + 18, y: top + 8, width: right - left - 36, height: bottom - 86 - (top + 8)};
      send = {x: right - 230, y: bottom - 86, width: 230, height: 86};
    }
    if (text.width < 60 || text.height < 24) return null;
    return {text, send, area: {x: text.x - 18, y: text.y - 8, width: text.width + 36, height: send.y + send.height - text.y + 8}};
  }
  function backgroundOf(area) {
    const values = pixelRows(area.x + 6, area.y + 4, area.y + 12);
    if (!values) return '#fafafa';
    const [r, g, b] = values[values.length - 1];
    return `rgb(${r},${g},${b})`;
  }
  function placeDraft() {
    typing = nativeInput();
    if (!typing) { draft.hidden = true; return; }
    const a = toClient(typing.text.x, typing.text.y), b = toClient(typing.text.x + typing.text.width, typing.text.y + typing.text.height);
    const font = (box.client === 'qq' ? 14 * (box.uiScale || 1) : 24.5) / unit * fit.scale;
    Object.assign(draft.style, {left: a.x + 'px', top: a.y + 'px', width: (b.x - a.x) + 'px', height: (b.y - a.y) + 'px',
      fontSize: Math.max(12, font) + 'px', background: backgroundOf(typing.text)});
    draft.hidden = false;
    if (draftChat !== box.conversation) switchDraft();
  }
  function switchDraft() {
    if (draftChat) drafts.set(draftChat, draft.value);
    draftChat = box.conversation;
    draft.value = drafts.get(draftChat) || '';
    if (!draft.value) readNative(false);
  }
  function hasInk(region) {
    // Whether the client's own box already holds something (a draft typed on a phone, a picked emoji).
    let ink = 0;
    for (let i = 1; i <= 10; i++) {
      const values = pixelRows(region.x + region.width * i / 11, region.y, region.y + Math.min(region.height, 120));
      if (values) { const base = luminance(values[0]); ink += values.filter(v => luminance(v) < base - 80).length; }
    }
    return ink > 6;
  }
  async function readNative(force) {
    if (busySync || !typing || !box?.conversation || (!force && !hasInk(typing.text))) return;
    busySync = true;
    const chat = box.conversation;
    try {
      const result = await call('input', {action: 'read', window: box.id, conversation: chat});
      if (chat === draftChat && typeof result.text === 'string' && result.text !== draft.value) {
        draft.value = result.text; drafts.set(chat, draft.value);
        draft.setSelectionRange(draft.value.length, draft.value.length);
      }
    } catch {} finally { busySync = false; }
  }
  async function writeNative() {
    // Before a native button (emoji and the like), the client's box gets what was typed here.
    if (!box?.conversation) return;
    await call('input', {action: 'write', text: draft.value, window: box.id, conversation: box.conversation});
    syncBack = true;
  }
  function focusDraft() { if (!draft.hidden) { draft.focus({preventScroll: true}); return true; } return false; }
  draft.addEventListener('input', () => { if (draftChat) drafts.set(draftChat, draft.value); });
  draft.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendDraft(); }
    else if (e.key === 'Escape') { e.preventDefault(); draft.blur(); }
  });
  // Sending clears the box at once and the next message can be typed straight away; messages go out
  // one after another in the background. One that fails returns to its chat's box, ahead of anything
  // typed since, and sending the same text again reuses its request, so the server never sends it twice.
  const failed = new Map();
  let sendChain = Promise.resolve();
  function sendDraft() {
    const text = draft.value;
    if (!text.trim()) return;
    if (!box?.conversation) return message('请先在左侧选择聊天', true);
    const chat = box.conversation, previous = failed.get(chat);
    const attempt = previous && previous.text === text && previous.window === box.id ? previous
      : {text, mode: 'enter', window: box.id, conversation: chat, requestId: crypto.randomUUID()};
    failed.delete(chat); draft.value = ''; drafts.delete(chat);
    sendChain = sendChain.then(async () => {
      try {
        const result = await call('send', attempt);
        if (result.layout) acceptLayout(result.layout);
      } catch (error) {
        if (error.layout) acceptLayout(error.layout);
        failed.set(chat, attempt);
        const kept = draftChat === chat ? draft.value : (drafts.get(chat) || '');
        const restored = attempt.text + (kept ? '\n' + kept : '');
        if (draftChat === chat) { draft.value = restored; draft.setSelectionRange(attempt.text.length, attempt.text.length); }
        else drafts.set(chat, restored);
        message(error.message + (draftChat === chat ? '' : '（内容已放回原聊天的输入框）'), true);
      }
    });
  }
  const inside = (p, r) => r && p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

  // ---- mouse ----
  function ripple(x, y) {
    const dot = document.createElement('div'); dot.className = 'ripple';
    dot.style.left = x + 'px'; dot.style.top = y + 'px'; document.body.append(dot);
    setTimeout(() => dot.remove(), 400);
  }
  function copyLocal(text) {
    navigator.clipboard?.writeText(text).then(() => message('已复制到这台电脑的剪贴板'), () => message('已复制；浏览器未允许写入剪贴板', true));
  }
  function tap(p, button, e, clickCount = 1) {
    ripple(e.clientX, e.clientY);
    tapChain = tapChain.then(async () => {
      try {
        const result = await call('tap', {target: 'desktop', x: p.x, y: p.y, button, ...(clickCount > 1 ? {clickCount} : {})});
        acceptLayout(result.layout);
        if (result.copied) copyLocal(result.copied);
      } catch (error) { if (error.layout) acceptLayout(error.layout); message(error.message, true); }
    });
  }
  view.addEventListener('mousedown', e => { if (e.button === 0) e.preventDefault(); });
  view.addEventListener('click', e => {
    // Finger taps are handled by the touch code below; the browser's own click after them is ignored.
    // The second click of a double-click is sent as one native double-click (QQ previews), or dropped.
    if (lastPointer === 'touch' || e.detail > 1) return;
    const p = toScreen(e.clientX, e.clientY); if (!p) return;
    handleClick(p, e);
  });
  function handleClick(p, e, clicks = 1) {
    if (clicks > 1) { tap(p, 1, e, clicks); return; }
    if (typing && inside(p, typing.send) && draft.value.trim()) { sendDraft(); return; }
    if (typing && inside(p, typing.area) && !inside(p, typing.send)) {
      // A native button below the text (emoji and the like) works on the client's own box: hand it what was
      // typed here first, and read the box back once the button's panel closes.
      (draft.value ? writeNative() : Promise.resolve()).then(() => { syncBack = true; tap(p, 1, e); }, error => message(error.message, true));
      return;
    }
    tap(p, 1, e);
  }
  view.addEventListener('dblclick', e => {
    if (box?.client !== 'qq' || lastPointer === 'touch') return;
    const p = toScreen(e.clientX, e.clientY);
    if (p) tap(p, 1, e, 2);
  });
  view.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (lastPointer === 'touch') return;
    const p = toScreen(e.clientX, e.clientY); if (p) tap(p, 3, e);
  });
  let wheelCarry = 0, wheelPoint = null, wheelBusy = false;
  view.addEventListener('wheel', e => {
    e.preventDefault();
    const p = toScreen(e.clientX, e.clientY); if (!p) return;
    wheelPoint = p; wheelCarry += e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? document.documentElement.clientHeight : 1);
    flushWheel();
  }, {passive: false});
  async function flushWheel() {
    if (wheelBusy) return;
    const steps = Math.trunc(wheelCarry / 64); if (!steps) return;
    const amount = Math.max(-15, Math.min(15, steps)); wheelCarry -= amount * 64; wheelBusy = true;
    try { await call('scroll', {x: wheelPoint.x, y: wheelPoint.y, amount}); } catch {}
    wheelBusy = false;
    if (Math.abs(wheelCarry) >= 64) flushWheel(); else wheelCarry = 0;
  }

  // ---- touch (iPad fingers): tap clicks, long press opens the menu, a drag scrolls, a flick keeps scrolling ----
  // Magic Keyboard trackpads arrive as mouse pointers and keep the mouse handling above.
  const LONG_PRESS = 480, TOUCH_STEP = 120;
  let lastPointer = 'mouse', touch = null, coastFrame = 0, lastTap = null;
  view.addEventListener('pointerdown', e => { lastPointer = e.pointerType; }, {capture: true});
  function scrollBy(delta, cx, cy) {
    const p = toScreen(cx, cy); if (!p) return;
    // One remote wheel step moves the client further than a finger; scale the drag to match.
    wheelPoint = p; wheelCarry += delta * 64 / TOUCH_STEP; flushWheel();
  }
  function coast(velocity, cx, cy) {
    let v = Math.max(-3, Math.min(3, velocity)), last = performance.now(), start = last;
    const tick = now => {
      const dt = Math.max(0, Math.min(32, now - last)); last = now; v *= Math.pow(.95, dt / 16);
      scrollBy(-v * dt, cx, cy);
      if (Math.abs(v) > .05 && now - start < 1200) coastFrame = requestAnimationFrame(tick);
    };
    coastFrame = requestAnimationFrame(tick);
  }
  view.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    e.preventDefault(); cancelAnimationFrame(coastFrame);
    if (touch) { touch.multi = true; clearTimeout(touch.timer); return; }
    const t = touch = {id: e.pointerId, x: e.clientX, y: e.clientY, lastY: e.clientY, lastT: performance.now(), v: 0, moved: false, long: false, multi: false};
    t.timer = setTimeout(() => {
      if (touch !== t || t.moved || t.multi) return;
      t.long = true;
      const p = toScreen(t.x, t.y); if (p) tap(p, 3, {clientX: t.x, clientY: t.y});
    }, LONG_PRESS);
    try { view.setPointerCapture(e.pointerId); } catch {}
  });
  view.addEventListener('pointermove', e => {
    if (e.pointerType !== 'touch' || !touch || e.pointerId !== touch.id || touch.multi) return;
    e.preventDefault();
    const now = performance.now(), dy = e.clientY - touch.lastY;
    if (!touch.moved && Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > 8) { touch.moved = true; clearTimeout(touch.timer); }
    if (touch.moved) { touch.v = .6 * touch.v + .4 * dy / Math.max(8, now - touch.lastT); scrollBy(-dy, touch.x, touch.y); }
    touch.lastY = e.clientY; touch.lastT = now;
  });
  function endTouch(e, cancelled) {
    if (e.pointerType !== 'touch' || !touch || e.pointerId !== touch.id) return;
    const t = touch; touch = null; clearTimeout(t.timer);
    if (cancelled || t.long || t.multi) return;
    if (t.moved) { if (performance.now() - t.lastT < 80 && Math.abs(t.v) > .2) coast(t.v, t.x, t.y); return; }
    const p = toScreen(t.x, t.y); if (!p) return;
    const now = performance.now();
    const double = box?.client === 'qq' && lastTap && now - lastTap.t < 350 && Math.hypot(t.x - lastTap.x, t.y - lastTap.y) < 24;
    lastTap = double ? null : {t: now, x: t.x, y: t.y};
    handleClick(p, {clientX: t.x, clientY: t.y}, double ? 2 : 1);
  }
  view.addEventListener('pointerup', e => endTouch(e, false));
  view.addEventListener('pointercancel', e => endTouch(e, true));

  // ---- keyboard ----
  document.addEventListener('keydown', e => {
    if (e.target === draft || $('#sheet').classList.contains('open')) return;
    if (e.key === 'Escape') {
      if (box?.popups?.length) call('window', {action: 'escape', window: box.popups[0].id}).then(r => acceptLayout(r.layout), error => message(error.message, true));
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Typing anywhere goes to the text box; focus moves before the character is inserted.
    if ((e.key.length === 1 || e.key === 'Process') && !focusDraft() && !box?.popups?.length) message('请先在左侧选择聊天');
  });

  // ---- files: picker, paste and drag-and-drop ----
  let pendingUpload = null, dragDepth = 0;
  attach.onclick = () => { if (!attach.disabled) picker.click(); };
  picker.onchange = () => { const files = [...picker.files]; picker.value = ''; prepareUpload(files); };
  document.addEventListener('paste', e => {
    const data = e.clipboardData; if (!data) return;
    const files = [...(data.files || [])];
    if (files.length) { e.preventDefault(); prepareUpload(files.map((f, i) => f.name ? f : new File([f], `粘贴图片-${Date.now()}-${i}.png`, {type: f.type}))); return; }
    const text = data.getData('text/plain');
    if (text && e.target !== draft && focusDraft()) { e.preventDefault(); draft.setRangeText(text, draft.selectionStart, draft.selectionEnd, 'end'); drafts.set(draftChat, draft.value); }
  });
  addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); dragDepth++; $('#drop').classList.add('on'); } });
  addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.remove('on'); } });
  addEventListener('drop', e => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault(); dragDepth = 0; $('#drop').classList.remove('on');
    prepareUpload([...e.dataTransfer.files]);
  });
  function prepareUpload(files) {
    if (!files.length) return;
    if (!nativeInput() || !box?.conversation) return message('请先在左侧打开要发送的聊天', true);
    if (files.some(f => f.size > 95 * 1024 * 1024)) return message('单个文件不能超过 95MB', true);
    const sheet = $('#sheet'), list = sheet.querySelector('ul'); list.replaceChildren();
    for (const file of files) {
      const item = document.createElement('li');
      item.textContent = file.name + ' · ' + (file.size > 1048576 ? (file.size / 1048576).toFixed(1) + ' MB' : Math.ceil(file.size / 1024) + ' KB');
      list.append(item);
    }
    // The chat header from the live picture, so the recipient can be checked.
    const target = sheet.querySelector('canvas'), head = headerArea();
    const hx = (head.x - rect[0]) / unit, hy = (head.y - rect[1]) / unit, hw = head.width / unit, hh = head.height / unit;
    target.width = Math.round(hw); target.height = Math.round(hh);
    target.getContext('2d').drawImage(mirror, hx, hy, hw, hh, 0, 0, target.width, target.height);
    pendingUpload = {files, window: box.id, conversation: box.conversation, ids: files.map(() => crypto.randomUUID())};
    $('#upload').textContent = '发送 ' + files.length + ' 个';
    sheet.classList.add('open');
  }
  $('#upload-cancel').onclick = () => { pendingUpload = null; $('#sheet').classList.remove('open'); };
  $('#upload').onclick = async () => {
    const job = pendingUpload; if (!job || busy) return;
    pendingUpload = null; $('#sheet').classList.remove('open'); busy = true; controls();
    try {
      for (const [index, file] of job.files.entries()) {
        await uploadOne(file, job.ids[index], job, part => message(`正在发送 ${index + 1}/${job.files.length}：${Math.round(part * 100)}%`));
      }
      message('已发送');
    } catch (error) { if (error.layout) acceptLayout(error.layout); message(error.message, true); }
    finally { busy = false; controls(); }
  };
  function uploadOne(file, id, job, progress) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', '/mobile-api/upload');
      request.setRequestHeader('X-Mobile-Control', '1'); request.setRequestHeader('Content-Type', 'application/octet-stream');
      request.setRequestHeader('X-File-Name', encodeURIComponent(file.name)); request.setRequestHeader('X-Request-Id', id);
      request.setRequestHeader('X-Window', job.window); request.setRequestHeader('X-Conversation', encodeURIComponent(job.conversation));
      request.timeout = 120000;
      request.ontimeout = () => reject(Error('上传超时，请检查聊天记录后再试'));
      request.upload.onprogress = e => { if (e.lengthComputable) progress(e.loaded / e.total); };
      request.onload = () => {
        if (request.status === 401) { location.replace('/mobile/login'); return reject(Error('请重新登录')); }
        let result = {}; try { result = JSON.parse(request.responseText); } catch {}
        if (request.status >= 200 && request.status < 300) resolve(result);
        else { const error = Error(result.error || '发送失败'); error.layout = result.layout; reject(error); }
      };
      request.onerror = () => reject(Error('上传中断，请稍后重试'));
      request.send(file);
    });
  }

  // ---- page ----
  $('#popup-close').onclick = () => closePopup();
  $('#to-phone').onclick = () => { try { localStorage.setItem('nas-chat-view', 'phone'); } catch {} location.href = '/mobile/?view=phone'; };
  $('#logout').onclick = async () => { try { await call('logout', {}); } catch {} location.replace('/mobile/login'); };
  const shape = () => document.documentElement.clientHeight / Math.max(1, document.documentElement.clientWidth);
  let resizeTimer = 0, shownAspect = shape();
  addEventListener('resize', () => {
    schedulePaint();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // A clearly different window shape asks the server for a matching WeChat window.
      const aspect = shape();
      if (Math.abs(aspect - shownAspect) / shownAspect > .08) { shownAspect = aspect; reconnect(); }
    }, 800);
  });
  // Closing the on-screen keyboard can leave the page panned; put it back.
  draft.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== draft) scrollTo(0, 0); }, 50));
  document.addEventListener('visibilitychange', () => { if (document.hidden) { epoch++; socket?.close(); socket = null; } else connect(); });
  controls(); setStatus(false); schedulePaint();
  call('layout').then(r => acceptLayout(r.layout)).catch(() => {}).finally(connect);
})();
