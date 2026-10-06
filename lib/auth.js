const jwt = require('jsonwebtoken');
const config = require('./config');
const db = require('./db');
const { unauthorized, forbidden } = require('./errors');

const TOKEN_TTL = '30d';

function signToken(user) {
  return jwt.sign({ uid: user.id, role: user.role, ver:user.auth_version||0 }, config.jwtSecret, { expiresIn: TOKEN_TTL,issuer:require('./replication').status().systemId });
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    email: u.email || null,
    phone: u.phone || null,
    role: u.role==='USER'&&require('./billing').account(u.id).demoActive?'TRAINER':u.role,
    displayName: u.display_name,
    avatarEmoji: u.avatar_emoji,
    status: u.status,
    chatMuted: !!u.chat_muted,
    friendCode: u.friend_code,
    createdAt: u.created_at
  };
}

// Извлекает Bearer-токен, проверяет подпись, подгружает актуального пользователя из БД
// (чтобы роль/статус всегда проверялись по серверным данным, а не по содержимому токена).
function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/.exec(header);
    if (!m) throw unauthorized();
    let payload;
    try {
      payload = jwt.verify(m[1], config.jwtSecret,{issuer:require('./replication').status().systemId});
    } catch (e) {
      throw unauthorized('Сессия истекла. Войдите снова.');
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
    if (!user) throw unauthorized('Аккаунт не найден.');
    if(payload.ver!==(user.auth_version||0))throw unauthorized('Доступ отозван. Войдите снова.');
    if (user.status !== 'active') throw forbidden('Аккаунт деактивирован. Обратитесь к администратору.');
    if(user.role==='USER'&&require('./billing').account(user.id).demoActive)user.role='TRAINER';
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/.exec(header);
  if (!m) return next();
  try {
    const payload = jwt.verify(m[1], config.jwtSecret,{issuer:require('./replication').status().systemId});
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
    if (user && user.status === 'active' && payload.ver===(user.auth_version||0)) req.user = user;
  } catch (e) { /* игнорируем невалидный токен для опциональной авторизации */ }
  next();
}

function requireRole() {
  const roles = Array.prototype.slice.call(arguments);
  return function (req, res, next) {
    if (!req.user) return next(unauthorized());
    if (roles.indexOf(req.user.role) === -1) return next(forbidden());
    next();
  };
}

module.exports = { signToken, publicUser, requireAuth, optionalAuth, requireRole };
