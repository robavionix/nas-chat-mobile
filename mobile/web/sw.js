// Network only: do not cache messages, credentials, or screenshots.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  let payload={};try{payload=event.data?.json()||{}}catch{}
  const title=typeof payload.title==='string'&&payload.title.trim()?payload.title.slice(0,100):'聊天 · 新消息';
  const body=typeof payload.body==='string'?payload.body.slice(0,400):'你有新的聊天消息，点击查看。';
  event.waitUntil(self.registration.showNotification(title,{body,icon:'/mobile/icon-192.png',badge:'/mobile/favicon.png',tag:payload.tag==='nas-chat-test'?'nas-chat-test-'+Date.now():'nas-chat-new-message',renotify:true,data:{url:'/mobile/?notifications=1'}}));
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
