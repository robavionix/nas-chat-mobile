const fs=require('fs'),vm=require('vm'),assert=require('assert'),{webcrypto}=require('crypto');
const documentHandlers={},windowHandlers={},requests=[];let heartbeat;
const context={crypto:webcrypto,Uint8Array,document:{hidden:false,addEventListener(name,fn){documentHandlers[name]=fn}},
  window:{addEventListener(name,fn){windowHandlers[name]=fn}},
  setInterval(fn,ms){assert.equal(ms,15000);heartbeat=fn},
  fetch(url,options){requests.push([url,options,JSON.parse(options.body)]);return Promise.resolve({ok:true})}};
vm.runInNewContext(fs.readFileSync('mobile/web/presence.js','utf8'),context);
assert.equal(requests.length,1);assert.equal(requests[0][2].visible,true);
assert.match(requests[0][2].id,/^[a-f0-9]{32}$/);
context.document.hidden=true;documentHandlers.visibilitychange();
assert.equal(requests.at(-1)[2].visible,false);assert.equal(requests.at(-1)[1].keepalive,true);
heartbeat();assert.equal(requests.length,2,'a suspended phone must not renew its foreground lease');
windowHandlers.pagehide();assert.equal(requests.at(-1)[2].visible,false);
context.document.hidden=false;windowHandlers.pageshow();heartbeat();
assert.equal(requests.at(-1)[2].visible,true);
requests.forEach(([url,options,payload],index)=>{
  assert.equal(url,'/mobile-api/presence');assert.equal(options.headers['X-Mobile-Control'],'1');
  assert.equal(payload.sequence,index+1);assert.equal(payload.id,requests[0][2].id);
});
console.log('PASS foreground heartbeat, immediate background release, page restore and ordered presence');
