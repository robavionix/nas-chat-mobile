const vm=require('vm'),fs=require('fs'),assert=require('assert');
function setup(){
  const events={},life={},frames=new Map(),taps=[];let now=1000,id=0,release;
  const box={id:'qq',conversation:'friend',client:'qq',compact:true,compactList:false,screenWidth:4200,screenHeight:6000,
    panes:{chat:{x:1000,y:120,width:1700,height:5000,header:168}}};
  const c={box,view:'chat',zoom:1,viewOnly:false,busy:false,navigating:false,
    screen:{getBoundingClientRect:()=>({left:0,top:0,width:390,height:700}),scrollWidth:390,clientWidth:390,scrollHeight:700,clientHeight:700,scrollTop:0},
    stage:{dataset:{panes:'{}'},getBoundingClientRect:()=>({left:0,top:0,right:390,bottom:700}),classList:{contains:()=>true}},
    panes:null,chatOpen:()=>true,popupActive:()=>false,controls(){},panePosition:(_panes,x,y)=>({x:1000+x*3,y:120+y*3}),
    scrollLocal:delta=>delta,remoteScroll(){},setZoom(){},message(){},debugLog(){},beginNavigationTransition:()=>null,cancelNavigationTransition(){},
    tapRemote(point,button,count=1){if(c.busy||c.navigating)return;taps.push({point,button,count});if(taps.length===1){c.navigating=true;return new Promise(resolve=>release=()=>{c.navigating=false;resolve()})}},
    performance:{now:()=>now},setTimeout:()=>1,clearTimeout(){},requestAnimationFrame(fn){frames.set(++id,fn);return id},cancelAnimationFrame(id){frames.delete(id)},
    navigator:{},document:{addEventListener(name,fn){life[name]=fn},querySelector:()=>({addEventListener(name,fn){events[name]=fn},setPointerCapture(){}}),createElement:()=>({style:{},remove(){}}),body:{append(){}}},
    window:{addEventListener(name,fn){life[name]=fn}},Map,Promise};
  vm.runInNewContext(fs.readFileSync('mobile/web/touch.js','utf8'),c);
  function event(name,values={}){events[name]?.({type:name,isPrimary:true,pointerId:1,pointerType:'touch',clientX:200,clientY:300,preventDefault(){},...values})}
  function advance(ms){now+=ms}
  function tap(x=200,y=300){for(const name of ['pointerdown','pointerup']){advance(20);event(name,{clientX:x,clientY:y})}}
  return {c,taps,tap,life,event,advance,release:()=>release()};
}
(async()=>{
  let s=setup();s.tap();assert.equal(s.taps.length,1,'first tap stays immediate');s.tap();assert.equal(s.taps.length,1,'second tap waits for the outstanding request');
  s.release();await Promise.resolve();await Promise.resolve();assert.equal(s.taps.length,2);assert.equal(s.taps[1].count,2);
  s=setup();s.tap();s.advance(330);s.event('pointerdown');s.advance(110);s.event('pointerup');
  s.release();await Promise.resolve();assert.equal(s.taps.length,2,'recognize the second touch when it starts, even if release crosses the double-tap deadline');assert.equal(s.taps[1].count,2);
  s=setup();s.tap();s.advance(40);s.event('pointerdown');s.event('lostpointercapture');
  s.event('touchend',{touches:[],changedTouches:[{clientX:200,clientY:300}]});
  s.release();await Promise.resolve();assert.equal(s.taps.length,2,'a real touch end completes a QQ tap when capture is lost before pointerup');
  s=setup();s.event('pointerdown');s.event('touchend',{touches:[],changedTouches:[{clientX:200,clientY:300}]});s.event('pointerup');s.event('lostpointercapture');
  assert.equal(s.taps.length,1,'touchend and pointerup cannot dispatch duplicate native clicks');
  s=setup();s.tap();s.event('touchend',{touches:[],changedTouches:[{clientX:200,clientY:300}]});s.event('lostpointercapture');
  assert.equal(s.taps.length,1,'pointerup before touchend also dispatches exactly once');
  s=setup();s.tap();s.event('pointerdown');s.event('pointercancel');s.event('touchend',{touches:[],changedTouches:[{clientX:200,clientY:300}]});
  s.release();await Promise.resolve();assert.equal(s.taps.length,1,'a genuine pointer cancellation still cancels preview');
  s=setup();s.tap();s.event('pointerdown');s.event('pointermove',{clientX:220});s.event('lostpointercapture');s.event('touchend',{touches:[],changedTouches:[{clientX:220,clientY:300}]});
  s.release();await Promise.resolve();assert.equal(s.taps.length,1,'a drag is never promoted to a double-click');
  s=setup();s.tap();s.event('pointerdown');s.event('lostpointercapture');s.event('touchcancel');
  s.release();await Promise.resolve();assert.equal(s.taps.length,1,'touch cancellation cancels an orphaned QQ pointer');
  s=setup();s.tap();s.event('pointerdown');s.event('lostpointercapture');s.c.box={...s.c.box,conversation:'different'};s.event('touchend',{touches:[],changedTouches:[{clientX:200,clientY:300}]});
  s.release();await Promise.resolve();assert.equal(s.taps.length,1,'touch fallback cannot click a changed conversation');
  s=setup();s.tap();s.tap();s.life['nas-navigation-start']();s.release();await Promise.resolve();assert.equal(s.taps.length,1,'starting navigation cancels already queued double taps');
  s=setup();s.tap();s.tap();s.event('wheel',{deltaY:20});s.release();await Promise.resolve();assert.equal(s.taps.length,1,'wheel scrolling cancels already queued double taps');
  s=setup();s.tap();s.advance(401);s.tap();s.release();await Promise.resolve();assert.equal(s.taps.length,1,'two separate taps stay separate while a request is in flight');
  s=setup();s.tap();s.tap();s.c.box={...s.c.box,conversation:'different'};s.release();await Promise.resolve();assert.equal(s.taps.length,1,'a queued preview cannot operate in a different chat');
  s=setup();s.tap();s.tap();s.life.pagehide();s.release();await Promise.resolve();assert.equal(s.taps.length,1,'backgrounding cancels a queued preview');
  s=setup();s.tap();s.tap(280,300);s.release();await Promise.resolve();assert.equal(s.taps.length,1,'distant taps are not an image double-click');
  s=setup();s.c.box={...s.c.box,compactList:true};s.tap();s.tap();s.release();await Promise.resolve();assert.equal(s.taps.length,1,'conversation list keeps its double-click guard');
  s=setup();s.c.box={...s.c.box,client:'wechat'};s.tap();s.tap();s.release();await Promise.resolve();assert.equal(s.taps.length,1,'WeChat gestures stay unchanged');
  console.log('PASS QQ double-tap press timing, lost capture/finger release, event deduplication, queue, scroll/cancel/navigation guards and client isolation');
})().catch(error=>{console.error(error);process.exitCode=1});
