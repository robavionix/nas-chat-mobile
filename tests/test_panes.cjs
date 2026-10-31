const assert=require('assert');
const {mobilePanes,panePosition,mobilePaneRegion}=require('../mobile/web/panes.js');
const qq={x:0,y:0,width:960,height:2740,panes:{
  list:{x:60,y:40,width:246,height:2696,header:52},
  chat:{x:308,y:40,width:648,height:2489,header:56}
}};
for(const view of ['list','chat']){
  const region=qq.panes[view],p=mobilePanes(qq,view,390,600);
  assert.equal(p.width,390);
  assert.deepEqual(p.sections[0],{x:region.x,y:region.y,width:region.width,height:region.header,dy:0});
  const point=panePosition(p,195,region.header*p.scale+20);
  assert.equal(point.x,Math.round(region.x+region.width/2));
  assert.ok(point.y>=p.sections[1].y&&point.y<p.sections[1].y+p.sections[1].height);
  assert.ok(p.sections[1].y+p.sections[1].height<=region.y+region.height);
  const scrolled=mobilePanes(qq,view,390,600,1,null,view==='list'?800:-800);
  assert.ok(scrolled.start>=scrolled.minStart&&scrolled.start<=scrolled.maxStart);
}
assert.deepEqual(mobilePaneRegion({x:10,y:20,width:760,height:2740,split:104},'chat'),
  {x:116,y:68,width:654,height:2434,header:90});
assert.deepEqual(mobilePaneRegion({x:10,y:20,width:760,height:2740,split:104},'list'),
  {x:116,y:68,width:654,height:2688,header:90});
const retina={panes:{chat:{x:1135,y:120,width:2213,height:3387,header:168,headerWidth:1170,headerRight:570,fillViewport:true}}};
for(const width of [320,390,430]){
  const p=mobilePanes(retina,'chat',width,680);
  assert.equal(p.height,680);
  assert.ok(Math.abs(p.headerHeight-168*width/1170)<1e-6);
  assert.equal(p.sections.length,3);
  const [left,right,body]=p.sections;
  assert.deepEqual(panePosition(p,100*width/390,20*width/390),{x:1435,y:180});
  const rightPoint=panePosition(p,right.dx+right.dw/2,p.headerHeight/2);
  assert.equal(rightPoint.x,Math.round(1135+2213-570/2));
  assert.equal(rightPoint.y,204);
  const bodyPoint=panePosition(p,width/2,body.dy+20);
  assert.equal(bodyPoint.x,Math.round(1135+2213/2));
  assert.equal(bodyPoint.y,Math.round(body.y+20/p.scale));
  assert.ok(Math.abs(body.dy+body.height*p.scale-680)<1e-6);
  if(body.dy>p.headerHeight+1)assert.equal(panePosition(p,100,p.headerHeight+1),null);
  assert.ok(p.sections.every(s=>s.y+s.height<=120+3387));
}
console.log('PASS QQ portrait crops, readable split header, Retina touch coordinates, scrolling bounds and WeChat geometry');
// Tall capture keeps history outside realistic iPhone portrait viewports,
// while the desktop remains at 3x and the phone touch mapping stays exact.
const buffered={panes:{chat:{x:1135,y:120,width:2453,height:5187,header:168,headerWidth:1260,headerRight:570,fillViewport:true}}};
for(const [width,height] of [[320,440],[390,700],[430,780]]){
  const p=mobilePanes(buffered,'chat',width,height);
  assert.ok((p.maxStart-p.minStart)*p.scale>120,'remote history has at least 120 CSS pixels of local scroll buffer');
  const before=p.sections.at(-1),q=mobilePanes(buffered,'chat',width,height,1,null,-100/p.scale);
  assert.ok(Math.abs((p.start-q.start)*p.scale-100)<1e-6);
  assert.equal(panePosition(q,width/2,before.dy+20).y,Math.round(q.start+20/q.scale));
}
for(const width of [320,390,430]){
  const regular={uiScale:3,panes:{list:{x:180,y:120,width:949,height:5808,header:156}}};
  const dense={uiScale:3,panes:{list:{...regular.panes.list,density:.68}}};
  const p=mobilePanes(dense,'list',width,700),previous=mobilePanes(regular,'list',width,700),body=p.sections.at(-1);
  assert.equal(p.width,width);assert.equal(p.headerHeight,previous.headerHeight,'search controls keep their readable size');
  assert.ok(Math.abs(p.scale/previous.scale-.68)<1e-6);
  assert.ok(body.height>previous.sections.at(-1).height,'smaller list text exposes more rows');
  assert.ok(Math.abs(body.dx+body.dw/2-width/2)<1e-6);
  assert.equal(panePosition(p,width/2,body.dy+30).x,655);
  assert.equal(panePosition(p,1,body.dy+30).x,180,'left background gutter selects the same native row');
  assert.equal(panePosition(p,width-1,body.dy+30).x,1128,'right background gutter stays inside the native list');
}
// QQ reflows its conversation column with the native window. Body text and
// row height must stay fixed on the phone, independent of that column width.
for(const width of [320,390,430]){
  let rowHeight=null;
  for(const nativeWidth of [738,883,949]){
    const box={uiScale:3,panes:{list:{x:180,y:120,width:nativeWidth,height:5808,header:156,density:.68*nativeWidth/(316*3)}}};
    const p=mobilePanes(box,'list',width,700),body=p.sections.at(-1),height=240*p.scale;
    if(rowHeight!==null)assert.ok(Math.abs(height-rowHeight)<1e-6,'native reflow cannot undo mobile list density');
    rowHeight=height;
    assert.equal(panePosition(p,width/2,body.dy+height/2).x,Math.round(180+nativeWidth/2));
    assert.equal(panePosition(p,width-1,body.dy+height/2).x,180+nativeWidth-1);
  }
}
// Keep the accepted text/row size while removing the centered blank gutters.
for(const width of [320,390,430]){
  const list={x:180,y:120,width:883,height:5808,header:156,density:.68*883/(316*3)};
  const regular=mobilePanes({uiScale:3,panes:{list}},'list',width,700);
  const p=mobilePanes({client:'qq',uiScale:3,panes:{list}},'list',width,700),body=p.sections.at(-1);
  assert.equal(p.scale,regular.scale,'font and row scales stay unchanged');
  assert.equal(p.headerHeight,regular.headerHeight,'search controls keep their existing size');
  assert.ok(body.dx<5,'avatar band starts near the left edge on every iPhone width');
  assert.equal(body.reflowList.rightInset,42);
  const y=body.dy+30,row=panePosition(p,1,y).y;
  for(const x of [1,width/2,width-1]){
    const point=panePosition(p,x,y);
    assert.equal(point.y,row,'both edges and the relocated timestamp select the same conversation');
    assert.ok(point.x>=list.x&&point.x<=list.x+list.width-36,'all row taps stay inside the native row, away from its separator');
  }
  assert.deepEqual(panePosition(p,width/2,20),panePosition(regular,width/2,20),'header search mapping stays exact');
}
