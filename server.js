const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const cron = require('node-cron');

const config = require('./lib/config');
require('./lib/db'); // инициализация БД + seed при первом запуске
const replication = require('./lib/replication');
const { errorHandler } = require('./lib/errors');
const backupLib = require('./lib/backup');

const authRoutes = require('./routes/auth');
const dataRoutes = require('./routes/data');
const modeRoutes = require('./routes/modes');
const socialRoutes = require('./routes/social');
const groupRoutes = require('./routes/groups');
const messageRoutes = require('./routes/messages');
const planRoutes = require('./routes/plans');
const paymentRoutes = require('./routes/payment');
const adminRoutes = require('./routes/admin');
const adminBackupRoutes = require('./routes/backup');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.use(cors({
  origin: config.corsOrigins.length ? config.corsOrigins : true,
  credentials: false
}));
app.use(express.json({ limit: '2mb' }));

// Счётчик изменений: растёт при любом успешном изменении данных на сервере.
// Приложение сверяет его раз в пару секунд и, если он вырос, сразу обновляет данные.
let changeSeq = 0; const changeBoot = Date.now();
app.use('/api', function (req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') res.on('finish', function () { if (res.statusCode < 400) changeSeq++; });
  next();
});
app.get('/api/changes', function (req, res) { res.set('Cache-Control', 'no-store'); res.json({ seq: changeBoot + ':' + changeSeq }); });

// QR-коды и другие загруженные файлы отдаются статически. Никаких исполняемых типов —
// multer на загрузке уже ограничивает расширения/MIME (см. routes/admin.js).
app.use('/uploads', express.static(config.uploadDir, { maxAge: '1h', fallthrough: true, setHeaders: function (res) { res.set('X-Content-Type-Options', 'nosniff'); } }));

app.get('/api/health', function (req, res) { res.set('Cache-Control','no-store'); res.json(Object.assign({ok:true,time:Date.now()},replication.status())); });
app.get('/api/replication/export', replication.authorize, function(req,res,next){
  try{const n=req.query.cursor===undefined?null:Number(req.query.cursor);if(n!==null&&(!Number.isSafeInteger(n)||n<0))return res.status(400).json({error:'Неверный курсор'});res.set('Cache-Control','no-store');res.json(replication.exportData(n));}catch(e){next(e);}
});
app.get('/connection-config.js', function(req,res){res.type('js').set('Cache-Control','no-store').send('window.DISCIPLINE_CONFIG='+JSON.stringify({standard:config.standardServer})+';');});
// Папки приложений ищем рядом с сервером (../user-pwa) или внутри него (./user-pwa) — так
// проект работает и когда на хостинг загружена вся папка, и когда только содержимое server.
function appDir(name){const candidates=[path.join(__dirname,'..',name),path.join(__dirname,name)];const found=candidates.find(d=>{try{return fs.statSync(d).isDirectory();}catch(e){return false;}});if(!found)console.warn('[server] Папка '+name+' не найдена рядом с сервером — этот раздел открываться не будет.');return found||candidates[0];}
app.use('/shared',express.static(appDir('shared')));
app.use('/user',express.static(appDir('user-pwa')));
app.use('/admin',express.static(appDir('admin-pwa')));
app.get('/',function(req,res){res.redirect('/user/');});
app.use('/api', replication.proxy);
app.use('/api', require('./lib/idempotency'));

// Последнее активное сообщение от разработчика — показывается всем, в том числе без входа.
app.get('/api/announcement',function(req,res){const r=require('./lib/db').prepare('SELECT id,text,created_at,lock_seconds FROM announcements WHERE active=1 AND group_id IS NULL ORDER BY id DESC LIMIT 1').get();res.set('Cache-Control','no-store').json({announcements:r?[{id:r.id,kind:'developer',text:r.text,createdAt:r.created_at,lockSeconds:r.lock_seconds}]:[]});});
// Для вошедшего пользователя: сообщение разработчика + последние сообщения тренеров его групп.
app.get('/api/announcements/mine',require('./lib/auth').requireAuth,function(req,res){const db=require('./lib/db');
 const dev=db.prepare('SELECT id,text,created_at,lock_seconds FROM announcements WHERE active=1 AND group_id IS NULL ORDER BY id DESC LIMIT 1').get();
 const mine=db.prepare(`SELECT a.id,a.text,a.created_at,a.lock_seconds,g.name AS group_name,u.display_name AS trainer_name FROM announcements a JOIN groups g ON g.id=a.group_id JOIN group_members gm ON gm.group_id=g.id AND gm.user_id=? JOIN users u ON u.id=g.trainer_id WHERE a.active=1 AND a.id=(SELECT MAX(id) FROM announcements WHERE group_id=a.group_id AND active=1) ORDER BY a.id`).all(req.user.id);
 res.set('Cache-Control','no-store').json({announcements:(dev?[{id:dev.id,kind:'developer',text:dev.text,createdAt:dev.created_at,lockSeconds:dev.lock_seconds}]:[]).concat(mine.map(a=>({id:a.id,kind:'trainer',text:a.text,createdAt:a.created_at,lockSeconds:a.lock_seconds,groupName:a.group_name,trainerName:a.trainer_name})))});});
app.use('/api/auth', authRoutes);
app.use('/api/me', dataRoutes);
app.use('/api/me', modeRoutes); // /api/me/modes
app.get('/api/features',function(req,res){const r=require('./lib/db').prepare("SELECT enabled FROM platform_modes WHERE key='communities'").get();res.set('Cache-Control','no-store').json({communities:!!(r&&r.enabled)});});
app.use('/api', require('./routes/billing'));
app.use('/api', require('./routes/social-extra'));
app.use('/api', socialRoutes); // /api/friends/*, /api/communities/*
app.use('/api/groups', groupRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/plans', planRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/backups', adminBackupRoutes);

app.use('/api', function (req, res) { res.status(404).json({ error: 'Эндпойнт не найден.' }); });

app.use(errorHandler);

const listener = (config.tlsCert && config.tlsKey ? https.createServer({cert:fs.readFileSync(config.tlsCert),key:fs.readFileSync(config.tlsKey)},app) : http.createServer(app));
listener.listen(config.port, config.host, function () {
  console.log('[server] Discipline Pro API слушает порт ' + config.port + ' (env: ' + config.nodeEnv + ')');
  if(process.send)process.send({type:'ready',port:config.port,https:!!config.tlsCert});
});
listener.on('error',function(e){console.error(e.code==='EADDRINUSE'?'[server] Порт занят. Выберите другой порт.':'[server] Не удалось запустить сервер: '+e.code);process.exitCode=1;shutdown();});
replication.start();
let closing=false;
function shutdown(){if(closing)return;closing=true;replication.stop();if(backupTask)backupTask.stop();listener.close(()=>{require('./lib/db').close();process.exit(process.exitCode||0);});setTimeout(()=>process.exit(1),5000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
process.on('disconnect',shutdown);
process.on('message',async function(m){
 if(!m||!m.id)return;
 try{
  let value;
  if(m.action==='stop'){shutdown();return;}
  else if(m.action==='status')value=replication.status();
  else if(m.action==='backup')value=backupLib.createBackup('manual');
  else if(m.action==='backups')value=backupLib.listBackups();
  else if(m.action==='restore'){if(replication.isReplica())throw new Error('Восстановление выполняется на ведущем узле.');value=backupLib.restoreAll(m.filename);}
  else if(m.action==='pairing')value=replication.pairing();
  else if(m.action==='join')value=replication.join(m.options);
  else throw new Error('Неизвестная команда');
  process.send({id:m.id,value});
 }catch(e){process.send({id:m.id,error:e.message});}
});

// Автоматический ежедневный backup (раздел 33), время задаётся BACKUP_HOUR:BACKUP_MINUTE (по времени сервера).
const cronExpr = (config.backupMinute) + ' ' + (config.backupHour) + ' * * *';
const backupTask=cron.schedule(cronExpr, function () {
  console.log('[backup] Запуск автоматического ежедневного backup...');
  const result = backupLib.createBackup('auto');
  if (result.ok) console.log('[backup] Успешно: ' + result.filename + ' (' + result.size + ' байт)');
  else console.error('[backup] Ошибка автоматического backup: ' + result.error);
});
console.log('[backup] Автоматический backup запланирован на ' + config.backupHour + ':' + String(config.backupMinute).padStart(2, '0') + ' (время сервера).');

module.exports = app;
