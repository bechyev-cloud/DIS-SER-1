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
test('four-part system: API, conflict, retries, isolation, replica journal, files, partition',async()=>{
 try{
 const a=await boot('authority');
 await assert.rejects(boot('occupied',Number(new URL(a.url).port)),/Порт занят/);
 assert.equal((await a.request('/api/health')).data.apiVersion,2);
 assert.equal((await fetch(a.url+'/user/')).status,200);assert.equal((await fetch(a.url+'/admin/')).status,200);assert.equal((await fetch(a.url+'/shared/connection.js')).status,200);
 const login=await a.request('/api/auth/login','POST',{username:'admin',password:'test-password-12345'});assert.equal(login.status,200);const admin=login.data.token;
 const registered=await a.request('/api/auth/register','POST',{username:'tester',password:'test-password-12345',displayName:'Тест'});assert.equal(registered.status,201);const token=registered.data.token;
 assert.equal((await a.request('/api/features')).data.communities,false);
 assert.equal((await a.request('/api/admin/modes/communities','PATCH',{enabled:true},token)).status,403);
 assert.equal((await a.request('/api/admin/modes/communities','PATCH',{enabled:true},admin)).status,200);
 assert.equal((await a.request('/api/features')).data.communities,true);
 const payload={baseVersion:0,operationId:crypto.randomUUID(),habits:[{id:'habit-test',name:'Чтение',createdAt:'2026-10-02'}],logs:{},progress:{},workouts:[],totals:{}};
 const first=await a.request('/api/me/state','PUT',payload,token);assert.equal(first.status,200);assert.equal(first.data.version,1);
 const repeated=await a.request('/api/me/state','PUT',payload,token);assert.deepEqual(repeated.data,first.data);
 const conflict=await a.request('/api/me/state','PUT',{...payload,operationId:crypto.randomUUID()},token);assert.equal(conflict.status,409);
 let b=await boot('replica');const pairing=await a.command('pairing');await b.command('join',{options:{url:a.url,...pairing}});
 await waitFor(async()=>!!(await b.command('status')).lastSuccess);
 const Database=require('better-sqlite3');let mirrored=new Database(path.join(b.dir,'database','discipline.sqlite'),{readonly:true});assert.equal(mirrored.prepare('SELECT name FROM habits WHERE id=?').get('habit-test').name,'Чтение');mirrored.close();
 await new Promise(r=>{b.c.once('exit',r);b.c.send({id:'restart',action:'stop'});});b=await boot('replica');
 assert.equal((await a.request('/api/admin/modes/gym','PATCH',{enabled:false},admin)).status,200);
 const userModes=await b.request('/api/me/modes','GET',undefined,token);assert.equal(userModes.data.modes.gym.enabled,false);assert.equal(userModes.data.modes.gym.locked,true);
 fs.writeFileSync(path.join(a.dir,'uploads','test.png'),Buffer.from('test-attachment'));
 const deletion=await a.request('/api/me/state','PUT',{...payload,baseVersion:1,operationId:crypto.randomUUID(),habits:[]},token);assert.equal(deletion.status,200);
 await waitFor(async()=>{const d=new Database(path.join(b.dir,'database','discipline.sqlite'),{readonly:true});const n=d.prepare('SELECT COUNT(*) AS n FROM habits').get().n;d.close();return n===0&&fs.existsSync(path.join(b.dir,'uploads','test.png'));});
 assert.equal(fs.readFileSync(path.join(b.dir,'uploads','test.png'),'utf8'),'test-attachment');
 assert.equal((await b.request('/api/me/state','GET',undefined,token)).status,200);
 const other=await a.request('/api/auth/register','POST',{username:'other',password:'test-password-12345'});
 assert.equal((await a.request('/api/me/state','GET',undefined,other.data.token)).data.habits.length,0);
 const backup=await a.command('backup');assert.equal(backup.ok,true);
 const headers={'Content-Type':'application/json',Authorization:'Bearer '+token,'Idempotency-Key':crypto.randomUUID()};
 const create=()=>fetch(a.url+'/api/communities',{method:'POST',headers,body:JSON.stringify({name:'Без дублей'})}).then(async r=>({status:r.status,data:await r.json()}));
 const community=await create();assert.equal(community.status,201);assert.deepEqual(await create(),community);
 assert.equal((await a.request('/api/communities','GET',undefined,token)).data.communities.length,1);
 await a.request('/api/admin/modes/communities','PATCH',{enabled:false},admin);
 assert.equal((await a.request('/api/features')).data.communities,false);
 assert.equal((await a.request('/api/communities','GET',undefined,token)).data.communities.length,1);
 await waitFor(async()=>{const d=new Database(path.join(b.dir,'database','discipline.sqlite'),{readonly:true});const flag=d.prepare("SELECT enabled FROM platform_modes WHERE key='communities'").get();d.close();return flag&&flag.enabled===0;});
 const changed=await fetch(a.url+'/api/communities',{method:'POST',headers,body:JSON.stringify({name:'Другой запрос'})});assert.equal(changed.status,409);
 const otherId=other.data.user.id;
 assert.equal((await a.request('/api/admin/users/'+otherId+'/status','PATCH',{status:'inactive'},admin)).status,200);
 assert.equal((await b.request('/api/me/state','GET',undefined,other.data.token)).status,401);
 assert.equal((await a.request('/api/admin/users/'+otherId+'/status','PATCH',{status:'active'},admin)).status,200);
 assert.equal((await a.request('/api/me/state','GET',undefined,other.data.token)).status,401);
 assert.equal((await a.request('/api/admin/backups','GET',undefined,token)).status,403);
 assert.equal((await a.request('/api/replication/export')).status,401);
 const restored=await a.command('restore',{filename:backup.filename});assert.equal(restored.ok,true);
 assert.equal((await a.request('/api/me/state','GET',undefined,token)).status,401);
 const fresh=await a.request('/api/auth/login','POST',{username:'tester',password:'test-password-12345'});
 assert.equal((await a.request('/api/communities','GET',undefined,fresh.data.token)).data.communities.length,0);
 const state=await a.request('/api/me/state','GET',undefined,fresh.data.token);assert.ok(state.data.version>2);
 assert.equal((await a.request('/api/me/state','PUT',{...payload,baseVersion:2,operationId:crypto.randomUUID()},fresh.data.token)).status,409);
 await new Promise(r=>{a.c.once('exit',r);a.c.send({id:'stop',action:'stop'});});
 assert.equal((await b.request('/api/me/state','GET',undefined,token)).status,503);
 console.log('PASS: static apps, health v2, login, idempotency, conflict, isolation, row deletion, attachment hash replication, backup, authorization and partition safety.');
 }finally{for(const c of children)if(c.exitCode===null){c.send({id:'stop',action:'stop'});await new Promise(r=>{c.once('exit',r);setTimeout(()=>{c.kill();r();},7000).unref();});}}
});
