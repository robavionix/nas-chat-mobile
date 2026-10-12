const vm=require('vm'),fs=require('fs'),assert=require('assert');
const source=fs.readFileSync('mobile/web/navigation.js','utf8');
function setup(reduced=false){
  const animations=[],timers=new Map(),listeners={};let timerId=0;
  function element(){return {style:{},children:[],removed:false,classList:{add(){},remove(){}},
    setAttribute(){},append(child){this.children.push(child)},prepend(child){this.children.unshift(child)},remove(){this.removed=true},
    getContext(){return {scale(){},fillRect(){},drawImage(){}}},
    animate(frames,options){let finish;const animation={frames,options,cancelled:false,finished:new Promise(resolve=>finish=resolve),finish:()=>finish(),cancel(){this.cancelled=true}};animations.push(animation);return animation}}}
  const screen=element();screen.getBoundingClientRect=()=>({left:0,top:60,width:390,height:600});
  const mobileCanvas=element();mobileCanvas.width=1170;mobileCanvas.getBoundingClientRect=screen.getBoundingClientRect;
  const context={screen,mobileCanvas,devicePixelRatio:3,view:'list',box:{conversation:'1:list',compactList:true},mirror:{ready:true,version:4,layout:{conversation:'1:list',compactList:true}},paintedVersion:4,renderDirty:false,
    popupActive:()=>false,pictureLayoutMatches:()=>true,Event,Promise,
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
  assert.equal(token.outgoing.children[0].width,1,'release retired Retina canvas backing stores');
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
  c.box={conversation:'list',compactList:true};c.view='list';
  token=c.beginNavigationTransition(1);c.cancelNavigationTransition();
  c.box={conversation:'chat',compactList:false};c.view='chat';
  token=c.beginNavigationTransition(-1,true);c.updateBackSwipe(token,140);
  assert.equal(token.phase,'dragging');assert.equal(c.navigationAnimationRunning(),true);
  assert.ok(token.preview,'use a local snapshot of the previous list while following the finger');
  assert.equal(token.outgoing.style.transform,'translate3d(140px,0,0)');
  token.phase='waiting';const list={conversation:'list',compactList:true};c.box=list;c.mirror.layout=list;c.renderDirty=false;
  finished=c.finishNavigationTransition(token,list);
  assert.equal(animations.at(-2).frames[0].transform,'translate3d(140px,0,0)','resume the release animation at the finger position');
  for(const animation of animations)animation.finish();await Promise.resolve();await Promise.resolve();c.renderDirty=false;c.navigationPicturePainted();
  assert.equal(await finished,true);
  c.box={conversation:'chat',compactList:false};c.mirror.layout=c.box;c.view='chat';
  token=c.beginNavigationTransition(-1,true);c.updateBackSwipe(token,120);
  let requested=false;c.setView=()=>{requested=true;return Promise.resolve()};
  const countBefore=animations.length;c.commitBackSwipe(token);
  assert.equal(requested,true);assert.equal(animations.length,countBefore+2,'release animation must start before the remote view response');
  for(const animation of animations.slice(countBefore))animation.finish();await Promise.resolve();await Promise.resolve();
  assert.equal(token.phase,'waiting-frame');assert.equal(token.cover.removed,false,'show the cached list while the remote frame is in flight');
  c.box=list;c.mirror.layout=list;c.renderDirty=false;finished=c.finishNavigationTransition(token,list);
  assert.equal(await finished,true);assert.equal(animations.length,countBefore+2,'a late frame must not start a second slide');
  const render=fs.readFileSync('mobile/web/render.js','utf8');
  const paint=render.slice(render.indexOf('function pictureLayoutMatches(){'),render.lastIndexOf('requestAnimationFrame(paintMobile);'));
  let clears=0,painted=0;
  Object.assign(c,{requestAnimationFrame(){},view:'chat',box:{conversation:'new',compactList:false,popups:[]},mirror:{ready:true,version:8,layout:{conversation:'old',compactList:false,popups:[]}},
    panes:{width:390,height:600,sections:[]},scrollCache:null,scrollClip:null,renderDirty:true,visualPending:false,paintedVersion:7,
    pictureContext:{setTransform(){},fillRect(){clears++}},findContentBottom(){},drawDesktop(){},
    navigationPicturePainted(){painted++}});
  c.document.querySelector=()=>({classList:{add(){},remove(){}}});
  vm.runInNewContext(paint,c);c.paintMobile(0);
  assert.equal(clears,0,'a new layout must not clear or crop an old conversation frame');
  c.mirror.layout=c.box;c.paintMobile(1);
  assert.equal(clears,1);assert.equal(painted,1);assert.equal(c.paintedVersion,8);
  const region={x:1135,y:120,width:2502,height:5187};
  c.box={...c.box,client:'qq',chatReady:true,panes:{chat:region}};
  c.mobilePaneRegion=()=>region;c.renderDirty=true;
  c.mirror.layout={...c.box,panes:{chat:{...region,width:3053}}};c.mirror.rect=[1135,120,3053,5187];
  c.paintMobile(2);assert.equal(clears,1,'same conversation with a stale private/group crop cannot paint');
  c.mirror.layout=c.box;c.paintMobile(3);assert.equal(clears,1,'matching metadata alone cannot validate stale captured pixels');
  c.mirror.rect=[1135,120,2502,5187];c.paintMobile(4);assert.equal(clears,2);
  c.box={client:'qq',chatReady:false,compactList:false,conversation:null,popups:[]};c.mirror.layout=c.box;c.renderDirty=true;
  c.paintMobile(5);assert.equal(clears,3,'QQ login/startup window must still paint without phone panes');
  console.log('PASS painted target gating, native-density snapshot, linear slide, reduced motion, resize, timeout and no-op cleanup');
})().catch(error=>{console.error(error);process.exitCode=1});
