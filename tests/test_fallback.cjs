const vm=require('vm'),fs=require('fs'),assert=require('assert');
const source=fs.readFileSync('mobile/web/render.js','utf8');
const loop=source.slice(source.indexOf('async function mirrorLoop(){'),source.indexOf('// A different target'));
const STOP=new Error('test finished');
async function exercise(hideOnFailure){
  let time=1000,sockets=0,paints=0;
  const requests=[],statuses=[];
  const mirror={mode:'websocket',key:'old',since:12,epoch:0,ready:true};
  const document={hidden:false};
  const context={frameQuality:()=>'clear',mirror,document,view:'chat',box:{},AbortController,performance:{now:()=>time},
    setTimeout:(_callback,delay)=>{if(delay===300)throw STOP;return 1},clearTimeout:()=>{},
    mirrorTarget:()=> 'main',transportStatus:()=>statuses.push(mirror.mode),
    socketMirror:async()=>{
      sockets++;
      if(sockets===1){document.hidden=hideOnFailure;throw Error('network unavailable')}
      document.hidden=true;
    },
    fetch:async url=>{
      requests.push(url);
      assert.equal(mirror.ready,true,'last picture stays visible during fallback');
      return {status:200,ok:true,arrayBuffer:async()=>new ArrayBuffer(0)};
    },
    applyFrame:async(_buffer,valid)=>{
      assert.equal(valid(),true);paints++;mirror.key='fresh';time=62000;
    }
  };
  vm.runInNewContext(loop,context);
  await assert.rejects(context.mirrorLoop(),error=>error===STOP);
  if(hideOnFailure){
    assert.equal(sockets,1);assert.equal(requests.length,0);assert.equal(mirror.mode,'websocket');
  }else{
    assert.equal(sockets,2,'retry WebSocket after 60 seconds');
    assert.equal(paints,1);assert.equal(requests.length,1);
    assert.equal(requests[0],'/mobile-api/frame?target=main&since=-1&key=&quality=clear');
    assert.deepEqual(statuses,['poll','websocket']);
  }
}
(async()=>{await exercise(false);await exercise(true);console.log('PASS automatic full-frame fallback, last-picture retention, timed retry, background lifecycle')})().catch(error=>{console.error(error);process.exitCode=1});
