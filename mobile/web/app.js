const frame=document.querySelector('#desktop'),screen=document.querySelector('#screen'),stage=document.querySelector('#stage'),draft=document.querySelector('#draft'),send=document.querySelector('#send'),status=document.querySelector('#status');
const attach=document.querySelector('#attach'),picker=document.querySelector('#picker'),menu=document.querySelector('#menu');
const viewOnly=new URLSearchParams(location.search).get('observe')==='1';
const chatDrafts=new Map(),fittedPopups=new Set();
const sendRecoveries=new Map();
function sendDraftKey(value=box){return value?String(value.id??value.window)+':'+value.conversation:''}
function renderSendRecovery(){
  const panel=document.querySelector('#send-recovery');if(!panel)return;
  panel.hidden=!sendRecoveries.has(sendDraftKey());
}
let view='chat',box=null,busy=false,navigating=false,visualPending=false,composing=false,zoom=1,updating=false,pendingResize=false,pendingSend=null,pendingUpload=null,adaptTimer=null,messageTimer=null,offlineShown=false,preparedWindow=false,transientError=false,baselineHeight=window.visualViewport?.height||innerHeight;
// Temporary diagnostics: touch positions and results, never message text.
const debugQueue=[];let debugTimer=0;
const debugEnabled=(()=>{try{return localStorage.getItem('wechatDebug')==='1'}catch{return false}})();
function debugLog(event,data={}){if(viewOnly||!debugEnabled)return;debugQueue.push({t:Math.round(performance.now()),event,...data});if(debugQueue.length>80)debugQueue.shift();clearTimeout(debugTimer);debugTimer=setTimeout(flushDebug,1500)}
function flushDebug(){
  if(!debugQueue.length)return;
  fetch('/mobile-api/debug',{method:'POST',headers:{'Content-Type':'application/json','X-Mobile-Control':'1'},body:JSON.stringify({events:debugQueue.splice(0,25)}),keepalive:true,cache:'no-store'}).catch(()=>{});
  if(debugQueue.length)debugTimer=setTimeout(flushDebug,300);
}
// The phone picture comes from the server; the remote desktop stream is only used for the full view.
function connected(){
  if(view==='full'){try{return frame.contentWindow?.selkiesTransport?.readyState===1}catch{return false}}
  return typeof mirror!=='undefined'&&performance.now()-mirror.alive<15000;
}
function message(text,error=false){
  clearTimeout(messageTimer);status.textContent=text;status.classList.toggle('visible',!!text);status.style.color=error?'#b44739':'#48677a';
  if(text&&!error)messageTimer=setTimeout(()=>{status.textContent='';status.classList.remove('visible');scheduleAdapt()},5000);
}
function popupActive(){return view!=='full'&&!!box?.popups?.length}
function activePopup(){return popupActive()?box.popups[0]:null}
function chatOpen(){return !!box?.chatReady&&!box.compactList&&!popupActive()}
function controls(){
  const blocked=viewOnly||busy||navigating||visualPending||!connected()||!chatOpen()||sendRecoveries.has(sendDraftKey());
  send.disabled=blocked||composing||!draft.value.trim();send.textContent=busy?'发送中':'发送';attach.disabled=blocked;
  renderSendRecovery();
}
async function call(path,data){
  let response;
  try{response=await fetch('/mobile-api/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-Mobile-Control':'1'},body:data===undefined?undefined:JSON.stringify(data),cache:'no-store',signal:AbortSignal.timeout(path==='send'?20000:9000)})}
  catch{const error=Error('连接暂时中断，请稍后重试；输入内容已保留');error.transient=true;throw error}
  if(response.status===401){location.replace('/mobile/login');throw Error('请重新登录')}
  let result;try{result=await response.json()}catch{const error=Error('连接暂时繁忙，请稍后再试');error.transient=true;throw error}
  if(!response.ok){const error=Error(result.error||'操作暂时失败');error.layout=result.layout;throw error}return result;
}
function sameLayout(a,b){
  return a&&b&&a.conversation===b.conversation&&a.compactList===b.compactList&&a.chatReady===b.chatReady&&a.x===b.x&&a.y===b.y&&a.width===b.width&&a.height===b.height
    &&JSON.stringify(a.popups)===JSON.stringify(b.popups)&&JSON.stringify(a.windows)===JSON.stringify(b.windows);
}
function acceptLayout(next){
  if(sameLayout(box,next))return;
  if(box?.conversation!==next.conversation){
    const oldChat=box&&!box.compactList?box.conversation?.split(':').slice(1).join(':'):null;
    const newChat=!next.compactList?next.conversation?.split(':').slice(1).join(':'):null;
    if(oldChat)chatDrafts.set(oldChat,draft.value);
    if(oldChat!==newChat){draft.value=newChat?(chatDrafts.get(newChat)||''):'';draft.style.height='auto'}
    pendingSend=null;pendingUpload=null;scrollPending=0;resetMessagePicture();
  }
  const before=activePopup()?.id;
  box=next;
  if(activePopup()?.id!==before){zoom=1;screen.scrollTop=0;screen.scrollLeft=0;document.querySelector('#zoom').classList.remove('active')}
  applyView();fit();fitPopupWindow();
}
// Large WeChat windows are reshaped to the phone screen so their text stays readable.
function fitPopupWindow(){
  const popup=activePopup();
  if(!popup||viewOnly||popup.kind!=='window'||fittedPopups.has(popup.id))return;
  fittedPopups.add(popup.id);
  if(popup.width<=800&&popup.height<=box.screenHeight-60&&popup.x>=0&&popup.y>=0)return;
  call('window',{action:'fit',window:popup.id,aspect:Math.max(.5,Math.min(3,screen.clientHeight/screen.clientWidth))}).then(r=>acceptLayout(r.layout)).catch(()=>{});
}
function reconnect(note){
  resetMirror();
  if(view==='full')frame.src='/index.html?reload='+Date.now();
  if(note)message(note);update(true);
}
async function tapRemote(p,button=1){
  if(viewOnly||busy||navigating||!connected()||!box){debugLog('tap-dropped',{busy,navigating,connected:connected()});return}
  const popup=activePopup();
  const oldHeader=popup?null:pictureHeader(),before=box.conversation;
  const transition=!popup&&box.compactList&&button===1&&p.y>box.y+160?beginNavigationTransition(1):null;
  navigating=true;controls();message(button===3?'正在打开菜单…':'正在打开…');
  try{
    const data=popup?{target:'popup',window:popup.id,x:p.x,y:p.y,button}:{target:'main',window:box.id,conversation:box.conversation,x:p.x,y:p.y,button};
    if(!popup&&box.compactList&&button===1){const signature=rowSignature(p.y);if(signature)data.signature=signature}
    debugLog('tap',{x:p.x,y:p.y,button,view,list:box.compactList,conversation:box.conversation,popup:popup?.kind,signature:!!data.signature});
    const result=await call('tap',data);
    debugLog('tap-result',{list:result.layout.compactList,conversation:result.layout.conversation,navigation:result.navigation,popups:result.layout.popups.length});
    acceptLayout(result.layout);
    if(transition){
      await finishNavigationTransition(transition,result.layout);
    }else if(!popupActive()&&!popup&&(result.navigation||before!==box.conversation)&&oldHeader){
      visualPending=true;controls();
      await waitPictureChange(oldHeader,2500);
    }
    visualPending=false;message('');
    if(result.copied)showCopied(result.copied);
  }catch(e){debugLog('tap-error',{message:e.message});if(e.layout)acceptLayout(e.layout);visualPending=false;message(e.message,true)}
  finally{cancelNavigationTransition(transition);navigating=false;controls();update()}
}
let scrollPending=0,scrollBusy=false,scrollPoint=null;
// Scrolling WeChat itself goes through the server, batched so a fling does not flood it.
function remoteScroll(amount,point){
  if(viewOnly||!box)return;
  if(busy||navigating)return;
  scrollPending=Math.max(-30,Math.min(30,scrollPending+amount));scrollPoint=point;
  if(!scrollBusy)flushScroll();
}
async function flushScroll(){
  if(!scrollPending||!scrollPoint)return;
  const amount=Math.max(-30,Math.min(30,scrollPending));scrollPending-=amount;scrollBusy=true;
  try{await call('scroll',{x:scrollPoint.x,y:scrollPoint.y,amount,conversation:box.conversation,popup:activePopup()?.id||null})}catch{}
  scrollBusy=false;if(scrollPending)flushScroll();
}
function applyView(){
  if(box?.compact&&view!=='full')view=box.compactList?'list':'chat';
  const popup=activePopup();
  document.body.classList.toggle('list',view==='list'&&!popup);
  document.body.classList.toggle('popup',!!popup);
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  document.querySelector('#mode-name').textContent=popup?(popup.kind==='menu'?'菜单':popup.name||'弹出窗口'):!box?.chatReady&&view!=='full'?'微信窗口':{chat:'当前聊天',list:'会话列表',full:'微信全览'}[view];
  document.querySelector('#composer').style.display=chatOpen()&&view!=='list'?'':'none';
  if(popup){
    document.querySelector('#popup-name').textContent=popup.kind==='menu'?'点选菜单项':(popup.name||'微信窗口');
    document.querySelector('#popup-back').hidden=popup.kind==='menu';
    document.querySelector('#popup-close').textContent=popup.kind==='menu'?'取消':'关闭';
  }
  const others=document.querySelector('#others'),key=JSON.stringify((box?.windows||[]).map(w=>[w.id,w.name]));
  if(others.dataset.key!==key){
    others.dataset.key=key;others.replaceChildren();
    for(const w of box?.windows||[]){const b=document.createElement('button');b.textContent='显示窗口：'+(w.name||'微信窗口');b.onclick=()=>windowAction('raise',w.id);others.append(b)}
  }
  controls();
}
function wantedHeight(){
  return box?Math.max(640,box.screenHeight-60):2740;
}
function fit(){
  if(!box)return;
  const full=view==='full';
  stage.classList.toggle('full',full);stage.classList.toggle('mobile-ready',!full);
  if(!full){
    if(frame.getAttribute('src')!=='about:blank')frame.src='about:blank';
    fitMobilePicture();return;
  }
  // The full view shows the remote desktop itself. Its canvas is sized in device pixels,
  // so the frame is shrunk by the pixel ratio to keep that canvas at the desktop's size.
  if(frame.getAttribute('src')==='about:blank'){frame.src='/index.html?view='+Date.now();stopMirror()}
  const dpr=Math.max(1,Math.min(3,devicePixelRatio||1));
  frame.style.width=box.screenWidth/dpr+'px';frame.style.height=box.screenHeight/dpr+'px';
  let video={x:0,y:0,width:box.screenWidth/dpr,height:box.screenHeight/dpr};
  try{const doc=frame.contentDocument,v=doc.querySelector('#videoStream'),c=doc.querySelector('#videoCanvas'),r=(v?.getBoundingClientRect().width?v:c)?.getBoundingClientRect();if(r?.width>0)video=r}catch{}
  const sx=video.width/box.screenWidth,sy=video.height/box.screenHeight;
  const crop={x:video.x+box.x*sx,y:video.y+box.y*sy,w:box.width*sx,h:box.height*sy};
  if(box.chatReady){crop.y+=48*sy;crop.h-=52*sy}
  const scale=Math.min(screen.clientWidth/crop.w,screen.clientHeight/crop.h);
  stage.style.width=crop.w*scale+'px';stage.style.height=crop.h*scale+'px';stage.style.marginTop='';
  frame.style.left=-crop.x*scale+'px';frame.style.top=-crop.y*scale+'px';frame.style.transform='scale('+scale+')';
  fullWaiting();
}
// The remote desktop can take several seconds to connect the first time.
function fullWaiting(){
  if(view!=='full')return;
  const waiting=document.querySelector('#waiting');
  waiting.textContent='正在连接完整桌面…';waiting.classList.toggle('hidden',connected());
}
setInterval(fullWaiting,700);
// Zoom around a screen point, keeping the content under the fingers in place.
function setZoom(value,clientX,clientY){
  const next=Math.max(1,Math.min(3,value));if(Math.abs(next-zoom)<.005||view==='full')return;
  const s=screen.getBoundingClientRect(),r=stage.getBoundingClientRect();
  const px=clientX-s.left,py=clientY-s.top,fx=(screen.scrollLeft+px)/Math.max(1,r.width),fy=(screen.scrollTop+py)/Math.max(1,r.height);
  zoom=next;document.querySelector('#zoom').classList.toggle('active',zoom>1.01);fit();
  const after=stage.getBoundingClientRect();
  screen.scrollLeft=fx*after.width-px;if(popupActive()||!box.chatReady)screen.scrollTop=fy*after.height-py;
}
function scheduleAdapt(){clearTimeout(adaptTimer);adaptTimer=setTimeout(()=>fit(),50)}
async function update(force=false){
  if(view!=='full'&&typeof mirror!=='undefined'&&mirror.alive&&!connected()){if(!offlineShown){offlineShown=true;message('连接暂时中断，正在重试…',true)}}
  else if(offlineShown){offlineShown=false;message('')}
  if(updating||busy||navigating){if(force)pendingResize=true;return}
  updating=true;
  try{
    const previousList=box?.compactList;
    acceptLayout((await call('layout')).layout);
    if(transientError){transientError=false;message('')}
    const height=wantedHeight();
    const reflow=!preparedWindow||previousList!==box.compactList;
    if(!viewOnly&&box.chatReady&&!box.popups.length&&(reflow||Math.abs(box.width-Math.min(box.screenWidth,760))>20||Math.abs(box.height-height)>20||box.x>10||box.y>10)){
      acceptLayout((await call('prepare',{height,stable:true,reflow})).layout);preparedWindow=true;
    }
  }catch(e){transientError=!!e.transient;message(e.message,true)}
  finally{updating=false;if(pendingResize){pendingResize=false;scheduleAdapt()}}
}
async function setView(next,swipe=null){
  if(busy||navigating||viewOnly){if(swipe)cancelNavigationTransition(swipe);return}
  pendingSend=null;
  if(popupActive()&&next!=='full'){if(swipe)cancelNavigationTransition(swipe);return}
  if(box?.compact&&!box.compactList&&next==='list'){
    const before=box.conversation,oldHeader=pictureHeader();draft.blur();navigating=true;controls();
    const transition=swipe||beginNavigationTransition(-1);
    zoom=1;document.querySelector('#zoom').classList.remove('active');
    screen.scrollTop=0;screen.scrollLeft=0;menu.classList.remove('open');
    try{
      acceptLayout((await call('view',{view:'list'})).layout);
      if(transition)await finishNavigationTransition(transition,box);
      else if(before!==box.conversation&&oldHeader)await waitPictureChange(oldHeader,2500);
      message('');
    }catch(e){if(e.layout)acceptLayout(e.layout);message(e.message,true);return}finally{cancelNavigationTransition(transition);navigating=false;controls()}
    return;
  }
  if(swipe)cancelNavigationTransition(swipe);
  if(box?.compactList&&next==='chat')return;
  view=next;zoom=1;document.querySelector('#zoom').classList.remove('active');
  screen.scrollTop=0;screen.scrollLeft=0;menu.classList.remove('open');applyView();fit();scheduleAdapt();
}
async function windowAction(action,id){
  if(busy||navigating||!box)return;
  navigating=true;controls();menu.classList.remove('open');
  try{acceptLayout((await call('window',{action,window:id})).layout);message('')}
  catch(e){if(e.layout)acceptLayout(e.layout);message(e.message,true)}
  finally{navigating=false;controls();update()}
}
function viewport(){
  const vv=window.visualViewport,height=vv?.height||innerHeight;
  baselineHeight=Math.max(baselineHeight,height);
  const keyboard=document.activeElement===draft&&height<baselineHeight-100;
  document.body.classList.toggle('keyboard',keyboard);
  const app=document.querySelector('#app');app.style.height=height+'px';app.style.top=(vv?.offsetTop||0)+'px';
  // Keyboard changes only affect the local crop, not the shared desktop.
  fit();scheduleAdapt();
}
function sizeDraft(){draft.style.height='auto';draft.style.height=Math.min(draft.scrollHeight+2,110)+'px';controls();scheduleAdapt()}
function showCopied(text){
  const toast=document.querySelector('#toast');
  toast.querySelector('span').textContent='已复制：'+text.replace(/\s+/g,' ').slice(0,60);
  toast.dataset.text=text;toast.classList.add('visible');
  clearTimeout(toast.timer);toast.timer=setTimeout(()=>toast.classList.remove('visible'),9000);
}
document.querySelector('#toast button').onclick=async()=>{
  const toast=document.querySelector('#toast'),text=toast.dataset.text||'';
  try{await navigator.clipboard.writeText(text)}
  catch{const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();document.execCommand('copy');area.remove()}
  toast.classList.remove('visible');message('已复制到手机剪贴板');
};
draft.addEventListener('compositionstart',()=>{composing=true;controls()});
draft.addEventListener('compositionend',()=>{composing=false;sizeDraft()});
draft.addEventListener('input',()=>{pendingSend=null;sizeDraft()});
draft.addEventListener('focus',viewport);draft.addEventListener('blur',viewport);
send.addEventListener('pointerdown',e=>e.preventDefault());
send.onclick=async()=>{
  if(send.disabled)return;
  const text=draft.value,mode='enter',windowId=box.id,conversation=box.conversation;
  if(!pendingSend||pendingSend.text!==text||pendingSend.window!==windowId||pendingSend.conversation!==conversation)pendingSend={text,mode,window:windowId,conversation,requestId:crypto.randomUUID()};
  const attempt=pendingSend;busy=true;pendingSend=null;
  // Detach the submitted text immediately; further typing belongs to the next message.
  draft.value='';sizeDraft();message('发送中…');controls();
  debugLog('send',{conversation});
  try{
    const result=await call('send',attempt);
    debugLog('send-result',{ok:true});
    if(sendRecoveries.get(sendDraftKey(attempt))?.requestId===attempt.requestId)sendRecoveries.delete(sendDraftKey(attempt));
    message('');
    if(result.layout)acceptLayout(result.layout);
    resetMessagePicture(true);
  }catch(e){
    debugLog('send-error',{message:e.message});if(e.layout)acceptLayout(e.layout);
    if(sendDraftKey()===sendDraftKey(attempt)&&!draft.value){draft.value=attempt.text;pendingSend=attempt;sizeDraft()}
    else sendRecoveries.set(sendDraftKey(attempt),attempt);
    message(e.message,true);
  }
  finally{busy=false;controls();update()}
};
document.querySelector('#restore-send')?.addEventListener('click',()=>{
  const key=sendDraftKey(),attempt=sendRecoveries.get(key);if(!attempt)return;
  if(draft.value)return message('输入框里已有新草稿，请先保存或处理新草稿，再恢复上一条',true);
  draft.value=attempt.text;pendingSend=attempt;sendRecoveries.delete(key);sizeDraft();draft.focus();
  message('已恢复上一条内容，请先核对聊天记录，避免重复发送',true);
});
document.querySelector('#dismiss-send')?.addEventListener('click',()=>{sendRecoveries.delete(sendDraftKey());controls();message('')});
attach.onclick=()=>{if(!attach.disabled)picker.click()};
picker.onchange=()=>{const files=[...picker.files];picker.value='';prepareAttachments(files)};
function prepareAttachments(files){
  if(!files.length)return;
  if(attach.disabled||!chatOpen()){message('请先打开聊天，再粘贴图片',true);return}
  if(files.some(f=>f.size>95*1024*1024)){message('单个文件不能超过 95MB',true);return}
  const sheet=document.querySelector('#sheet'),list=sheet.querySelector('ul');list.replaceChildren();
  for(const file of files){
    const item=document.createElement('li');
    if(file.type.startsWith('image/')){const img=document.createElement('img');img.src=URL.createObjectURL(file);img.onload=()=>URL.revokeObjectURL(img.src);item.append(img)}
    const label=document.createElement('span');label.textContent=file.name+' · '+(file.size>1048576?(file.size/1048576).toFixed(1)+' MB':Math.ceil(file.size/1024)+' KB');item.append(label);list.append(item);
  }
  // Show the chat header from the live picture so the recipient can be checked.
  const target=sheet.querySelector('canvas');
  if(panes){const dpr=mobileCanvas.width/panes.width,h=90*panes.scale;target.width=mobileCanvas.width;target.height=Math.round(h*dpr);target.style.height=h+'px';target.getContext('2d').drawImage(mobileCanvas,0,0,mobileCanvas.width,Math.round(h*dpr),0,0,target.width,target.height)}
  pendingUpload={files,window:box.id,conversation:box.conversation,ids:files.map(()=>crypto.randomUUID())};
  sheet.querySelector('#upload').textContent='发送 '+files.length+' 个';
  sheet.classList.add('open');draft.blur();
}
// Safari exposes copied photos through the trusted paste event; no clipboard permission is needed.
draft.addEventListener('paste',event=>{
  const data=event.clipboardData;if(!data)return;
  const files=[...(data.files||[])].filter(f=>f.type.startsWith('image/'));
  if(!files.length)for(const item of data.items||[]){if(item.kind==='file'&&item.type.startsWith('image/')){const file=item.getAsFile();if(file)files.push(file)}}
  if(!files.length)return;
  event.preventDefault();
  prepareAttachments(files.map((file,index)=>file.name?file:new File([file],`粘贴图片-${Date.now()}-${index}.${file.type==='image/jpeg'?'jpg':'png'}`,{type:file.type})));
});
draft.placeholder='输入消息，也可长按粘贴图片';
document.querySelector('#upload-cancel').onclick=()=>{pendingUpload=null;document.querySelector('#sheet').classList.remove('open')};
function uploadOne(file,id,target){
  return new Promise((resolve,reject)=>{
    const request=new XMLHttpRequest();
    request.open('POST','/mobile-api/upload');
    request.setRequestHeader('X-Mobile-Control','1');request.setRequestHeader('Content-Type','application/octet-stream');
    request.setRequestHeader('X-File-Name',encodeURIComponent(file.name));request.setRequestHeader('X-Request-Id',id);
    request.setRequestHeader('X-Window',target.window);request.setRequestHeader('X-Conversation',encodeURIComponent(target.conversation));
    request.timeout=120000;
    request.ontimeout=()=>reject(Error('上传超时，请检查聊天记录后再试'));
    request.upload.onprogress=e=>{if(e.lengthComputable)target.progress(e.loaded/e.total)};
    request.onload=()=>{
      if(request.status===401){location.replace('/mobile/login');return reject(Error('请重新登录'))}
      let result={};try{result=JSON.parse(request.responseText)}catch{}
      if(request.status>=200&&request.status<300)resolve(result);else{const error=Error(result.error||(request.status===413?'文件太大，单个不能超过 95MB':'发送失败'));error.layout=result.layout;reject(error)}
    };
    request.onerror=()=>reject(Error('上传中断，请稍后重试'));request.send(file);
  });
}
document.querySelector('#upload').onclick=async()=>{
  const job=pendingUpload;if(!job||busy)return;
  if(job.window!==box?.id||job.conversation!==box?.conversation){message('聊天对象已变化，请重新选择文件',true);document.querySelector('#sheet').classList.remove('open');pendingUpload=null;return}
  document.querySelector('#sheet').classList.remove('open');busy=true;controls();
  try{
    for(let i=0;i<job.files.length;i++){
      const prefix=job.files.length>1?`正在发送 ${i+1}/${job.files.length}`:'正在发送';
      message(prefix+'…');
      const result=await uploadOne(job.files[i],job.ids[i],{window:job.window,conversation:job.conversation,progress:f=>message(f<1?`${prefix} · 上传 ${Math.round(f*100)}%`:prefix+' · 微信处理中…')});
      if(result.layout)acceptLayout(result.layout);
    }
    pendingUpload=null;resetMessagePicture(true);message('已发送');
  }catch(e){if(e.layout)acceptLayout(e.layout);message(e.message+(pendingUpload?'；可重新选择文件再试':''),true)}
  finally{busy=false;controls();update()}
};
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
document.querySelector('#back').onclick=()=>popupActive()?windowAction(activePopup().kind==='menu'?'escape':'lower',activePopup().id):setView('list');
document.querySelector('#popup-back').onclick=()=>activePopup()&&windowAction('lower',activePopup().id);
document.querySelector('#popup-close').onclick=()=>activePopup()&&windowAction(activePopup().kind==='menu'?'escape':'close',activePopup().id);
document.querySelector('#zoom').onclick=()=>{const s=screen.getBoundingClientRect();setZoom(zoom>1.01?1:1.3,s.left+s.width/2,s.top);if(zoom===1)screen.scrollLeft=0};
document.querySelector('#more').onclick=()=>menu.classList.toggle('open');
document.querySelector('#keyboard').onclick=()=>{draft.blur();menu.classList.remove('open')};
document.querySelector('#refresh').onclick=()=>{if(busy||navigating)return;reconnect('');menu.classList.remove('open')};
document.querySelector('#logout').onclick=async()=>{try{await call('logout',{});location.replace('/mobile/login')}catch(e){message(e.message,true)}};
document.querySelector('#logout-all').onclick=async()=>{if(!confirm('所有已登录的手机和电脑都需要重新输入密码，确定吗？'))return;try{await call('logout-all',{});location.replace('/mobile/login')}catch(e){message(e.message,true)}};
window.visualViewport?.addEventListener('resize',viewport);window.visualViewport?.addEventListener('scroll',viewport);
window.addEventListener('resize',viewport);window.addEventListener('orientationchange',()=>{baselineHeight=window.visualViewport?.height||innerHeight;viewport()});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)update(true)});
new ResizeObserver(()=>{fit();scheduleAdapt()}).observe(screen);
frame.addEventListener('load',()=>{if(view==='full')setTimeout(()=>{fit();update(true)},1000)});
// render.js and touch.js load after this file; start once every script is in place.
document.addEventListener('DOMContentLoaded',()=>{setInterval(()=>{if(!document.hidden)update()},8000);viewport();controls();update()});
debugLog('load',{agent:navigator.userAgent,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,standalone:!!navigator.standalone});
const mobileWorkerRegistration='serviceWorker'in navigator?navigator.serviceWorker.register('./sw.js?v=0.3.0',{updateViaCache:'none'}).catch(()=>null):Promise.resolve(null);

// Optional LAN configuration is generated on the deployment host, never baked into the bundle.
fetch('/mobile/lan-config.json',{cache:'no-store'}).then(r=>r.ok?r.json():{}).then(config=>{
  if(!config.url)return;
  const url=new URL(config.url),link=document.querySelector('#lan-entry');
  if(url.protocol!=='https:'||url.username||url.password||!link)return;
  link.href=url.href;link.hidden=false;
}).catch(()=>{});
