// Prefer the home network for the picture stream when this device can reach the NAS directly.
// The page stays on the public address (same login, home-screen app and notifications); only the
// picture WebSocket goes to the LAN entry, authorised by a short-lived stream token. The LAN entry
// uses the NAS's own certificate, so this works on devices that trust it and quietly does nothing elsewhere.
(() => {
  const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
  const KEY = 'nas-chat-lan';
  let origin = null, reachable = null, checked = 0, probing = null, failedUntil = 0, using = false;
  const onLan = PRIVATE.test(location.hostname);
  function enabled() { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } }
  async function lanOrigin() {
    if (origin !== null) return origin;
    try {
      const response = await fetch('/mobile/lan-config.json', {cache: 'no-store'});
      const url = new URL((await response.json()).url);
      origin = url.protocol === 'https:' && PRIVATE.test(url.hostname) ? url.origin : '';
    } catch { origin = ''; }
    return origin;
  }
  // Runs in the background, so a page away from home never waits for it.
  function probe() {
    if (probing) return probing;
    probing = (async () => {
      const target = await lanOrigin();
      let ok = false;
      if (target) {
        try {
          await fetch(target + '/mobile/manifest.json?probe=' + Date.now(), {mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(1500)});
          ok = true;
        } catch {}
      }
      reachable = ok; checked = Date.now(); probing = null;
      if (ok && !using && enabled() && Date.now() >= failedUntil) dispatchEvent(new Event('nas-lan-change'));
      return ok;
    })();
    return probing;
  }
  // Resolves to {base, token} for a LAN stream, or null to use the public address now.
  async function stream() {
    using = false;
    if (onLan || !enabled() || Date.now() < failedUntil) return null;
    if (reachable !== true) { if (reachable === null || Date.now() - checked > 60000) probe(); return null; }
    if (Date.now() - checked > 60000) probe();
    try {
      const response = await fetch('/mobile-api/stream-token', {method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(6000),
        headers: {'Content-Type': 'application/json', 'X-Mobile-Control': '1'}, body: '{}'});
      if (!response.ok) return null;
      const {token} = await response.json();
      if (!token) return null;
      using = true;
      return {base: origin.replace(/^https:/, 'wss:'), token};
    } catch { return null; }
  }
  function failed() { using = false; reachable = null; failedUntil = Date.now() + 60000; }
  function reset() { reachable = null; failedUntil = 0; }
  addEventListener('online', reset);
  // The network may have changed while the page was in the background.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reachable = null; });
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
      reset(); label(button);
      dispatchEvent(new Event('nas-lan-change'));
    });
  });
  window.nasLan = {stream, failed, reset, enabled, active: () => using};
})();
