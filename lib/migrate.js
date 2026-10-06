// Безопасные аддитивные миграции поверх database/schema.sql (Round 2).
// Каждая проверяет текущее состояние через PRAGMA перед изменением — повторный
// запуск на уже мигрированной БД ничего не делает и не трогает существующие данные.
// Принимает открытое соединение db как параметр (а не require('./db')), чтобы избежать
// циклической зависимости: db.js вызывает migrate.run(db) сразу после exec(schema.sql).

const MODE_KEYS = ['workout', 'gym', 'nutrition', 'goals', 'discipline'];

function hasColumn(db, table, column) {
  const rows = db.prepare('PRAGMA table_info(' + table + ')').all();
  return rows.some(function (r) { return r.name === column; });
}

function addColumnIfMissing(db, table, column, ddl) {
  if (!hasColumn(db, table, column)) {
    db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl);
    console.log('[migrate] Добавлена колонка ' + table + '.' + column);
  }
}

function migrateSchema(db) {
  addColumnIfMissing(db, 'users', 'auth_version', 'auth_version INTEGER NOT NULL DEFAULT 0');
  // A trainer assignment has separate progress for each member, not one shared unique row.
  for(const table of ['habit_logs','habit_progress']){
    const sql=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql;
    if(/UNIQUE\s*\(habit_id,\s*date_key\)/i.test(sql)){
      db.transaction(()=>{
        const columns=db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name).join(',');
        const create=sql.replace('CREATE TABLE '+table,'CREATE TABLE '+table+'_v2').replace(/UNIQUE\s*\(habit_id,\s*date_key\)/i,'UNIQUE(user_id, habit_id, date_key)');
        db.exec(create);db.exec('INSERT INTO '+table+'_v2 ('+columns+') SELECT '+columns+' FROM '+table);
        db.exec('DROP TABLE '+table);db.exec('ALTER TABLE '+table+'_v2 RENAME TO '+table);
        db.exec('CREATE INDEX IF NOT EXISTS idx_'+table+'_user ON '+table+'(user_id)');
      })();
    }
  }
  addColumnIfMissing(db, 'users', 'mode_settings', "mode_settings TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, 'habits', 'target_user_id', 'target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
  addColumnIfMissing(db, 'subscriptions', 'admin_note', 'admin_note TEXT');
  addColumnIfMissing(db, 'subscriptions', 'reviewed_as', 'reviewed_as TEXT');

  db.exec(`CREATE TABLE IF NOT EXISTS platform_modes (
    key TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  )`);
}

// Досевает строки-настройки (НЕ пользовательские данные), которых может не хватать —
// как при первом запуске, так и после restoreAll() восстановлением backup, снятого ДО
// появления этой таблицы/тарифа (раздел 35: восстановление не должно ломать новые функции).
// Идемпотентно и безопасно вызывать многократно.
function seedDefaults(db) {
  db.prepare("INSERT OR IGNORE INTO platform_modes(key,enabled,updated_at) VALUES('communities',0,?)").run(Date.now());
  // Общая группа для всех пользователей: enabled=1 — открыта, 0 — закрыта администратором.
  db.prepare("INSERT OR IGNORE INTO platform_modes(key,enabled,updated_at) VALUES('global_chat',1,?)").run(Date.now());
  for(const [key,name,price,trainer,description] of [['start','Start',500,0,'Личная часть приложения, 500 ₽ в месяц'],['start_plus','Start Plus · тренер',100,1,'100 ₽ за ученика в месяц, Start оплачивается отдельно'],['trainer_pays','Тренер платит',100,1,'100 ₽ за ученика в месяц, тренер оплачивает личную часть учеников']])db.prepare('INSERT OR IGNORE INTO plans(key,name,price,client_limit,description,active,is_trainer_plan,created_at,updated_at) VALUES(?,?,?,0,?,1,?,?,?)').run(key,name,price,description,trainer,Date.now(),Date.now());
  const existing = db.prepare("SELECT COUNT(*) AS c FROM platform_modes WHERE key NOT IN ('communities','global_chat')").get().c;
  if (existing === 0) {
    const t = Date.now();
    const ins = db.prepare('INSERT INTO platform_modes (key, enabled, updated_at) VALUES (?,1,?)');
    const tx = db.transaction(function () { MODE_KEYS.forEach(function (k) { ins.run(k, t); }); });
    tx();
    console.log('[migrate] Созданы 5 режимов по умолчанию (все включены): ' + MODE_KEYS.join(', '));
  }

  // Платный тариф для обычных пользователей (не тренерский) — разблокирует привычки сверх
  // бесплатного лимита. Добавляется один раз, если такого ключа ещё нет (seedPlans() в db.js
  // не перезапускается, если таблица plans уже не пуста из Round 1).
  const proExists = db.prepare("SELECT 1 FROM plans WHERE key = 'pro'").get();
  if (!proExists) {
    const t = Date.now();
    db.prepare(`INSERT INTO plans (key, name, price, client_limit, description, active, is_trainer_plan, created_at, updated_at)
      VALUES ('pro','Pro',249,0,'Безлимит привычек и дополнительные параметры режимов',1,0,?,?)`).run(t, t);
    console.log('[migrate] Создан платный тариф "pro" для обычных пользователей (249 ₽/мес, безлимит привычек).');
  }
}

function run(db) {
  migrateSchema(db);
  if(!db.prepare('PRAGMA table_info(billing_accounts)').all().some(c=>c.name==='demo_until')){
    db.exec('ALTER TABLE billing_accounts ADD COLUMN demo_until INTEGER NOT NULL DEFAULT 0');
    for(const op of ['INSERT','UPDATE','DELETE'])db.exec('DROP TRIGGER IF EXISTS journal_billing_accounts_'+op);
  }
  // Счётчик непрочитанного в общей группе: до какого сообщения участник дочитал.
  if(!hasColumn(db,'group_members','last_read_message_id')){
    db.exec('ALTER TABLE group_members ADD COLUMN last_read_message_id INTEGER NOT NULL DEFAULT 0');
    for(const op of ['INSERT','UPDATE','DELETE'])db.exec('DROP TRIGGER IF EXISTS journal_group_members_'+op);
  }
  // Тариф «Тренер платит»: до какого времени тренер оплатил личную часть своих учеников.
  if(!hasColumn(db,'billing_accounts','students_paid_until')){
    db.exec('ALTER TABLE billing_accounts ADD COLUMN students_paid_until INTEGER NOT NULL DEFAULT 0');
    for(const op of ['INSERT','UPDATE','DELETE'])db.exec('DROP TRIGGER IF EXISTS journal_billing_accounts_'+op);
  }
  // Общая группа: до какого сообщения пользователь дочитал.
  if(!hasColumn(db,'users','global_read_id')){
    db.exec('ALTER TABLE users ADD COLUMN global_read_id INTEGER NOT NULL DEFAULT 0');
    for(const op of ['INSERT','UPDATE','DELETE'])db.exec('DROP TRIGGER IF EXISTS journal_users_'+op);
  }
  // Ограничение администратора: пользователь не может писать в общую группу.
  db.exec('CREATE TABLE IF NOT EXISTS user_notes (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  if(!hasColumn(db,'users','phone')){
    db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
    for(const op of ['INSERT','UPDATE','DELETE'])db.exec('DROP TRIGGER IF EXISTS journal_users_'+op);
  }
  if(!hasColumn(db,'users','chat_muted')){
    db.exec('ALTER TABLE users ADD COLUMN chat_muted INTEGER NOT NULL DEFAULT 0');
    for(const op of ['INSERT','UPDATE','DELETE'])db.exec('DROP TRIGGER IF EXISTS journal_users_'+op);
  }
  // Чат группы: до какого сообщения дочитал тренер.
  if(!hasColumn(db,'groups','trainer_read_id')){
    db.exec('ALTER TABLE groups ADD COLUMN trainer_read_id INTEGER NOT NULL DEFAULT 0');
    for(const op of ['INSERT','UPDATE','DELETE'])db.exec('DROP TRIGGER IF EXISTS journal_groups_'+op);
  }
  // Тренер может запретить ученику писать в чат группы.
  if(!hasColumn(db,'group_members','chat_muted')){
    db.exec('ALTER TABLE group_members ADD COLUMN chat_muted INTEGER NOT NULL DEFAULT 0');
    for(const op of ['INSERT','UPDATE','DELETE'])db.exec('DROP TRIGGER IF EXISTS journal_group_members_'+op);
  }
  // Сообщения от разработчика, которые показываются всем в центре экрана.
  // group_id IS NULL — сообщение от разработчика всем; иначе — от тренера ученикам группы.
  // lock_seconds — сколько секунд окно нельзя закрыть (0–300).
  db.exec('CREATE TABLE IF NOT EXISTS announcements(id INTEGER PRIMARY KEY AUTOINCREMENT,text TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_by INTEGER,created_at INTEGER NOT NULL,group_id INTEGER,lock_seconds INTEGER NOT NULL DEFAULT 0)');
  // Чат друзей: сообщение видят автор и его подтверждённые друзья (audience='friends').
  if(!hasColumn(db,'messages','audience')){
    db.exec('ALTER TABLE messages ADD COLUMN audience TEXT');
    for(const op of ['INSERT','UPDATE','DELETE'])db.exec('DROP TRIGGER IF EXISTS journal_messages_'+op);
  }
  if(!hasColumn(db,'users','friends_read_id')){
    db.exec('ALTER TABLE users ADD COLUMN friends_read_id INTEGER NOT NULL DEFAULT 0');
    for(const op of ['INSERT','UPDATE','DELETE'])db.exec('DROP TRIGGER IF EXISTS journal_users_'+op);
  }
  // Вложения в чате: голосовые сообщения, фото и файлы.
  if(!hasColumn(db,'messages','attachment_path')){
    for(const ddl of ['attachment_path TEXT','attachment_name TEXT','attachment_type TEXT','attachment_size INTEGER','attachment_kind TEXT','attachment_duration INTEGER'])db.exec('ALTER TABLE messages ADD COLUMN '+ddl);
    for(const op of ['INSERT','UPDATE','DELETE'])db.exec('DROP TRIGGER IF EXISTS journal_messages_'+op);
  }
  seedDefaults(db);
}

module.exports = { run, migrateSchema, seedDefaults, MODE_KEYS };
