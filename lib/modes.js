// "Режимы" (раздел 4 инструкции): Тренировки/Спортзал/Диета/Цели/Дисциплина.
// Платформенный рубильник (администратор) + личная настройка пользователя (вкл/выкл),
// сохранённая на сервере — источник правды для того, какие поля показывать при
// создании задачи, но НЕ влияет на уже сохранённые данные существующих задач.
const db = require('./db');

const MODE_KEYS = ['workout', 'gym', 'nutrition', 'goals', 'discipline'];
const MODE_LABELS = {
  workout: 'Тренировки',
  gym: 'Спортзал',
  nutrition: 'Диета / питание',
  goals: 'Цели',
  discipline: 'Дисциплина / задачи'
};

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

function getPlatformModes() {
  const rows = db.prepare('SELECT * FROM platform_modes').all();
  const byKey = {};
  rows.forEach(function (r) { byKey[r.key] = !!r.enabled; });
  // На случай, если новый ключ режима появится позже, а строка ещё не создана — по умолчанию включён.
  MODE_KEYS.forEach(function (k) { if (!(k in byKey)) byKey[k] = true; });
  return byKey;
}

function setPlatformModeEnabled(key, enabled) {
  if (MODE_KEYS.indexOf(key) === -1) throw new Error('Неизвестный режим: ' + key);
  const t = Date.now();
  db.prepare(`INSERT INTO platform_modes (key, enabled, updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`)
    .run(key, enabled ? 1 : 0, t);
}

// Личные предпочтения пользователя, отфильтрованные платформенной доступностью:
// { workout: {enabled: bool, locked: bool}, ... } — locked=true значит "администратор
// отключил этот режим целиком", личная настройка в этом случае игнорируется, но не стирается.
function getUserModes(userId) {
  const user = db.prepare('SELECT mode_settings FROM users WHERE id = ?').get(userId);
  const personal = user ? safeJsonParse(user.mode_settings, {}) : {};
  const platform = getPlatformModes();
  const result = {};
  MODE_KEYS.forEach(function (k) {
    const platformOn = platform[k] !== false;
    const personalOn = personal[k] !== false; // по умолчанию включено, как и задумано в разделе 4
    result[k] = { enabled: platformOn && personalOn, locked: !platformOn, label: MODE_LABELS[k] };
  });
  return result;
}

function setUserModes(userId, patch) {
  const user = db.prepare('SELECT mode_settings FROM users WHERE id = ?').get(userId);
  const personal = user ? safeJsonParse(user.mode_settings, {}) : {};
  MODE_KEYS.forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) personal[k] = !!patch[k];
  });
  db.prepare('UPDATE users SET mode_settings = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(personal), Date.now(), userId);
  return getUserModes(userId);
}

module.exports = { MODE_KEYS, MODE_LABELS, getPlatformModes, setPlatformModeEnabled, getUserModes, setUserModes };
