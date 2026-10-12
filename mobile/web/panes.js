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
  return {width:outputWidth,height:outputHeight,headerHeight,scale,start,base,minStart,maxStart,
    sections:[...headers,body]};
}
function panePosition(panes, x, y) {
  const section=panes.sections.find(s=>x>=(s.fillEdges?0:s.dx||0)&&x<(s.fillEdges?panes.width:(s.dx||0)+(s.dw||panes.width))&&y>=s.dy&&y<s.dy+s.height*(s.scale||panes.scale));
  if(!section)return null;
  const scale=section.scale||panes.scale;
  const nativeX=section.x+(x-(section.dx||0))/scale;
  return {x:Math.max(section.x,Math.min(section.x+section.width-1,Math.round(nativeX))),y:Math.round(section.y+(y-section.dy)/scale)};
}
if(typeof module!=='undefined')module.exports={mobilePanes,panePosition,mobilePaneRegion};
