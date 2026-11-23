const {strict: assert}=require('node:assert');
const vm=require('node:vm'), fs=require('node:fs');
const code=fs.readFileSync('mobile/web/lan.js','utf8');
function setup() {
  const win=new EventTarget(), doc=new EventTarget();doc.hidden=false;
  let now=0, seq=0, timers=new Map(), log=[], changes=0;
  const flags={ok:true,config:true,token:true,delay:false};
  let release;
  const ctx={window:win,document:doc,location:{hostname:'chat.example.com'},navigator:{onLine:true},Date:{now:()=>now},
    localStorage:{getItem:()=>null},URL,AbortController,Event,addEventListener:win.addEventListener.bind(win),dispatchEvent:win.dispatchEvent.bind(win),
    setTimeout:(fn,ms)=>{const id=++seq;timers.set(id,{t:now+ms,fn});return id},clearTimeout:id=>timers.delete(id),
    fetch:async(url,opts)=>{
      log.push(url);
      if(url.endsWith('lan-config.json'))return {ok:flags.config,json:async()=>({url:'https://192.168.1.2:8443/mobile/'})};
      if(url.includes('manifest')){
        if(flags.delay)await new Promise(r=>{release=r});
        if(!flags.ok)throw Error('LAN unavailable');return {};
      }
      return {ok:flags.token,json:async()=>({token:'fixture'})};
    }};
  vm.runInNewContext(code,ctx);
  win.addEventListener('nas-lan-change',()=>{changes++;win.nasLan.stream()});
  async function tick(ms){const end=now+ms;for(;;){
    const next=[...timers].sort((a,b)=>a[1].t-b[1].t)[0];if(!next||next[1].t>end)break;
    now=next[1].t;timers.delete(next[0]);next[1].fn();await new Promise(setImmediate);
  }now=end;}
  return {win,doc,flags,log,tick,route:win.nasLan,changes:()=>changes,release:()=>release()};
}
(async()=>{
  let t=setup();assert.equal(t.route.stream(),null);await t.tick(0);assert.equal(t.changes(),1);assert.ok(t.route.active());
  t.route.failed();assert.equal(t.route.stream(),null);await t.tick(14999);assert.equal(t.changes(),1);await t.tick(1);assert.equal(t.changes(),2);
  for(const key of ['ok','token','config']){t=setup();t.flags[key]=false;assert.equal(t.route.stream(),null);await t.tick(0);assert.equal(t.changes(),0);
    t.flags[key]=true;await t.tick(45000);assert.equal(t.changes(),1);}
  t=setup();t.flags.delay=true;t.route.stream();await t.tick(0);t.doc.hidden=true;t.doc.dispatchEvent(new Event('visibilitychange'));t.release();
  await new Promise(setImmediate);assert.equal(t.changes(),0);assert.equal(t.log.filter(s=>s.endsWith('stream-token')).length,0);
  t.doc.hidden=false;t.flags.delay=false;t.doc.dispatchEvent(new Event('visibilitychange'));await t.tick(0);assert.equal(t.changes(),1);
  t=setup();t.route.stream();await t.tick(0);t.win.dispatchEvent(new Event('offline'));assert.equal(t.route.active(),false);
  t.win.dispatchEvent(new Event('online'));await t.tick(0);assert.equal(t.changes(),2);
  console.log('Route tests passed: public-first, fallback, cooldown, LAN return, config and token recovery, stale probe cancellation, foreground and network resumption');
})().catch(e=>{console.error(e);process.exit(1)});
