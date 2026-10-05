'use strict';
// One authoritative writer; replicas pull an ordered row journal and forward API requests.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const TABLES = ['plans','users','subscriptions','groups','group_members','friendships','communities','community_members','community_goals','community_goal_contrib','habits','habit_logs','habit_progress','workouts','user_totals','messages','community_messages','billing_accounts','billing_orders','trainer_invitations','payment_settings','platform_modes','announcements','admin_audit_log','state_versions','operation_receipts','sync_conflicts','request_receipts'];
fs.mkdirSync(config.dataRoot,{recursive:true});
const localFile = path.join(config.dataRoot,'replication-local.json');
let local = fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile,'utf8')) : {systemId:crypto.randomUUID(),nodeId:crypto.randomUUID(),key:crypto.randomBytes(32).toString('hex'),upstream:'',cursor:0};
function save(){ fs.writeFileSync(localFile+'.tmp',JSON.stringify(local),{mode:0o600}); fs.renameSync(localFile+'.tmp',localFile); }
save();
db.exec(`CREATE TABLE IF NOT EXISTS state_versions(user_id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS request_receipts(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,hash TEXT NOT NULL,status INTEGER NOT NULL,response TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS operation_receipts(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, hash TEXT NOT NULL, response TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sync_conflicts(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,base_version INTEGER,current_version INTEGER,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS replica_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 INSERT OR IGNORE INTO replica_meta VALUES('applying','0');
 CREATE TABLE IF NOT EXISTS change_journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,table_name TEXT NOT NULL,row_key TEXT NOT NULL,op TEXT NOT NULL,row_json TEXT);
 CREATE TABLE IF NOT EXISTS global_ids(table_name TEXT NOT NULL,row_key TEXT NOT NULL,global_id TEXT NOT NULL,PRIMARY KEY(table_name,row_key));`);
const meta={};
for(const table of TABLES){
 const columns=db.prepare('PRAGMA table_info('+table+')').all();
 const pk=columns.find(c=>c.pk).name; meta[table]={pk,cols:columns.map(c=>c.name)};
 const row=prefix=>'json_object('+columns.map(c=>"'"+c.name+"',"+prefix+'."'+c.name+'"').join(',')+')';
 for(const [event,prefix,op] of [['INSERT','NEW','put'],['UPDATE','NEW','put'],['DELETE','OLD','delete']]){
  db.exec(`CREATE TRIGGER IF NOT EXISTS journal_${table}_${event} AFTER ${event} ON ${table}
   WHEN (SELECT value FROM replica_meta WHERE key='applying')='0'
   BEGIN INSERT INTO change_journal(table_name,row_key,op,row_json) VALUES('${table}',CAST(${prefix}."${pk}" AS TEXT),'${op}',${event==='DELETE'?'NULL':row(prefix)}); END;`);
 }
}
function ensureGlobalIds(){
 const ins=db.prepare('INSERT OR IGNORE INTO global_ids VALUES(?,?,?)');
 db.transaction(()=>{for(const t of TABLES)for(const r of db.prepare('SELECT "'+meta[t].pk+'" AS k FROM '+t).all()){
  const key=String(r.k); ins.run(t,key,crypto.createHash('sha256').update(local.systemId+'/'+t+'/'+key).digest('hex'));
 }})();
}
ensureGlobalIds();
let running=false,timer,lastError='',lastSuccess=local.lastSuccess||null;
function status(){return {systemId:local.systemId,nodeId:local.nodeId,apiVersion:2,role:local.upstream?'replica':'authority',cursor:local.cursor,lastSuccess,lastError,upstream:local.upstream||null,ready:!local.upstream||!!lastSuccess&&Date.now()-lastSuccess<15000};}
function authorize(req,res,next){
 const supplied=Buffer.from(String(req.headers['x-replication-key']||'')), expected=Buffer.from(local.key);
 if(!(req.secure || ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.ip)))return res.status(403).json({error:'Межсерверная синхронизация требует HTTPS.'});
 if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected))return res.status(401).json({error:'Недействительный ключ узла.'});
 next();
}
function attachments(){return fs.readdirSync(config.uploadDir).filter(n=>/^[\w.-]+$/.test(n)&&fs.statSync(path.join(config.uploadDir,n)).isFile()).map(name=>{const bytes=fs.readFileSync(path.join(config.uploadDir,name));return {name,hash:crypto.createHash('sha256').update(bytes).digest('hex'),data:bytes.toString('base64')};});}
function exportData(cursor){
 return db.transaction(()=>{
  ensureGlobalIds();
  const seq=db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM change_journal').get().n;
  if(cursor>seq)throw new Error('Курсор больше журнала. Требуется повторное связывание.');
  const packet={systemId:local.systemId,apiVersion:2,cursor:seq,attachments:attachments()};
  if(cursor===null){packet.tables={}; for(const t of TABLES) packet.tables[t]=db.prepare('SELECT * FROM '+t).all();}
  else packet.changes=db.prepare('SELECT * FROM change_journal WHERE seq>? ORDER BY seq').all(cursor);
  return packet;
 })();
}
function apply(packet){
 if(packet.apiVersion!==2||packet.systemId!==local.systemId)throw new Error('Несовместимый или посторонний сервер.');
 if(!Number.isSafeInteger(packet.cursor)||packet.cursor<local.cursor)throw new Error('Устаревший курсор.');
 const files=(packet.attachments||[]).map(a=>{
  if(!/^[\w.-]+$/.test(a.name)||a.name==='.'||a.name==='..')throw new Error('Некорректное вложение.');
  const bytes=Buffer.from(a.data,'base64');if(crypto.createHash('sha256').update(bytes).digest('hex')!==a.hash)throw new Error('Ошибка целостности вложения.');
  return {name:a.name,bytes};
 });
 // Files are immutable uploads. Stage and rename before DB commit; an interrupted run only leaves unreferenced files.
 for(const f of files){const dest=path.join(config.uploadDir,f.name);fs.writeFileSync(dest+'.sync-tmp',f.bytes);fs.renameSync(dest+'.sync-tmp',dest);}
 db.transaction(()=>{
  db.pragma('defer_foreign_keys = ON');
  db.prepare("UPDATE replica_meta SET value='1' WHERE key='applying'").run();
  function put(t,row){
   if(!meta[t]||!row||meta[t].cols.some(c=>!(c in row)))throw new Error('Неверная схема репликации.');
   const {cols,pk}=meta[t];
   const sql='INSERT INTO '+t+' ('+cols.map(c=>'"'+c+'"').join(',')+') VALUES ('+cols.map(()=>'?').join(',')+') ON CONFLICT("'+pk+'") DO UPDATE SET '+cols.filter(c=>c!==pk).map(c=>'"'+c+'"=excluded."'+c+'"').join(',');
   db.prepare(sql).run(...cols.map(c=>row[c]));
  }
  if(packet.tables){
   if(TABLES.some(t=>!Array.isArray(packet.tables[t])))throw new Error('Неполный снимок.');
   db.prepare('DELETE FROM global_ids').run();
   for(const t of [...TABLES].reverse())db.prepare('DELETE FROM '+t).run();
   for(const t of TABLES)for(const r of packet.tables[t])put(t,r);
  }else{
   for(const c of packet.changes||[]){
    if(!meta[c.table_name])throw new Error('Неизвестная таблица.');
    if(c.op==='delete')db.prepare('DELETE FROM '+c.table_name+' WHERE "'+meta[c.table_name].pk+'"=?').run(c.row_key);
    else if(c.op==='put')put(c.table_name,JSON.parse(c.row_json));else throw new Error('Неверная операция.');
   }
  }
  if(db.pragma('foreign_key_check').length)throw new Error('Нарушены связи данных.');
  db.prepare("INSERT OR REPLACE INTO replica_meta VALUES('cursor',?)").run(String(packet.cursor));
  db.prepare("UPDATE replica_meta SET value='0' WHERE key='applying'").run();
 })();
 local.cursor=packet.cursor;local.initialized=true;save();ensureGlobalIds();
}
async function sync(){
 if(running||!local.upstream)return; running=true;
 try{
  const persisted=db.prepare("SELECT value FROM replica_meta WHERE key='cursor'").get();
  const cursor=local.initialized&&persisted?Number(persisted.value):null;
  const res=await fetch(local.upstream+'/api/replication/export'+(cursor===null?'':'?cursor='+cursor),{headers:{'X-Replication-Key':local.key},signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!res.ok)throw new Error('Ответ ведущего узла: '+res.status);
  apply(await res.json());lastSuccess=Date.now();local.lastSuccess=lastSuccess;save();lastError='';
 }catch(e){lastError=e.name==='TimeoutError'?'Истекло время ожидания связи.':String(e.message).replace(/https?:\/\/\S+/g,'[адрес]');}
 finally{running=false;}
}
function join(options){
 const url=new URL(options.url);if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw new Error('Нужен HTTPS-адрес сервера без пути и пароля.');
 if(!/^[a-f0-9]{64}$/.test(options.key)||! /^[a-f0-9-]{36}$/.test(options.systemId))throw new Error('Неверные параметры связывания.');
 if(local.upstream)throw new Error('Этот узел уже связан. Для переноса используйте отдельный каталог данных.');
 if(db.prepare('SELECT COUNT(*) AS n FROM users').get().n>1||db.prepare('SELECT COUNT(*) AS n FROM habits').get().n||db.prepare('SELECT COUNT(*) AS n FROM groups').get().n)throw new Error('База заполнена. Автоматическое объединение запрещено: сначала экспортируйте данные для ручного согласования.');
 const backup=require('./backup').createBackup('pre_restore');if(!backup.ok)throw new Error('Не удалось сохранить защитную копию.');
 local.upstream=url.origin;local.key=options.key;local.systemId=options.systemId;local.cursor=0;local.initialized=false;save();sync();
 return status();
}
async function proxy(req,res,next){
 if(!local.upstream)return next();
 try{
  const headers={};for(const name of ['authorization','content-type','idempotency-key','if-match'])if(req.headers[name])headers[name]=req.headers[name];
  const hasBody=!['GET','HEAD'].includes(req.method);
  const form=String(req.headers['content-type']||'').startsWith('multipart/');
  const response=await fetch(local.upstream+req.originalUrl,{method:req.method,headers,body:hasBody?(form?req:JSON.stringify(req.body||{})):undefined,duplex:form?'half':undefined,signal:AbortSignal.timeout(15000),redirect:'error'});
  res.status(response.status);res.set('Content-Type',response.headers.get('content-type')||'application/json');res.send(Buffer.from(await response.arrayBuffer()));
 }catch(e){res.status(503).json({error:'Ведущий узел недоступен. Локальные изменения остаются в очереди; права и административные действия требуют связи.',code:'AUTHORITY_UNAVAILABLE'});}
}
function start(){sync();timer=setInterval(sync,5000);timer.unref();}
function stop(){clearInterval(timer);}
module.exports={TABLES,status,authorize,exportData,apply,sync,join,proxy,start,stop,pairing:()=>({systemId:local.systemId,key:local.key}),isReplica:()=>!!local.upstream};
