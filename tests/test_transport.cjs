const vm=require('vm'),fs=require('fs'),assert=require('assert');
const source=fs.readFileSync('mobile/web/render.js','utf8');
const code=source.slice(source.indexOf('async function socketMirror()'),source.indexOf("document.addEventListener('visibilitychange'"));
let socket,draws=0,appliedResolve,frames=[];
class FakeSocket{
  constructor(url){this.url=url;this.readyState=1;socket=this;this.sent=[]}
  close(){this.readyState=3}
  send(value){this.sent.push(value)}
}
const mirror={epoch:0,frames:0,bytes:0};
const context={frameQuality:()=>'clear',mirror,WebSocket:FakeSocket,location:{protocol:'https:',host:'test.invalid'},document:{hidden:false},view:'chat',
  performance,ArrayBuffer,DataView,Uint8Array,TextDecoder,Number,JSON,Error,
  setInterval,clearInterval,controls:()=>{},releaseScrollCache:()=>{},transportStatus:()=>{},requestAnimationFrame:callback=>setTimeout(callback,0),
  applyMessage:()=>new Promise(resolve=>{draws++;appliedResolve=resolve})};
vm.runInNewContext(code,context);
function message(seq){const h=Buffer.from(JSON.stringify({seq,key:'test',strips:[]})),out=Buffer.alloc(8+h.length);out.writeUInt32BE(h.length);h.copy(out,8);return out.buffer.slice(out.byteOffset,out.byteOffset+out.byteLength)}
(async()=>{
  const run=context.socketMirror();assert.equal(socket.url,'wss://test.invalid/mobile-api/ws?quality=clear&pipeline=2');
  const consuming=socket.onmessage({data:message(1)});
  assert.equal(draws,1);assert.deepEqual(socket.sent,[],'must not ACK before decode');
  appliedResolve();await consuming;assert.deepEqual(socket.sent,['ack 1']);
  context.stopMirror();socket.onclose();await run;assert.equal(mirror.epoch,1);
  const failed=context.socketMirror();socket.onerror();await assert.rejects(failed,/不可用/);
  const stale=context.socketMirror();context.stopMirror();await socket.onmessage({data:message(2)});await stale;
  assert.equal(draws,1,'stale socket must not draw');
  // With a second picture in flight, pictures are drawn and acknowledged strictly in arrival order.
  const order=[];context.applyMessage=header=>new Promise(resolve=>{order.push(header.seq);setTimeout(resolve,header.seq===3?5:0)});
  const piped=context.socketMirror();await new Promise(r=>setTimeout(r,0));
  const first=socket.onmessage({data:message(3)}),second=socket.onmessage({data:message(4)});
  await first;await second;
  assert.deepEqual(order,[3,4]);assert.deepEqual(socket.sent.filter(v=>v.startsWith('ack')),['ack 3','ack 4']);
  context.stopMirror();socket.onclose();await piped;
  console.log('PASS WSS endpoint, ACK after draw, close lifecycle, transport error, stale generation, ordered pipelining');
})().catch(error=>{console.error(error);process.exitCode=1});
