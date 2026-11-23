// Keep login and controls on the page origin. Only the picture stream can take the LAN route.
(() => {
  const KEY = 'nas-chat-lan';
  function privateAddress(host) {
    const octets = host.split('.');
    if (octets.length !== 4 || !octets.every(x => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return false;
    const [a, b] = octets.map(Number);
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  const onLan = privateAddress(location.hostname);
  let origin, candidate, expires = 0, using = false, generation = 0;
  let job = null, timer = 0, failures = 0, retryAt = 0;
  function enabled() { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } }
  function available() { return !onLan && enabled() && !document.hidden && navigator.onLine !== false; }

  function schedule(delay) {
    clearTimeout(timer);
    if (available() && !using) timer = setTimeout(prepare, delay);
  }
  async function prepare() {
    if (!available() || using || job) return;
    if (Date.now() < retryAt) { schedule(retryAt - Date.now()); return; }
    const version = generation;
    const controller = new AbortController();
    job = controller;
    const timeout = setTimeout(() => controller.abort(), 4500);
    try {
      if (!origin) {
        const r = await fetch('/mobile/lan-config.json', {cache: 'no-store', signal: controller.signal});
        if (!r.ok) throw Error('config');
        const url = new URL((await r.json()).url);
        if (url.protocol !== 'https:' || !privateAddress(url.hostname) || url.username || url.password) throw Error('origin');
        if (generation !== version) return;
        origin = url.origin;
      }
      await fetch(origin + '/mobile/manifest.json', {mode: 'no-cors', credentials: 'omit', cache: 'no-store', signal: controller.signal});
      if (generation !== version || !available()) return;
      const r = await fetch('/mobile-api/stream-token', {method: 'POST', cache: 'no-store', signal: controller.signal,
        headers: {'Content-Type': 'application/json', 'X-Mobile-Control': '1'}, body: '{}'});
      if (!r.ok) throw Error('token');
      const {token} = await r.json();
      if (typeof token !== 'string' || !token || generation !== version || !available()) return;
      candidate = {base: origin.replace(/^https:/, 'wss:'), token};
      expires = Date.now() + 60000;
      dispatchEvent(new Event('nas-lan-change'));
    } catch { /* The public stream continues during discovery. */ }
    finally {
      clearTimeout(timeout);
      if (job === controller) {
        job = null;
        if (!using) {
          retryAt = Date.now() + 45000;
          schedule(45000);
        }
      }
    }
  }
  function stream() {
    if (available() && candidate && Date.now() < expires) {
      using = true; clearTimeout(timer);
      return candidate;
    }
    using = false;
    if (available()) schedule(Math.max(0, retryAt - Date.now()));
    return null;
  }
  function reset() {
    generation++; job?.abort(); job = null; clearTimeout(timer);
    candidate = null; using = false; retryAt = 0; failures = 0;
  }
  function failed() {
    candidate = null; using = false;
    const delay = Math.min(180000, 15000 * 2 ** Math.min(failures++, 4));
    retryAt = Date.now() + delay;
    schedule(delay);
  }
  function networkChange() { reset(); schedule(0); }
  addEventListener('offline', reset);
  addEventListener('online', networkChange);
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); else schedule(0); });
  function label(button) {
    button.textContent = onLan ? '已在家里直连' : '优先家里直连：' + (enabled() ? '开' : '关');
    button.disabled = onLan;
  }
  document.addEventListener('DOMContentLoaded', () => {
    const button = document.querySelector('#lan-pref');
    if (!button) return;
    label(button);
    button.addEventListener('click', () => {
      try { localStorage.setItem(KEY, enabled() ? 'off' : 'on'); } catch {}
      const wasUsing = using;
      networkChange(); label(button);
      if (wasUsing && !enabled()) dispatchEvent(new Event('nas-lan-change'));
    });
  });
  window.nasLan = {stream, failed, reset, enabled, active: () => using, connected: () => { failures = 0; }};
})();
