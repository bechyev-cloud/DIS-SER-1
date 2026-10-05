const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { friendCode } = require('./ids');

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.backupDir, { recursive: true });

const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
db.exec(schema);

require('./migrate').run(db);

function now() { return Date.now(); }

function seedPlans() {
  // Проверяем конкретно наличие базового тарифа 'free', а не просто "есть ли вообще строки" —
  // к этому моменту lib/migrate.js уже мог создать тариф 'pro' (Round 2), и на чистой базе
  // COUNT(*)>0 ложно считал бы все тарифы уже засеянными, пропуская free/trainer10/20/30.
  const existing = db.prepare("SELECT 1 FROM plans WHERE key = 'free'").get();
  if (existing) return;
  const insert = db.prepare(`INSERT INTO plans (key, name, price, client_limit, description, active, is_trainer_plan, created_at, updated_at)
    VALUES (@key,@name,@price,@client_limit,@description,1,@is_trainer_plan,@t,@t)`);
  const t = now();
  const tx = db.transaction((plans) => { plans.forEach((p) => insert.run(Object.assign({ t }, p))); });
  tx([
    { key: 'free', name: 'Обычный', price: 0, client_limit: 0, description: 'Базовый доступ для обычного пользователя', is_trainer_plan: 0 },
    { key: 'trainer10', name: 'Trainer 10', price: 990, client_limit: 10, description: 'До 10 клиентов', is_trainer_plan: 1 },
    { key: 'trainer20', name: 'Trainer 20', price: 1690, client_limit: 20, description: 'До 20 клиентов', is_trainer_plan: 1 },
    { key: 'trainer30', name: 'Trainer 30', price: 2290, client_limit: 30, description: 'До 30 клиентов', is_trainer_plan: 1 }
  ]);
  console.log('[db] Созданы тарифы по умолчанию (free, trainer10, trainer20, trainer30). Цены можно изменить в админ-панели.');
}

function seedAdmin() {
  const adminExists = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='ADMIN'").get().c;
  if (adminExists > 0) return;
  const hash = bcrypt.hashSync(config.adminPassword, 11);
  const t = now();
  db.prepare(`INSERT INTO users (username, email, password_hash, role, display_name, avatar_emoji, status, friend_code, created_at, updated_at)
    VALUES (?,?,?,'ADMIN',?,?, 'active', ?, ?, ?)`)
    .run(config.adminLogin, null, hash, 'Администратор', '🛡️', friendCode(), t, t);
  console.log('[db] Создан администратор "' + config.adminLogin + '" из переменных окружения. Обязательно смените пароль после первого входа в production.');
}

function seedPaymentSettings() {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM payment_settings WHERE id=1').get().c;
  if (existing > 0) return;
  db.prepare(`INSERT INTO payment_settings (id, recipient_name, phone, card_requisites, extra_info, whatsapp, qr_path, updated_at)
    VALUES (1,'','','','','',NULL,?)`).run(now());
}

seedPlans();
seedAdmin();
seedPaymentSettings();

module.exports = db;
