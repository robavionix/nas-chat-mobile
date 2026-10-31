// Both drawing and touch coordinates use the same crop, in desktop pixels.
// The pane header stays fixed; below it the list scrolls down from the top and the chat scrolls up from the latest message.
function mobilePaneRegion(box, view) {
  if(box.panes?.[view])return box.panes[view];
  const split=box.split||104;
  return {x:box.x+split+2,y:box.y+48,width:box.width-split-2,height:box.height-48-(view==='list'?4:258),header:90};
}
function mobilePanes(box, view, viewportWidth, viewportHeight, zoom=1, contentBottom=null, offset=0) {
  const region=mobilePaneRegion(box,view),left=region.x,top=region.y,width=region.width,header=region.header;
  const outputWidth=viewportWidth*zoom,density=region.density||1;
  const scale=outputWidth/width*density, first=top+header;
  const headerScale=viewportWidth/Math.min(width,region.headerWidth||width)*zoom;
  const headerHeight=header*headerScale,visible=Math.max(1,(viewportHeight-headerHeight)/scale);
  let height,minStart,maxStart,base;
  if(view==='list'){
    const last=top+region.height;
    height=Math.min(visible,last-first);minStart=base=first;maxStart=first+Math.max(0,last-first-height);
  }else{
    const bottom=top+region.height;
    height=Math.min(visible,bottom-first);
    const end=Math.min(bottom,Math.max(first+height,contentBottom??bottom));
    minStart=first;maxStart=base=end-height;
  }
  const start=Math.max(minStart,Math.min(maxStart,base+offset));
  const outputHeight=region.fillViewport?Math.max(viewportHeight,headerHeight+height*scale):headerHeight+height*scale;
  let headers=[{x:left,y:top,width,height:header,dy:0}];
  if(headerScale!==scale){
    const total=Math.min(width,region.headerWidth||width),right=Math.min(region.headerRight||0,total/2),firstWidth=total-right;
    headers=[{x:left,y:top,width:firstWidth,height:header,dx:0,dy:0,dw:firstWidth*headerScale,scale:headerScale}];
    if(right)headers.push({x:left+width-right,y:top,width:right,height:header,dx:firstWidth*headerScale,dy:0,dw:right*headerScale,scale:headerScale});
  }
  const body={x:left,y:start,width,height,dy:outputHeight-height*scale};
  if(density!==1)Object.assign(body,{dx:(outputWidth-width*scale)/2,dw:width*scale,fillEdges:true,edgeInset:4*(box.uiScale||1)});
  if(box.client==='qq'&&view==='list'&&density<1){
    const unit=box.uiScale||1;
    Object.assign(body,{dx:5*unit*scale,reflowList:{rightInset:14*unit,trimRight:12*unit}});
  }
  return {width:outputWidth,height:outputHeight,headerHeight,scale,start,base,minStart,maxStart,
    sections:[...headers,body]};
}
function panePosition(panes, x, y) {
  const section=panes.sections.find(s=>x>=(s.fillEdges?0:s.dx||0)&&x<(s.fillEdges?panes.width:(s.dx||0)+(s.dw||panes.width))&&y>=s.dy&&y<s.dy+s.height*(s.scale||panes.scale));
  if(!section)return null;
  const scale=section.scale||panes.scale;
  const nativeX=section.x+(x-(section.dx||0))/scale;
  const right=section.x+section.width-(section.reflowList?.trimRight||1);
  return {x:Math.max(section.x,Math.min(right,Math.round(nativeX))),y:Math.round(section.y+(y-section.dy)/scale)};
}
// Locate the grey, right-aligned time on the same line as a dark chat name.
// Work at logical desktop resolution once per complete frame, never per drag.
function findListTimestamps(pixels,width,height){
  const result=[],nameLeft=76,rightLeft=Math.max(nameLeft+8,width-86);
  let first=-1,last=-1;
  const dark=(i)=>pixels[i+3]>128&&Math.max(pixels[i],pixels[i+1],pixels[i+2])<100;
  function finish(){
    if(first<0||last-first<4||last-first>32)return;
    const top=Math.max(0,first-2),bottom=Math.min(height,last+3),grey=new Uint8Array(width),black=new Uint8Array(width);
    for(let y=top;y<bottom;y++)for(let x=rightLeft;x<width-4;x++){
      const i=(y*width+x)*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2];
      if(dark(i))black[x]=1;
      if(pixels[i+3]>128&&r>=125&&r<=190&&Math.max(r,g,b)-Math.min(r,g,b)<8)grey[x]=1;
    }
    let end=width-5;while(end>=rightLeft&&!grey[end])end--;
    if(end<width-25)return;
    let start=end,gap=0,boundary=rightLeft;
    for(let x=end;x>=rightLeft;x--){
      if(black[x]){boundary=x+1;break}
      if(grey[x]){start=x;gap=0}else if(++gap>12)break;
    }
    if(end-start<4)return;
    const x=Math.max(boundary,start-2),right=Math.min(width,end+3);
    result.push({x,y:top,width:right-x,height:bottom-top});
  }
  for(let y=0;y<height;y++){
    let ink=0;
    for(let x=nameLeft;x<rightLeft;x++)if(dark((y*width+x)*4)&&++ink>=2)break;
    if(ink>=2){if(first<0)first=y;last=y}
    else if(first>=0&&y-last>2){finish();first=last=-1}
  }
  finish();return result;
}
if(typeof module!=='undefined')module.exports={mobilePanes,panePosition,mobilePaneRegion,findListTimestamps};
