const vm=require('vm'),fs=require('fs'),assert=require('assert');
const source=fs.readFileSync('mobile/web/app.js','utf8');
const code=source.slice(source.indexOf('let scrollPending='),source.indexOf('function applyView()'));
(async()=>{
  const requests=[];let resolve,reject;
  const c={viewOnly:false,busy:false,navigating:false,box:{conversation:'1:chat'},activePopup:()=>null,
    call(path,payload){requests.push(payload);return new Promise((yes,no)=>{resolve=yes;reject=no})},
    acceptLayout(layout){c.box=layout},message(){}};
  vm.runInNewContext(code,c);
  const point={x:1500,y:1500};
  c.remoteScroll(-3,point);for(let i=0;i<200;i++)c.remoteScroll(-8,point);
  assert.equal(requests.length,1,'only one request is in flight');resolve();await new Promise(setImmediate);
  assert.equal(requests[1].amount,-12,'fast flings retain bounded recent intent');
  reject(Object.assign(Error('changed'),{layout:{conversation:'2:chat'}}));await new Promise(setImmediate);
  assert.equal(c.box.conversation,'2:chat','a rejected scroll resynchronizes the layout');
  c.remoteScroll(3,point);assert.equal(requests[2].conversation,'2:chat');resolve();await Promise.resolve();
  assert.equal(requests.length,3,'stale queued requests are discarded');
  await new Promise(setImmediate);c.remoteScroll(3,point);c.box={conversation:'new chat'};
  reject(Object.assign(Error('late changed'),{layout:{conversation:'old chat'}}));await new Promise(setImmediate);
  assert.equal(c.box.conversation,'new chat','late scroll errors cannot restore a previous chat');
  console.log('PASS bounded scroll queue, single request in flight and stale-layout recovery');
})().catch(error=>{console.error(error);process.exitCode=1});
