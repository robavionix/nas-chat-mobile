// A short lease covers full-desktop mode and browsers suspended without a close event.
(() => {
  const id=Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join('');
  let sequence=0;
  function report(visible){
    fetch('/mobile-api/presence',{method:'POST',headers:{'Content-Type':'application/json','X-Mobile-Control':'1'},
      body:JSON.stringify({id,visible,sequence:++sequence}),keepalive:true,cache:'no-store'}).catch(()=>{});
  }
  document.addEventListener('visibilitychange',()=>report(!document.hidden));
  window.addEventListener('pagehide',()=>report(false));
  window.addEventListener('pageshow',()=>report(!document.hidden));
  setInterval(()=>{if(!document.hidden)report(true)},15000);
  report(!document.hidden);
})();
