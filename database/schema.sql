-- Схема базы данных «Дисциплина Pro». SQLite. Все запросы в коде используют prepared statements.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL UNIQUE,
  email           TEXT,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','TRAINER','ADMIN')),
  display_name    TEXT NOT NULL,
  avatar_emoji    TEXT DEFAULT '🙂',
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  friend_code     TEXT NOT NULL UNIQUE,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  price         INTEGER NOT NULL DEFAULT 0,
  client_limit  INTEGER NOT NULL DEFAULT 0,
  description   TEXT DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  is_trainer_plan INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id               INTEGER NOT NULL REFERENCES plans(id),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','cancelled')),
  requisites_shown_at   INTEGER,
  whatsapp_sent_at      INTEGER,
  activated_by_admin_id INTEGER REFERENCES users(id),
  activated_at          INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trainer_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  invite_code   TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at   INTEGER NOT NULL,
  UNIQUE(group_id, user_id)
);

CREATE TABLE IF NOT EXISTS friendships (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(requester_id, addressee_id)
);

CREATE TABLE IF NOT EXISTS communities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  emoji       TEXT DEFAULT '👥',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS community_members (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id  INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at      INTEGER NOT NULL,
  UNIQUE(community_id, user_id)
);

CREATE TABLE IF NOT EXISTS community_goals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id  INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  target        INTEGER NOT NULL,
  unit          TEXT DEFAULT '',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS community_goal_contrib (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id     INTEGER NOT NULL REFERENCES community_goals(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  UNIQUE(goal_id, user_id)
);

CREATE TABLE IF NOT EXISTS habits (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  emoji         TEXT DEFAULT '✅',
  type          TEXT NOT NULL DEFAULT 'simple',
  config_json   TEXT NOT NULL DEFAULT '{}',
  group_id      INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  assigned_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS habit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  habit_id    TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  date_key    TEXT NOT NULL,
  done        INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL,
  UNIQUE(habit_id, date_key)
);

CREATE TABLE IF NOT EXISTS habit_progress (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  habit_id        TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  date_key        TEXT NOT NULL,
  progress_json   TEXT NOT NULL DEFAULT '{}',
  updated_at      INTEGER NOT NULL,
  UNIQUE(habit_id, date_key)
);

CREATE TABLE IF NOT EXISTS workouts (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'other',
  date_key    TEXT NOT NULL,
  duration    INTEGER,
  note        TEXT DEFAULT '',
  habit_id    TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_totals (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  zikr_count        INTEGER NOT NULL DEFAULT 0,
  timer_sessions    INTEGER NOT NULL DEFAULT 0,
  timer_minutes     INTEGER NOT NULL DEFAULT 0,
  checklist_done    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
  group_id      INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  read_at       INTEGER
);

CREATE TABLE IF NOT EXISTS payment_settings (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  recipient_name      TEXT DEFAULT '',
  phone               TEXT DEFAULT '',
  card_requisites     TEXT DEFAULT '',
  extra_info          TEXT DEFAULT '',
  whatsapp            TEXT DEFAULT '',
  qr_path             TEXT,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('auto','manual','pre_restore')),
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL CHECK (status IN ('ok','error')),
  error_text  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id      INTEGER REFERENCES users(id),
  action        TEXT NOT NULL,
  details_json  TEXT DEFAULT '{}',
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_id);
CREATE INDEX IF NOT EXISTS idx_habit_logs_user ON habit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_habit_progress_user ON habit_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_workouts_user ON workouts(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id);
CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id);

CREATE TABLE IF NOT EXISTS community_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE, sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS community_messages_thread ON community_messages(community_id,id);

CREATE TABLE IF NOT EXISTS billing_accounts(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,personal_until INTEGER NOT NULL,trainer_until INTEGER NOT NULL DEFAULT 0,seat_limit INTEGER NOT NULL DEFAULT 0,seat_used INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS billing_orders(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,plan_key TEXT NOT NULL,seat_count INTEGER NOT NULL,include_start INTEGER NOT NULL,base_price INTEGER NOT NULL,seat_price INTEGER NOT NULL,amount INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','pending','approved','rejected','cancelled')),reviewed_by INTEGER REFERENCES users(id),admin_note TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS trainer_invitations(id INTEGER PRIMARY KEY AUTOINCREMENT,group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(group_id,user_id));
