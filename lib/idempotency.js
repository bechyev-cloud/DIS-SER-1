'use strict';
const crypto=require('crypto');const db=require('./db');const {requireAuth}=require('./auth');
// Synchronous JSON business routes only. Uploads and restore have their own lifecycle.
module.exports=function(req,res,next){
 if(['GET','HEAD','OPTIONS'].includes(req.method)||req.path.startsWith('/auth/')||req.path==='/me/state'||req.path.startsWith('/admin/backups')||String(req.headers['content-type']||'').startsWith('multipart/'))return next();
 const key=req.headers['idempotency-key'];if(!key)return next();
 if(!/^[\w-]{8,100}$/.test(key))return res.status(400).json({error:'Некорректный ключ операции.'});
 requireAuth(req,res,function(err){
  if(err)return next(err);
  const id=req.user.id+':'+key;
  const hash=crypto.createHash('sha256').update(req.method+req.originalUrl+JSON.stringify(req.body||{})).digest('hex');
  const prior=db.prepare('SELECT * FROM request_receipts WHERE id=?').get(id);
  if(prior){if(prior.hash!==hash)return res.status(409).json({error:'Ключ операции использован для другого запроса.'});return res.status(prior.status).json(JSON.parse(prior.response));}
  const original=res.json;let captured,finished=false;
  res.json=function(body){captured=body;finished=true;return res;};
  try{
   db.transaction(()=>{
    next();
    if(!finished)throw Error('Асинхронный обработчик не поддерживает транзакционную запись.');
    if(res.statusCode>=400)throw Object.assign(Error('Request rejected'),{rejected:true});
    db.prepare('INSERT INTO request_receipts VALUES(?,?,?,?,?)').run(id,req.user.id,hash,res.statusCode,JSON.stringify(captured));
   })();
  }catch(e){if(!e.rejected){res.status(500);captured={error:'Операция не завершена. Данные не изменены.'};}}
  finally{res.json=original;}
  original.call(res,captured);
 });
};
