'use strict';
const router=require('express').Router(),db=require('../lib/db'),billing=require('../lib/billing');
const {requireAuth,requireRole,publicUser}=require('../lib/auth');
const {badRequest,notFound,forbidden,conflict}=require('../lib/errors');
router.get('/plans/me',requireAuth,(req,res)=>{
 const a=billing.account(req.user.id),legacy=require('../lib/subscription').activeSubscription(req.user.id);
 res.json({billing:a,prices:billing.prices(),user:publicUser(req.user),subscription:legacy?{planKey:legacy.plan_key,planName:legacy.plan_name,clientLimit:legacy.client_limit,price:legacy.price,status:'active'}:null,orders:db.prepare('SELECT id,plan_key,seat_count,include_start,amount,status,admin_note,created_at FROM billing_orders WHERE user_id=? ORDER BY id DESC LIMIT 20').all(req.user.id)});
});
router.post('/plans/demo',requireAuth,(req,res,next)=>{try{res.json({billing:billing.activateDemo(req.user.id),user:publicUser(req.user)});}catch(e){next(e);}});
router.post('/plans/select',requireAuth,(req,res,next)=>{try{const order=billing.createOrder(req.user.id,req.body||{});res.status(201).json({ok:true,order});}catch(e){next(e);}});
router.post('/plans/orders/:id/submit',requireAuth,(req,res,next)=>{try{
 const order=db.prepare('SELECT * FROM billing_orders WHERE id=? AND user_id=?').get(req.params.id,req.user.id);if(!order)throw notFound('Заявка не найдена.');if(!['draft','pending'].includes(order.status))throw conflict('Заявка уже обработана.');
 db.prepare("UPDATE billing_orders SET status='pending',updated_at=? WHERE id=?").run(Date.now(),order.id);res.json({ok:true,status:'pending'});
}catch(e){next(e);}});
router.post('/plans/orders/:id/cancel',requireAuth,(req,res,next)=>{try{const r=db.prepare("UPDATE billing_orders SET status='cancelled',updated_at=? WHERE id=? AND user_id=? AND status IN ('draft','pending')").run(Date.now(),req.params.id,req.user.id);if(!r.changes)throw conflict('Заявка уже обработана.');res.json({ok:true});}catch(e){next(e);}});
router.get('/trainer/invitations',requireAuth,(req,res)=>{res.json({invitations:db.prepare("SELECT i.id,i.group_id AS groupId,g.name AS groupName,u.display_name AS trainerName FROM trainer_invitations i JOIN groups g ON g.id=i.group_id JOIN users u ON u.id=g.trainer_id WHERE i.user_id=? AND i.status='pending'").all(req.user.id)});});
router.post('/trainer/groups/:id/invite',requireAuth,requireRole('TRAINER','ADMIN'),(req,res,next)=>{try{
 const g=db.prepare('SELECT * FROM groups WHERE id=? AND trainer_id=?').get(req.params.id,req.user.id);if(!g)throw forbidden('Эта группа недоступна.');billing.requireTrainer(req.user.id);
 const target=db.prepare("SELECT id FROM users WHERE status='active' AND (username=? COLLATE NOCASE OR friend_code=? COLLATE NOCASE)").get(String(req.body.username||'').trim(),String(req.body.username||'').trim());if(!target||target.id===req.user.id)throw badRequest('Введите псевдоним или код ученика.');
 if(db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(g.id,target.id))throw conflict('Ученик уже в группе.');
 const t=Date.now();db.prepare("INSERT INTO trainer_invitations(group_id,user_id,status,created_at,updated_at) VALUES(?,?,'pending',?,?) ON CONFLICT(group_id,user_id) DO UPDATE SET status='pending',created_at=excluded.created_at,updated_at=excluded.updated_at").run(g.id,target.id,t,t);res.status(201).json({ok:true});
}catch(e){next(e);}});
router.post('/trainer/invitations/:id/:decision',requireAuth,(req,res,next)=>{try{
 if(!['accept','decline'].includes(req.params.decision))throw badRequest('Неизвестное действие.');
 db.transaction(()=>{const i=db.prepare('SELECT * FROM trainer_invitations WHERE id=? AND user_id=?').get(req.params.id,req.user.id);if(!i)throw notFound('Приглашение не найдено.');if(i.status!=='pending')throw conflict('Приглашение уже обработано.');
 if(req.params.decision==='accept'){const g=db.prepare('SELECT * FROM groups WHERE id=?').get(i.group_id);billing.enroll(g,req.user.id);}
 db.prepare('UPDATE trainer_invitations SET status=?,updated_at=? WHERE id=?').run(req.params.decision==='accept'?'accepted':'declined',Date.now(),i.id);
 })();res.json({ok:true});
}catch(e){next(e);}});
router.get('/trainer/students/:id/progress',requireAuth,requireRole('TRAINER','ADMIN'),(req,res,next)=>{try{
 const student=Number(req.params.id),owned=db.prepare('SELECT g.id FROM groups g JOIN group_members gm ON gm.group_id=g.id WHERE g.trainer_id=? AND gm.user_id=?').all(req.user.id,student);if(!owned.length)throw forbidden('Ученик не состоит в ваших группах.');
 const from=String(req.query.from||''),to=String(req.query.to||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||to<from||(Date.parse(to)-Date.parse(from))/86400000>366)throw badRequest('Выберите период не длиннее года.');
 const ids=owned.map(g=>g.id),ph=ids.map(()=>'?').join(',');
 const tasks=db.prepare(`SELECT id,name,emoji,type,config_json FROM habits WHERE assigned_by=? AND group_id IN (${ph}) AND (target_user_id IS NULL OR target_user_id=?)`).all(req.user.id,...ids,student).map(h=>({id:h.id,name:h.name,emoji:h.emoji,type:h.type,config:JSON.parse(h.config_json||'{}'),days:db.prepare('SELECT date_key AS date,done FROM habit_logs WHERE user_id=? AND habit_id=? AND date_key BETWEEN ? AND ? ORDER BY date_key').all(student,h.id,from,to),progress:db.prepare('SELECT date_key AS date,progress_json FROM habit_progress WHERE user_id=? AND habit_id=? AND date_key BETWEEN ? AND ? ORDER BY date_key').all(student,h.id,from,to).map(r=>({date:r.date,value:JSON.parse(r.progress_json||'{}')}))}));
 const u=db.prepare('SELECT display_name FROM users WHERE id=?').get(student);res.json({student:{id:student,name:u.display_name},from,to,tasks});
}catch(e){next(e);}});
module.exports=router;
