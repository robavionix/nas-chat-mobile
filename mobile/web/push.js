// Ask permission only on an explicit tap. Server ownership is authoritative:
// logging out never silently re-enables an old browser subscription.
(() => {
  const panel=document.querySelector('#push-settings');if(!panel)return;
  if(/^[\d.]+$/.test(location.hostname)||location.hostname.endsWith('.local'))return;
  panel.hidden=false;
  const toggle=panel.querySelector('#push-toggle'),preview=panel.querySelector('#push-preview'),test=panel.querySelector('#push-test'),info=panel.querySelector('#push-info');
  let state=null,registration=null,subscription=null,identity=null,active=null,working=false,notice='',revision=0;
  const supported=isSecureContext&&'serviceWorker'in navigator&&'PushManager'in window&&'Notification'in window;
  const iphone=/iPhone|iPad|iPod/.test(navigator.userAgent)||navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1;
  const installed=window.matchMedia?.('(display-mode: standalone)').matches||navigator.standalone===true;
  const keyBytes=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4)),c=>c.charCodeAt(0));
  async function subscriptionId(value){
    if(!value)return null;
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value.endpoint));
    return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
  }
  function render(){
    toggle.textContent='消息推送：'+(active?'开启':'关闭');toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked',String(!!active));
    preview.textContent='通知显示内容：'+(active?.preview?'开启':'关闭');preview.setAttribute('role','switch');preview.setAttribute('aria-checked',String(!!active?.preview));
    toggle.disabled=working||!supported||!state?.available||!registration||iphone&&!installed;
    preview.disabled=test.disabled=working||!active;
    info.textContent=notice||(!supported?'当前浏览器不支持后台推送。':iphone&&!installed?'请先通过 Safari 分享菜单添加到主屏幕，再从主屏幕打开并开启推送。':!state?'正在检查推送…':!state.available?'外网推送尚未配置。':Notification.permission==='denied'?'通知权限已关闭，请在系统设置中允许通知后再开启。':active?(state.deliveryError||(state.source==='connected'?'已开启。锁屏或关闭页面后也可接收桌面聊天客户端发出的新消息通知。':'已开启，正在等待桌面聊天客户端通知源连接。')):'关闭时不会接收通知。开启后可发送测试通知；默认隐藏消息内容。');
  }
  async function refresh(){
    if(!supported){render();return}
    const generation=revision,next=await call('push/status');
    let reg=null,sub=null,id=null;
    if(next.available){
      const ready=(async()=>{
        const value=await (typeof mobileWorkerRegistration!=='undefined'?mobileWorkerRegistration:navigator.serviceWorker.ready);
        if(!value)throw Error('推送初始化失败，请刷新后重试');
        const worker=value.installing||value.waiting;
        if(worker&&worker.state!=='activated')await new Promise((resolve,reject)=>{
          worker.addEventListener('statechange',()=>{if(worker.state==='activated')resolve();else if(worker.state==='redundant')reject(Error('推送更新失败，请刷新后重试'))});
        });
        return value;
      })();
      reg=await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('推送初始化超时，请刷新后重试')),9000))]);
      sub=await reg.pushManager.getSubscription();id=await subscriptionId(sub);
    }
    if(working||generation!==revision)return;
    state=next;registration=reg;subscription=sub;identity=id;
    active=next.available?next.subscriptions.find(item=>item.id===id)||null:null;
    render();
  }
  toggle.addEventListener('click',async()=>{
    if(working||toggle.disabled)return;
    working=true;revision++;notice='';render();
    try{
      if(active){
        await call('push/unsubscribe',{id:identity});active=null;
        // Server revocation prevents delivery even when browser cleanup fails.
        try{await subscription?.unsubscribe()}catch{}
        subscription=null;identity=null;notice='消息推送已关闭。';
      }else{
        // This must precede asynchronous work: iOS requires a direct user gesture.
        const permission=Notification.permission==='granted'?'granted':await Notification.requestPermission();
        if(permission!=='granted')throw Error(permission==='denied'?'系统未允许通知，请在系统设置中开启后重试。':'尚未允许通知，可稍后再次开启。');
        const wanted=keyBytes(state.publicKey),existing=subscription?.options?.applicationServerKey;
        if(subscription&&existing&&(existing.byteLength!==wanted.length||!Array.from(new Uint8Array(existing)).every((value,index)=>value===wanted[index]))){
          await subscription.unsubscribe();subscription=null;
        }
        subscription=subscription||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:wanted});
        const result=await call('push/subscribe',{subscription:subscription.toJSON(),preview:false});
        identity=result.id;active={id:identity,preview:false};notice='消息推送已开启。点“发送测试通知”确认手机能收到。';
      }
    }catch(error){notice=error.message||'推送设置失败，请稍后重试。'}finally{working=false;render()}
  });
  preview.addEventListener('click',async()=>{
    if(working||!active)return;working=true;revision++;notice='';render();
    try{const value=!active.preview;await call('push/subscribe',{subscription:subscription.toJSON(),preview:value});active.preview=value;notice=value?'通知将显示发送者和消息内容。':'通知只显示新消息提醒。'}
    catch(error){notice=error.message}finally{working=false;render()}
  });
  test.addEventListener('click',async()=>{
    if(working||!active)return;working=true;revision++;notice='';render();
    try{
      const result=await call('push/test',{id:identity});
      notice='正在验证推送投递…';render();
      if(!result.testId){notice='测试通知已排队，请检查手机通知。';return}
      for(let count=0;count<20;count++){
        const next=await call('push/status'),record=next.subscriptions?.find(item=>item.id===identity),report=record?.test;
        if(!record)throw Error('订阅已失效，请关闭后重新开启推送。');
        if(report?.id===result.testId&&report.state==='accepted'){notice='推送服务已接受测试通知。请检查通知中心；若未显示，请检查系统通知和专注模式。';return}
        if(report?.id===result.testId&&report.state==='error')throw Error(report.error);
        await new Promise(resolve=>setTimeout(resolve,900));
      }
      notice='尚未获得投递确认，请稍后重新测试。';
    }catch(error){notice=error.message}finally{working=false;render()}
  });
  async function openInbox(){
    for(let count=0;count<30;count++){
      if(box&&!busy&&!navigating&&!popupActive()){await setView('list');return}
      await new Promise(resolve=>setTimeout(resolve,300));
    }
  }
  navigator.serviceWorker?.addEventListener('message',event=>{if(event.data?.type==='nas-notification-open')openInbox()});
  if(new URLSearchParams(location.search).get('notifications')==='1'){
    const url=new URL(location.href);url.searchParams.delete('notifications');history.replaceState(null,'',url);openInbox();
  }
  refresh().catch(error=>{notice=error.message;render()});
  setInterval(()=>{if(!document.hidden&&menu.classList.contains('open')&&!working){notice='';refresh().catch(()=>{})}},30000);
})();
