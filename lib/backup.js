// Резервное копирование и восстановление (разделы 32-35, 57).
// Backup — это полный JSON-снимок всех таблиц, кроме самой таблицы backups.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const migrate = require('./migrate');
const crypto = require('crypto');

const TABLES = [
  'plans', 'users', 'subscriptions', 'groups', 'group_members', 'friendships',
  'communities', 'community_members', 'community_goals', 'community_goal_contrib',
  'habits', 'habit_logs', 'habit_progress', 'workouts', 'user_totals',
  'messages', 'community_messages','billing_accounts','billing_orders','trainer_invitations', 'payment_settings', 'admin_audit_log', 'platform_modes', 'announcements',
  'state_versions','operation_receipts','sync_conflicts','request_receipts'
];

// Таблицы, которых могло не быть в backup-файле, снятом до появления этой таблицы
// (Round 2). Их отсутствие в старом файле — не повреждение, а ожидаемая история;
// restoreAll() и так подставляет [] для отсутствующего ключа (см. insertRows ниже).
const OPTIONAL_TABLES = ['announcements','billing_accounts','billing_orders','trainer_invitations','community_messages','platform_modes','state_versions','operation_receipts','sync_conflicts','request_receipts'];

function dumpAllTables() {
  const data = {};
  TABLES.forEach(function (t) { data[t] = db.prepare('SELECT * FROM ' + t).all(); });
  const attachments=fs.readdirSync(config.uploadDir).filter(n=>/^[\w.-]+$/.test(n)&&fs.statSync(path.join(config.uploadDir,n)).isFile()).map(name=>{const bytes=fs.readFileSync(path.join(config.uploadDir,name));return {name,hash:crypto.createHash('sha256').update(bytes).digest('hex'),data:bytes.toString('base64')};});
  return { version: 2, createdAt: Date.now(), tables: data, attachments };
}

function createBackup(type) {
  try {
    const payload = dumpAllTables();
    const filename = 'backup-' + new Date(payload.createdAt).toISOString().replace(/[:.]/g, '-') + '-' + type + '.json';
    const filePath = path.join(config.backupDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(payload));
    const size = fs.statSync(filePath).size;
    db.prepare("INSERT INTO backups (filename, type, size_bytes, status, created_at) VALUES (?,?,?,'ok',?)")
      .run(filename, type, size, Date.now());
    return { ok: true, filename: filename, size: size };
  } catch (e) {
    db.prepare("INSERT INTO backups (filename, type, size_bytes, status, error_text, created_at) VALUES ('',?,0,'error',?,?)")
      .run(type, String(e && e.message || e), Date.now());
    console.error('[backup] Ошибка создания backup:', e);
    return { ok: false, error: String(e && e.message || e) };
  }
}

function listBackups() {
  return db.prepare('SELECT * FROM backups ORDER BY created_at DESC LIMIT 100').all();
}

function readBackupFile(filename) {
  if (!filename || filename.indexOf('..') > -1 || /[\\/:]/.test(filename) || path.basename(filename)!==filename) {
    throw new Error('Некорректное имя файла резервной копии.');
  }
  const filePath = path.join(config.backupDir, filename);
  if (!fs.existsSync(filePath)) throw new Error('Файл резервной копии не найден.');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error('Резервная копия повреждена или имеет неверный формат (не удалось прочитать JSON).');
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.tables || typeof parsed.tables !== 'object') {
    throw new Error('Резервная копия повреждена или имеет неверный формат.');
  }
  const missing = TABLES.filter(function (t) {
    return OPTIONAL_TABLES.indexOf(t) === -1 && !Array.isArray(parsed.tables[t]);
  });
  if (missing.length) {
    throw new Error('Резервная копия повреждена: отсутствуют таблицы (' + missing.join(', ') + ').');
  }
  return parsed;
}

function columnsOf(rows) {
  if (!rows.length) return null;
  return Object.keys(rows[0]);
}

function insertRows(table, rows) {
  const cols = columnsOf(rows);
  if (!cols) return;
  const allowed=new Set(db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name));
  if(cols.some(c=>!allowed.has(c)))throw new Error('Резервная копия содержит неизвестные поля.');
  const placeholders = cols.map(function () { return '?'; }).join(',');
  const stmt = db.prepare('INSERT INTO ' + table + ' (' + cols.join(',') + ') VALUES (' + placeholders + ')');
  rows.forEach(function (r) { stmt.run(cols.map(function (c) { return r[c]; })); });
}

// Полное восстановление системы: перед восстановлением сначала создаётся защитная копия
// текущего состояния (раздел 35), затем все таблицы заменяются содержимым из backup.
function restoreAll(filename) {
  const backup = readBackupFile(filename);
  const safety = createBackup('pre_restore');
  if (!safety.ok) throw new Error('Не удалось создать защитную копию перед восстановлением. Восстановление отменено.');
  const prepared=(backup.attachments||[]).map(a=>{if(!/^[\w.-]+$/.test(a.name)||a.name==='.'||a.name==='..')throw new Error('Некорректное имя вложения.');const bytes=Buffer.from(a.data,'base64');if(crypto.createHash('sha256').update(bytes).digest('hex')!==a.hash)throw new Error('Повреждено вложение.');return {name:a.name,bytes};});
  for(const a of prepared){fs.writeFileSync(path.join(config.uploadDir,a.name+'.restore-tmp'),a.bytes);fs.renameSync(path.join(config.uploadDir,a.name+'.restore-tmp'),path.join(config.uploadDir,a.name));}
  const oldVersions=db.prepare('SELECT * FROM state_versions').all();
  const oldAuth=new Map(db.prepare('SELECT id,auth_version FROM users').all().map(u=>[u.id,u.auth_version]));

  // PRAGMA foreign_keys — no-op внутри активной транзакции в SQLite, поэтому переключаем
  // его строго до/после db.transaction(), а не внутри неё.
  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(function () {
      // Удаляем в обратном порядке зависимостей, вставляем в прямом.
      TABLES.slice().reverse().forEach(function (t) { db.prepare('DELETE FROM ' + t).run(); });
      TABLES.forEach(function (t) { insertRows(t, backup.tables[t] || []); });
      for(const r of oldVersions)db.prepare('INSERT INTO state_versions VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET version=MAX(version,excluded.version)').run(r.user_id,r.version+1);
      for(const u of db.prepare('SELECT id,auth_version FROM users').all())db.prepare('UPDATE users SET auth_version=? WHERE id=?').run(Math.max(u.auth_version,oldAuth.get(u.id)||0)+1,u.id);
      if(db.pragma('foreign_key_check').length)throw new Error('В резервной копии нарушены связи данных.');
    });
    tx();
    // Backup мог быть снят до появления platform_modes/'pro' — досеваем настройки по
    // умолчанию, если они не попали в восстановленные данные. Пользовательские данные
    // не трогает.
    migrate.seedDefaults(db);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return { ok: true, safetyBackup: safety.filename };
}

// Восстановление данных только выбранных пользователей (раздел 35, 57).
// Восстанавливает: учётную запись, её привычки/логи/прогресс/тренировки/totals, собственные
// группы (если пользователь — тренер, включая состав участников на момент backup),
// собственные сообщества и их цели/вклады, подписки, дружеские связи и сообщения —
// но только там, где это не ломает ссылочную целостность с текущими данными.
function restoreSelectedUsers(filename, userIds) {
  const backup = readBackupFile(filename);
  const backupUsers = backup.tables.users.filter(function (u) { return userIds.indexOf(u.id) > -1; });
  const foundIds = backupUsers.map(function (u) { return u.id; });
  const notFound = userIds.filter(function (id) { return foundIds.indexOf(id) === -1; });
  if (notFound.length) {
    throw new Error('В резервной копии не найдены пользователи с ID: ' + notFound.join(', ') + '.');
  }

  const safety = createBackup('pre_restore');
  if (!safety.ok) throw new Error('Не удалось создать защитную копию перед восстановлением. Восстановление отменено.');

  const idSet = foundIds;
  const previousUsers=new Map(db.prepare('SELECT id,auth_version FROM users').all().map(u=>[u.id,u.auth_version]));
  const previousVersions=new Map(db.prepare('SELECT * FROM state_versions').all().map(u=>[u.user_id,u.version]));
  const inList = function (col) { return col + ' IN (' + idSet.map(function () { return '?'; }).join(',') + ')'; };

  db.pragma('foreign_keys = OFF');
  try {
  const tx = db.transaction(function () {
    // 1) пользователи
    db.prepare('DELETE FROM users WHERE ' + inList('id')).run(...idSet);
    insertRows('users', backupUsers);

    // 2) личные данные (привычки/логи/прогресс/тренировки/итоги), включая назначенные им
    //    тренером привычки, если соответствующая группа тоже существует в текущей БД.
    ['habits', 'habit_logs', 'habit_progress', 'workouts', 'user_totals', 'subscriptions'].forEach(function (table) {
      const rows = backup.tables[table].filter(function (r) { return idSet.indexOf(r.user_id) > -1; });
      db.prepare('DELETE FROM ' + table + ' WHERE ' + inList('user_id')).run(...idSet);
      insertRows(table, rows);
    });

    // 3) группы, где восстанавливаемый пользователь — тренер (плюс состав участников на момент backup)
    const ownGroups = backup.tables.groups.filter(function (g) { return idSet.indexOf(g.trainer_id) > -1; });
    const ownGroupIds = ownGroups.map(function (g) { return g.id; });
    if (ownGroupIds.length) {
      db.prepare('DELETE FROM groups WHERE ' + inList('trainer_id')).run(...idSet);
      insertRows('groups', ownGroups);
      const members = backup.tables.group_members.filter(function (m) { return ownGroupIds.indexOf(m.group_id) > -1; });
      db.prepare('DELETE FROM group_members WHERE group_id IN (' + ownGroupIds.map(function () { return '?'; }).join(',') + ')').run(...ownGroupIds);
      insertRows('group_members', members);
    }

    // 4) сообщества, которыми владеет пользователь, с их целями и вкладами
    const ownCommunities = backup.tables.communities.filter(function (c) { return idSet.indexOf(c.owner_id) > -1; });
    const ownCommunityIds = ownCommunities.map(function (c) { return c.id; });
    if (ownCommunityIds.length) {
      const communityPh = ownCommunityIds.map(function () { return '?'; }).join(',');
      // PRAGMA foreign_keys=OFF отключает автоматический ON DELETE CASCADE, поэтому дочерние
      // таблицы community_members/community_goals/community_goal_contrib нужно чистить явно —
      // иначе при повторной вставке старые строки с теми же id вызовут UNIQUE constraint.
      const oldGoalIds = db.prepare('SELECT id FROM community_goals WHERE community_id IN (' + communityPh + ')').all(...ownCommunityIds).map(function (g) { return g.id; });
      if (oldGoalIds.length) {
        const goalPh = oldGoalIds.map(function () { return '?'; }).join(',');
        db.prepare('DELETE FROM community_goal_contrib WHERE goal_id IN (' + goalPh + ')').run(...oldGoalIds);
      }
      db.prepare('DELETE FROM community_goals WHERE community_id IN (' + communityPh + ')').run(...ownCommunityIds);
      db.prepare('DELETE FROM community_members WHERE community_id IN (' + communityPh + ')').run(...ownCommunityIds);
      db.prepare('DELETE FROM communities WHERE ' + inList('owner_id')).run(...idSet);

      insertRows('communities', ownCommunities);
      const cm = backup.tables.community_members.filter(function (m) { return ownCommunityIds.indexOf(m.community_id) > -1; });
      const goals = backup.tables.community_goals.filter(function (g) { return ownCommunityIds.indexOf(g.community_id) > -1; });
      const goalIds = goals.map(function (g) { return g.id; });
      const contrib = backup.tables.community_goal_contrib.filter(function (c) { return goalIds.indexOf(c.goal_id) > -1; });
      insertRows('community_members', cm);
      insertRows('community_goals', goals);
      insertRows('community_goal_contrib', contrib);
    }

    // 5) дружеские связи и сообщения — только если оба участника существуют в текущей БД
    //    (после восстановления выбранных пользователей выше).
    const currentUserIds = db.prepare('SELECT id FROM users').all().map(function (u) { return u.id; });
    const friendRows = backup.tables.friendships.filter(function (f) {
      return (idSet.indexOf(f.requester_id) > -1 || idSet.indexOf(f.addressee_id) > -1) &&
        currentUserIds.indexOf(f.requester_id) > -1 && currentUserIds.indexOf(f.addressee_id) > -1;
    });
    db.prepare('DELETE FROM friendships WHERE ' + inList('requester_id') + ' OR ' + inList('addressee_id')).run(...idSet, ...idSet);
    insertRows('friendships', friendRows);

    const msgRows = backup.tables.messages.filter(function (m) {
      const senderOk = currentUserIds.indexOf(m.sender_id) > -1;
      const recipOk = m.recipient_id == null || currentUserIds.indexOf(m.recipient_id) > -1;
      const touches = idSet.indexOf(m.sender_id) > -1 || idSet.indexOf(m.recipient_id) > -1;
      return touches && senderOk && recipOk;
    });
    db.prepare('DELETE FROM messages WHERE ' + inList('sender_id') + ' OR ' + inList('recipient_id')).run(...idSet, ...idSet);
    insertRows('messages', msgRows);
    const communityIds = new Set(db.prepare('SELECT id FROM communities').all().map(c=>c.id));
    db.prepare('DELETE FROM community_messages WHERE ' + inList('sender_id')).run(...idSet);
    insertRows('community_messages', (backup.tables.community_messages||[]).filter(m=>idSet.includes(m.sender_id)&&communityIds.has(m.community_id)&&currentUserIds.includes(m.sender_id)));
    for(const table of ['billing_accounts','billing_orders','trainer_invitations']){db.prepare('DELETE FROM '+table+' WHERE '+inList('user_id')).run(...idSet);insertRows(table,(backup.tables[table]||[]).filter(r=>idSet.includes(r.user_id)));}
    for(const id of idSet){
      const u=db.prepare('SELECT auth_version FROM users WHERE id=?').get(id);
      db.prepare('UPDATE users SET auth_version=? WHERE id=?').run(Math.max(u.auth_version,previousUsers.get(id)||0)+1,id);
      db.prepare('INSERT INTO state_versions VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET version=excluded.version').run(id,(previousVersions.get(id)||0)+1);
    }
    if(db.pragma('foreign_key_check').length)throw new Error('Выборочное восстановление нарушает связи. Используйте полное восстановление после согласования данных.');
  });
  tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return { ok: true, safetyBackup: safety.filename, restoredUserIds: foundIds };
}

module.exports = { createBackup, listBackups, readBackupFile, restoreAll, restoreSelectedUsers, TABLES };
