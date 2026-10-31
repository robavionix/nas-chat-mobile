const assert=require('assert'),fs=require('fs'),vm=require('vm');
const render=fs.readFileSync('mobile/web/render.js','utf8');
const frames=new Map();let id=0,paints=0;
const c={document:{hidden:false},view:'chat',renderDirty:false,
  requestAnimationFrame(fn){frames.set(++id,fn);return id},cancelAnimationFrame(id){frames.delete(id)},clearTimeout(){},
  paintMobile(){paints++;c.renderDirty=false}};
vm.runInNewContext(render.slice(render.indexOf('let paintRequest='),render.indexOf('// After sending')),c);
for(let i=0;i<100;i++)c.invalidateMobilePicture();
assert.equal(frames.size,1,'a burst of frames/layout/gesture changes shares one paint');
const paint=()=>{for(const [key,fn] of [...frames]){frames.delete(key);fn(1000)}};
paint();assert.equal(paints,1);assert.equal(frames.size,0,'a static page schedules no more animation callbacks');
c.invalidateMobilePicture();c.suspendMobilePainting();assert.equal(frames.size,0,'backgrounding cancels pending work');
c.document.hidden=true;c.invalidateMobilePicture();assert.equal(frames.size,0);
c.document.hidden=false;c.view='full';c.invalidateMobilePicture();assert.equal(frames.size,0,'full desktop owns its own renderer');
c.view='chat';c.invalidateMobilePicture();paint();assert.equal(paints,2,'returning to the phone view wakes the renderer');
assert.ok(!render.slice(render.indexOf('function paintMobile(')).includes('requestAnimationFrame(paintMobile)'));
const loop=render.slice(render.indexOf('async function mirrorLoop(){'),render.indexOf('// A different target'));
const STOP=Error('done');let sockets=0,waits=0;
const loopContext={document:{hidden:false},view:'chat',box:null,mirror:{mode:'websocket'},
  socketMirror:async()=>{sockets++;throw STOP},performance:{now:()=>1},
  waitForMirror:async()=>{waits++;throw STOP}};
vm.runInNewContext(loop,loopContext);
(async()=>{
  // Stop after the first connect without exercising the fallback branch.
  loopContext.socketMirror=async()=>{sockets++;loopContext.document.hidden=true};
  await assert.rejects(loopContext.mirrorLoop(),error=>error===STOP);
  assert.equal(sockets,1,'startup WS connects before the HTTP layout is ready');assert.equal(waits,1);
  const handlers={},requests=[];
  const file={name:'small.jpg',size:1048576};
  const upload={XMLHttpRequest:class{
    constructor(){handlers.request=this;this.upload={}}open(){}setRequestHeader(){}send(value){requests.push(value)}
  },Error,JSON,encodeURIComponent,location:{replace(){}}};
  const app=fs.readFileSync('mobile/web/app.js','utf8');
  vm.runInNewContext(app.slice(app.indexOf('function uploadOne('),app.indexOf("document.querySelector('#upload').onclick=")),upload);
  const result=upload.uploadOne(file,'test-id',{window:'1',conversation:'a',progress(){}});
  handlers.request.status=413;handlers.request.responseText='<html>nginx</html>';handlers.request.onload();
  await assert.rejects(result,error=>error.message.includes('1.00 MB')&&!error.message.includes('不能超过 95MB'));
  assert.equal(requests[0],file,'upload sends the original binary; no base64 expansion');
  console.log('PASS demand-driven idle painting, burst coalescing, background/full view, parallel startup and accurate small-file proxy errors');
})().catch(error=>{console.error(error);process.exitCode=1});
