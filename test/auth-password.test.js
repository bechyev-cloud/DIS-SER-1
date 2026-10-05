'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {spawn}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');const net=require('node:net');const crypto=require('node:crypto');
const base=path.resolve(__dirname,'../../.test-data',crypto.randomUUID());fs.mkdirSync(base,{recursive:true});
const children=[];
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function boot(name,assignedPort){
 const p=assignedPort||await port(),dir=path.join(base,name);fs.mkdirSync(dir,{recursive:true});
 const c=spawn(process.execPath,[process.env.TEST_SERVER_ENTRY||path.resolve(__dirname,'../server.js')],{cwd:dir,env:{...process.env,DATA_DIR:dir,PORT:String(p),NODE_ENV:'production',JWT_SECRET:'test-only-secret-'+name,ADMIN_PASSWORD:'test-password-12345',ADMIN_LOGIN:'admin'},stdio:['ignore','pipe','pipe','ipc']});children.push(c);
 let log='';c.stdout.on('data',b=>log+=b);c.stderr.on('data',b=>log+=b);
 await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Server startup timeout: '+log)),12000);c.on('message',m=>{if(m.type==='ready'){clearTimeout(t);resolve();}});c.on('exit',code=>{clearTimeout(t);reject(Error('Server exited '+code+': '+log));});});
 const url='http://127.0.0.1:'+p;
 async function request(route,method='GET',body,token){const r=await fetch(url+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
 function command(action,extra={}){return new Promise((resolve,reject)=>{const id=crypto.randomUUID(),t=setTimeout(()=>reject(Error('IPC timeout')),15000);function receive(m){if(m.id===id){clearTimeout(t);c.off('message',receive);m.error?reject(Error(m.error)):resolve(m.value);}}c.on('message',receive);c.send({id,action,...extra});});}
 return {c,dir,url,request,command};
}
async function waitFor(fn){let last;for(let n=0;n<40;n++){try{last=await fn();if(last)return;}catch(e){}await new Promise(r=>setTimeout(r,250));}throw Error('Condition timeout: '+last);}

test('registration supports four-digit and four-character passwords and rejects shorter ones',async()=>{try{
 const server=await boot('passwords');
 for(const [username,password,status] of [['digits','1234',201],['letters','абвг',201],['short','123',400]]){
  const registered=await server.request('/api/auth/register','POST',{username,password,displayName:username});assert.equal(registered.status,status);
  if(status===201){assert.equal((await server.request('/api/auth/login','POST',{username,password})).status,200);assert.equal((await server.request('/api/auth/login','POST',{username,password:'wrong'})).status,401);}
 }
}finally{for(const c of children)if(c.exitCode===null)c.kill();}});
