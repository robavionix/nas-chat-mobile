// Computer view input, run against mobile/web/desktop.js with a small fake page:
// iPad fingers (tap, long press, drag), Magic Keyboard trackpad (click, secondary click, scroll),
// the on-screen keyboard, and the text box over the client's own input (instant clear, ordered sends,
// a failed message returning with the same request).
const vm = require('vm'), fs = require('fs'), assert = require('assert');
const source = fs.readFileSync('mobile/web/desktop.js', 'utf8');

function element(id) {
  const listeners = {};
  return {id, listeners, hidden: false, value: '', style: {}, dataset: {}, readOnly: false, disabled: false, textContent: '',
    classList: {add() {}, remove() {}, toggle() {}, contains: () => false},
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatch(type, event) { for (const fn of listeners[type] || []) fn(event); },
    querySelector: () => element('child'), getContext: () => context2d(), focus() {}, blur() {}, setPointerCapture() {},
    setSelectionRange() {}, setRangeText() {}, replaceChildren() {}, append() {}, remove() {}, click() {}};
}
function context2d() {
  return {fillRect() {}, drawImage() {}, getImageData: (x, y, w, h) => ({data: new Uint8ClampedArray(w * h * 4).fill(250)}),
    set fillStyle(v) {}, set imageSmoothingEnabled(v) {}, set imageSmoothingQuality(v) {}};
}
const elements = {}, $ = selector => (elements[selector] ||= element(selector));
const layout = {id: '1', x: 0, y: 0, width: 1800, height: 1300, screenWidth: 1800, screenHeight: 2800, chatReady: true, compact: false,
  split: 389, popups: [], conversation: 'c', client: 'wechat', clientLabel: '微信'};
const calls = [], sockets = [];
let frameCallbacks = [], failSend = false, uuid = 0;
class FakeSocket { constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); } send() {} close() { this.readyState = 3; } }
const context = {
  console, Math, JSON, Promise, Error, TypeError, Map, Set, Array, Number, String, Object, Uint8Array, Uint8ClampedArray, ArrayBuffer, DataView,
  TextDecoder, URLSearchParams, Blob, setTimeout, clearTimeout, setInterval, clearInterval,
  performance: {now: () => Date.now()},
  requestAnimationFrame: fn => { frameCallbacks.push(fn); return frameCallbacks.length; }, cancelAnimationFrame() {},
  location: {search: '', hostname: 'chat.example', protocol: 'https:', host: 'chat.example', replace() {}, href: ''},
  localStorage: {getItem: () => null, setItem() {}},
  navigator: {clipboard: {writeText: async () => {}}},
  crypto: {randomUUID: () => 'request-' + ++uuid},
  AbortSignal: {timeout: () => undefined},
  devicePixelRatio: 2, innerWidth: 1180, innerHeight: 820, scrollTo() {},
  WebSocket: FakeSocket, createImageBitmap: async () => ({close() {}}), Image: class {},
  fetch: async (url, options = {}) => {
    const path = url.replace('/mobile-api/', ''), body = options.body ? JSON.parse(options.body) : null;
    calls.push({path, body});
    if (path === 'send' && failSend) return {status: 409, ok: false, json: async () => ({error: '聊天窗口已变化'})};
    return {status: 200, ok: true, json: async () => ({ok: true, layout})};
  },
  addEventListener() {}, dispatchEvent() {},
  document: {
    hidden: false, activeElement: null, title: '', body: {dataset: {}, append() {}},
    documentElement: {clientWidth: 1180, clientHeight: 820},
    querySelector: $, createElement: () => element('canvas'), addEventListener() {},
  },
};
context.globalThis = context; context.window = context;
vm.runInNewContext(source, context);

const flush = async () => { for (let i = 0; i < 5; i++) { const fns = frameCallbacks; frameCallbacks = []; fns.forEach(fn => fn(context.performance.now())); await new Promise(r => setTimeout(r, 0)); } };
const wait = ms => new Promise(r => setTimeout(r, ms));
function frame() {
  const header = Buffer.from(JSON.stringify({seq: 1, key: 'k', rect: [0, 0, 1800, 1300], size: [1800, 1300], full: true, strips: [], layout}));
  const out = Buffer.alloc(8 + header.length); out.writeUInt32BE(header.length); header.copy(out, 8);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}
const view = $('#view'), draft = $('#draft');
const pointer = (type, kind, x, y) => view.dispatch(type, {pointerType: kind, pointerId: 1, clientX: x, clientY: y, preventDefault() {}});
const actions = () => calls.filter(c => ['tap', 'scroll'].includes(c.path)).map(c => c.path === 'tap' ? 'tap:' + c.body.button : 'scroll');
const sends = () => calls.filter(c => c.path === 'send').map(c => c.body);

(async () => {
  await wait(20); await flush();
  await sockets[0].onmessage({data: frame()}); await flush();
  assert.equal(context.document.title, '微信 · 电脑视图', 'the client name comes from the layout');
  assert.equal(draft.hidden, false, 'the text box covers the client input once a chat is open');

  calls.length = 0;  // finger tap, then the browser's own click for it
  pointer('pointerdown', 'touch', 300, 300); pointer('pointerup', 'touch', 300, 300);
  view.dispatch('click', {detail: 1, clientX: 300, clientY: 300}); await wait(30);
  assert.deepEqual(actions(), ['tap:1'], 'a finger tap clicks once');

  calls.length = 0;  // long press
  pointer('pointerdown', 'touch', 400, 300); await wait(560); pointer('pointerup', 'touch', 400, 300);
  view.dispatch('contextmenu', {preventDefault() {}, clientX: 400, clientY: 300}); await wait(30);
  assert.deepEqual(actions(), ['tap:3'], 'a long press opens the context menu once');

  calls.length = 0;  // drag upward: scrolls only, towards newer content
  pointer('pointerdown', 'touch', 500, 600);
  for (let y = 590; y >= 300; y -= 10) { pointer('pointermove', 'touch', 500, y); await wait(4); }
  pointer('pointerup', 'touch', 500, 300); await wait(60); await flush();
  assert.ok(actions().length && actions().every(a => a === 'scroll'), 'a drag only scrolls');
  assert.ok(calls.filter(c => c.path === 'scroll').every(c => c.body.amount > 0), 'finger up reveals newer content');

  calls.length = 0;  // Magic Keyboard trackpad: click, secondary click, two-finger scroll
  pointer('pointerdown', 'mouse', 300, 300); view.dispatch('click', {detail: 1, clientX: 300, clientY: 300});
  pointer('pointerdown', 'mouse', 300, 300); view.dispatch('contextmenu', {preventDefault() {}, clientX: 300, clientY: 300});
  for (let i = 0; i < 4; i++) view.dispatch('wheel', {deltaY: 60, deltaMode: 0, clientX: 300, clientY: 300, preventDefault() {}});
  await wait(30);
  // Taps are queued and the wheel is immediate (a flick from the drag above may still be coasting), so check each kind.
  assert.deepEqual(actions().filter(a => a !== 'scroll'), ['tap:1', 'tap:3'], 'trackpad click and secondary click');
  assert.ok(actions().filter(a => a === 'scroll').length >= 1, 'two-finger trackpad scrolling');

  const before = [view.width, view.height];  // on-screen keyboard
  context.innerHeight = 420; await sockets[0].onmessage({data: frame()}); await flush();
  assert.deepEqual([view.width, view.height], before, 'the keyboard leaves the picture alone');

  calls.length = 0;  // Enter clears at once; messages go out in order
  const enter = () => draft.dispatch('keydown', {key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 13, preventDefault() {}});
  draft.value = '第一条'; enter(); assert.equal(draft.value, '', 'the box clears immediately');
  draft.value = '第二条'; enter(); assert.equal(draft.value, '');
  await wait(30);
  assert.deepEqual(sends().map(s => s.text), ['第一条', '第二条'], 'sent in order');
  assert.notEqual(sends()[0].requestId, sends()[1].requestId);

  calls.length = 0; failSend = true;  // a failed send returns to the box and keeps its request
  draft.value = '没发出去'; enter(); await wait(30);
  assert.equal(draft.value, '没发出去', 'a failed message comes back');
  failSend = false; enter(); await wait(30);
  assert.equal(sends().length, 2); assert.equal(sends()[0].requestId, sends()[1].requestId, 'the retry is the same request');
  assert.equal(draft.value, '');

  console.log('PASS computer view input: finger tap/long press/drag, trackpad click/secondary/scroll, keyboard keeps the picture, instant ordered sends, failed send returns with its request');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
