// Only versioned application scripts are cached. Documents, messages,
// credentials, screenshots and all API calls always use the network.
const ASSET_CACHE='nas-mobile-assets-20261014-1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  try{for(const name of await caches.keys())if(name.startsWith('nas-mobile-assets-')&&name!==ASSET_CACHE)await caches.delete(name)}catch{}
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin||url.searchParams.size!==1
    ||!/^\/mobile\/(panes|app|render|navigation|push|touch|presence|keyboard)\.js$/.test(url.pathname)
    ||!/^[A-Za-z0-9._-]{1,64}$/.test(url.searchParams.get('v')||''))return;
  event.respondWith((async()=>{
    let cache;
    try{cache=await caches.open(ASSET_CACHE);const hit=await cache.match(request);if(hit)return hit}catch{}
    const response=await fetch(request);
    // Authentication redirects and error pages must never become JS assets.
    if(cache&&response.ok&&!response.redirected&&/javascript/.test(response.headers.get('Content-Type')||'')){
      try{
        await cache.put(request,response.clone());
        const keys=await cache.keys();
        for(const old of keys.slice(0,Math.max(0,keys.length-32)))await cache.delete(old);
      }catch{}
    }
    return response;
  })());
});
self.addEventListener('push',event=>{
  let payload={};try{payload=event.data?.json()||{}}catch{}
  const title=typeof payload.title==='string'&&payload.title.trim()?payload.title.slice(0,100):'聊天 · 新消息';
  const body=typeof payload.body==='string'?payload.body.slice(0,400):'你有新的聊天消息，点击查看。';
  event.waitUntil(self.registration.showNotification(title,{body,icon:'/mobile/icon-192.png',badge:'/mobile/favicon.png',tag:payload.tag==='nas-chat-test'?'nas-chat-test-'+Date.now():'nas-chat-new-message',renotify:payload.update!==true,data:{url:'/mobile/?notifications=1'}}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=windows.find(client=>{const url=new URL(client.url);return url.origin===self.location.origin&&/^\/mobile\/(?:index.html)?$/.test(url.pathname)});
    if(existing){existing.postMessage({type:'nas-notification-open'});await existing.focus()}
    else await self.clients.openWindow('/mobile/?notifications=1');
  })());
});
