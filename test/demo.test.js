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

test('demo grants one month once, trainer access, replication and expiry without changing paid balance',async()=>{try{
 const a=await boot('demo'),register=async username=>(await a.request('/api/auth/register','POST',{username,displayName:username,password:'1234'})).data;
 const coach=await register('democoach'),student=await register('demostudent');const call=(u,p,m='GET',b)=>a.request('/api'+p,m,b,u.token);
 const before=(await call(coach,'/plans/me')).data.billing;
 const demo=await call(coach,'/plans/demo','POST',{});assert.equal(demo.status,200);assert.equal(demo.data.billing.demoActive,true);assert.equal(demo.data.user.role,'TRAINER');
 assert.equal((await call(coach,'/plans/demo','POST',{})).data.billing.demo_until,demo.data.billing.demo_until);
 assert.equal((await call(coach,'/admin/users')).status,403);
 const group=(await call(coach,'/groups','POST',{name:'Демо ученики'})).data;
 assert.equal((await call(coach,'/trainer/groups/'+group.id+'/invite','POST',{username:'demostudent'})).status,201);
 const invitation=(await call(student,'/trainer/invitations')).data.invitations[0];assert.equal((await call(student,'/trainer/invitations/'+invitation.id+'/accept','POST',{})).status,200);
 assert.equal((await call(coach,'/groups/'+group.id+'/habits','POST',{name:'Демо задание'})).status,201);
 const Database=require('better-sqlite3'),db=new Database(path.join(a.dir,'database','discipline.sqlite'));
 const raw=db.prepare('SELECT * FROM billing_accounts WHERE user_id=?').get(coach.user.id);assert.equal(raw.personal_until,before.personal_until);assert.equal(raw.trainer_until,0);assert.equal(raw.seat_used,0);
 const replica=await boot('demo-replica'),pairing=await a.command('pairing');await replica.command('join',{options:{url:a.url,...pairing}});await waitFor(async()=>!!(await replica.command('status')).lastSuccess);
 const mirror=new Database(path.join(replica.dir,'database','discipline.sqlite'),{readonly:true});assert.equal(mirror.prepare('SELECT demo_until FROM billing_accounts WHERE user_id=?').get(coach.user.id).demo_until,raw.demo_until);mirror.close();
 db.prepare('UPDATE billing_accounts SET demo_until=? WHERE user_id=?').run(Date.now()-1,coach.user.id);db.close();
 assert.equal((await call(coach,'/plans/demo','POST',{})).data.billing.demoActive,false);
 assert.equal((await call(coach,'/groups/'+group.id+'/habits','POST',{name:'После демо'})).status,403);
 assert.equal((await call(coach,'/plans/me')).data.user.role,'USER');
 }finally{for(const c of children)if(c.exitCode===null)c.kill();}});
