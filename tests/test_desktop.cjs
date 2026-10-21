const vm=require('vm'),fs=require('fs'),assert=require('assert');

// ---- the phone page sends computers to the desktop page ----
const page=fs.readFileSync('mobile/web/index.html','utf8');
const detect=page.match(/<title>[^<]*<\/title><script>([\s\S]*?)<\/script>/)[1];
function visit({ua,data=null,touch=0,fine=true,search='',saved=null}){
  let target=null;const store={};if(saved)store['nas-chat-view']=saved;
  vm.runInNewContext(detect,{URLSearchParams,location:{search,replace:url=>{target=url}},
    localStorage:{getItem:key=>store[key]??null,setItem:(key,value)=>{store[key]=value}},
    navigator:{userAgent:ua,userAgentData:data,maxTouchPoints:touch},matchMedia:()=>({matches:fine})});
  return {computer:target==='./desktop.html',store};
}
const windows='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const mac='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
assert.ok(visit({ua:windows,data:{mobile:false},touch:10}).computer,'Windows touch laptops are computers');
assert.ok(visit({ua:windows,data:{mobile:false}}).computer);
assert.ok(visit({ua:mac}).computer,'Mac Safari');
assert.ok(!visit({ua:mac,touch:5}).computer,'iPad reports a Mac user agent but has touch points');
assert.ok(!visit({ua:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148',touch:5,fine:false}).computer);
assert.ok(!visit({ua:'Mozilla/5.0 (Linux; Android 15) Chrome/141.0 Mobile Safari/537.36',data:{mobile:true},touch:5,fine:false}).computer);
assert.ok(!visit({ua:'Mozilla/5.0 (Linux; Android 15) Chrome/141.0 Safari/537.36',data:{mobile:false},touch:10}).computer,'Android tablets keep the phone view');
assert.ok(!visit({ua:windows,data:{mobile:false},saved:'phone'}).computer,'a chosen phone view is remembered');
const chosen=visit({ua:mac,touch:5,search:'?view=desktop'});
assert.ok(chosen.computer);assert.equal(chosen.store['nas-chat-view'],'desktop');
console.log('PASS computer detection: Windows touch PCs, Mac, iPad, phones, Android tablets and remembered choice');

// ---- lan.js prefers the home network only when it is reachable ----
const lanSource=fs.readFileSync('mobile/web/lan.js','utf8');
function lan({host='chat.example',config={url:'https://192.168.1.10:5843/mobile/'},reachable=true,pref=null}){
  const events=[],store={};if(pref)store['nas-chat-lan']=pref;const listeners={};
  const fetch=async(url,options={})=>{
    if(url==='/mobile/lan-config.json')return {json:async()=>config};
    if(url.startsWith('https://192.168.1.10:5843/mobile/manifest.json')){assert.equal(options.mode,'no-cors');if(!reachable)throw TypeError('unreachable');return {}}
    if(url==='/mobile-api/stream-token'){assert.equal(options.headers['X-Mobile-Control'],'1');return {ok:true,json:async()=>({token:'t1'})}}
    throw Error('unexpected '+url);
  };
  const context={location:{hostname:host},fetch,AbortSignal:{timeout:()=>undefined},URL,Date,Event:class{constructor(type){this.type=type}},
    localStorage:{getItem:key=>store[key]??null,setItem:(key,value)=>{store[key]=value}},
    document:{hidden:false,addEventListener(type,fn){listeners[type]=fn},querySelector:()=>null},
    addEventListener(){},dispatchEvent:event=>events.push(event.type)};
  context.window=context;vm.runInNewContext(lanSource,context);
  return {api:context.nasLan,events};
}
const settle=()=>new Promise(r=>setTimeout(r,10));
(async()=>{
  let home=lan({});
  assert.equal(await home.api.stream(),null,'the first connection never waits for the probe');
  await settle();assert.deepEqual(home.events,['nas-lan-change'],'a reachable NAS asks the page to move the stream');
  assert.deepEqual(await home.api.stream(),{base:'wss://192.168.1.10:5843',token:'t1'});assert.ok(home.api.active());
  home.api.failed();assert.equal(await home.api.stream(),null,'a failed home stream falls back for a while');
  const away=lan({reachable:false});await away.api.stream();await settle();
  assert.deepEqual(away.events,[]);assert.equal(await away.api.stream(),null);
  for(const options of [{host:'192.168.1.10'},{pref:'off'},{config:{}},{config:{url:'http://192.168.1.10:5843/'}},{config:{url:'https://chat.example/'}}]){
    const off=lan(options);await off.api.stream();await settle();
    assert.equal(await off.api.stream(),null,JSON.stringify(options));assert.deepEqual(off.events,[]);
  }
  console.log('PASS home-network stream: background probe, token, fallback, opt-out, private-only https entries');
})().catch(error=>{console.error(error);process.exitCode=1});
