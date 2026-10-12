(() => {
  const layer = document.querySelector('#touch-layer');
  const LONG_PRESS = 480;
  let gesture = null, pinch = null, carry = 0, inertia = 0, pressTimer = 0;
  const fingers = new Map();
  let pendingDelta=0,scrollFrame=0;
  function flushLocal(){cancelAnimationFrame(scrollFrame);scrollFrame=0;const delta=pendingDelta;pendingDelta=0;if(delta&&!busy&&!navigating){try{wheel(delta)}catch(err){stop();message(err.message,true)}}}
  function queueLocal(delta){pendingDelta+=delta;if(!scrollFrame)scrollFrame=requestAnimationFrame(flushLocal)}
  function stop(reset=true) { cancelAnimationFrame(inertia); inertia = 0; if(reset) carry = 0; }
  // The touch layer only exists over the phone picture, whose crop is described by its panes.
  function position(x, y) {
    if (!box || !stage.dataset.panes) throw Error('画面尚未加载，请稍后重试');
    const r=stage.getBoundingClientRect(),p=panePosition(JSON.parse(stage.dataset.panes),x-r.left,y-r.top);
    if(!p)throw Error('请点选聊天客户端内容');
    return {x:Math.max(0,Math.min(box.screenWidth-1,p.x)),y:Math.max(0,Math.min(box.screenHeight-1,p.y))};
  }
  function visibleCenter() {
    const r=stage.getBoundingClientRect(),s=screen.getBoundingClientRect();
    const body=panes?.sections.at(-1),bodyTop=body?r.top+body.dy:r.top;
    const top=Math.max(bodyTop,s.top),bottom=Math.min(r.bottom,s.bottom);
    return position((Math.max(r.left,s.left)+Math.min(r.right,s.right))/2,top+(bottom-top)*.55);
  }
  function wheel(delta) {
    const before=screen.scrollTop, max=Math.max(0,screen.scrollHeight-screen.clientHeight);
    if(max>1) {
      screen.scrollTop=Math.max(0,Math.min(max,before+delta));
      delta-=screen.scrollTop-before;
    }
    if(stage.classList.contains('mobile-ready'))delta=scrollLocal(delta);
    if(viewOnly)return;
    carry += delta;
    const count = Math.min(8, Math.floor(Math.abs(carry)/64));
    if (!count || !box) return;
    const direction = Math.sign(carry);
    remoteScroll(direction*count, visibleCenter());
    carry -= direction*count*64;
  }
  // A fling keeps moving and slows down gradually, close to native iOS scrolling.
  function coast(velocity) {
    let v = Math.max(-4, Math.min(4, velocity)), last = performance.now(), start = last;
    function tick(now) {
      if(busy||navigating){stop();return}
      const dt = Math.min(32, now-last); last = now;
      v *= Math.pow(.95, dt/16);
      try { wheel(-v*dt); } catch(e) { message(e.message,true); return; }
      if (Math.abs(v)>.05 && now-start<1200) inertia=requestAnimationFrame(tick);
    }
    inertia=requestAnimationFrame(tick);
  }
  // Immediate feedback where the finger landed, before WeChat has answered.
  function ripple(x, y, long=false) {
    const dot=document.createElement('div');dot.className='ripple'+(long?' long':'');
    dot.style.left=x+'px';dot.style.top=y+'px';document.body.append(dot);
    setTimeout(()=>dot.remove(),700);
  }
  function distance() {
    const [a,b]=[...fingers.values()];
    return {d:Math.hypot(a.x-b.x,a.y-b.y),x:(a.x+b.x)/2,y:(a.y+b.y)/2};
  }
  function cancelPress() { clearTimeout(pressTimer); pressTimer=0; }
  function interrupt(){
    stop();cancelPress();cancelAnimationFrame(scrollFrame);cancelAnimationFrame(gesture?.backFrame);
    if(gesture?.back)cancelNavigationTransition(gesture.back);
    scrollFrame=0;pendingDelta=0;gesture=null;pinch=null;fingers.clear();
  }
  layer.addEventListener('pointerdown', e => {
    if (e.pointerType==='mouse' && e.button!==0) return;
    e.preventDefault(); stop();
    if(busy||navigating)return;
    // iOS can lose capture during a keyboard/viewport change without delivering
    // pointerup. A fresh primary touch must not become a permanent fake pinch.
    if(e.isPrimary&&fingers.size)interrupt();
    fingers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    layer.setPointerCapture(e.pointerId);
    if (fingers.size===2) {
      // A second finger turns the gesture into a pinch.
      cancelPress();if(gesture?.back){cancelAnimationFrame(gesture.backFrame);cancelNavigationTransition(gesture.back)}gesture=null;
      const p=distance(); pinch={start:p.d,zoom,x:p.x,y:p.y};
      return;
    }
    if (fingers.size>2 || busy || navigating) { gesture=null; return; }
    gesture={id:e.pointerId,x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,time:performance.now(),lastTime:performance.now(),velocity:0,moved:false,pressed:false};
    const g=gesture;
    const edge=e.clientX-screen.getBoundingClientRect().left;
    g.edge=e.pointerType==='touch'&&edge>=0&&edge<=28&&zoom<=1.01&&!viewOnly&&chatOpen()&&box.compact;
    pressTimer=setTimeout(()=>{
      if(gesture!==g||g.moved||viewOnly)return;
      g.pressed=true; navigator.vibrate?.(12); ripple(g.x,g.y,true);
      try { tapRemote(position(g.x,g.y),3); } catch(err) { message(err.message,true); }
    },LONG_PRESS);
  });
  layer.addEventListener('pointermove', e => {
    if (!fingers.has(e.pointerId)) return;
    e.preventDefault();
    fingers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if (pinch && fingers.size===2) {
      const p=distance();
      if(p.d>10&&pinch.start>10)setZoom(pinch.zoom*p.d/pinch.start,p.x,p.y);
      return;
    }
    if (!gesture || gesture.id!==e.pointerId) return;
    const now=performance.now(), dx=e.clientX-gesture.lastX, dy=e.clientY-gesture.lastY, dt=Math.max(8,now-gesture.lastTime);
    const totalX=e.clientX-gesture.x,totalY=e.clientY-gesture.y;
    if(gesture.edge&&!gesture.back&&!gesture.pressed){
      if(totalX>12&&totalX>Math.abs(totalY)*1.3){gesture.back=beginNavigationTransition(-1,true);gesture.edge=false;cancelPress();cancelAnimationFrame(scrollFrame);scrollFrame=0;pendingDelta=0;gesture.moved=true}
      else if(Math.abs(totalY)>12||totalX< -8)gesture.edge=false;
    }
    if(gesture.back){
      gesture.velocityX=.5*(gesture.velocityX||0)+.5*dx/dt;
      gesture.lastX=e.clientX;gesture.lastY=e.clientY;gesture.lastTime=now;
      gesture.backDistance=totalX;
      const g=gesture;
      if(!g.backFrame)g.backFrame=requestAnimationFrame(()=>{g.backFrame=0;if(gesture===g)updateBackSwipe(g.back,g.backDistance||0)});
      return;
    }
    if (!gesture.moved && Math.hypot(e.clientX-gesture.x,e.clientY-gesture.y)>8) { gesture.moved=true; cancelPress(); }
    if (gesture.moved && !gesture.pressed) {
      if (screen.scrollWidth>screen.clientWidth+1) screen.scrollLeft-=dx;
      try { queueLocal(-dy); } catch(err) { message(err.message,true); }
      gesture.velocity=.5*gesture.velocity+.5*(dy/dt);
    }
    gesture.lastX=e.clientX; gesture.lastY=e.clientY; gesture.lastTime=now;
  });
  function finish(e, cancelled=false) {
    fingers.delete(e.pointerId);
    if (pinch) { if(!fingers.size) pinch=null; return; }
    if (!gesture || gesture.id!==e.pointerId) return;
    const g=gesture; gesture=null; e.preventDefault(); cancelPress();flushLocal();
    if(g.back){
      cancelAnimationFrame(g.backFrame);updateBackSwipe(g.back,Math.max(0,e.clientX-g.x));
      const quick=performance.now()-g.lastTime<100&&(g.velocityX||0)>.5&&g.back.progress>40;
      if(!cancelled&&(g.back.progress>=g.back.width*.32||quick))commitBackSwipe(g.back);
      else{navigating=true;controls();cancelBackSwipe(g.back).finally(()=>{navigating=false;controls()})}
      return;
    }
    if (cancelled || g.pressed) { stop(); return; }
    if (g.moved) { if(performance.now()-g.lastTime<100) coast(g.velocity); return; }
    if (viewOnly) return;
    ripple(e.clientX,e.clientY);
    try { tapRemote(position(e.clientX,e.clientY),1); } catch(err) { message(err.message,true); }
  }
  layer.addEventListener('pointerup', e=>finish(e));
  layer.addEventListener('pointercancel', e=>finish(e,true));
  layer.addEventListener('lostpointercapture',e=>finish(e,true));
  layer.addEventListener('wheel',e=>{
    e.preventDefault();
    if(busy||navigating)return;
    if(e.ctrlKey){setZoom(zoom*Math.exp(-e.deltaY/300),e.clientX,e.clientY);return;}
    stop(false);
    try { wheel(e.deltaY*(e.deltaMode===1?20:e.deltaMode===2?screen.clientHeight:1)); } catch(err) { message(err.message,true); }
  },{passive:false});
  layer.addEventListener('contextmenu',e=>e.preventDefault());
  window.addEventListener('resize',interrupt);
  window.addEventListener('nas-navigation-start',()=>{stop();cancelAnimationFrame(scrollFrame);cancelAnimationFrame(gesture?.backFrame);scrollFrame=0;pendingDelta=0;cancelPress();gesture=null;pinch=null;fingers.clear()});
  window.addEventListener('pagehide',interrupt);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)interrupt()});
})();
