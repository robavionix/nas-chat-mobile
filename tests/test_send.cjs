const vm=require('vm'),fs=require('fs'),assert=require('assert');
const source=fs.readFileSync('mobile/web/app.js','utf8');
const code=source.slice(source.indexOf('send.onclick=async()=>{'),source.indexOf("document.querySelector('#restore-send')"));
async function exercise(nextText,failed=false,switched=false){
  let resolve,reject,calls=0;
  const send={disabled:false},draft={value:'first'},recoveries=new Map();
  const context={send,draft,box:{id:'1',conversation:'chat:a'},pendingSend:null,busy:false,crypto,
    sendRecoveries:recoveries,sendDraftKey(value){value??=context.box;return String(value.id??value.window)+':'+value.conversation},
    sizeDraft:()=>{},message:()=>{},controls:()=>send.disabled=context.busy,
    debugLog:()=>{},acceptLayout:()=>{},resetMessagePicture:()=>{},update:()=>{},
    call:async()=>{calls++;return new Promise((r,j)=>{resolve=r;reject=j})}};
  vm.runInNewContext(code,context);
  const task=send.onclick();
  assert.equal(draft.value,'','submitted text must clear before awaiting the server');
  await send.onclick();assert.equal(calls,1,'double tap must not duplicate the request');
  if(nextText!==undefined)draft.value=nextText;
  if(switched)context.box={id:'1',conversation:'chat:b'};
  if(failed)reject(Error('unconfirmed'));else resolve({});
  await task;
  if(failed&&nextText===undefined&&!switched){assert.equal(draft.value,'first');assert.ok(context.pendingSend?.requestId)}
  else {
    assert.equal(draft.value,nextText??'');
    if(failed)assert.equal(recoveries.get('1:chat:a').text,'first','failed text stays with its original chat');
  }
}
(async()=>{
  await exercise('next');await exercise('first');await exercise(undefined);
  await exercise(undefined,true);await exercise('next',true);await exercise('other-chat-draft',true,true);
  console.log('PASS immediate clear, rapid typing, identical next message, double tap, failure recovery and chat isolation');
})().catch(error=>{console.error(error);process.exitCode=1});
