// Keep the old viewport until the target screenshot has been painted. Only transforms
// move during the transition; the resting canvas stays at its native pixel density.
let navigationTransition=null;
function navigationAnimationRunning(){return navigationTransition?.phase==='animating'}
function cancelNavigationTransition(token=navigationTransition,completed=false){
  if(!token||navigationTransition!==token)return;
  navigationTransition=null;
  clearTimeout(token.hintTimer);clearTimeout(token.deadline);
  for(const animation of token.animations||[])animation.cancel();
  token.cover.remove();
  token.resolve?.(completed);
  renderDirty=true;
}
function beginNavigationTransition(direction){
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
  token.hintTimer=setTimeout(()=>{
    if(navigationTransition!==token||token.phase!=='waiting')return;
    const hint=document.createElement('span');hint.textContent='正在打开…';
    Object.assign(hint.style,{position:'absolute',top:'12px',left:'50%',transform:'translateX(-50%)',padding:'7px 13px',borderRadius:'20px',background:'#ffffffed',boxShadow:'0 2px 12px #17374b18',color:'#48677a',fontSize:'13px'});
    cover.append(hint);token.hint=hint;
  },400);
  window.dispatchEvent(new Event('nas-navigation-start'));
  return token;
}
function captureNavigationPane(rect,height){
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
  if(box.conversation!==target.conversation||box.compactList!==target.list||mirror.layout?.conversation!==target.conversation||mirror.layout?.compactList!==target.list)return;
  if(token.phase==='settling'){cancelNavigationTransition(token,token.completed);return}
  if(token.phase!=='waiting')return;
  clearTimeout(token.hintTimer);clearTimeout(token.deadline);token.hint?.remove();
  if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches||!screen.animate||!token.cover.animate){cancelNavigationTransition(token,true);return}
  token.phase='animating';
  const options={duration:220,easing:'linear',fill:'both'},distance=token.direction*token.width;
  try{
    const rect=screen.getBoundingClientRect();navigationLayoutChanged();
    token.incoming=captureNavigationPane(rect,Math.max(token.height,rect.height));
    token.cover.prepend(token.incoming);
    token.animations=[
      token.outgoing.animate([{transform:'translate3d(0,0,0)'},{transform:`translate3d(${-distance}px,0,0)`}],options),
      token.incoming.animate([{transform:`translate3d(${distance}px,0,0)`},{transform:'translate3d(0,0,0)'}],options)
    ];
    Promise.all(token.animations.map(animation=>animation.finished)).then(()=>settleNavigationTransition(token),()=>{if(navigationTransition===token&&token.phase==='animating')settleNavigationTransition(token,false)});
  }catch{cancelNavigationTransition(token)}
}
window.addEventListener('resize',()=>{if(navigationTransition?.target)settleNavigationTransition(navigationTransition,false);else cancelNavigationTransition()});
window.addEventListener('pagehide',()=>cancelNavigationTransition());
document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelNavigationTransition()});
