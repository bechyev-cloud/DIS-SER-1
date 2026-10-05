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

test('monthly Start, trial preservation, admin approval, seats, consent, progress and replication',async()=>{try{
 const a=await boot('billing'),Database=require('better-sqlite3');
 const register=async username=>(await a.request('/api/auth/register','POST',{username,password:'1234',displayName:username})).data;
 const coach=await register('monthlycoach'),student=await register('monthlystudent'),second=await register('secondstudent');
 const admin=(await a.request('/api/auth/login','POST',{username:'admin',password:'test-password-12345'})).data;
 const call=(u,p,m='GET',b)=>a.request('/api'+p,m,b,u.token);
 const trial=(await call(coach,'/plans/me')).data.billing;assert.equal(trial.personal_until-coach.user.createdAt,35*86400000);assert.equal(trial.remaining,0);
 let order=(await call(coach,'/plans/select','POST',{planKey:'start_plus',seatCount:1,includeStart:false})).data.order;assert.equal(order.amount,100);assert.equal(order.status,'draft');
 assert.ok(!(await call(admin,'/admin/payments')).data.requests.some(r=>r.id==='b'+order.id));
 assert.equal((await call(student,'/plans/orders/'+order.id+'/submit','POST',{})).status,404);
 await call(coach,'/plans/orders/'+order.id+'/submit','POST',{});
 assert.equal((await call(student,'/admin/payments/b'+order.id+'/confirm','POST',{})).status,403);
 assert.equal((await call(admin,'/admin/payments/b'+order.id+'/confirm','POST',{})).status,200);
 const licensed=(await call(coach,'/plans/me')).data;assert.equal(licensed.user.role,'TRAINER');assert.equal(licensed.billing.personal_until,trial.personal_until);assert.equal(licensed.billing.remaining,1);
 assert.notEqual((await call(admin,'/admin/payments/b'+order.id+'/confirm','POST',{})).status,200);assert.equal((await call(coach,'/plans/me')).data.billing.remaining,1);
 const group=(await call(coach,'/groups','POST',{name:'Ученики'})).data;
 for(const user of [student,second])assert.equal((await call(coach,'/trainer/groups/'+group.id+'/invite','POST',{username:user.user.username})).status,201);
 const invitation=(await call(student,'/trainer/invitations')).data.invitations[0],invitation2=(await call(second,'/trainer/invitations')).data.invitations[0];
 assert.equal((await call(coach,'/plans/me')).data.billing.remaining,1);
 assert.equal((await call(second,'/trainer/invitations/'+invitation.id+'/accept','POST',{})).status,404);
 assert.equal((await call(student,'/trainer/invitations/'+invitation.id+'/accept','POST',{})).status,200);
 assert.equal((await call(coach,'/plans/me')).data.billing.remaining,0);
 assert.equal((await call(student,'/trainer/invitations/'+invitation.id+'/accept','POST',{})).status,409);
 assert.equal((await call(second,'/trainer/invitations/'+invitation2.id+'/accept','POST',{})).status,403);
 const task=(await call(coach,'/groups/'+group.id+'/habits','POST',{name:'Чтение',targetUserId:student.user.id,type:'simple',config:{goal:{enabled:true,repeat:'daily',mode:'count',total:1000,daily:50,unit:'страниц',buttons:[{value:10}]}}})).data;
 const state=(await call(student,'/me/state')).data;
 assert.equal((await call(student,'/me/state','PUT',{...state,baseVersion:state.version,operationId:crypto.randomUUID(),logs:{'2026-10-03':{[task.id]:true}},progress:{'2026-10-03':{[task.id]:{goalAmount:50}}}})).status,200);
 const report=await call(coach,'/trainer/students/'+student.user.id+'/progress?from=2026-10-01&to=2026-10-31');assert.equal(report.status,200);assert.equal(report.data.tasks[0].days[0].done,1);assert.equal(report.data.tasks[0].config.goal.total,1000);assert.equal(report.data.tasks[0].progress[0].value.goalAmount,50);
 assert.equal((await call(admin,'/trainer/students/'+student.user.id+'/progress?from=2026-10-01&to=2026-10-31')).status,403);
 order=(await call(coach,'/plans/select','POST',{planKey:'start',includeStart:true})).data.order;assert.equal(order.amount,500);await call(coach,'/plans/orders/'+order.id+'/submit','POST',{});await call(admin,'/admin/payments/b'+order.id+'/confirm','POST',{});
 const renewed=(await call(coach,'/plans/me')).data.billing;const adminView=(await call(admin,'/admin/users/'+coach.user.id)).data;assert.equal(adminView.billing.personal_until,renewed.personal_until);assert.equal(adminView.billing.trainerActive,true);assert.ok(renewed.personal_until>trial.personal_until+27*86400000);assert.equal(renewed.trainer_until,licensed.billing.trainer_until);
 order=(await call(coach,'/plans/select','POST',{planKey:'start_plus',seatCount:2,includeStart:true})).data.order;assert.equal(order.amount,700);await call(coach,'/plans/orders/'+order.id+'/submit','POST',{});await call(admin,'/admin/payments/b'+order.id+'/confirm','POST',{});assert.equal((await call(coach,'/plans/me')).data.billing.remaining,1);
 assert.equal((await call(second,'/trainer/invitations/'+invitation2.id+'/accept','POST',{})).status,200);
 assert.equal((await call(coach,'/plans/select','POST',{planKey:'start_plus',seatCount:1})).status,400);
 const replica=await boot('billing-replica'),pairing=await a.command('pairing');await replica.command('join',{options:{url:a.url,...pairing}});await waitFor(async()=>!!(await replica.command('status')).lastSuccess);
 const mirrored=new Database(path.join(replica.dir,'database','discipline.sqlite'),{readonly:true});assert.equal(mirrored.prepare('SELECT seat_used FROM billing_accounts WHERE user_id=?').get(coach.user.id).seat_used,2);assert.equal(mirrored.prepare("SELECT COUNT(*) AS n FROM billing_orders WHERE status='approved'").get().n,3);mirrored.close();
 const db=new Database(path.join(a.dir,'database','discipline.sqlite'));db.prepare('UPDATE billing_accounts SET trainer_until=? WHERE user_id=?').run(Date.now()-1,coach.user.id);db.prepare('UPDATE billing_accounts SET personal_until=? WHERE user_id=?').run(Date.now()-1,student.user.id);db.close();
 assert.equal((await call(coach,'/groups/'+group.id+'/habits','POST',{name:'После истечения'})).status,403);
 const current=(await call(student,'/me/state')).data;assert.equal((await call(student,'/me/state','PUT',{...current,baseVersion:current.version,operationId:crypto.randomUUID()})).status,403);assert.ok(current.habits.length);
 const backup=await a.command('backup');assert.equal(backup.ok,true);
}finally{for(const c of children)if(c.exitCode===null)c.kill();}});
