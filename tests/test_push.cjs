const vm=require('vm'),fs=require('fs'),assert=require('assert'),{webcrypto}=require('crypto');
async function setup({iphone=false,installed=true,owned=false,existing=false,permission='default'}={}){
  const nodes={},calls=[],order=[];let unsubscribed=0,requested=0,periodic,isOwned=owned,lastTest=null;
  for(const id of ['push-toggle','push-preview','push-test','push-info'])nodes['#'+id]={disabled:false,setAttribute(){},addEventListener(name,fn){this[name]=fn}};
  const sub={endpoint:'https://web.push.apple.com/test',options:{},toJSON(){return {endpoint:this.endpoint}},async unsubscribe(){unsubscribed++;return true}};
  const digest=await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(sub.endpoint));
  const id=Buffer.from(digest).toString('hex');
  const manager={async getSubscription(){return existing?sub:null},async subscribe(){order.push('subscribe');return sub}};
  const context={isSecureContext:true,location:{hostname:'chat.example.com',search:'',href:'https://chat.example.com/mobile/'},
    document:{querySelector:()=>({hidden:true,querySelector:selector=>nodes[selector]}),hidden:false},
    window:{PushManager:function(){},Notification:{},matchMedia:()=>({matches:installed})},
    navigator:{userAgent:iphone?'iPhone':'test',serviceWorker:{ready:Promise.resolve({pushManager:manager}),addEventListener(){}},standalone:installed},
    Notification:{permission,requestPermission(){requested++;order.push('permission');return Promise.resolve('granted')}},
    crypto:webcrypto,TextEncoder,Uint8Array,atob,URL,URLSearchParams,history:{replaceState(){}},
    setTimeout:()=>1,setInterval(fn){periodic=fn},menu:{classList:{contains:()=>false}},box:null,
    async call(path,data){calls.push([path,data]);order.push(path);if(path==='push/status')return {available:true,publicKey:Buffer.alloc(65,4).toString('base64url'),source:'connected',subscriptions:isOwned?[{id,preview:false,test:lastTest}]:[]};if(path==='push/subscribe'){isOwned=true;return {id}}if(path==='push/unsubscribe')isOwned=false;if(path==='push/test'){lastTest={id:'ticket',state:'accepted'};return {testId:'ticket'}}return {ok:true}}};
  vm.runInNewContext(fs.readFileSync('mobile/web/push.js','utf8'),context);
  for(let n=0;n<8;n++)await new Promise(resolve=>setImmediate(resolve));
  return {nodes,context,calls,order,get periodic(){return periodic},get requested(){return requested},get unsubscribed(){return unsubscribed}};
}
(async()=>{
  let s=await setup({iphone:true,installed:false});assert.equal(s.nodes['#push-toggle'].disabled,true);assert.equal(s.requested,0,'loading a Safari tab must never ask permission');
  s=await setup();assert.equal(s.requested,0);const pending=s.nodes['#push-toggle'].click();assert.equal(s.requested,1,'permission must be requested synchronously during the tap');await pending;
  assert.equal(s.nodes['#push-toggle'].textContent,'消息推送：开启');assert.ok(s.order.indexOf('permission')<s.order.indexOf('subscribe'));
  assert.equal(s.calls.find(([path])=>path==='push/subscribe')[1].preview,false);
  await s.nodes['#push-preview'].click();assert.equal(s.calls.at(-1)[1].preview,true);
  await s.nodes['#push-test'].click();assert.equal(s.calls.at(-1)[0],'push/status');assert.ok(s.nodes['#push-info'].textContent.includes('已接受'),'test feedback must distinguish acceptance from merely queued');
  await s.nodes['#push-toggle'].click();assert.equal(s.calls.at(-1)[0],'push/unsubscribe');assert.equal(s.unsubscribed,1);assert.equal(s.nodes['#push-toggle'].textContent,'消息推送：关闭');
  s=await setup({existing:true,owned:false,permission:'granted'});assert.equal(s.nodes['#push-toggle'].textContent,'消息推送：关闭');assert.equal(s.calls.length,1,'an orphaned browser subscription must not re-enable itself after logout');
  s=await setup({existing:true,owned:true,permission:'granted'});assert.equal(s.nodes['#push-toggle'].textContent,'消息推送：开启');
  s.context.call=async()=>{throw Error('offline')};await s.nodes['#push-toggle'].click();assert.equal(s.unsubscribed,0,'keep retry possible when server revocation fails');assert.equal(s.nodes['#push-toggle'].textContent,'消息推送：开启');
  s=await setup({existing:true,owned:true,permission:'granted'});
  const original=s.context.call;let release;
  s.context.menu.classList.contains=()=>true;
  s.context.call=(path,data)=>path==='push/status'?new Promise(resolve=>{const stale=original(path,data);release=async()=>resolve(await stale)}):original(path,data);
  s.periodic();await s.nodes['#push-toggle'].click();await release();
  for(let n=0;n<8;n++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(s.nodes['#push-toggle'].textContent,'消息推送：关闭','a stale status refresh must not undo an explicit opt-out');
  const handlers={},shown=[],opened=[];let waited,focused=0;
  const worker={location:{origin:'https://chat.example.com'},addEventListener(name,fn){handlers[name]=fn},registration:{showNotification(title,options){shown.push({title,options});return Promise.resolve()}},clients:{async matchAll(){return []},async openWindow(url){opened.push(url)}}};
  vm.runInNewContext(fs.readFileSync('mobile/web/sw.js','utf8'),{self:worker,URL});
  handlers.push({data:{json:()=>({title:'Alice',body:'hello',url:'https://evil.example/'})},waitUntil(p){waited=p}});await waited;
  assert.equal(shown[0].title,'Alice');assert.equal(shown[0].options.data.url,'/mobile/?notifications=1');
  handlers.push({data:{json(){throw Error('invalid')}},waitUntil(p){waited=p}});await waited;assert.equal(shown.length,2,'every push must produce a visible notification');
  const click={notification:{close(){}},waitUntil(p){waited=p}};handlers.notificationclick(click);await waited;assert.deepEqual(opened,['/mobile/?notifications=1']);
  worker.clients.matchAll=async()=>[{url:'https://chat.example.com/mobile/',postMessage(value){assert.equal(value.type,'nas-notification-open')},async focus(){focused++}}];
  handlers.notificationclick(click);await waited;assert.equal(focused,1);assert.equal(opened.length,1,'focus the existing app instead of opening duplicates');
  console.log('PASS explicit iPhone permission, subscription ownership, preview, server-first opt-out, visible push and safe notification click');
})().catch(error=>{console.error(error);process.exitCode=1});
