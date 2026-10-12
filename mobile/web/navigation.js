// Keep the old viewport until the target screenshot has been painted. Only transforms
// move during the transition; the resting canvas stays at its native pixel density.
let navigationTransition=null,listNavigationSnapshot=null;
function releaseNavigationPane(pane){const canvas=pane?.children[0];if(canvas&&typeof canvas.width==='number'){canvas.width=1;canvas.height=1}}
function navigationAnimationRunning(){return ['animating','dragging','cancelling'].includes(navigationTransition?.phase)}
function cancelNavigationTransition(token=navigationTransition,completed=false){
  if(!token||navigationTransition!==token)return;
  navigationTransition=null;
  clearTimeout(token.hintTimer);clearTimeout(token.deadline);
  for(const animation of token.animations||[])animation.cancel();
  token.preview?.remove();
  token.cover.remove();
  releaseNavigationPane(token.outgoing);releaseNavigationPane(token.incoming);
  if(token.preview!==listNavigationSnapshot)releaseNavigationPane(token.preview);
  if(token.optimistic){document.body.classList.remove('swipe-return-pending');if(typeof fit==='function')fit()}
  token.resolve?.(completed);
  renderDirty=true;
}
function beginNavigationTransition(direction,interactive=false){
  cancelNavigationTransition();
  if(!mirror.ready||view==='full'||popupActive()||document.hidden||!mobileCanvas.width)return null;
  const rect=screen.getBoundingClientRect();
  if(rect.width<1||rect.height<1)return null;
  const cover=document.createElement('div');
  cover.id='navigation-cover';cover.setAttribute('aria-hidden','true');
  Object.assign(cover.style,{position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',overflow:'hidden',pointerEvents:'none',zIndex:'6',contain:'paint'});
  let outgoing;try{outgoing=captureNavigationPane(rect,rect.height)}catch{return null}
  cover.append(outgoing);document.body.append(cover);
  const token={cover,outgoing,direction,width:rect.width,height:rect.height,before:box.conversation,list:box.compactList,phase:'waiting',animations:[]};
  navigationTransition=token;
  if(direction===1&&box.compactList){releaseNavigationPane(listNavigationSnapshot);try{listNavigationSnapshot=copyNavigationPane(outgoing,rect.width,rect.height)}catch{listNavigationSnapshot=null}}
  if(interactive){
    token.phase='dragging';token.progress=0;
    // Reuse the cached list at its original size; copying or scaling here can hitch
    // the first drag frame and distort rows when the composer changes the height.
    if(listNavigationSnapshot){token.preview=listNavigationSnapshot;cover.prepend(token.preview)}
    outgoing.style.boxShadow='-8px 0 24px #17374b18';
    updateBackSwipe(token,0);return token;
  }
  token.hintTimer=setTimeout(()=>{
    if(navigationTransition!==token||token.phase!=='waiting')return;
    const hint=document.createElement('span');hint.textContent='正在打开…';
    Object.assign(hint.style,{position:'absolute',top:'12px',left:'50%',transform:'translateX(-50%)',padding:'7px 13px',borderRadius:'20px',background:'#ffffffed',boxShadow:'0 2px 12px #17374b18',color:'#48677a',fontSize:'13px'});
    cover.append(hint);token.hint=hint;
  },400);
  window.dispatchEvent(new Event('nas-navigation-start'));
  return token;
}
function copyNavigationPane(source,width,height){
  const pane=document.createElement('div'),canvas=document.createElement('canvas'),original=source.children[0];
  Object.assign(pane.style,{position:'absolute',inset:'0',background:'#fafafa',willChange:'transform'});
  canvas.width=original.width;canvas.height=original.height;
  canvas.style.width=width+'px';canvas.style.height=height+'px';
  canvas.getContext('2d',{alpha:false}).drawImage(original,0,0);pane.append(canvas);return pane;
}
function updateBackSwipe(token,distance){
  if(navigationTransition!==token||token.phase!=='dragging')return;
  token.progress=Math.max(0,Math.min(token.width,distance));
  token.outgoing.style.transform=`translate3d(${token.progress}px,0,0)`;
  if(token.preview)token.preview.style.transform=`translate3d(${(-token.width+token.progress)*.28}px,0,0)`;
}
async function cancelBackSwipe(token){
  if(navigationTransition!==token)return;
  token.phase='cancelling';
  try{
    if(token.outgoing.animate&&!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches){
      const options={duration:160,easing:'cubic-bezier(.2,.8,.2,1)',fill:'both'};
      token.animations=[token.outgoing.animate([{transform:`translate3d(${token.progress}px,0,0)`},{transform:'translate3d(0,0,0)'}],options)];
      if(token.preview)token.animations.push(token.preview.animate([{transform:`translate3d(${(-token.width+token.progress)*.28}px,0,0)`},{transform:`translate3d(${-token.width*.28}px,0,0)`}],options));
      await Promise.all(token.animations.map(animation=>animation.finished));
    }
  }catch{}finally{cancelNavigationTransition(token)}
}
function commitBackSwipe(token){
  if(navigationTransition!==token)return;
  token.optimistic=true;token.phase='animating';
  document.body.classList.add('swipe-return-pending');navigationLayoutChanged();
  if(!token.preview){
    token.preview=document.createElement('div');token.preview.textContent='正在载入会话…';
    Object.assign(token.preview.style,{position:'absolute',inset:'0',background:'#fafafa',display:'grid',placeItems:'center',color:'#8194a3',fontSize:'14px'});
    token.cover.prepend(token.preview);
  }
  const settled=()=>{
    if(navigationTransition!==token)return;
    token.outgoing.hidden=true;token.preview.style.transform='none';
    for(const animation of token.animations)animation.cancel();
    token.phase='waiting-frame';renderDirty=true;
  };
  try{
    if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches||!token.outgoing.animate)settled();
    else{
      const options={duration:Math.max(90,180*(1-token.progress/token.width)),easing:'linear',fill:'both'};
      token.animations=[
        token.outgoing.animate([{transform:`translate3d(${token.progress}px,0,0)`},{transform:`translate3d(${token.width}px,0,0)`}],options),
        token.preview.animate([{transform:`translate3d(${(-token.width+token.progress)*.28}px,0,0)`},{transform:'translate3d(0,0,0)'}],options)
      ];
      Promise.all(token.animations.map(animation=>animation.finished)).then(settled,settled);
    }
  }catch{settled()}
  // Complete the local motion immediately. Keep the cached list until the real
  // target frame is painted; network latency must not interrupt the release.
  return setView('list',token);
}
function captureNavigationPane(rect,height){
  if(typeof materializeMobilePicture==='function')materializeMobilePicture();
  const pane=document.createElement('div'),snapshot=document.createElement('canvas'),picture=mobileCanvas.getBoundingClientRect();
  Object.assign(pane.style,{position:'absolute',inset:'0',background:'#fafafa',willChange:'transform'});
  const dpr=Math.min(3,devicePixelRatio||1);
  snapshot.width=Math.round(rect.width*dpr);snapshot.height=Math.round(height*dpr);
  snapshot.style.width=rect.width+'px';snapshot.style.height=height+'px';
  const context=snapshot.getContext('2d',{alpha:false});
  context.scale(dpr,dpr);context.fillStyle='#fafafa';context.fillRect(0,0,rect.width,height);
  context.drawImage(mobileCanvas,picture.left-rect.left,picture.top-rect.top,picture.width,picture.height);
  pane.append(snapshot);return pane;
}
function navigationLayoutChanged(){
  const token=navigationTransition;if(!token)return;
  const rect=screen.getBoundingClientRect();
  // Returning hides the composer and makes the viewport taller. Cover that new area too.
  token.cover.style.height=Math.max(token.height,rect.height)+'px';
}
function settleNavigationTransition(token,completed=true){
  if(navigationTransition!==token)return;
  token.phase='settling';token.completed=completed;
  if(token.incoming){token.outgoing.hidden=true;token.incoming.style.transform='none'}
  for(const animation of token.animations)animation.cancel();
  renderDirty=true;
  // Keep the snapshot until the live canvas has repainted at its final viewport size.
  clearTimeout(token.deadline);token.deadline=setTimeout(()=>cancelNavigationTransition(token,completed),250);
}
function finishNavigationTransition(token,target){
  if(!token||navigationTransition!==token)return Promise.resolve(false);
  if(!target||target.popups?.length||(target.conversation===token.before&&target.compactList===token.list)){
    cancelNavigationTransition(token);return Promise.resolve(false);
  }
  token.target={conversation:target.conversation,list:target.compactList};
  token.deadline=setTimeout(()=>cancelNavigationTransition(token),2500);
  return new Promise(resolve=>{token.resolve=resolve;navigationPicturePainted()});
}
function navigationPicturePainted(){
  const token=navigationTransition,target=token?.target;
  if(!target||!mirror.ready||paintedVersion!==mirror.version||renderDirty)return;
  if(!pictureLayoutMatches())return;
  if(box.conversation!==target.conversation||box.compactList!==target.list||mirror.layout?.conversation!==target.conversation||mirror.layout?.compactList!==target.list)return;
  if(token.optimistic){if(token.phase==='waiting-frame')cancelNavigationTransition(token,true);return}
  if(token.phase==='settling'){cancelNavigationTransition(token,token.completed);return}
  if(token.phase!=='waiting')return;
  clearTimeout(token.hintTimer);clearTimeout(token.deadline);token.hint?.remove();
  if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches||!screen.animate||!token.cover.animate){cancelNavigationTransition(token,true);return}
  token.phase='animating';
  const progress=token.progress||0;
  const options={duration:Math.max(100,220*(1-progress/token.width)),easing:'linear',fill:'both'},distance=token.direction*token.width;
  try{
    const rect=screen.getBoundingClientRect();navigationLayoutChanged();
    token.incoming=captureNavigationPane(rect,Math.max(token.height,rect.height));
    token.preview?.remove();
    token.cover.prepend(token.incoming);
    token.animations=[
      token.outgoing.animate([{transform:`translate3d(${progress}px,0,0)`},{transform:`translate3d(${-distance}px,0,0)`}],options),
      token.incoming.animate([{transform:`translate3d(${progress?(distance+progress)*.28:distance}px,0,0)`},{transform:'translate3d(0,0,0)'}],options)
    ];
    Promise.all(token.animations.map(animation=>animation.finished)).then(()=>settleNavigationTransition(token),()=>{if(navigationTransition===token&&token.phase==='animating')settleNavigationTransition(token,false)});
  }catch{cancelNavigationTransition(token)}
}
window.addEventListener('resize',()=>{
  const old=listNavigationSnapshot;listNavigationSnapshot=null;
  const token=navigationTransition,rect=screen.getBoundingClientRect();
  if(token?.optimistic&&Math.abs(rect.width-token.width)<1){token.cover.style.top=rect.top+'px';navigationLayoutChanged();return}
  if(token?.target)settleNavigationTransition(token,false);else cancelNavigationTransition();
  if(old!==token?.preview)releaseNavigationPane(old);
});
window.addEventListener('pagehide',()=>{const old=listNavigationSnapshot;listNavigationSnapshot=null;cancelNavigationTransition();releaseNavigationPane(old)});
document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelNavigationTransition()});
