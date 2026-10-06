'use strict';
const router=require('express').Router(),db=require('../lib/db');
const {requireAuth}=require('../lib/auth');
const {forbidden,badRequest}=require('../lib/errors');
db.function('social_lower',s=>String(s||'').toLocaleLowerCase('ru'));
const person=u=>({id:u.id,username:u.username,displayName:u.display_name,avatarEmoji:u.avatar_emoji});
function friends(a,b){return !!db.prepare("SELECT 1 FROM friendships WHERE status='accepted' AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))").get(a,b,b,a);}
function member(c,u){return db.prepare('SELECT 1 FROM communities WHERE id=? AND owner_id=?').get(c,u)||db.prepare('SELECT 1 FROM community_members WHERE community_id=? AND user_id=?').get(c,u);}
// Личные заметки и задачи пользователя (по 12 штук). У каждого аккаунта свои.
function cleanNotes(body){
 const text=v=>String(v==null?'':v).slice(0,2000);
 const notes=[],tasks=[];
 for(let i=0;i<12;i++){
  const n=(Array.isArray(body.notes)&&body.notes[i])||{};notes.push({text:text(n.text)});
  const t=(Array.isArray(body.tasks)&&body.tasks[i])||{};tasks.push({text:text(t.text),done:!!t.done&&!!text(t.text)});
 }
 return {notes,tasks};
}
router.get('/notes',requireAuth,(req,res)=>{
 const row=db.prepare('SELECT data,updated_at FROM user_notes WHERE user_id=?').get(req.user.id);
 let data=null;try{data=row?JSON.parse(row.data):null;}catch(e){}
 res.json({...cleanNotes(data||{}),updatedAt:row?row.updated_at:0});
});
router.put('/notes',requireAuth,(req,res)=>{
 const data=cleanNotes(req.body||{}),t=Date.now();
 db.prepare('INSERT INTO user_notes (user_id,data,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at').run(req.user.id,JSON.stringify(data),t);
 res.json({...data,updatedAt:t});
});
router.get('/friends/search',requireAuth,(req,res)=>{
 const q=String(req.query.q||'').trim().toLocaleLowerCase('ru').slice(0,80);
 if(q.length<2)return res.json({users:[]});
 // Телефон и почта ищутся только по полному совпадению и никогда не показываются в результатах.
 let digits=q.replace(/\D/g,'');if(digits.length===11&&digits[0]==='8')digits='7'+digits.slice(1);
 const phone=/^[\d\s+()-]+$/.test(q)&&digits.length>=7?'+'+digits:'\u0000';
 const rows=db.prepare("SELECT id,username,display_name,avatar_emoji FROM users WHERE status='active' AND id<>? AND (instr(social_lower(display_name),?)>0 OR instr(social_lower(username),?)>0 OR social_lower(friend_code)=? OR lower(email)=? OR phone=?) ORDER BY display_name LIMIT 30").all(req.user.id,q,q,q,q,phone);
 res.json({users:rows.map(u=>{const f=db.prepare('SELECT * FROM friendships WHERE (requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)').get(req.user.id,u.id,u.id,req.user.id);return {...person(u),relationship:f?f.status:null,incoming:!!f&&f.addressee_id===req.user.id,friendshipId:f&&f.id};})});
});
router.get('/friends/:userId/goals',requireAuth,(req,res,next)=>{try{
 const id=Number(req.params.userId);if(!friends(req.user.id,id))throw forbidden('Цели доступны только подтверждённым друзьям.');
 const user=db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(id);if(!user)throw forbidden('Профиль недоступен.');
 const goals=db.prepare('SELECT * FROM habits WHERE user_id=? AND assigned_by IS NULL AND group_id IS NULL').all(id).flatMap(h=>{
  let config;try{config=JSON.parse(h.config_json);}catch{return [];}
  if(!['simple','checklist','zikr','timer','assignment'].includes(h.type)||['gym','diet','workout','nutrition','fitness'].some(k=>config.modes&&config.modes[k]))return [];
  const history=db.prepare('SELECT date_key AS date,done FROM habit_logs WHERE user_id=? AND habit_id=? ORDER BY date_key DESC').all(id,h.id);
  const progress=db.prepare('SELECT date_key AS date,progress_json FROM habit_progress WHERE user_id=? AND habit_id=? ORDER BY date_key DESC LIMIT 366').all(id,h.id).map(r=>{let p={};try{p=JSON.parse(r.progress_json);}catch{}return {date:r.date,amount:Number(p.goalAmount!=null?p.goalAmount:p.amount)||0,count:Number(p.count)||0,stepIndex:Number(p.stepIndex)||0,doneCount:Array.isArray(p.done)?p.done.length:0};});
  const goalEnabled=config.goal&&config.goal.enabled;const totalAmount=goalEnabled?db.prepare('SELECT progress_json FROM habit_progress WHERE user_id=? AND habit_id=?').all(id,h.id).reduce((sum,r)=>{try{return sum+(Number(JSON.parse(r.progress_json).goalAmount)||0);}catch{return sum;}},0):null;
  return [{totalAmount,id:h.id,name:h.name,emoji:h.emoji,type:h.type,createdAt:h.created_at,target:goalEnabled?config.goal.total:Number(config.target)||null,unit:String(goalEnabled?config.goal.unit:config.unit||''),itemCount:Array.isArray(config.items)?config.items.length:0,completedDays:history.filter(r=>r.done).length,history:history.slice(0,366),progress}];
 });res.json({user:person(user),goals});
}catch(e){next(e);}});
router.get('/communities/:id/messages',requireAuth,(req,res,next)=>{try{
 const id=Number(req.params.id);if(!member(id,req.user.id))throw forbidden('Чат доступен только участникам группы.');
 const rows=db.prepare('SELECT m.id,m.sender_id AS senderId,m.text,m.created_at AS createdAt,u.display_name AS senderName FROM community_messages m JOIN users u ON u.id=m.sender_id WHERE community_id=? ORDER BY m.id DESC LIMIT 200').all(id).reverse();res.json({messages:rows});
}catch(e){next(e);}});
router.post('/communities/:id/messages',requireAuth,(req,res,next)=>{try{
 const id=Number(req.params.id);if(!member(id,req.user.id))throw forbidden('Чат доступен только участникам группы.');
 const text=String(req.body.text||'').trim();if(!text||text.length>2000)throw badRequest('Введите сообщение до 2000 символов.');
 const result=db.prepare('INSERT INTO community_messages(community_id,sender_id,text,created_at) VALUES(?,?,?,?)').run(id,req.user.id,text,Date.now());res.status(201).json({id:result.lastInsertRowid});
}catch(e){next(e);}});
module.exports=router;
