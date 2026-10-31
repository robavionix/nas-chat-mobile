// Keep hardware Return on the same guarded, idempotent path as the Send button.
(() => {
  const field=document.querySelector('#draft'),button=document.querySelector('#send');
  if(!field||!button)return;
  let imeActive=false,committedAt=-Infinity;
  field.setAttribute('enterkeyhint','send');
  field.addEventListener('compositionstart',()=>{imeActive=true;committedAt=-Infinity});
  field.addEventListener('compositionend',()=>{imeActive=false;committedAt=performance.now()});
  field.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.key!=='Enter'||event.shiftKey||event.ctrlKey||event.altKey||event.metaKey)return;
    // WebKit may dispatch compositionend before the Return that selected a
    // Chinese candidate. isComposing alone cannot distinguish that Return.
    if(imeActive||event.isComposing||event.keyCode===229)return;
    event.preventDefault();
    if(event.repeat||performance.now()-committedAt<60)return;
    if(typeof controls==='function')controls();
    if(!button.disabled)button.click();
  });
})();
