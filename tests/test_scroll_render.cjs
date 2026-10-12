const vm=require('vm'),fs=require('fs'),assert=require('assert');
const {mobilePanes,panePosition}=require('../mobile/web/panes.js');
const source=fs.readFileSync('mobile/web/render.js','utf8');
const region={x:1135,y:120,width:2453,height:5187,header:168,headerWidth:1260,headerRight:570,fillViewport:true};
const box={client:'qq',chatReady:true,panes:{chat:region}},panes=mobilePanes(box,'chat',390,700);
let nativeDraws=0,copies=[],clock=1000,requests=[];
const c={box,panes,view:'chat',popupActive:()=>false,mobilePaneRegion:()=>region,
  mirror:{epoch:0,key:'main:qq:chat',version:1,rect:[region.x,region.y,region.width,region.height]},
  scrollBodyCanvas:{width:1,height:1},scrollBodyContext:{fillRect(){}},
  pictureContext:{drawImage(...args){copies.push(args)}},drawDesktop(){nativeDraws++;return true},
  localScrolling:()=>true,performance:{now:()=>clock},remoteScroll(...args){requests.push(args)},
  localOffset:0,followUntil:0,stage:{dataset:{}},renderDirty:false,
  fitMobilePicture(){throw Error('touch movement must not resize or relayout the canvas')},JSON,Math};
vm.createContext(c);
vm.runInContext('let scrollCache=null;'+source.slice(source.indexOf('function drawScrollBody('),source.indexOf('// Publish only complete frames.')),c);
const part=panes.sections.at(-1);
assert.equal(c.drawScrollBody(part,3),true);
assert.equal(nativeDraws,1);
const initialY=part.y;
part.y-=100/panes.scale;
assert.equal(c.drawScrollBody(part,3),true);
assert.equal(nativeDraws,1,'local movement reuses the Retina resample');
assert.ok(Math.abs((copies[0][2]-copies[1][2])-300)<1e-6,'100 CSS pixels map to 300 physical pixels');
part.y-=.123;c.drawScrollBody(part,3);
assert.equal(copies.at(-1)[2],Math.round(copies.at(-1)[2]),'cached rows land on physical pixels to preserve text clarity');
c.mirror.version++;
c.drawScrollBody(part,3);assert.equal(nativeDraws,2,'a complete remote frame refreshes the cache');
c.drawScrollBody(part,2);assert.equal(nativeDraws,3,'a pixel density change invalidates the cache');
assert.equal(c.drawScrollBody(part,30),false,'oversized caches use the regular drawing path');
assert.equal(c.scrollBodyCanvas.width*c.scrollBodyCanvas.height,1,'oversized/retired buffers are released');
const list={x:180,y:120,width:949,height:5808,header:156};
c.box={client:'qq',chatReady:true,panes:{list}};c.view='list';c.mobilePaneRegion=()=>list;
c.panes=mobilePanes(c.box,'list',430,800);
assert.equal(c.drawScrollBody(c.panes.sections.at(-1),3),true,'large iPhones cache a bounded band of a long list');
assert.ok(c.scrollBodyCanvas.width*c.scrollBodyCanvas.height<=8*1024*1024);
const listDraws=nativeDraws;c.panes.sections.at(-1).y+=100/c.panes.scale;
c.drawScrollBody(c.panes.sections.at(-1),3);assert.equal(nativeDraws,listDraws,'movement inside the band needs no new resample');
c.box=box;c.view='chat';c.panes=panes;c.mobilePaneRegion=()=>region;
part.y=initialY;
vm.runInContext(source.slice(source.indexOf('let lastPrefetch='),source.indexOf('function findContentBottom(')),c);
assert.ok(Math.abs(c.scrollLocal(-100))<1e-6);
const updated=JSON.parse(c.stage.dataset.panes),body=updated.sections.at(-1);
assert.ok(Math.abs((initialY-body.y)*panes.scale-100)<1e-6);
assert.equal(panePosition(updated,195,body.dy+20).y,Math.round(body.y+20/panes.scale));
clock+=200;c.scrollLocal(-10);clock+=200;c.scrollLocal(-10);
assert.equal(requests.length,1,'prefetch waits for a new remote frame, rather than piling up scrolls');
c.mirror.version++;clock+=200;c.scrollLocal(-10);assert.equal(requests.length,2);
c.releaseScrollCache();assert.equal(c.scrollBodyCanvas.width*c.scrollBodyCanvas.height,1);
// Separate classic scripts share one lexical scope in Safari/Chrome.
new vm.Script(['panes','app','render','navigation','push','touch'].map(name=>fs.readFileSync('mobile/web/'+name+'.js','utf8')).join('\n'));
console.log('PASS Retina scroll cache reuse, bounded allocation, crop-only movement, touch alignment, prefetch backpressure and shared script scope');
