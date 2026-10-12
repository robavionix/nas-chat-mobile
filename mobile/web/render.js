// The phone picture is built from strips that the server captures from WeChat's window.
// Nothing here depends on the browser's video decoder, which can hold back the newest frame.
const mobileCanvas=document.querySelector('#mobile-picture'),pictureContext=mobileCanvas.getContext('2d',{alpha:false});
const mirrorCanvas=document.createElement('canvas'),mirrorContext=mirrorCanvas.getContext('2d',{alpha:false});
const boundsCanvas=document.createElement('canvas'),boundsContext=boundsCanvas.getContext('2d',{willReadFrequently:true});
const headerCanvas=document.createElement('canvas'),headerContext=headerCanvas.getContext('2d',{willReadFrequently:true});
const sampleCanvas=document.createElement('canvas'),sampleContext=sampleCanvas.getContext('2d',{willReadFrequently:true});
const shiftCanvas=document.createElement('canvas'),shiftContext=shiftCanvas.getContext('2d',{alpha:false});
const scrollBodyCanvas=document.createElement('canvas'),scrollBodyContext=scrollBodyCanvas.getContext('2d',{alpha:false});
let scrollCache=null;
let scrollClip=null;
headerCanvas.width=64;headerCanvas.height=16;
const mirror={key:null,rect:null,layout:null,version:-1,alive:0,ready:false,changed:0,controller:null,target:null,mode:'websocket',failures:0,streamed:false,socket:null,epoch:0,retryAt:0,frames:0,bytes:0};
let boundsVersion=-1;
let panes=null,boundsTime=0,contentBottom=null,localOffset=0,lastPaneView=null,waitingHeader=null,renderDirty=true,followUntil=0,paintedVersion=-1;
// After sending or switching chats, keep following the newest message for a moment.
function resetMessagePicture(keepBottom=false){localOffset=0;if(!keepBottom)contentBottom=null;boundsTime=0;renderDirty=true;followUntil=performance.now()+3000}
function mirrorTarget(){return popupActive()?'popup':'main'}
// Copy a desktop rectangle from the mirror, clipped to what the mirror holds.
function drawDesktop(context,x,y,width,height,dx,dy,dw,dh){
  const r=mirror.rect;if(!r||!mirror.ready)return false;
  const left=Math.max(x,r[0]),top=Math.max(y,r[1]),right=Math.min(x+width,r[0]+r[2]),bottom=Math.min(y+height,r[1]+r[3]);
  if(right<=left||bottom<=top)return false;
  const sx=dw/width,sy=dh/height;
  context.drawImage(mirrorCanvas,left-r[0],top-r[1],right-left,bottom-top,dx+(left-x)*sx,dy+(top-y)*sy,(right-left)*sx,(bottom-top)*sy);
  return true;
}
// Resample the captured column once per remote frame, at the phone's actual
// pixel density. Local scrolling moves a composited layer; it does not repaint
// the Retina viewport, and can continue while the next strips are decoding.
function scrollGeometry(part,dpr){
  return JSON.stringify([box.id,box.conversation,view,mobilePaneRegion(box,view),panes.scale,dpr,
    mobileCanvas.width,mobileCanvas.height,part.dx||0,part.dy,part.width,part.height]);
}
function positionScrollBody(part,dpr){
  if(!scrollCache||scrollCache.geometry!==scrollGeometry(part,dpr)||part.y<scrollCache.top-1e-6||part.y+part.height>scrollCache.top+scrollCache.height+1e-6)return false;
  if(!scrollClip){
    scrollClip=document.createElement('div');scrollClip.setAttribute('aria-hidden','true');
    Object.assign(scrollClip.style,{position:'absolute',overflow:'hidden',pointerEvents:'none',zIndex:'1',contain:'strict'});
    Object.assign(scrollBodyCanvas.style,{display:'block',position:'absolute',left:'0',top:'0',willChange:'transform',transformOrigin:'top left'});
    scrollClip.append(scrollBodyCanvas);stage.append(scrollClip);
  }
  scrollClip.hidden=false;
  const dy=Math.round(part.dy*dpr),rows=Math.round((part.dy+part.height*panes.scale)*dpr)-dy;
  const sourceY=Math.max(0,Math.min(scrollBodyCanvas.height-rows,Math.round((part.y-scrollCache.top)*panes.scale*dpr)));
  const clipStyle=scrollClip.style,bodyStyle=scrollBodyCanvas.style;
  const values={left:(part.dx||0)+'px',top:dy/dpr+'px',width:(part.dw||panes.width)+'px',height:rows/dpr+'px'};
  for(const [key,value] of Object.entries(values))if(clipStyle[key]!==value)clipStyle[key]=value;
  bodyStyle.width=scrollBodyCanvas.width/dpr+'px';bodyStyle.height=scrollBodyCanvas.height/dpr+'px';
  bodyStyle.transform=`translate3d(0,${-sourceY/dpr}px,0)`;
  scrollCache.crop={sourceY,rows,dy,dpr,dx:part.dx||0,dw:part.dw||panes.width};
  return true;
}
function drawScrollBody(part,dpr){
  if(box.client!=='qq'||popupActive()||!box.chatReady)return false;
  const region=mobilePaneRegion(box,view),top=region.y+region.header,height=region.height-region.header;
  const scale=panes.scale*dpr,width=Math.round(part.width*scale);
  const limit=Math.min(8192,Math.floor(8*1024*1024/width));
  const captured=Math.min(height,Math.floor(limit/scale)),pixels=Math.ceil(captured*scale);
  if(width<1||pixels<1||captured+1e-6<part.height){if(scrollCache)releaseScrollCache();return false}
  const key=JSON.stringify([mirror.epoch,mirror.version,mirror.key,mirror.rect,scrollGeometry(part,dpr)]);
  if(scrollCache?.key!==key||part.y<scrollCache.top-1e-6||part.y+part.height>scrollCache.top+scrollCache.height+1e-6){
    const origin=Math.max(top,Math.min(top+height-captured,part.y-(captured-part.height)/2));
    if(scrollBodyCanvas.width!==width)scrollBodyCanvas.width=width;
    if(scrollBodyCanvas.height!==pixels)scrollBodyCanvas.height=pixels;
    scrollBodyContext.imageSmoothingQuality='high';
    scrollBodyContext.fillStyle='#f4f4f4';scrollBodyContext.fillRect(0,0,width,pixels);
    if(!drawDesktop(scrollBodyContext,region.x,origin,region.width,captured,0,0,width,captured*scale))return false;
    scrollCache={key,geometry:scrollGeometry(part,dpr),top:origin,height:captured};
  }
  return positionScrollBody(part,dpr);
}
// Navigation snapshots include the currently composited body at the same DPR.
function materializeMobilePicture(){
  if(!scrollCache?.crop||!scrollClip||scrollClip.hidden)return;
  const {sourceY,rows,dy,dpr,dx,dw}=scrollCache.crop;
  pictureContext.setTransform(dpr,0,0,dpr,0,0);pictureContext.imageSmoothingQuality='low';
  pictureContext.drawImage(scrollBodyCanvas,0,sourceY,scrollBodyCanvas.width,rows,dx,dy/dpr,dw,rows/dpr);
}
function releaseScrollCache(){if(scrollClip)scrollClip.hidden=true;scrollCache=null;scrollBodyCanvas.width=1;scrollBodyCanvas.height=1}
// Publish only complete frames. Decode one strip at a time so Retina frames
// do not retain another full desktop-sized set of bitmaps on the phone.
async function applyMessage(header,bytes,valid=()=>true){
  if(!valid())return;
  if(!header.key){if(header.layout)acceptLayout(header.layout);mirror.key=null;mirror.ready=false;return}
  let offset=0;const deadline=performance.now()+8000;
  const shifted=!header.full&&header.key===mirror.key&&header.moves?.length;
  if(header.layout)acceptLayout(header.layout);
  mirror.ready=false;
  if(header.full||header.key!==mirror.key){
    const [,,w,h]=header.rect;
    if(mirrorCanvas.width!==w||mirrorCanvas.height!==h){mirrorCanvas.width=w;mirrorCanvas.height=h}
    mirror.ready=false;
  }else if(header.moves?.length){
    // Scrolled content is moved locally, every segment from the previous picture at once;
    // only newly revealed rows arrive as strips. The scrollbar column on the right is not moved.
    movePictureRows(header.moves,header.span||mirrorCanvas.width);
  }
  for(const [top,height,size,left=0,width=mirrorCanvas.width,mime='image/jpeg'] of header.strips){
    if(!valid())return;
    const remaining=deadline-performance.now();
    if(remaining<=0)throw Error('画面解码超时');
    const image=await decodeImage(new Blob([bytes.subarray(offset,offset+=size)],{type:mime}),Math.min(3000,remaining));
    try{if(!valid())return;mirrorContext.drawImage(image,left,top,width,height)}finally{image.close?.()}
  }
  if(!valid())return;
  if(header.strips.length||header.moves?.length){mirror.changed=performance.now();mirror.version++;renderDirty=true}
  mirror.key=header.key;mirror.rect=header.rect;mirror.ready=true;
  if(header.layout)mirror.layout=header.layout;
  // Keep the complete old layer at its old origin during decode. Shift its
  // coordinates only when the corresponding new pixels are ready to publish.
  if(shifted)followShift(header.moves);
}
function movePictureRows(moves,width){
  // Same-direction scrolls can copy in place, starting at the far end. Canvas
  // snapshots overlapping source/destination rectangles for each drawImage.
  const positive=moves.every(([distance])=>distance>0),negative=moves.every(([distance])=>distance<0);
  if(positive||negative){
    const ordered=[...moves].sort((a,b)=>positive?b[1]-a[1]:a[1]-b[1]);
    for(const [distance,start,end] of ordered)mirrorContext.drawImage(mirrorCanvas,0,start-distance,width,end-start,0,start,width,end-start);
    return;
  }
  // Unrelated animated regions can move in opposite directions. Snapshot only
  // for that case, then explicitly release the temporary backing store.
  shiftCanvas.width=width;shiftCanvas.height=mirrorCanvas.height;
  try{
    shiftContext.drawImage(mirrorCanvas,0,0,width,mirrorCanvas.height,0,0,width,mirrorCanvas.height);
    for(const [distance,start,end] of moves)mirrorContext.drawImage(shiftCanvas,0,start-distance,width,end-start,0,start,width,end-start);
  }finally{shiftCanvas.width=1;shiftCanvas.height=1}
}
async function applyFrame(buffer,valid=()=>true){
  const length=new DataView(buffer).getUint32(0),header=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,4,length)));
  await applyMessage(header,new Uint8Array(buffer,4+length),valid);
  if(valid())mirror.since=header.version;
}
// Acknowledge only after the decoded picture has reached the next paint opportunity.
// The server sends one picture at a time; dependent deltas must be applied in order.
function transportStatus(){
  const label=document.querySelector('#connection-info');
  if(label){
    label.textContent=(/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname)?'家里直连':'公网连接')+' · '+(mirror.mode==='websocket'?'实时推送':'兼容模式');
    label.dataset.transport=mirror.mode;
  }
}
function frameQuality(){
  try{if(localStorage.getItem('nas-chat-mobile-quality')==='adaptive')return 'adaptive'}catch{}
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname)?'lossless':'clear';
}
document.addEventListener('DOMContentLoaded',()=>{
  const button=document.querySelector('#quality');if(!button)return;
  const label=()=>button.textContent='画质：'+(frameQuality()==='adaptive'?'流畅优先':'清晰优先');label();
  button.onclick=()=>{
    const next=frameQuality()==='adaptive'?'clear':'adaptive';
    try{localStorage.setItem('nas-chat-mobile-quality',next)}catch{return message('浏览器无法保存画质设置',true)}
    label();resetMirror();message(next==='adaptive'?'已切换流畅优先':'已切换清晰优先');
  };
});
async function socketMirror(){
  const epoch=mirror.epoch,socket=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/mobile-api/ws?quality='+frameQuality());
  socket.binaryType='arraybuffer';mirror.socket=socket;mirror.target='websocket';
  let received=false,last=performance.now(),busy=false,settled=false;
  const valid=()=>!settled&&epoch===mirror.epoch&&!document.hidden&&view!=='full';
  return new Promise((resolve,reject)=>{
    function finish(error){
      if(settled)return;settled=true;clearInterval(watchdog);
      if(mirror.socket===socket)mirror.socket=null;
      socket.close();error?reject(error):resolve();
    }
    const watchdog=setInterval(()=>{
      if(!valid())return finish();
      if(performance.now()-last>(received?15000:5000))return finish(Error('画面连接超时'));
      if(socket.readyState===1)socket.send('ping');
    },3000);
    socket.onmessage=async event=>{
      if(!valid())return finish();
      if(busy)return finish(Error('画面队列不同步'));
      busy=true;
      try{
        const buffer=event.data;
        if(!(buffer instanceof ArrayBuffer)||buffer.byteLength<8)throw Error('画面格式无效');
        const lengths=new DataView(buffer),hl=lengths.getUint32(0),bl=lengths.getUint32(4);
        if(hl>65536||bl>12*1024*1024||8+hl+bl!==buffer.byteLength)throw Error('画面长度无效');
        const header=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,8,hl)));
        if(!Number.isSafeInteger(header.seq)||!Array.isArray(header.strips))throw Error('画面序号无效');
        await applyMessage(header,new Uint8Array(buffer,8+hl,bl),valid);
        if(!valid())return finish();
        mirror.alive=last=performance.now();mirror.streamed=true;
        mirror.frames++;mirror.bytes+=buffer.byteLength;
        if(!received)transportStatus();
        received=true;mirror.failures=0;
        controls();
        await new Promise(requestAnimationFrame);
        if(valid()&&socket.readyState===1)socket.send('ack '+header.seq);
      }catch(error){finish(error)}finally{busy=false}
    };
    socket.onerror=()=>finish(Error('实时连接不可用'));
    socket.onclose=()=>finish(valid()?Error('实时连接已断开'):null);
  });
}
function stopMirror(){mirror.epoch++;mirror.controller?.abort();mirror.socket?.close();releaseScrollCache()}

document.addEventListener('visibilitychange',()=>{if(document.hidden)stopMirror()});
window.addEventListener('pagehide',releaseScrollCache);
function decodeImage(blob,timeout=3000){
  // WebKit can leave a bitmap decode pending under memory pressure. Bound the
  // entire decode, including its HTMLImage fallback, and dispose late results.
  return new Promise((resolve,reject)=>{
    let settled=false,cancel=()=>{};
    const finish=(error,image)=>{
      if(settled){image?.close?.();return}
      settled=true;clearTimeout(timer);cancel();error?reject(error):resolve(image);
    };
    const timer=setTimeout(()=>finish(Error('画面解码超时')),timeout);
    const fallback=()=>{
      if(settled)return;
      const url=URL.createObjectURL(blob),img=new Image();
      cancel=()=>{img.onload=img.onerror=null;URL.revokeObjectURL(url);if(!img.complete)img.src=''};
      img.onload=()=>finish(null,img);img.onerror=()=>finish(Error('图片解码失败'));img.src=url;
    };
    if(window.createImageBitmap){try{createImageBitmap(blob).then(image=>finish(null,image),fallback)}catch{fallback()}}
    else fallback();
  });
}
async function mirrorLoop(){
  for(;;){
    if(document.hidden||view==='full'||!box){await new Promise(r=>setTimeout(r,300));continue}
    if(mirror.mode==='poll'&&performance.now()>mirror.retryAt){mirror.mode='websocket';transportStatus()}
    if(mirror.mode==='websocket'){
      try{await socketMirror()}catch{
        if(!document.hidden&&view!=='full'){
          mirror.mode='poll';mirror.retryAt=performance.now()+60000;
          mirror.key=null;mirror.since=-1;
          // Keep the last picture visible while the compatible transport fetches a fresh frame.
          transportStatus();
        }
      }
      continue;
    }
    const target=mirrorTarget(),controller=new AbortController(),epoch=mirror.epoch;
    mirror.controller=controller;mirror.target=target;
    const since=mirror.key&&mirror.since!==undefined?mirror.since:-1;
    const timer=setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetch('/mobile-api/frame?target='+target+'&since='+since+'&key='+encodeURIComponent(mirror.key||'')+'&quality='+frameQuality(),{cache:'no-store',signal:controller.signal});
      if(response.status===401){location.replace('/mobile/login');return}
      if(!response.ok)throw Error('frame '+response.status);
      const buffer=await response.arrayBuffer();
      if(controller.signal.aborted||mirror.target!==target)continue;
      await applyFrame(buffer,()=>!controller.signal.aborted&&epoch===mirror.epoch);
      mirror.alive=performance.now();
      if(!mirror.key)await new Promise(r=>setTimeout(r,150));
    }catch(e){mirror.key=null;mirror.since=-1;if(!controller.signal.aborted)await new Promise(r=>setTimeout(r,700))}
    finally{clearTimeout(timer)}
  }
}
// A different target (for example a menu that just opened) must not wait for the old long poll.
function retargetMirror(){if(mirror.mode==='poll'&&mirror.controller&&mirror.target!==mirrorTarget()){mirror.target=null;mirror.controller.abort()}}
function resetMirror(){stopMirror();mirror.key=null;mirror.since=-1;mirror.version=-1;mirror.mode='websocket';mirror.retryAt=0;renderDirty=true;transportStatus()}
function pictureHeader(){
  if(!box||!mirror.ready)return null;
  try{
    headerContext.fillStyle='#fff';headerContext.fillRect(0,0,64,16);
    const region=mobilePaneRegion(box,view);
    if(!drawDesktop(headerContext,region.x,region.y,region.width,region.header,0,0,64,16))return null;
    const pixels=headerContext.getImageData(0,0,64,16).data,result=new Uint8Array(1024);
    for(let i=0;i<1024;i++)result[i]=Math.round((pixels[i*4]+pixels[i*4+1]+pixels[i*4+2])/48);
    return result;
  }catch{return null}
}
function headerChanged(before){
  const now=pictureHeader();if(!now)return false;if(!before)return true;
  let changed=0;for(let i=0;i<now.length;i++)if(Math.abs(now[i]-before[i])>1)changed++;
  return changed>16;
}
async function waitPictureChange(before,timeout){
  waitingHeader=before;
  const until=performance.now()+timeout;
  while(performance.now()<until){
    if(headerChanged(before)){waitingHeader=null;return true}
    await new Promise(resolve=>setTimeout(resolve,60));
  }
  return false;
}
// Block averages of a desktop region, matching the server's box filter.
function regionAverages(x,y,width,height,columns,rows,detail=8){
  if(!box||!mirror.ready)return null;
  try{
    const w=Math.max(columns,Math.min(columns*detail,Math.round(width))),h=Math.max(rows,Math.min(rows*detail,Math.round(height)));
    if(sampleCanvas.width!==w)sampleCanvas.width=w;if(sampleCanvas.height!==h)sampleCanvas.height=h;
    sampleContext.imageSmoothingQuality='high';
    if(!drawDesktop(sampleContext,x,y,width,height,0,0,w,h))return null;
    const pixels=sampleContext.getImageData(0,0,w,h).data,sums=new Float64Array(columns*rows),counts=new Float64Array(columns*rows);
    for(let py=0;py<h;py++){const r=Math.min(rows-1,Math.floor(py*rows/h));for(let px=0;px<w;px++){
      const i=(py*w+px)*4,cell=r*columns+Math.min(columns-1,Math.floor(px*columns/w));
      sums[cell]+=pixels[i]*.299+pixels[i+1]*.587+pixels[i+2]*.114;counts[cell]++;
    }}
    return Array.from(sums,(s,i)=>Math.round(s/counts[i]));
  }catch{return null}
}
function rowSignature(y){const s=box?.uiScale||1;return box?regionAverages((box.panes?.list?.x??box.x+(box.split||104)+2)+8*s,y-30*s,90*s,60*s,6,6):null}
function fitMobilePicture(){
  renderDirty=true;
  const popup=activePopup(),mode=popup?'popup':!box.chatReady?'window':view;
  if(lastPaneView!==mode){localOffset=0;contentBottom=null;boundsTime=0;lastPaneView=mode}
  if(popup||!box.chatReady){
    const area=popup||box,fitWidth=screen.clientWidth/area.width;
    let scale=popup?.kind==='window'?fitWidth:Math.min(fitWidth,screen.clientHeight/area.height,popup?2.4:fitWidth);
    scale*=zoom;
    panes={width:area.width*scale,height:area.height*scale,scale,start:0,base:0,minStart:0,maxStart:0,sections:[{x:area.x,y:area.y,width:area.width,height:area.height,dy:0}]};
  }else panes=mobilePanes(box,view,screen.clientWidth,screen.clientHeight,zoom,contentBottom,localOffset);
  if(!popup&&box.chatReady)localOffset=panes.start-panes.base;
  stage.dataset.panes=JSON.stringify(panes);
  stage.style.width=panes.width+'px';stage.style.height=panes.height+'px';
  stage.style.marginTop=popup?Math.max(0,(screen.clientHeight-panes.height)/2)+'px':'';
  stage.style.marginLeft=popup||!box.chatReady?Math.max(0,(screen.clientWidth-panes.width)/2)+'px':'';
  const dpr=Math.min(3,devicePixelRatio||1),width=Math.round(panes.width*dpr),height=Math.round(panes.height*dpr);
  if(mobileCanvas.width!==width||mobileCanvas.height!==height){mobileCanvas.width=width;mobileCanvas.height=height}
  mobileCanvas.style.width=panes.width+'px';mobileCanvas.style.height=panes.height+'px';
  if(typeof navigationLayoutChanged==='function')navigationLayoutChanged();
  retargetMirror();
}
function localScrolling(){return panes&&(view==='chat'||view==='list')&&!popupActive()&&box?.chatReady}
// When WeChat scrolls, keep the same content under the finger instead of letting it jump.
// At the default position (newest message, top of the list) the picture simply follows WeChat.
function followShift(moves){
  if(!localScrolling()||!mirror.rect||Math.abs(localOffset)<1&&performance.now()-lastUserScroll>600)return;
  // Neighbouring segments differ by a pixel at most; use the one under the middle of the screen.
  const middle=panes.start+panes.sections.at(-1).height/2-mirror.rect[1];
  const move=moves.find(([,start,end])=>middle>=start&&middle<end)||moves.reduce((a,b)=>b[2]-b[1]>a[2]-a[1]?b:a);
  localOffset+=move[0];fitMobilePicture();
}
let lastPrefetch=0,lastUserScroll=0,lastPrefetchFrame=null,lastPrefetchDirection=0;
// Scroll the captured window locally first; the remainder scrolls WeChat itself.
function scrollLocal(delta){
  if(!localScrolling())return delta;
  lastUserScroll=performance.now();
  const before=panes.start,next=Math.max(panes.minStart,Math.min(panes.maxStart,before+delta/panes.scale));
  // Ask WeChat to scroll before the captured window runs out, so scrolling continues locally.
  const room=delta>0?panes.maxStart-next:next-panes.minStart;
  const range=panes.maxStart-panes.minStart,direction=Math.sign(delta);
  const threshold=Math.min(range*.6,180/panes.scale);
  const frame=mirror.epoch+':'+mirror.key+':'+mirror.version;
  const prefetch=box.client==='qq'
    ?range>0&&room<threshold&&performance.now()-lastPrefetch>160&&(lastPrefetchFrame!==frame||lastPrefetchDirection!==direction)
    :room<500&&performance.now()-lastPrefetch>350;
  if(delta&&prefetch){
    lastPrefetch=performance.now();lastPrefetchFrame=frame;lastPrefetchDirection=direction;
    const area=panes.sections.at(-1);
    remoteScroll(Math.sign(delta)*3,{x:Math.round(area.x+Math.min(298,area.width/2)),y:Math.round(panes.start+area.height/2)});
  }
  if(next===before)return delta;
  localOffset=next-panes.base;followUntil=0;
  // Only the crop origin changes during a drag. Avoid layout/style writes and
  // canvas sizing work in the touch hot path; hit testing shares this origin.
  if(box.client==='qq'){
    panes.start=next;panes.sections.at(-1).y=next;
    stage.dataset.panes=JSON.stringify(panes);renderDirty=true;
  }else fitMobilePicture();
  return delta-(next-before)*panes.scale;
}
function findContentBottom(now){
  if(view!=='chat'||popupActive()||!box.chatReady||box.compactList||!mirror.key?.startsWith('main:'))return;
  const following=now<followUntil;
  if(!following&&boundsVersion===mirror.version&&contentBottom!==null)return;
  if(now-boundsTime<(following?120:400))return;
  boundsTime=now;boundsVersion=mirror.version;
  const region=mobilePaneRegion(box,'chat'),top=region.y+region.header,bottom=region.y+region.height,height=bottom-top,s=box.uiScale||1,step=4*s;
  if(height<=0)return;
  // Determine only the bottom of the visible message area, without OCR or storing pixels.
  if(boundsCanvas.width!==64)boundsCanvas.width=64;if(boundsCanvas.height!==Math.ceil(height/step))boundsCanvas.height=Math.ceil(height/step);
  boundsContext.fillStyle='#fff';boundsContext.fillRect(0,0,64,boundsCanvas.height);
  if(!drawDesktop(boundsContext,region.x+6*s,top,region.width-26*s,height,0,0,64,boundsCanvas.height))return;
  const pixels=boundsContext.getImageData(0,0,64,boundsCanvas.height).data;
  let last=-1;
  for(let y=0;y<boundsCanvas.height;y++){
    let count=0;
    for(let x=0;x<64;x++){
      const i=(y*64+x)*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2];
      if(Math.min(r,g,b)<220||Math.max(r,g,b)-Math.min(r,g,b)>20)count++;
    }
    if(count>=2)last=y;
  }
  const next=last<0?top:Math.min(bottom,top+(last+1)*step+32*s);
  if(following)localOffset=0;
  if(contentBottom===null||Math.abs(next-contentBottom)>8*s||(following&&panes&&panes.start!==panes.base)){contentBottom=next;fitMobilePicture()}
}
function paintMobile(now){
  requestAnimationFrame(paintMobile);
  if(!box||view==='full'||document.hidden)return;
  if(typeof navigationAnimationRunning==='function'&&navigationAnimationRunning())return;
  const waiting=document.querySelector('#waiting');
  // An HTTP layout can beat its screenshot. Never crop the old chat using the new layout.
  if(mirror.layout&&(mirror.layout.conversation!==box.conversation||mirror.layout.compactList!==box.compactList||mirror.layout.popups?.[0]?.id!==box.popups?.[0]?.id))return;
  if(!renderDirty&&panes&&paintedVersion===mirror.version)return;
  // Finger movement uses only a complete cached body. Never expose the native
  // mirror while a delta is being applied, including its partially decoded rows.
  if(panes&&box.client==='qq'&&scrollCache&&!popupActive()&&box.chatReady&&(!mirror.ready||paintedVersion===mirror.version)){
    const dpr=mobileCanvas.width/panes.width;
    if(positionScrollBody(panes.sections.at(-1),dpr)){renderDirty=false;return}
  }
  if(!mirror.ready){if(!mirror.streamed){waiting.textContent='正在加载画面…';waiting.classList.remove('hidden')}return}
  if(visualPending){
    if(waitingHeader&&headerChanged(waitingHeader)){visualPending=false;waitingHeader=null;controls()}
  }
  try{findContentBottom(now)}catch{}
  if(!renderDirty&&paintedVersion===mirror.version||!panes)return;
  try{
    const dpr=mobileCanvas.width/panes.width;
    pictureContext.setTransform(dpr,0,0,dpr,0,0);
    pictureContext.imageSmoothingQuality='high';
    pictureContext.fillStyle=box.client==='qq'?'#f4f4f4':'#fafafa';pictureContext.fillRect(0,0,panes.width,panes.height);
    if(scrollCache&&(box.client!=='qq'||popupActive()||!box.chatReady))releaseScrollCache();
    if(scrollClip)scrollClip.hidden=true;
    for(const [index,part] of panes.sections.entries()){
      if(index===panes.sections.length-1&&drawScrollBody(part,dpr))continue;
      pictureContext.imageSmoothingQuality='high';
      drawDesktop(pictureContext,part.x,part.y,part.width,part.height,part.dx||0,part.dy,part.dw||panes.width,part.height*(part.scale||panes.scale));
    }
    renderDirty=false;paintedVersion=mirror.version;
    waiting.classList.add('hidden');
    if(typeof navigationPicturePainted==='function')navigationPicturePainted();
  }catch{}
}
requestAnimationFrame(paintMobile);
mirrorLoop();
