const vm=require('vm'),fs=require('fs'),assert=require('assert'),{webcrypto}=require('crypto');
const source=fs.readFileSync(process.env.KEYBOARD_APP_SOURCE||'mobile/web/app.js','utf8');
const sending=source.slice(source.indexOf('send.onclick=async()=>{'),source.indexOf("document.querySelector('#restore-send')"));
function setup(){
  const handlers={},jobs=[],requests=[],attributes={};let now=100,blocked=false;
  const draft={value:'第一条',style:{},setAttribute(k,v){attributes[k]=v},addEventListener(k,v){handlers[k]=v}};
  const send={disabled:false,click(){jobs.push(this.onclick())}};
  const context={document:{querySelector:id=>id==='#draft'?draft:send},performance:{now:()=>now},
    send,draft,box:{id:'1',conversation:'chat:a'},pendingSend:null,busy:false,crypto:webcrypto,
    sendRecoveries:new Map(),sendDraftKey(value){value??=context.box;return String(value.id??value.window)+':'+value.conversation},
    controls(){send.disabled=blocked||context.busy||!draft.value.trim()},
    sizeDraft(){context.controls()},message(){},debugLog(){},acceptLayout(){},resetMessagePicture(){},update(){},
    call:async(path,data)=>new Promise((resolve,reject)=>requests.push({path,data,resolve,reject}))};
  vm.runInNewContext(sending,context);
  vm.runInNewContext(fs.readFileSync('mobile/web/keyboard.js','utf8'),context);
  function key(overrides={}){
    const event={key:'Enter',keyCode:13,prevented:false,preventDefault(){this.prevented=true},...overrides};
    handlers.keydown(event);return event;
  }
  return {context,handlers,jobs,requests,attributes,draft,send,key,advance(ms){now+=ms},block(value){blocked=value}};
}
(async()=>{
  let s=setup();assert.equal(s.attributes.enterkeyhint,'send');
  assert.ok(s.key().prevented);assert.equal(s.requests.length,1);assert.equal(s.draft.value,'');
  s.draft.value='第二条';s.key({repeat:true});s.key();
  assert.equal(s.requests.length,1,'held Return and busy state never submit twice');assert.equal(s.draft.value,'第二条');
  s.requests[0].resolve({});await s.jobs[0];s.key();
  assert.equal(s.requests.length,2);assert.equal(s.requests[1].data.text,'第二条');
  assert.notEqual(s.requests[0].data.requestId,s.requests[1].data.requestId);
  s.requests[1].resolve({});await s.jobs[1];
  s=setup();for(const modifier of ['shiftKey','ctrlKey','altKey','metaKey'])assert.ok(!s.key({[modifier]:true}).prevented);
  assert.equal(s.requests.length,0);s.draft.value+='\n下一行';s.key();assert.equal(s.requests[0].data.text,'第一条\n下一行');
  s.requests[0].resolve({});await s.jobs[0];
  s=setup();s.handlers.compositionstart();assert.ok(!s.key().prevented);assert.equal(s.requests.length,0);
  s.handlers.compositionend();assert.ok(!s.key({keyCode:229}).prevented);assert.equal(s.requests.length,0);
  assert.ok(s.key().prevented);assert.equal(s.requests.length,0,'WebKit compositionend-before-keydown must not send');
  s.advance(80);s.key();assert.equal(s.requests.length,1);s.requests[0].resolve({});await s.jobs[0];
  s=setup();assert.ok(!s.key({isComposing:true}).prevented);assert.equal(s.requests.length,0);
  s.block(true);s.key();assert.equal(s.requests.length,0);assert.equal(s.draft.value,'第一条');
  s.block(false);s.draft.value='   ';s.key();assert.equal(s.requests.length,0);
  s.draft.value='连接失败要保留';s.key();const id=s.requests[0].data.requestId;
  s.requests[0].reject(Error('unconfirmed'));await s.jobs[0];assert.equal(s.draft.value,'连接失败要保留');
  s.key();assert.equal(s.requests[1].data.requestId,id,'keyboard retry keeps send idempotency');
  s.requests[1].resolve({});await s.jobs[1];
  console.log('PASS Return send, Shift+Return newline, IME/WebKit event order, held keys, busy/offline guards and idempotent recovery');
})().catch(error=>{console.error(error);process.exitCode=1});
