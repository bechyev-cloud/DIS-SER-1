'use strict';
const db=require('./db');
const {badRequest,forbidden,notFound,conflict}=require('./errors');
const DAY=86400000;
function account(id){
 const u=db.prepare('SELECT created_at FROM users WHERE id=?').get(id);if(!u)throw notFound('Пользователь не найден.');
 db.prepare('INSERT OR IGNORE INTO billing_accounts(user_id,personal_until,trainer_until,seat_limit,seat_used,updated_at) VALUES(?,?,0,0,0,?)').run(id,u.created_at+35*DAY,Date.now());
 const a=db.prepare('SELECT * FROM billing_accounts WHERE user_id=?').get(id);
 const covered=!!db.prepare('SELECT 1 FROM group_members gm JOIN groups g ON g.id=gm.group_id JOIN billing_accounts t ON t.user_id=g.trainer_id WHERE gm.user_id=? AND t.students_paid_until>? AND t.trainer_until>?').get(id,Date.now(),Date.now());
 const demoActive=a.demo_until>Date.now();if(demoActive)return {...a,coveredByTrainer:covered,studentsPaid:a.students_paid_until>Date.now(),demoActive:true,personal_until:Math.max(a.personal_until,a.demo_until),trainer_until:Math.max(a.trainer_until,a.demo_until),personalActive:true,trainerActive:true,seat_limit:2147483647,remaining:2147483647,trialUntil:u.created_at+35*DAY};
 return {...a,demoActive:false,coveredByTrainer:covered,studentsPaid:a.students_paid_until>Date.now(),trialUntil:u.created_at+35*DAY,personalActive:covered||a.personal_until>Date.now(),trainerActive:a.trainer_until>Date.now(),remaining:a.trainer_until>Date.now()?Math.max(0,a.seat_limit-a.seat_used):0};
}
function addMonth(timestamp){const d=new Date(timestamp),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+1);const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return d.getTime();}
function roster(id){return db.prepare('SELECT COUNT(DISTINCT gm.user_id) AS n FROM group_members gm JOIN groups g ON g.id=gm.group_id WHERE g.trainer_id=?').get(id).n;}
function prices(){const rows=db.prepare("SELECT key,price FROM plans WHERE key IN ('start','start_plus','trainer_pays')").all();const m=Object.fromEntries(rows.map(r=>[r.key,r.price]));return {start:m.start??500,seat:m.start_plus??100,trainerPays:m.trainer_pays??100};}
function createOrder(userId,body){
 const plan=body.planKey;if(!['start','start_plus','trainer_pays'].includes(plan))throw badRequest('Выберите Start, Start Plus или «Тренер платит».');
 const paysForStudents=plan==='trainer_pays',maxSeats=paysForStudents?999:1000;
 if(!db.prepare('SELECT 1 FROM plans WHERE key=? AND active=1').get(plan))throw badRequest('Тариф временно недоступен.');
 const seats=plan!=='start'?Number(body.seatCount):0,includeStart=plan==='start'||(!paysForStudents&&body.includeStart===true);
 if(plan!=='start'&&(!Number.isSafeInteger(seats)||seats<1||seats>maxSeats))throw badRequest('Количество учеников: от 1 до '+maxSeats+'.');
 if(plan!=='start'&&seats<roster(userId))throw badRequest('Количество мест не может быть меньше числа текущих учеников.');
 const p=prices(),seatPrice=paysForStudents?p.trainerPays:p.seat,amount=(includeStart?p.start:0)+seats*seatPrice;
 const existing=db.prepare("SELECT * FROM billing_orders WHERE user_id=? AND status IN ('draft','pending') ORDER BY id DESC LIMIT 1").get(userId);
 if(existing){if(existing.plan_key===plan&&existing.seat_count===seats&&!!existing.include_start===includeStart)return existing;throw conflict('Сначала отмените или дождитесь обработки предыдущей заявки.');}
 const id=db.prepare("INSERT INTO billing_orders(user_id,plan_key,seat_count,include_start,base_price,seat_price,amount,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'draft',?,?)").run(userId,plan,seats,+includeStart,p.start,seatPrice,amount,Date.now(),Date.now()).lastInsertRowid;
 return db.prepare('SELECT * FROM billing_orders WHERE id=?').get(id);
}
const approve=db.transaction((adminId,id)=>{
 const o=db.prepare('SELECT * FROM billing_orders WHERE id=?').get(id);if(!o)throw notFound('Заявка не найдена.');if(o.status!=='pending')throw conflict('Заявка уже обработана или оплата ещё не заявлена.');
 account(o.user_id);const a=db.prepare('SELECT * FROM billing_accounts WHERE user_id=?').get(o.user_id),t=Date.now(),used=roster(o.user_id);
 if(o.seat_count&&o.seat_count<used)throw conflict('В группе уже больше учеников, чем оплаченных мест.');
 const personal=o.include_start?addMonth(Math.max(t,a.personal_until)):a.personal_until;
 // Each payment buys the selected total capacity for another month; current pupils occupy it.
 const until=o.seat_count?addMonth(Math.max(t,a.trainer_until)):a.trainer_until;
 // «Тренер платит»: на оплаченный месяц личная часть учеников этого тренера открыта без их оплаты.
 const studentsPaid=o.plan_key==='trainer_pays'?until:(o.seat_count?0:a.students_paid_until);
 db.prepare('UPDATE billing_accounts SET personal_until=?,trainer_until=?,seat_limit=?,seat_used=?,students_paid_until=?,updated_at=? WHERE user_id=?').run(personal,until,o.seat_count||a.seat_limit,o.seat_count?used:a.seat_used,studentsPaid,t,o.user_id);
 if(o.seat_count)db.prepare("UPDATE users SET role=CASE WHEN role='ADMIN' THEN role ELSE 'TRAINER' END,updated_at=? WHERE id=?").run(t,o.user_id);
 db.prepare("UPDATE billing_orders SET status='approved',reviewed_by=?,updated_at=? WHERE id=?").run(adminId,t,o.id);
 db.prepare('INSERT INTO admin_audit_log(admin_id,action,details_json,created_at) VALUES(?,?,?,?)').run(adminId,'approve_start_order',JSON.stringify({orderId:o.id,plan:o.plan_key,userId:o.user_id,amount:o.amount,seats:o.seat_count,personalUntil:personal,trainerUntil:until}),t);
 return account(o.user_id);
});
function reject(adminId,id,note){const r=db.prepare("UPDATE billing_orders SET status='rejected',reviewed_by=?,admin_note=?,updated_at=? WHERE id=? AND status='pending'").run(adminId,String(note||'').slice(0,500),Date.now(),id);if(!r.changes)throw conflict('Заявка уже обработана.');}
function requireTrainer(id){const a=account(id);if(!a.personalActive)throw forbidden('Продлите Start для работы в приложении.');if(!a.trainerActive)throw forbidden('Продлите места Start Plus для работы с учениками.');return a;}
const enroll=db.transaction((group,userId)=>{
 if(group.trainer_id===userId)throw badRequest('Нельзя вступить в собственную группу.');
 if(db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(group.id,userId))return false;
 const a=requireTrainer(group.trainer_id);
 const already=db.prepare('SELECT 1 FROM group_members gm JOIN groups g ON g.id=gm.group_id WHERE g.trainer_id=? AND gm.user_id=?').get(group.trainer_id,userId);
 if(!already&&!a.demoActive){const update=db.prepare('UPDATE billing_accounts SET seat_used=seat_used+1,updated_at=? WHERE user_id=? AND trainer_until>? AND seat_used<seat_limit').run(Date.now(),group.trainer_id,Date.now());if(!update.changes)throw forbidden('У тренера нет свободных оплаченных приглашений.');}
 db.prepare('INSERT INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)').run(group.id,userId,Date.now());return true;
});
function activateDemo(id){account(id);db.prepare('UPDATE billing_accounts SET demo_until=?,updated_at=? WHERE user_id=? AND demo_until=0').run(addMonth(Date.now()),Date.now(),id);return account(id);}
module.exports={activateDemo,account,addMonth,roster,prices,createOrder,approve,reject,requireTrainer,enroll};
