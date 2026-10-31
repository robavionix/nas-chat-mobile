const assert=require('assert'),fs=require('fs'),vm=require('vm');
const handlers={},stored=new Map(),deleted=[];let network=0,mode='ok';
const cache={async match(request){return stored.get(request.url)},async put(request,response){stored.set(request.url,response)},
  async keys(){return [...stored.keys()].map(url=>({url}))},async delete(request){return stored.delete(request.url)}};
const self={location:{origin:'https://chat.example.com'},addEventListener(name,fn){handlers[name]=fn},clients:{async claim(){}},skipWaiting(){}};
const response=()=>({ok:true,redirected:mode==='redirect',headers:{get:()=>mode==='html'?'text/html':'application/javascript'},clone(){return this}});
vm.runInNewContext(fs.readFileSync('mobile/web/sw.js','utf8'),{self,URL,
  caches:{async keys(){return ['other-app','nas-mobile-assets-old']},async delete(name){deleted.push(name)},async open(){return cache}},
  async fetch(){network++;return response()}});
async function request(path,method='GET'){
  let result;handlers.fetch({request:{url:new URL(path,self.location.origin).href,method},respondWith(promise){result=promise}});
  if(result)return await result;return null;
}
(async()=>{
  let activation;handlers.activate({waitUntil(promise){activation=promise}});await activation;
  assert.deepEqual(deleted,['nas-mobile-assets-old'],'only this application owns its cache namespace');
  await request('/mobile/render.js?v=build-1');await request('/mobile/render.js?v=build-1');assert.equal(network,1);
  await request('/mobile/render.js?v=build-2');assert.equal(network,2,'version changes fetch new code');
  for(const path of ['/mobile/','/mobile/index.html','/mobile/login','/session/login','/mobile-api/frame','/mobile-api/upload','/mobile/sw.js?v=1','/mobile/lan-config.json','/mobile/render.js','/mobile/render.js?v=1&token=x','https://other.example/mobile/render.js?v=1'])assert.equal(await request(path),null,path+' must not be cached');
  assert.equal(await request('/mobile/render.js?v=1','POST'),null);
  mode='redirect';await request('/mobile/app.js?v=redirect');await request('/mobile/app.js?v=redirect');assert.equal(network,4,'login redirects do not poison script cache');
  mode='html';await request('/mobile/app.js?v=html');await request('/mobile/app.js?v=html');assert.equal(network,6,'error HTML cannot become cached JS');
  mode='ok';for(let i=0;i<40;i++)await request('/mobile/render.js?v=revision-'+i);
  assert.ok(stored.size<=32,'cache growth is bounded');
  console.log('PASS versioned static cache, update invalidation, bounded storage, authentication response rejection and network-only private content');
})().catch(error=>{console.error(error);process.exitCode=1});
