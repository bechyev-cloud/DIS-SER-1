// Централизованная конфигурация сервера из переменных окружения.
// Файл настроек без точки в имени (такие файлы неудобно загружать на GitHub).
// Ищем по порядку: путь из DISCIPLINE_SETTINGS → DisciplineProData/settings.env в домашней папке
// → settings.env рядом с сервером → старый .env. Берётся первый найденный.
(function loadSettings() {
  const fs = require('fs'), p = require('path'), os = require('os');
  const candidates = [
    process.env.DISCIPLINE_SETTINGS,
    p.join(os.homedir(), 'DisciplineProData', 'settings.env'),
    p.join(__dirname, '..', 'settings.env'),
    p.join(process.cwd(), 'settings.env'),
    p.join(process.cwd(), '.env')
  ].filter(Boolean);
  const found = candidates.find(function (f) { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
  if (found) { require('dotenv').config({ path: found }); process.env.DISCIPLINE_SETTINGS_FILE = found; }
})();
const path = require('path');
const dataRoot = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : process.cwd();

function requireEnvInProd(name, devDefault) {
  const val = process.env[name];
  if (val && val.trim()) return val.trim();
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Переменная окружения ' + name + ' обязательна в production (файл settings.env).');
  }
  return devDefault;
}

const config = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '0.0.0.0',
  dataRoot,
  tlsCert: process.env.TLS_CERT || '',
  tlsKey: process.env.TLS_KEY || '',
  standardServer: process.env.STANDARD_SERVER_URL || '',
  nodeEnv: process.env.NODE_ENV || 'development',
  jwtSecret: requireEnvInProd('JWT_SECRET', 'dev-insecure-secret-change-me'),
  adminLogin: process.env.ADMIN_LOGIN || 'admin',
  adminPassword: requireEnvInProd('ADMIN_PASSWORD','admin123'),
  databasePath: path.resolve(dataRoot, process.env.DATABASE_PATH || './database/discipline.sqlite'),
  uploadDir: path.resolve(dataRoot, process.env.UPLOAD_DIR || './uploads'),
  backupDir: path.resolve(dataRoot, process.env.BACKUP_DIR || './backups'),
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
  backupHour: process.env.BACKUP_HOUR != null ? Number(process.env.BACKUP_HOUR) : 3,
  backupMinute: process.env.BACKUP_MINUTE != null ? Number(process.env.BACKUP_MINUTE) : 0
};

if (config.jwtSecret === 'dev-insecure-secret-change-me' && config.nodeEnv !== 'production') {
  console.warn('[config] ВНИМАНИЕ: используется временный JWT_SECRET для разработки. Задайте свой в settings.env перед production.');
}

module.exports = config;
