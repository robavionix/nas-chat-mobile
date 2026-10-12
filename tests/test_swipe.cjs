const vm=require('vm'),fs=require('fs'),assert=require('assert');
function setup(){
  const events={},lifecycle={},frames=new Map();let frameId=0,now=0,taps=0,scrolls=0,commits=0,cancels=0,token=null;
  const c={box:{compact:true,screenWidth:760,screenHeight:2800},zoom:1,viewOnly:false,busy:false,navigating:false,
    screen:{getBoundingClientRect:()=>({left:0,top:0,width:390,height:600}),scrollWidth:390,clientWidth:390,scrollHeight:600,clientHeight:600,scrollTop:0},
    stage:{dataset:{panes:'{}'},getBoundingClientRect:()=>({left:0,top:0,right:390,bottom:600}),classList:{contains:()=>true}},
    panes:null,chatOpen:()=>true,controls(){},scrollLocal(delta){scrolls++;return 0},panePosition:()=>({x:0,y:0}),remoteScroll(){},setZoom(){},message(){},tapRemote(){taps++},
    beginNavigationTransition(){return token={phase:'dragging',width:390,progress:0}},updateBackSwipe(t,distance){if(t)t.progress=Math.max(0,Math.min(t.width,distance))},
    commitBackSwipe(){commits++},cancelBackSwipe(){cancels++;return Promise.resolve()},cancelNavigationTransition(){cancels++},
    performance:{now:()=>now},setTimeout:()=>1,clearTimeout(){},requestAnimationFrame(fn){frames.set(++frameId,fn);return frameId},cancelAnimationFrame(id){frames.delete(id)},
    navigator:{},document:{addEventListener(name,fn){lifecycle[name]=fn},querySelector:()=>({addEventListener(name,fn){events[name]=fn},setPointerCapture(){}}),createElement:()=>({style:{},remove(){}}),body:{append(){}}},
    window:{addEventListener(name,fn){lifecycle[name]=fn}},Map};
  vm.runInNewContext(fs.readFileSync('mobile/web/touch.js','utf8'),c);
  function fire(name,x,y=200,id=1){now+=20;events[name]({isPrimary:id===1,pointerId:id,pointerType:'touch',clientX:x,clientY:y,preventDefault(){}});for(const [key,fn] of [...frames]){frames.delete(key);fn(now)}}
  return {c,fire,lifecycle,get result(){return {taps,scrolls,commits,cancels,token}}};
}
(async()=>{
  let s=setup();s.fire('pointerdown',8);s.fire('pointermove',155);s.fire('pointerup',160);assert.equal(s.result.commits,1);assert.equal(s.result.taps,0);assert.equal(s.result.scrolls,0);
  s=setup();s.fire('pointerdown',8);s.fire('pointermove',30);s.fire('pointerup',30);await Promise.resolve();assert.equal(s.result.cancels,1);assert.equal(s.result.commits,0);assert.equal(s.result.taps,0);
  s=setup();s.fire('pointerdown',8);s.fire('pointermove',155);s.fire('pointercancel',155);assert.equal(s.result.commits,0);assert.equal(s.result.cancels,1);
  s=setup();s.fire('pointerdown',100);s.fire('pointermove',250);s.fire('pointerup',250);assert.equal(s.result.token,null,'horizontal drag away from the edge must not go back');
  s=setup();s.fire('pointerdown',8);s.fire('pointermove',10,260);s.fire('pointerup',10,260);assert.equal(s.result.token,null);assert.ok(s.result.scrolls>0,'vertical gestures still scroll');
  s=setup();s.fire('pointerdown',8);s.fire('pointermove',55);s.fire('pointerdown',100,200,2);s.fire('pointerup',55);s.fire('pointerup',100,200,2);assert.equal(s.result.commits,0);assert.equal(s.result.cancels,1,'a second finger cancels back before pinch');
  s=setup();s.c.zoom=2;s.fire('pointerdown',8);s.fire('pointermove',180);s.fire('pointerup',180);assert.equal(s.result.commits,0,'zoomed canvas retains pan gestures');
  s=setup();s.fire('pointerdown',100);s.fire('lostpointercapture',100);s.fire('pointerdown',100);s.fire('pointermove',100,300);s.fire('pointerup',100,300);assert.ok(s.result.scrolls>0,'scroll survives lost iOS capture');
  s=setup();s.fire('pointerdown',100,200,3);s.fire('pointerdown',100);s.fire('pointermove',100,300);s.fire('pointerup',100,300);assert.ok(s.result.scrolls>0,'fresh primary touch clears a stale finger');
  s=setup();s.fire('pointerdown',100);s.lifecycle.resize();s.fire('pointerdown',100);s.fire('pointermove',100,300);s.fire('pointerup',100,300);assert.ok(s.result.scrolls>0,'keyboard resize cannot leave a fake pinch');
  console.log('PASS edge commit, cancel, interrupted touch, off-edge drag, vertical scroll, pinch and zoom');
})().catch(error=>{console.error(error);process.exitCode=1});
