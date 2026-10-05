'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Database=require('better-sqlite3');
test('migration preserves old records and separates member progress on a shared assignment',()=>{
 const db=new Database(':memory:');try{
 db.exec(fs.readFileSync(path.resolve(__dirname,'../database/schema.sql'),'utf8'));
 const user=db.prepare('INSERT INTO users(id,username,password_hash,display_name,friend_code,created_at,updated_at) VALUES(?,?,?,?,?,1,1)');user.run(1,'one','test','One','AAA');user.run(2,'two','test','Two','BBB');
 db.exec("INSERT INTO habits(id,user_id,name,created_at,updated_at) VALUES('shared',1,'Задание','2026-10-02',1); INSERT INTO habit_logs(id,user_id,habit_id,date_key,done,updated_at) VALUES(9,1,'shared','2026-10-02',1,1)");
 const migrate=require('../lib/migrate');migrate.migrateSchema(db);migrate.migrateSchema(db);
 assert.equal(db.prepare('SELECT habit_id FROM habit_logs WHERE id=9').get().habit_id,'shared');
 db.exec("INSERT INTO habit_logs(user_id,habit_id,date_key,done,updated_at) VALUES(2,'shared','2026-10-02',1,2)");
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM habit_logs').get().n,2);assert.deepEqual(db.pragma('foreign_key_check'),[]);
 }finally{db.close();}
});
