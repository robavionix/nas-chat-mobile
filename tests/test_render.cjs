const vm=require('vm'),fs=require('fs'),assert=require('assert');
const source=fs.readFileSync('mobile/web/render.js','utf8');
function canvas(width,height){
  let w=width,h=height,rows=Array.from({length:h},(_,i)=>i);
  return {get width(){return w},set width(value){w=value;rows=Array(h).fill(0)},get height(){return h},set height(value){h=value;rows=Array(h).fill(0)},
    get rows(){return rows},drawImage(from,sx,sy,sw,sh,dx,dy,dw,dh){
      if(arguments.length===5){dx=sx;dy=sy;dw=sw;dh=sh;sx=sy=0;sh=dh}
      const saved=from.rows?.slice();for(let i=0;i<dh;i++)rows[dy+i]=saved?saved[sy+Math.floor(i*sh/dh)]:from.value;
    }};
}
function setup(){
  const mirrorCanvas=canvas(12,24),shiftCanvas=canvas(1,1),mirror={ready:true,key:'old',rect:[0,0,12,24],version:1};
  const c={mirrorCanvas,mirrorContext:mirrorCanvas,shiftCanvas,shiftContext:shiftCanvas,mirror,
    performance:{now:()=>0},acceptLayout(){},followShift(){},renderDirty:false,decodeImage:async()=>({value:9,close(){}}),Blob,Uint8Array,Error};
  vm.runInNewContext(source.slice(source.indexOf('async function applyMessage('),source.indexOf('async function applyFrame(')),c);
  return c;
}
(async()=>{
  for(const moves of [[[3,10,18],[2,18,24]],[[-3,0,7],[-2,7,14]],[[3,10,17],[-3,0,7]]]){
    const c=setup(),original=c.mirrorCanvas.rows.slice(),expected=original.slice();
    for(const [distance,start,end] of moves)expected.splice(start,end-start,...original.slice(start-distance,end-distance));
    c.movePictureRows(moves,12);assert.deepEqual(c.mirrorCanvas.rows,expected,'overlapping scroll segments use original rows');
    assert.equal(c.shiftCanvas.width*c.shiftCanvas.height,1,'temporary desktop canvas is released');
  }
  let live=0,peak=0,decodes=0;
  const c=setup();c.decodeImage=async()=>{
    assert.equal(c.mirror.ready,false,'half a frame must not be published');
    live++;peak=Math.max(peak,live);decodes++;return {value:9,close(){live--}};
  };
  await c.applyMessage({key:'new',rect:[0,0,12,24],full:true,strips:[[0,8,1],[8,8,1],[16,8,1]]},new Uint8Array(3));
  assert.equal(decodes,3);assert.equal(peak,1);assert.equal(live,0);assert.equal(c.mirror.ready,true);
  assert.deepEqual(c.mirrorCanvas.rows,Array(24).fill(9));
  let finishMove,shifts=0;
  c.followShift=()=>{assert.equal(c.mirror.ready,true);shifts++};
  c.decodeImage=()=>new Promise(resolve=>finishMove=resolve);
  const moving=c.applyMessage({key:'new',rect:[0,0,12,24],moves:[[2,2,20]],strips:[[0,2,1]]},new Uint8Array(1));
  assert.equal(shifts,0,'local coordinates must not jump while the new rows are still decoding');
  finishMove({value:7,close(){}});await moving;assert.equal(shifts,1);
  let complete,closed=0;
  c.decodeImage=()=>new Promise(resolve=>complete=resolve);
  let valid=true;const pending=c.applyMessage({key:'later',rect:[0,0,12,24],full:true,strips:[[0,24,1]]},new Uint8Array(1),()=>valid);
  valid=false;complete({close(){closed++}});await pending;
  assert.equal(closed,1);assert.equal(c.mirror.key,'new','cancelled decodes cannot publish over a newer stream');
  const timers=new Map();let tid=0,bitmapResolve;
  const decoder={window:{createImageBitmap:true},createImageBitmap:()=>new Promise(resolve=>bitmapResolve=resolve),
    setTimeout(fn){timers.set(++tid,fn);return tid},clearTimeout(id){timers.delete(id)},Error};
  vm.runInNewContext(source.slice(source.indexOf('function decodeImage('),source.indexOf('async function mirrorLoop(')),decoder);
  const hung=decoder.decodeImage({},3000);timers.values().next().value();
  await assert.rejects(hung,/解码超时/);
  bitmapResolve({close(){closed++}});await Promise.resolve();assert.equal(closed,2,'late bitmap is disposed after timeout');
  console.log('PASS bounded Retina decode, atomic frames, scroll copy ordering, scratch release and late bitmap cleanup');
})().catch(error=>{console.error(error);process.exitCode=1});
