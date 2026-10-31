const assert=require('assert'),fs=require('fs'),vm=require('vm');
const {findListTimestamps}=require('../mobile/web/panes.js');
const width=300,height=190,pixels=new Uint8ClampedArray(width*height*4);
function fill(x,y,w,h,r,g=r,b=r){
  for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++)pixels.set([r,g,b,255],(row*width+col)*4);
}
fill(0,0,width,height,244);fill(0,0,width,70,215);
fill(10,12,44,44,20,110,200); // Avatar is coloured and must stay intact.
fill(78,15,100,11,24); // Dark name, with a date separated into two groups.
fill(223,15,17,11,153);fill(251,15,32,11,153);
fill(78,37,205,10,153); // Grey preview must not be treated as a timestamp.
fill(78,95,173,11,24); // Long dark name close to the second date.
fill(253,95,30,11,153);
fill(78,117,205,10,153);
const rects=findListTimestamps(pixels,width,height);
assert.equal(rects.length,2,'both timestamp formats are found, with no preview false positives');
assert.ok(rects[0].x<=223&&rects[0].x+rects[0].width>=283,'date prefix and time are kept together across whitespace');
assert.ok(rects[1].x>250,'timestamp cleanup cannot erase the end of a dark name');
assert.ok(rects.every(rect=>rect.y<30||rect.y>=90&&rect.y<110),'preview lines never move');
const cut=pixels.slice(8*width*4);
assert.equal(findListTimestamps(cut,width,height-8).length,2,'sampling a scroll band preserves row detection');
const noName=pixels.slice();
for(let y=15;y<26;y++)for(let x=78;x<178;x++)noName.set([215,215,215,255],(y*width+x)*4);
assert.equal(findListTimestamps(noName,width,height).length,1,'isolated grey text without a name line stays in place');

// Exercise the actual section painter at native 3x, with an offset crop.
const source=fs.readFileSync('mobile/web/render.js','utf8'),unit=3,draws=[],sampleCanvas={width:1,height:1};
const context={box:{uiScale:unit},listLayoutCanvas:sampleCanvas,
  listLayoutContext:{getImageData(){return {data:pixels}}},findListTimestamps,
  drawDesktop(...args){draws.push(args);return true}};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function listTimestampRects('),source.indexOf('function positionScrollBody(')),context);
const output={},part={x:180,y:600,width:900,height:570,dy:8,dx:4.2,dw:252,edgeInset:12,reflowList:{trimRight:36,rightInset:42}};
assert.equal(context.drawPaneSection(output,part,390,.28),true);
assert.equal(sampleCanvas.width,300);assert.equal(sampleCanvas.height,190,'layout analysis uses bounded logical pixels');
const [background,body,sample,erase1,time1,erase2,time2]=draws;
assert.equal(background[5],0);assert.equal(background[7],390,'selected background extends to both screen edges');
assert.equal(body[3],864,'rounded native separator is excluded');
assert.equal(body[5],part.dx,'avatar and name share the same left-aligned band');
for(const [erase,time] of [[erase1,time1],[erase2,time2]]){
  assert.equal(erase[2],time[2],'old and new date pixels use the same native row');
  assert.equal(erase[6],time[6],'relocated dates keep their exact vertical alignment');
  assert.ok(Math.abs(time[5]+time[7]-(390-42*.28))<1e-9,'dates align at the right screen inset');
  assert.ok(Math.abs(time[7]/time[3]-.28)<1e-9,'date glyphs retain the original text scale');
}
assert.equal(draws.length,7,'only recognised date fields are erased and moved');
context.drawDesktop=()=>{throw Error('oversized layout samples must never allocate or read pixels')};
assert.deepEqual(Array.from(context.listTimestampRects({...part,height:15000})),[]);
console.log('PASS full-width QQ rows, intact names/avatars/previews, complete dates, right alignment and bounded logical sampling');
