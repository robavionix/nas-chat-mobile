// The phone picture is built from strips that the server captures from WeChat's window.
// Nothing here depends on the browser's video decoder, which can hold back the newest frame.
const mobileCanvas=document.querySelector('#mobile-picture'),pictureContext=mobileCanvas.getContext('2d',{alpha:false});
const mirrorCanvas=document.createElement('canvas'),mirrorContext=mirrorCanvas.getContext('2d',{alpha:false});
const boundsCanvas=document.createElement('canvas'),boundsContext=boundsCanvas.getContext('2d',{willReadFrequently:true});
const headerCanvas=document.createElement('canvas'),headerContext=headerCanvas.getContext('2d',{willReadFrequently:true});
const sampleCanvas=document.createElement('canvas'),sampleContext=sampleCanvas.getContext('2d',{willReadFrequently:true});
const shiftCanvas=document.createElement('canvas'),shiftContext=shiftCanvas.getContext('2d',{alpha:false});
headerCanvas.width=64;headerCanvas.height=16;
const mirror={key:null,rect:null,version:-1,alive:0,ready:false,changed:0,controller:null,target:null,mode:'poll',failures:0,streamed:false};
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
// Strips are decoded first and drawn together, so a frame never shows half old and half new content.
async function applyMessage(header,bytes){
  if(header.layout)acceptLayout(header.layout);
  if(!header.key){mirror.key=null;mirror.ready=false;return}
  let offset=0;
  const images=await Promise.all(header.strips.map(([,,size])=>decodeImage(new Blob([bytes.subarray(offset,offset+=size)],{type:'image/jpeg'}))));
  if(header.full||header.key!==mirror.key){
    const [,,w,h]=header.rect;
    if(mirrorCanvas.width!==w||mirrorCanvas.height!==h){mirrorCanvas.width=w;mirrorCanvas.height=h}
    mirror.ready=false;
  }else if(header.moves?.length){
    // Scrolled content is moved locally, every segment from the previous picture at once;
    // only newly revealed rows arrive as strips. The scrollbar column on the right is not moved.
    const w=header.span||mirrorCanvas.width,h=mirrorCanvas.height;
    if(shiftCanvas.width!==w||shiftCanvas.height!==h){shiftCanvas.width=w;shiftCanvas.height=h}
    shiftContext.drawImage(mirrorCanvas,0,0,w,h,0,0,w,h);
    for(const [distance,start,end] of header.moves)mirrorContext.drawImage(shiftCanvas,0,start-distance,w,end-start,0,start,w,end-start);
    followShift(header.moves);
  }
  header.strips.forEach(([top,height,,left=0,width=mirrorCanvas.width],i)=>{mirrorContext.drawImage(images[i],left,top,width,height);images[i].close?.()});
  if(header.strips.length||header.moves?.length){mirror.changed=performance.now();mirror.version++;renderDirty=true}
  mirror.key=header.key;mirror.rect=header.rect;mirror.ready=true;
}
async function applyFrame(buffer){
  const length=new DataView(buffer).getUint32(0),header=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,4,length)));
  await applyMessage(header,new Uint8Array(buffer,4+length));
  mirror.since=header.version;
}
// One long response carries every frame; each message is [header length][strip bytes][header][strips].
async function streamMirror(){
  const controller=new AbortController();mirror.controller=controller;mirror.target='stream';
  let received=false;
  const watchdog=setTimeout(()=>{if(!received)controller.abort()},6000);
  try{
    const response=await fetch('/mobile-api/stream',{cache:'no-store',signal:controller.signal});
    if(response.status===401){location.replace('/mobile/login');return 'stop'}
    if(!response.ok||!response.body)throw Error('stream '+response.status);
    const reader=response.body.getReader();
    let buffer=new Uint8Array(0);
    for(;;){
      const {value,done}=await reader.read();if(done)return;
      const joined=new Uint8Array(buffer.length+value.length);joined.set(buffer);joined.set(value,buffer.length);buffer=joined;
      while(buffer.length>=8){
        const sizes=new DataView(buffer.buffer,buffer.byteOffset,8),headLength=sizes.getUint32(0),total=8+headLength+sizes.getUint32(4);
        if(buffer.length<total)break;
        const header=JSON.parse(new TextDecoder().decode(buffer.subarray(8,8+headLength))),strips=buffer.subarray(8+headLength,total);
        buffer=buffer.slice(total);
        received=true;mirror.streamed=true;mirror.failures=0;mirror.alive=performance.now();
        await applyMessage(header,strips);
      }
    }
  }finally{clearTimeout(watchdog)}
}
function stopMirror(){mirror.controller?.abort()}
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopMirror()});
function decodeImage(blob){
  if(window.createImageBitmap)return createImageBitmap(blob);
  return new Promise((resolve,reject)=>{const url=URL.createObjectURL(blob),img=new Image();img.onload=()=>{URL.revokeObjectURL(url);resolve(img)};img.onerror=reject;img.src=url});
}
async function mirrorLoop(){
  for(;;){
    if(document.hidden||view==='full'||!box){await new Promise(r=>setTimeout(r,300));continue}
    if(mirror.mode==='stream'){
      try{if(await streamMirror()==='stop')return}catch{}
      if(document.hidden||view==='full')continue;
      // Some networks buffer long responses; after repeated silence fall back to asking for each frame.
      if(++mirror.failures>=3&&!mirror.streamed)mirror.mode='poll';
      await new Promise(r=>setTimeout(r,Math.min(3000,250*mirror.failures)));
      continue;
    }
    const target=mirrorTarget(),controller=new AbortController();
    mirror.controller=controller;mirror.target=target;
    const since=mirror.key&&mirror.since!==undefined?mirror.since:-1;
    const timer=setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetch('/mobile-api/frame?target='+target+'&since='+since+'&key='+encodeURIComponent(mirror.key||''),{cache:'no-store',signal:controller.signal});
      if(response.status===401){location.replace('/mobile/login');return}
      if(!response.ok)throw Error('frame '+response.status);
      await applyFrame(await response.arrayBuffer());
      mirror.alive=performance.now();
      if(!mirror.key)await new Promise(r=>setTimeout(r,150));
    }catch(e){if(!controller.signal.aborted||mirror.target===target)await new Promise(r=>setTimeout(r,700))}
    finally{clearTimeout(timer)}
  }
}
// A different target (for example a menu that just opened) must not wait for the old long poll.
function retargetMirror(){if(mirror.mode==='poll'&&mirror.controller&&mirror.target!==mirrorTarget()){mirror.target=null;mirror.controller.abort()}}
function resetMirror(){mirror.key=null;mirror.ready=false;mirror.version=-1;mirror.controller?.abort();renderDirty=true}
function pictureHeader(){
  if(!box||!mirror.ready)return null;
  try{
    headerContext.fillStyle='#fff';headerContext.fillRect(0,0,64,16);
    if(!drawDesktop(headerContext,box.x+106,box.y+48,box.width-106,90,0,0,64,16))return null;
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
function rowSignature(y){return box?regionAverages(box.x+(box.split||104)+10,y-30,90,60,6,6):null}
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
  const dpr=Math.min(2,devicePixelRatio||1),width=Math.round(panes.width*dpr),height=Math.round(panes.height*dpr);
  if(mobileCanvas.width!==width||mobileCanvas.height!==height){mobileCanvas.width=width;mobileCanvas.height=height}
  mobileCanvas.style.width=panes.width+'px';mobileCanvas.style.height=panes.height+'px';
  retargetMirror();
}
function localScrolling(){return panes&&(view==='chat'||view==='list')&&!popupActive()&&box?.chatReady}
// When WeChat scrolls, keep the same content under the finger instead of letting it jump.
// At the default position (newest message, top of the list) the picture simply follows WeChat.
function followShift(moves){
  if(!localScrolling()||!mirror.rect||Math.abs(localOffset)<1&&performance.now()-lastUserScroll>600)return;
  // Neighbouring segments differ by a pixel at most; use the one under the middle of the screen.
  const middle=panes.start+(panes.height/panes.scale-90)/2-mirror.rect[1];
  const move=moves.find(([,start,end])=>middle>=start&&middle<end)||moves.reduce((a,b)=>b[2]-b[1]>a[2]-a[1]?b:a);
  localOffset+=move[0];fitMobilePicture();
}
let lastPrefetch=0,lastUserScroll=0;
// Scroll the captured window locally first; the remainder scrolls WeChat itself.
function scrollLocal(delta){
  if(!localScrolling())return delta;
  lastUserScroll=performance.now();
  const before=panes.start,next=Math.max(panes.minStart,Math.min(panes.maxStart,before+delta/panes.scale));
  // Ask WeChat to scroll before the captured window runs out, so scrolling continues locally.
  const room=delta>0?panes.maxStart-next:next-panes.minStart;
  if(delta&&room<500&&performance.now()-lastPrefetch>350){
    lastPrefetch=performance.now();
    remoteScroll(Math.sign(delta)*3,{x:Math.round(box.x+(box.split||104)+300),y:Math.round(panes.start+(panes.height/panes.scale)/2)});
  }
  if(next===before)return delta;
  localOffset=next-panes.base;followUntil=0;fitMobilePicture();
  return delta-(next-before)*panes.scale;
}
function findContentBottom(now){
  if(view!=='chat'||popupActive()||!box.chatReady||box.compactList||!mirror.key?.startsWith('main:'))return;
  const following=now<followUntil;
  if(now-boundsTime<(following?120:400))return;
  boundsTime=now;
  const top=box.y+138,bottom=box.y+box.height-258,height=bottom-top;
  if(height<=0)return;
  // Determine only the bottom of the visible message area, without OCR or storing pixels.
  if(boundsCanvas.width!==64)boundsCanvas.width=64;if(boundsCanvas.height!==Math.ceil(height/4))boundsCanvas.height=Math.ceil(height/4);
  boundsContext.fillStyle='#fff';boundsContext.fillRect(0,0,64,boundsCanvas.height);
  if(!drawDesktop(boundsContext,box.x+(box.split||104)+8,top,box.width-(box.split||104)-28,height,0,0,64,boundsCanvas.height))return;
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
  const next=last<0?top:Math.min(bottom,top+(last+1)*4+32);
  if(following)localOffset=0;
  if(contentBottom===null||Math.abs(next-contentBottom)>8||(following&&panes&&panes.start!==panes.base)){contentBottom=next;fitMobilePicture()}
}
function paintMobile(now){
  requestAnimationFrame(paintMobile);
  if(!box||view==='full'||document.hidden)return;
  const waiting=document.querySelector('#waiting');
  if(!mirror.ready){waiting.textContent='正在加载画面…';waiting.classList.remove('hidden');return}
  if(visualPending){
    if(waitingHeader&&headerChanged(waitingHeader)){visualPending=false;waitingHeader=null;controls()}
  }
  try{findContentBottom(now)}catch{}
  if(!renderDirty&&paintedVersion===mirror.version||!panes)return;
  try{
    const dpr=mobileCanvas.width/panes.width;
    pictureContext.setTransform(dpr,0,0,dpr,0,0);
    pictureContext.fillStyle='#fafafa';pictureContext.fillRect(0,0,panes.width,panes.height);
    for(const part of panes.sections)drawDesktop(pictureContext,part.x,part.y,part.width,part.height,0,part.dy,panes.width,part.height*panes.scale);
    renderDirty=false;paintedVersion=mirror.version;
    waiting.classList.add('hidden');
  }catch{}
}
requestAnimationFrame(paintMobile);
mirrorLoop();
