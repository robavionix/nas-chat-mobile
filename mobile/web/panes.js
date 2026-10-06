// Both drawing and touch coordinates use the same crop, in desktop pixels.
// The pane header stays fixed; below it the list scrolls down from the top and the chat scrolls up from the latest message.
function mobilePanes(box, view, viewportWidth, viewportHeight, zoom=1, contentBottom=null, offset=0) {
  const split=box.split||104, left=box.x+split+2, top=box.y+48, width=box.width-split-2, header=90;
  const scale=viewportWidth/width*zoom, first=top+header;
  const visible=Math.max(1,viewportHeight/scale-header);
  let height,minStart,maxStart,base;
  if(view==='list'){
    const last=box.y+box.height-4;
    height=Math.min(visible,last-first);minStart=base=first;maxStart=first+Math.max(0,last-first-height);
  }else{
    const bottom=box.y+box.height-258;
    height=Math.min(visible,bottom-first);
    const end=Math.min(bottom,Math.max(first+height,contentBottom??bottom));
    minStart=first;maxStart=base=end-height;
  }
  const start=Math.max(minStart,Math.min(maxStart,base+offset));
  return {width:width*scale,height:(header+height)*scale,scale,start,base,minStart,maxStart,
    sections:[{x:left,y:top,width,height:header,dy:0},{x:left,y:start,width,height,dy:header*scale}]};
}
function panePosition(panes, x, y) {
  const section=panes.sections.find(s=>y>=s.dy&&y<s.dy+s.height*panes.scale)||panes.sections.at(-1);
  return {x:Math.round(section.x+x/panes.scale),y:Math.round(section.y+(y-section.dy)/panes.scale)};
}
if(typeof module!=='undefined')module.exports={mobilePanes,panePosition};
