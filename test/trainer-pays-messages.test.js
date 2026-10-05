'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {spawn}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');const net=require('node:net');const crypto=require('node:crypto');
const dir=path.resolve(__dirname,'../../.test-data',crypto.randomUUID());fs.mkdirSync(dir,{recursive:true});
test('trainer_pays order covers students; group unread counter',async()=>{
 const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
 const c=spawn(process.execPath,[path.resolve(__dirname,'../server.js')],{cwd:dir,env:{...process.env,DATA_DIR:dir,PORT:String(port),NODE_ENV:'production',JWT_SECRET:'test-only-secret',ADMIN_PASSWORD:'test-password-12345',ADMIN_LOGIN:'admin'},stdio:['ignore','pipe','pipe','ipc']});
 try{
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('startup timeout')),12000);c.on('message',m=>{if(m.type==='ready'){clearTimeout(t);resolve();}});});
  const req=async(route,method='GET',body,token)=>{const r=await fetch('http://127.0.0.1:'+port+'/api'+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  const reg=async u=>(await req('/auth/register','POST',{username:u,password:'1234',displayName:u})).data;
  const coach=await reg('payingcoach'),student=await reg('paidstudent');
  const admin=(await req('/auth/login','POST',{username:'admin',password:'test-password-12345'})).data;
  const call=(u,p,m='GET',b)=>req(p,m,b,u.token);
  assert.equal((await call(coach,'/plans/me')).data.prices.trainerPays,100);
  assert.equal((await call(coach,'/plans/select','POST',{planKey:'trainer_pays',seatCount:1000})).status,400);
  const order=(await call(coach,'/plans/select','POST',{planKey:'trainer_pays',seatCount:3,includeStart:true})).data.order;
  assert.equal(order.amount,300);assert.equal(order.plan_key,'trainer_pays');assert.equal(order.include_start,0);
  await call(coach,'/plans/orders/'+order.id+'/submit','POST',{});
  const listed=(await call(admin,'/admin/payments')).data.requests.find(r=>r.id==='b'+order.id);assert.match(listed.plan.name,/Тренер платит/);
  assert.equal((await call(admin,'/admin/payments/b'+order.id+'/confirm','POST',{})).status,200);
  const me=(await call(coach,'/plans/me')).data;assert.equal(me.user.role,'TRAINER');assert.equal(me.billing.remaining,3);assert.equal(me.billing.studentsPaid,true);
  const group=(await call(coach,'/groups','POST',{name:'Общая'})).data;
  await call(coach,'/trainer/groups/'+group.id+'/invite','POST',{username:'paidstudent'});
  const inv=(await call(student,'/trainer/invitations')).data.invitations[0];
  assert.equal((await call(student,'/trainer/invitations/'+inv.id+'/accept','POST',{})).status,200);
  // личная часть ученика истекла, но тренер платит — доступ остаётся
  const Database=require('better-sqlite3'),db=new Database(path.join(dir,'database','discipline.sqlite'));
  db.prepare('UPDATE billing_accounts SET personal_until=? WHERE user_id=?').run(Date.now()-1,student.user.id);db.close();
  const sb=(await call(student,'/plans/me')).data.billing;assert.equal(sb.coveredByTrainer,true);assert.equal(sb.personalActive,true);
  // общая группа: счётчик непрочитанного
  await call(coach,'/messages','POST',{groupId:group.id,text:'Привет всем'});await call(coach,'/messages','POST',{groupId:group.id,text:'Завтра в 7:00'});
  const thread=async u=>(await call(u,'/messages/threads')).data.threads.find(t=>t.type==='group');
  assert.equal((await thread(student)).unread,2);assert.equal((await thread(coach)).unread,0);
  const chat=(await call(student,'/messages?groupId='+group.id)).data.messages;assert.equal(chat.length,2);assert.equal(chat[0].senderName,'payingcoach');
  assert.equal((await thread(student)).unread,0);
  await call(coach,'/messages','POST',{groupId:group.id,text:'Ещё одно'});assert.equal((await thread(student)).unread,1);
  // ученик тоже может писать в чат группы, посторонний — нет
  assert.equal((await call(student,'/messages','POST',{groupId:group.id,text:'Буду!'})).status,201);assert.equal((await thread(coach)).unread,1);
  await call(coach,'/messages?groupId='+group.id);assert.equal((await thread(coach)).unread,0);
  const outsider=await reg('outsider1');assert.equal((await call(outsider,'/messages','POST',{groupId:group.id,text:'x'})).status,403);
 }finally{c.kill();}
});
test('global chat: everyone writes, admin closes, deletes and reopens',async()=>{
 const d=path.resolve(__dirname,'../../.test-data',crypto.randomUUID());fs.mkdirSync(d,{recursive:true});
 const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
 const c=spawn(process.execPath,[path.resolve(__dirname,'../server.js')],{cwd:d,env:{...process.env,DATA_DIR:d,PORT:String(port),NODE_ENV:'production',JWT_SECRET:'test-only-secret',ADMIN_PASSWORD:'test-password-12345',ADMIN_LOGIN:'admin'},stdio:['ignore','pipe','pipe','ipc']});
 try{
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('startup timeout')),12000);c.on('message',m=>{if(m.type==='ready'){clearTimeout(t);resolve();}});});
  const req=async(route,method='GET',body,token)=>{const r=await fetch('http://127.0.0.1:'+port+'/api'+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  const reg=async u=>(await req('/auth/register','POST',{username:u,password:'1234',displayName:u})).data;
  const a=await reg('globalone'),b=await reg('globaltwo');const admin=(await req('/auth/login','POST',{username:'admin',password:'test-password-12345'})).data;
  const global=async u=>(await req('/messages/threads','GET',undefined,u.token)).data.threads.find(t=>t.type==='global');
  assert.equal((await req('/messages','POST',{global:true,text:'привет'},a.token)).status,201);
  assert.equal((await global(b)).unread,1);assert.equal((await global(a)).unread,0);
  const chat=(await req('/messages?global=1','GET',undefined,b.token)).data;assert.equal(chat.messages[0].senderName,'globalone');assert.equal(chat.canPost,true);assert.equal((await global(b)).unread,0);
  assert.equal((await req('/admin/global-chat','POST',{open:false},a.token)).status,403);
  assert.equal((await req('/admin/global-chat','POST',{open:false},admin.token)).data.open,false);
  assert.equal((await req('/messages','POST',{global:true,text:'нельзя'},b.token)).status,403);
  assert.equal((await req('/messages?global=1','GET',undefined,b.token)).data.canPost,false);
  assert.equal((await req('/messages','POST',{global:true,text:'объявление'},admin.token)).status,201);
  assert.equal((await req('/admin/global-chat/messages/'+chat.messages[0].id,'DELETE',undefined,b.token)).status,403);
  assert.equal((await req('/admin/global-chat/messages/'+chat.messages[0].id,'DELETE',undefined,admin.token)).status,200);
  assert.equal((await req('/admin/global-chat','POST',{open:true},admin.token)).data.messages,1);
  assert.equal((await req('/messages','POST',{global:true,text:'снова'},b.token)).status,201);
  assert.equal((await req('/admin/global-chat/messages','DELETE',undefined,admin.token)).data.deleted,2);
  // личные и групповые переписки общий чат не затрагивает
  assert.ok((await req('/messages/threads','GET',undefined,a.token)).data.threads.every(t=>t.type==='global'||t.type==='friends'));
 }finally{c.kill();}
});
test('admin: mute, manual billing, block and delete user',async()=>{
 const d=path.resolve(__dirname,'../../.test-data',crypto.randomUUID());fs.mkdirSync(d,{recursive:true});
 const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
 const c=spawn(process.execPath,[path.resolve(__dirname,'../server.js')],{cwd:d,env:{...process.env,DATA_DIR:d,PORT:String(port),NODE_ENV:'production',JWT_SECRET:'test-only-secret',ADMIN_PASSWORD:'test-password-12345',ADMIN_LOGIN:'admin'},stdio:['ignore','pipe','pipe','ipc']});
 try{
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('startup timeout')),12000);c.on('message',m=>{if(m.type==='ready'){clearTimeout(t);resolve();}});});
  const req=async(route,method='GET',body,token)=>{const r=await fetch('http://127.0.0.1:'+port+'/api'+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  const reg=async u=>(await req('/auth/register','POST',{username:u,password:'1234',displayName:u})).data;
  const coach=await reg('managedcoach'),user=await reg('manageduser');const admin=(await req('/auth/login','POST',{username:'admin',password:'test-password-12345'})).data;
  const A=(p,m,b)=>req('/admin'+p,m,b,admin.token);
  // ограничение в общей группе
  assert.equal((await req('/admin/users/'+user.user.id+'/chat','PATCH',{muted:true},coach.token)).status,403);
  assert.equal((await A('/users/'+user.user.id+'/chat','PATCH',{muted:true})).status,200);
  assert.equal((await req('/messages','POST',{global:true,text:'x'},user.token)).status,403);
  assert.equal((await req('/messages?global=1','GET',undefined,user.token)).data.canPost,false);
  assert.equal((await A('/users/'+user.user.id)).data.user.chatMuted,true);
  await A('/users/'+user.user.id+'/chat','PATCH',{muted:false});assert.equal((await req('/messages','POST',{global:true,text:'x'},user.token)).status,201);
  // ручная подписка
  assert.equal((await A('/users/'+coach.user.id+'/billing','PATCH',{action:'set_trainer_pays',enabled:true})).status,400);
  let b=(await A('/users/'+coach.user.id+'/billing','PATCH',{action:'add_trainer_month'})).data.billing;assert.equal(b.trainerActive,true);assert.equal(b.seat_limit,1);
  b=(await A('/users/'+coach.user.id+'/billing','PATCH',{action:'set_seats',seats:7})).data.billing;assert.equal(b.remaining,7);
  b=(await A('/users/'+coach.user.id+'/billing','PATCH',{action:'set_trainer_pays',enabled:true})).data.billing;assert.equal(b.studentsPaid,true);
  assert.equal((await req('/plans/me','GET',undefined,coach.token)).data.user.role,'TRAINER');
  const before=(await A('/users/'+user.user.id)).data.billing.personal_until;
  b=(await A('/users/'+user.user.id+'/billing','PATCH',{action:'add_personal_month'})).data.billing;assert.ok(b.personal_until>before+27*86400000);
  b=(await A('/users/'+user.user.id+'/billing','PATCH',{action:'revoke_personal'})).data.billing;assert.equal(b.personalActive,false);
  b=(await A('/users/'+coach.user.id+'/billing','PATCH',{action:'revoke_trainer'})).data.billing;assert.equal(b.trainerActive,false);assert.equal(b.studentsPaid,false);
  assert.equal((await A('/users/'+coach.user.id+'/billing','PATCH',{action:'nope'})).status,400);
  // блокировка и удаление
  await A('/users/'+user.user.id+'/status','PATCH',{status:'inactive'});assert.notEqual((await req('/plans/me','GET',undefined,user.token)).status,200);
  assert.equal((await A('/users/'+admin.user.id,'DELETE')).status,400);
  assert.equal((await req('/admin/users/'+user.user.id,'DELETE',undefined,coach.token)).status,403);
  assert.equal((await A('/users/'+user.user.id,'DELETE')).status,200);
  assert.equal((await A('/users/'+user.user.id)).status,404);
  assert.equal((await req('/auth/login','POST',{username:'manageduser',password:'1234'})).status>=400,true);
  assert.equal((await A('/global-chat')).data.messages,0);
  assert.equal((await A('/users/'+coach.user.id,'DELETE')).status,200);
 }finally{c.kill();}
});
test('announcements, group mute and admin chat view',async()=>{
 const d=path.resolve(__dirname,'../../.test-data',crypto.randomUUID());fs.mkdirSync(d,{recursive:true});
 const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
 const c=spawn(process.execPath,[path.resolve(__dirname,'../server.js')],{cwd:d,env:{...process.env,DATA_DIR:d,PORT:String(port),NODE_ENV:'production',JWT_SECRET:'test-only-secret',ADMIN_PASSWORD:'test-password-12345',ADMIN_LOGIN:'admin'},stdio:['ignore','pipe','pipe','ipc']});
 try{
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('startup timeout')),12000);c.on('message',m=>{if(m.type==='ready'){clearTimeout(t);resolve();}});});
  const req=async(route,method='GET',body,token)=>{const r=await fetch('http://127.0.0.1:'+port+'/api'+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  const reg=async u=>(await req('/auth/register','POST',{username:u,password:'1234',displayName:u})).data;
  const coach=await reg('anncoach'),st=await reg('annstudent'),other=await reg('annother');const admin=(await req('/auth/login','POST',{username:'admin',password:'test-password-12345'})).data;
  const A=(p,m,b)=>req('/admin'+p,m,b,admin.token);
  await A('/users/'+coach.user.id+'/billing','PATCH',{action:'add_trainer_month'});await A('/users/'+coach.user.id+'/billing','PATCH',{action:'set_seats',seats:3});
  const g=(await req('/groups','POST',{name:'Группа'},coach.token)).data;
  await req('/trainer/groups/'+g.id+'/invite','POST',{username:'annstudent'},coach.token);
  const inv=(await req('/trainer/invitations','GET',undefined,st.token)).data.invitations[0];await req('/trainer/invitations/'+inv.id+'/accept','POST',{},st.token);
  // сообщение разработчика
  assert.equal((await req('/admin/announcements','POST',{text:'x'},coach.token)).status,403);
  assert.equal((await A('/announcements','POST',{text:'Первое'})).status,201);
  assert.equal((await A('/announcements','POST',{text:'Обновление приложения',lockSeconds:999})).status,201);
  let pub=(await req('/announcement')).data.announcements;assert.equal(pub.length,1);assert.equal(pub[0].text,'Обновление приложения');assert.equal(pub[0].lockSeconds,300);
  // сообщение тренера видят только его ученики
  assert.equal((await req('/groups/'+g.id+'/announce','POST',{text:'Сбор в 7:00',lockSeconds:10},st.token)).status,403);
  assert.equal((await req('/groups/'+g.id+'/announce','POST',{text:'Сбор в 7:00',lockSeconds:10},coach.token)).data.recipients,1);
  const mine=(await req('/announcements/mine','GET',undefined,st.token)).data.announcements;assert.deepEqual(mine.map(a=>a.kind),['developer','trainer']);assert.equal(mine[1].trainerName,'anncoach');assert.equal(mine[1].lockSeconds,10);
  assert.equal((await req('/announcements/mine','GET',undefined,other.token)).data.announcements.length,1);
  await A('/announcements/'+pub[0].id,'DELETE');assert.equal((await req('/announcement')).data.announcements.length,0);
  // тренер запрещает ученику писать в чат группы и удаляет его
  assert.equal((await req('/messages','POST',{groupId:g.id,text:'привет'},st.token)).status,201);
  assert.equal((await req('/groups/'+g.id+'/members/'+st.user.id+'/chat','PATCH',{muted:true},st.token)).status,403);
  assert.equal((await req('/groups/'+g.id+'/members/'+st.user.id+'/chat','PATCH',{muted:true},coach.token)).status,200);
  assert.equal((await req('/messages','POST',{groupId:g.id,text:'нельзя'},st.token)).status,403);
  const chat=(await req('/messages?groupId='+g.id,'GET',undefined,st.token)).data;assert.equal(chat.canPost,false);assert.equal(chat.muted,true);
  assert.equal((await req('/groups/'+g.id+'/members','GET',undefined,coach.token)).data.members[0].chatMuted,true);
  // администратор видит переписки
  await req('/messages','POST',{recipientId:st.user.id,text:'личное'},coach.token);
  const chats=(await A('/users/'+st.user.id+'/chats')).data;assert.equal(chats.dms[0].id,coach.user.id);assert.equal(chats.groups[0].id,g.id);
  assert.equal((await A('/chats?a='+st.user.id+'&b='+coach.user.id)).data.messages[0].text,'личное');
  assert.equal((await A('/chats?groupId='+g.id)).data.messages.length,1);
  assert.equal((await req('/admin/chats?groupId='+g.id,'GET',undefined,coach.token)).status,403);
  assert.equal((await req('/groups/'+g.id+'/members/'+st.user.id,'DELETE',undefined,coach.token)).status,200);
  assert.equal((await req('/messages?groupId='+g.id,'GET',undefined,st.token)).status,403);
 }finally{c.kill();}
});
test('friends chat: only me and my accepted friends see it; global chat untouched',async()=>{
 const d=path.resolve(__dirname,'../../.test-data',crypto.randomUUID());fs.mkdirSync(d,{recursive:true});
 const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
 const c=spawn(process.execPath,[path.resolve(__dirname,'../server.js')],{cwd:d,env:{...process.env,DATA_DIR:d,PORT:String(port),NODE_ENV:'production',JWT_SECRET:'test-only-secret',ADMIN_PASSWORD:'test-password-12345',ADMIN_LOGIN:'admin'},stdio:['ignore','pipe','pipe','ipc']});
 try{
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('startup timeout')),12000);c.on('message',m=>{if(m.type==='ready'){clearTimeout(t);resolve();}});});
  const req=async(route,method='GET',body,token)=>{const r=await fetch('http://127.0.0.1:'+port+'/api'+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  const reg=async u=>(await req('/auth/register','POST',{username:u,password:'1234',displayName:u})).data;
  const a=await reg('frienda'),b=await reg('friendb'),x=await reg('stranger');const admin=(await req('/auth/login','POST',{username:'admin',password:'test-password-12345'})).data;
  await req('/friends/request','POST',{userId:b.user.id},a.token);
  const inc=(await req('/friends','GET',undefined,b.token)).data.incoming[0];await req('/friends/'+inc.friendshipId+'/accept','POST',{},b.token);
  assert.equal((await req('/messages','POST',{friends:true,text:'привет друзьям'},a.token)).status,201);
  await req('/messages','POST',{friends:true,text:'чужое'},x.token);
  const th=async u=>(await req('/messages/threads','GET',undefined,u.token)).data.threads.find(t=>t.type==='friends');
  assert.equal((await th(b)).unread,1);assert.equal((await th(a)).unread,0);
  const chat=(await req('/messages?friends=1','GET',undefined,b.token)).data;assert.deepEqual(chat.messages.map(m=>m.text),['привет друзьям']);assert.equal(chat.messages[0].senderName,'frienda');
  assert.equal((await th(b)).unread,0);
  assert.deepEqual((await req('/messages?friends=1','GET',undefined,x.token)).data.messages.map(m=>m.text),['чужое']);
  // общая группа не смешивается с чатом друзей
  assert.equal((await req('/messages?global=1','GET',undefined,a.token)).data.messages.length,0);
  assert.equal((await req('/admin/global-chat','GET',undefined,admin.token)).data.messages,0);
  await req('/messages','POST',{global:true,text:'всем'},a.token);
  assert.equal((await req('/messages?friends=1','GET',undefined,b.token)).data.messages.length,1);
  assert.equal((await req('/admin/global-chat/messages','DELETE',undefined,admin.token)).data.deleted,1);
  assert.equal((await req('/messages?friends=1','GET',undefined,b.token)).data.messages.length,1);
 }finally{c.kill();}
});
