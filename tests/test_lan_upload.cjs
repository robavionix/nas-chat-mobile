const {strict: assert}=require('node:assert');
const vm=require('node:vm'), fs=require('node:fs');
const code=fs.readFileSync('mobile/web/lan.js','utf8');

// A page at the public address whose picture stream already found the home entry.
async function setup({token=true, xhr}={}) {
  const win=new EventTarget(), doc=new EventTarget(); doc.hidden=false;
  let now=0, seq=0; const timers=new Map(), log=[], sent=[];
  class FakeXHR {
    constructor(){ this.upload={}; this.headers={}; }
    open(method,url){ this.method=method; this.url=url; }
    setRequestHeader(k,v){ this.headers[k]=v; }
    abort(){ this.onabort?.(); }
    send(body){ sent.push(this); this.body=body; queueMicrotask(()=>xhr(this)); }
  }
  const ctx={window:win,document:doc,location:{hostname:'chat.example.com'},navigator:{onLine:true},Date:{now:()=>now},
    localStorage:{getItem:()=>null},URL,AbortController,AbortSignal,Event,TextEncoder,DataView,Uint8Array,Blob,JSON,Object,
    XMLHttpRequest:FakeXHR,addEventListener:win.addEventListener.bind(win),dispatchEvent:win.dispatchEvent.bind(win),
    setTimeout:(fn,ms)=>{const id=++seq;timers.set(id,{t:now+ms,fn});return id},clearTimeout:id=>timers.delete(id),
    fetch:async(url)=>{
      log.push(url);
      if(url.endsWith('lan-config.json'))return {ok:true,json:async()=>({url:'https://192.168.1.2:8443/mobile/'})};
      if(url.includes('manifest'))return {};
      if(url.endsWith('upload-token'))return {ok:token,json:async()=>({token:'upload.fixture'})};
      return {ok:true,json:async()=>({token:'stream.fixture'})};
    }};
  vm.runInNewContext(code,ctx);
  win.addEventListener('nas-lan-change',()=>win.nasLan.stream());
  assert.equal(win.nasLan.stream(),null,'the first picture uses the page address while the home entry is checked');
  for(let i=0;i<20;i++) await new Promise(setImmediate);
  const due=[...timers].sort((a,b)=>a[1].t-b[1].t)[0]; if(due){timers.delete(due[0]);due[1].fn();}
  for(let i=0;i<20;i++) await new Promise(setImmediate);
  return {route:win.nasLan,log,sent,advance:ms=>{now+=ms}};
}
const reply=(status,body)=>x=>{x.status=status;x.responseText=body===undefined?'':JSON.stringify(body);x.onload();};
const meta={name:'a.png',id:'request-0000000001',window:'7',conversation:'chat'};

(async()=>{
  // Success: token from the page's own address, picture straight to the home entry, chat details in the body.
  let t=await setup({xhr:reply(200,{ok:true,confirmed:true})});
  assert.ok(t.route.active(),'picture stream is on the home network');
  let progress=[];
  const result=await t.route.upload(new Uint8Array([1,2,3]),meta,p=>progress.push(p));
  assert.equal(result.confirmed,true);
  assert.ok(t.log.includes('/mobile-api/upload-token'),'token comes from the page address');
  const x=t.sent[0];
  assert.equal(x.url,'https://192.168.1.2:8443/mobile-api/upload?via=lan');
  assert.equal(x.headers['Content-Type'],'text/plain');
  assert.ok(!Object.keys(x.headers).some(k=>/^X-/.test(k)),'no custom headers, so the chat name never appears in headers or the address');
  const bytes=new Uint8Array(await x.body.arrayBuffer()), size=new DataView(bytes.buffer).getUint32(0);
  const head=JSON.parse(new TextDecoder().decode(bytes.subarray(4,4+size)));
  assert.deepEqual(head,{...meta,token:'upload.fixture'});
  assert.deepEqual([...bytes.subarray(4+size)],[1,2,3]);

  // A refusal from the chat client is shown to the user, not retried elsewhere.
  t=await setup({xhr:reply(409,{error:'聊天窗口已变化'})});
  await assert.rejects(t.route.upload(new Uint8Array([1]),meta,()=>{}),/聊天窗口已变化/);

  // Network failure, CORS failure or an expired token fall back to the public address (same request id).
  for(const xhr of [x=>x.onerror(), reply(401,{error:'expired'}), reply(0)]){
    t=await setup({xhr});
    assert.equal(await t.route.upload(new Uint8Array([1]),meta,()=>{}),null);
    assert.equal(await t.route.upload(new Uint8Array([1]),meta,()=>{}),null,'home route rests for a minute after a failure');
    assert.equal(t.sent.length,1);
  }

  // No token (for example the public address is unreachable) means no home attempt at all.
  t=await setup({token:false,xhr:reply(200,{ok:true})});
  assert.equal(await t.route.upload(new Uint8Array([1]),meta,()=>{}),null);
  assert.equal(t.sent.length,0);
  console.log('PASS home-network upload: body-only metadata, token from page address, refusals shown, failures fall back');
})().catch(e=>{console.error(e);process.exit(1)});
