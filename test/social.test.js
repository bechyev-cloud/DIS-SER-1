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

test('social: explicit acceptance, private goals, group chat and revocation',async()=>{
 try{
 const a=await boot('social');
 const register=async(username,displayName)=>(await a.request('/api/auth/register','POST',{username,displayName,password:'test-password-12345'})).data;
 const alice=await register('alice','Алиса Иванова'),bob=await register('bobby','Борис Петров'),eve=await register('eveuser','Ева');
 const call=(u,path,method='GET',body)=>a.request('/api'+path,method,body,u.token);
 assert.equal((await call(alice,'/friends/search?q='+encodeURIComponent('ПЕТРОВ'))).data.users[0].id,bob.user.id);
 assert.equal((await call(alice,'/friends/'+bob.user.id+'/goals')).status,403);
 assert.equal((await call(alice,'/friends/request','POST',{userId:bob.user.id})).status,201);
 const pending=(await call(bob,'/friends')).data.incoming[0];assert.equal(pending.id,alice.user.id);
 assert.equal((await call(bob,'/friends/request','POST',{userId:alice.user.id})).status,409);
 assert.equal((await call(eve,'/friends/'+pending.friendshipId+'/accept','POST',{})).status,404);
 assert.equal((await call(bob,'/friends/'+pending.friendshipId+'/accept','POST',{})).status,200);
 const Database=require('better-sqlite3'),db=new Database(path.join(a.dir,'database','discipline.sqlite'));
 const ins=db.prepare('INSERT INTO habits(id,user_id,name,type,config_json,created_at,updated_at,assigned_by) VALUES(?,?,?,?,?,?,?,?)');
 ins.run('personal',bob.user.id,'Чтение','simple','{}','2026-10-01',Date.now(),null);
 ins.run('private-workout',bob.user.id,'Тренировка','workout','{}','2026-10-01',Date.now(),null);
 ins.run('private-diet',bob.user.id,'Питание','simple',JSON.stringify({modes:{nutrition:{}}}),'2026-10-01',Date.now(),null);
 ins.run('private-assignment',bob.user.id,'От тренера','assignment','{}','2026-10-01',Date.now(),alice.user.id);
 db.prepare('INSERT INTO habit_logs(user_id,habit_id,date_key,done,updated_at) VALUES(?,?,?,?,?)').run(bob.user.id,'personal','2026-10-03',1,Date.now());db.close();
 const saved=(await call(bob,'/me/state')).data;
 const personal=saved.habits.find(h=>h.id==='personal');personal.config.schedule={start:'2026-10-01',end:'2026-11-01'};personal.config.goal={enabled:true,repeat:'daily',mode:'count',total:1000,daily:50,unit:'страниц',buttons:[{value:10,label:'Чтение'}]};
 saved.progress={'2026-10-02':{personal:{goalAmount:50}},'2026-10-03':{personal:{goalAmount:20}}};
 assert.equal((await call(bob,'/me/state','PUT',{...saved,baseVersion:saved.version,operationId:crypto.randomUUID()})).status,200);
 const loaded=(await call(bob,'/me/state')).data;assert.equal(loaded.progress['2026-10-03'].personal.goalAmount,20);assert.equal(loaded.habits.find(h=>h.id==='personal').config.goal.daily,50);assert.equal(loaded.habits.find(h=>h.id==='personal').config.schedule.end,'2026-11-01');
 const goals=await call(alice,'/friends/'+bob.user.id+'/goals');assert.equal(goals.status,200);assert.deepEqual(goals.data.goals.map(g=>g.id),['personal']);assert.equal(goals.data.goals[0].completedDays,1);assert.equal(goals.data.goals[0].totalAmount,70);assert.equal(goals.data.goals[0].target,1000);
 assert.equal((await call(bob,'/friends/'+alice.user.id+'/goals')).status,200);
 assert.equal((await call(eve,'/friends/'+bob.user.id+'/goals')).status,403);
 const group=(await call(alice,'/communities','POST',{name:'Общая группа'})).data;
 assert.equal((await call(alice,'/communities/'+group.id+'/members','POST',{userId:bob.user.id})).status,200);
 assert.equal((await call(bob,'/communities/'+group.id+'/messages','POST',{text:'Привет'})).status,201);
 assert.equal((await call(alice,'/communities/'+group.id+'/messages')).data.messages[0].senderName,'Борис Петров');
 const replica=await boot('social-replica'),pairing=await a.command('pairing');await replica.command('join',{options:{url:a.url,...pairing}});await waitFor(async()=>!!(await replica.command('status')).lastSuccess);const mirror=new Database(path.join(replica.dir,'database','discipline.sqlite'),{readonly:true});assert.equal(mirror.prepare('SELECT text FROM community_messages').get().text,'Привет');assert.equal(JSON.parse(mirror.prepare("SELECT progress_json FROM habit_progress WHERE habit_id='personal' AND date_key='2026-10-03'").get().progress_json).goalAmount,20);mirror.close();
 assert.equal((await call(eve,'/communities/'+group.id+'/messages')).status,403);
 assert.equal((await call(eve,'/communities/'+group.id+'/messages','POST',{text:'Нет'})).status,403);
 assert.ok((await call(bob,'/messages/threads')).data.threads.some(t=>t.type==='community'));
 await call(alice,'/communities/'+group.id+'/members/'+bob.user.id,'DELETE');assert.equal((await call(bob,'/communities/'+group.id+'/messages')).status,403);
 await call(alice,'/friends/'+pending.friendshipId,'DELETE');assert.equal((await call(alice,'/friends/'+bob.user.id+'/goals')).status,403);
 assert.equal((await call(alice,'/messages','POST',{recipientId:bob.user.id,text:'Нет'})).status,403);
 }finally{for(const c of children)if(c.exitCode===null)c.kill();}
});

