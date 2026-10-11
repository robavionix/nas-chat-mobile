const vm=require('vm'),fs=require('fs'),assert=require('assert');
const source=fs.readFileSync('mobile/web/navigation.js','utf8');
function setup(reduced=false){
  const animations=[],timers=new Map(),listeners={};let timerId=0;
  function element(){return {style:{},children:[],removed:false,
    setAttribute(){},append(child){this.children.push(child)},prepend(child){this.children.unshift(child)},remove(){this.removed=true},
    getContext(){return {scale(){},fillRect(){},drawImage(){}}},
    animate(frames,options){let finish;const animation={frames,options,cancelled:false,finished:new Promise(resolve=>finish=resolve),finish:()=>finish(),cancel(){this.cancelled=true}};animations.push(animation);return animation}}}
  const screen=element();screen.getBoundingClientRect=()=>({left:0,top:60,width:390,height:600});
  const mobileCanvas=element();mobileCanvas.width=1170;mobileCanvas.getBoundingClientRect=screen.getBoundingClientRect;
  const context={screen,mobileCanvas,devicePixelRatio:3,view:'list',box:{conversation:'1:list',compactList:true},mirror:{ready:true,version:4,layout:{conversation:'1:list',compactList:true}},paintedVersion:4,renderDirty:false,
    popupActive:()=>false,Event,Promise,
    setTimeout(fn){timers.set(++timerId,fn);return timerId},clearTimeout(id){timers.delete(id)},
    document:{hidden:false,body:element(),createElement:element,addEventListener(name,fn){listeners[name]=fn}},
    window:{matchMedia:()=>({matches:reduced}),dispatchEvent(){},addEventListener(name,fn){listeners[name]=fn}}};
  vm.runInNewContext(source,context);
  return {context,animations,timers,listeners};
}
async function exercise(reduced=false){
  const {context:c,animations}=setup(reduced);
  const token=c.beginNavigationTransition(1);assert.equal(token.outgoing.children[0].width,1170,'snapshot must retain device pixel density');
  const target={conversation:'2:chat',compactList:false};
  c.box=target;
  const finished=c.finishNavigationTransition(token,target);
  assert.equal(animations.length,0,'HTTP response must not animate the old screenshot');
  c.mirror.layout=target;c.mirror.version=5;c.renderDirty=true;c.navigationPicturePainted();
  assert.equal(animations.length,0,'decoding alone is not sufficient');
  c.paintedVersion=5;c.renderDirty=false;c.navigationPicturePainted();
  if(!reduced){
    assert.equal(animations.length,2);assert.equal(c.navigationAnimationRunning(),true);
    for(const animation of animations){assert.equal(animation.options.easing,'linear');assert.equal(animation.options.duration,220);animation.finish()}
    await Promise.resolve();await Promise.resolve();
    assert.equal(token.cover.removed,false,'keep snapshots while a resized live canvas is still blank');
    c.renderDirty=false;c.navigationPicturePainted();
  }
  assert.equal(await finished,true);assert.equal(token.cover.removed,true);assert.equal(c.navigationAnimationRunning(),false);
}
(async()=>{
  await exercise();await exercise(true);
  const {context:c,listeners,timers,animations}=setup();
  let token=c.beginNavigationTransition(-1);
  let finished=c.finishNavigationTransition(token,{conversation:'2:chat',compactList:false});
  listeners.resize();[...timers.values()].at(-1)();assert.equal(await finished,false);assert.equal(timers.size,0);
  token=c.beginNavigationTransition(1);finished=c.finishNavigationTransition(token,{conversation:'2:chat',compactList:false});
  // A missing frame must release the cover and caller, without inventing a successful animation.
  [...timers.values()].at(-1)();assert.equal(await finished,false);assert.equal(animations.length,0);
  token=c.beginNavigationTransition(1);assert.equal(await c.finishNavigationTransition(token,c.box),false);
  assert.equal(token.cover.removed,true);
  token=c.beginNavigationTransition(-1);
  c.screen.getBoundingClientRect=()=>({left:0,top:60,width:390,height:680});
  c.navigationLayoutChanged();assert.equal(token.cover.style.height,'680px','cover the taller list viewport when the composer disappears');
  c.cancelNavigationTransition();
  const render=fs.readFileSync('mobile/web/render.js','utf8');
  const paint=render.slice(render.indexOf('function paintMobile(now){'),render.lastIndexOf('requestAnimationFrame(paintMobile);'));
  let clears=0,painted=0;
  Object.assign(c,{requestAnimationFrame(){},view:'chat',box:{conversation:'new',compactList:false,popups:[]},mirror:{ready:true,version:8,layout:{conversation:'old',compactList:false,popups:[]}},
    panes:{width:390,height:600,sections:[]},renderDirty:true,visualPending:false,paintedVersion:7,
    pictureContext:{setTransform(){},fillRect(){clears++}},findContentBottom(){},drawDesktop(){},
    navigationPicturePainted(){painted++}});
  c.document.querySelector=()=>({classList:{add(){},remove(){}}});
  vm.runInNewContext(paint,c);c.paintMobile(0);
  assert.equal(clears,0,'a new layout must not clear or crop an old conversation frame');
  c.mirror.layout=c.box;c.paintMobile(1);
  assert.equal(clears,1);assert.equal(painted,1);assert.equal(c.paintedVersion,8);
  console.log('PASS painted target gating, native-density snapshot, linear slide, reduced motion, resize, timeout and no-op cleanup');
})().catch(error=>{console.error(error);process.exitCode=1});
