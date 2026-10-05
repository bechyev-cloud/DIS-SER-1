'use strict';
// Local administrator CLI. Run with the same DATA_DIR/.env as the stopped server.
const fs=require('fs'),path=require('path');
async function main(){
 const [action,file,url]=process.argv.slice(2);
 if(!['export','join'].includes(action)||!file)throw Error('node pair.js export <файл.json> <https://адрес> | node pair.js join <файл.json>. Сервер перед этим остановите.');
 const replication=require('./lib/replication');
 if(action==='export'){
  const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('Укажите HTTPS origin ведущего сервера.');
  fs.writeFileSync(path.resolve(file),JSON.stringify({...replication.pairing(),url:u.origin},null,2),{mode:0o600,flag:'wx'});
  console.log('Файл создан. Передайте его только администратору связанного сервера; он даёт доступ ко всем данным.');
 }else{
  replication.join(JSON.parse(fs.readFileSync(path.resolve(file),'utf8')));await replication.sync();
  console.log('Настройки связывания сохранены. Запустите сервер и проверьте состояние синхронизации.');
 }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
