'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const storage=()=>{const map=new Map();return {getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};};
function connection(store,network){
 let now=100000;class Clock extends Date{static now(){return now;}}
 const context={localStorage:store,location:{origin:'https://home.test',protocol:'https:',hostname:'home.test'},performance,URL,AbortController,Date:Clock,Math,Set,Promise,CustomEvent:class{},setTimeout,clearTimeout,setInterval:()=>0,fetch:network,confirm:()=>true};
 context.window={isSecureContext:true,dispatchEvent(){},addEventListener(){}};
 context.document={head:{appendChild(){}},createElement:()=>({}),getElementById:()=>null,addEventListener(){},hidden:false};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../shared/connection.js'),'utf8'),context);
 return {api:context.window.DPConnection,tick:()=>now+=20000};
}
test('connection: priorities survive reload, failover, untrusted isolation and no failover on 401',async()=>{
 const store=storage(),id='test-system';
 store.setItem('discipline:connections:v2',JSON.stringify({order:['custom','home','standard'],urls:{home:'https://home.test',standard:'https://standard.test',custom:'https://custom.test'},trusted:{'https://home.test':id,'https://custom.test':id},systemId:id}));
 const down=new Set(),calls=[];let apiStatus=200;
 const network=async(url,opts)=>{calls.push({url,opts});if(down.has(new URL(url).origin))throw Error('offline');return {ok:true,status:url.includes('/health')?200:apiStatus,json:async()=>({ok:true,apiVersion:2,systemId:id,ready:true})};};
 const c=connection(store,network);await c.api.monitor();assert.equal(c.api.status().active,'custom');
 apiStatus=401;await c.api.request('/me/state',{method:'GET',headers:{Authorization:'Bearer test'}});assert.equal(c.api.status().active,'custom');
 down.add('https://custom.test');await c.api.monitor();await c.api.monitor();assert.equal(c.api.status().active,'home');
 down.add('https://home.test');await c.api.monitor();await c.api.monitor();await assert.rejects(c.api.request('/me/state',{method:'GET'}));
 assert.ok(calls.filter(c=>c.url.startsWith('https://standard.test')).every(c=>!c.opts.headers));
 down.clear();await c.api.monitor();await c.api.monitor();c.tick();await c.api.monitor();assert.equal(c.api.status().active,'custom');
 const reloaded=connection(store,network);await reloaded.api.monitor();assert.equal(reloaded.api.status().active,'custom');
});
test('preferred home switches immediately, falls back to reserve and persists the choice',async()=>{
 const store=storage(),id='same-system',down=new Set();
 store.setItem('discipline:connections:v2',JSON.stringify({order:['standard','custom','home'],urls:{home:'https://home.test',standard:'https://standard.test',custom:'https://reserve.test'},trusted:{'https://home.test':id,'https://standard.test':id,'https://reserve.test':id},systemId:id}));
 const network=async url=>{if(down.has(new URL(url).origin))throw Error('offline');return {ok:true,status:200,json:async()=>({ok:true,apiVersion:2,systemId:id,ready:true})};};
 const c=connection(store,network);await c.api.monitor();assert.equal(c.api.status().active,'standard');
 c.api.prefer('home');assert.equal(c.api.status().active,'home');await c.api.monitor();assert.equal(c.api.settings.order.join(','),'home,custom,standard');
 down.add('https://home.test');await c.api.monitor();await c.api.monitor();assert.equal(c.api.status().active,'custom');
 const reload=connection(store,network);await reload.api.monitor();assert.equal(reload.api.settings.order[0],'home');assert.equal(reload.api.status().active,'custom');
 down.clear();await reload.api.monitor();await reload.api.monitor();reload.tick();await reload.api.monitor();assert.equal(reload.api.status().active,'home');
});
function queue(store,api){
 const html=fs.readFileSync(path.resolve(__dirname,'../../user-pwa/index.html'),'utf8');
 const code=html.slice(html.indexOf("  var syncStatus = 'local'"),html.indexOf('  /* ---------- Аккаунт / карточки'));
 const c={localStorage:store,currentUser:{id:7},state:{habits:[{id:'h',name:'A'}],logs:{},progress:{},workouts:[],totals:{}},api,navigator:{onLine:false},document:{hidden:false,addEventListener(){}},window:{DPConnection:{settings:{systemId:'one'},markSynced(){}},addEventListener(){}},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},isLoggedIn:()=>true,saveLocal(){},renderCurrentView(){},showToast(){},refreshTrainerNotificationQuiet(){},console};
 vm.createContext(c);vm.runInContext(code+'\nrenderOutbox=function(){};refreshChrome=function(){};',c);return c;
}
test('outbox: offline reload keeps operation; uncertain reply retries same ID; edits during send survive',async()=>{
 const store=storage();let fail=true,resolveSend;const ids=[];
 const api={request:async(m,p,data)=>{ids.push(data.operationId);if(fail)throw Object.assign(Error('lost reply'),{status:0});return new Promise(r=>resolveSend=()=>r({...data,version:1}));}};
 const a=queue(store,api);a.scheduleSync();const id=a.readOutbox()[0].payload.operationId;
 const b=queue(store,api);await b.pushRemote();assert.equal(b.readOutbox()[0].payload.operationId,id);
 fail=false;const sent=b.pushRemote();b.state.habits[0].name='B';b.scheduleSync();assert.equal(b.readOutbox().length,2);
 // Stop automatic next send to inspect the committed queue transition.
 vm.runInContext('var originalPush=pushRemote;pushRemote=function(){return Promise.resolve();};',b);
 resolveSend();await sent;assert.equal(ids[0],ids[1]);assert.equal(b.readOutbox().length,1);assert.equal(b.readOutbox()[0].payload.baseVersion,1);assert.equal(b.state.habits[0].name,'B');
});
test('outbox: late pull cannot replace a different account or a newly edited state',async()=>{
 let resolve;const c=queue(storage(),{get:()=>new Promise(r=>resolve=r)});const pull=c.pullRemote();c.currentUser={id:8};resolve({habits:[{name:'Other account'}],version:3});await pull;assert.equal(c.state.habits[0].name,'A');
 const pull2=c.pullRemote();c.state.habits[0].name='Local edit';c.scheduleSync();resolve({habits:[{name:'Stale server'}],version:3});await pull2;assert.equal(c.state.habits[0].name,'Local edit');
});
