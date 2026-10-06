const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../lib/db');
const { signToken, publicUser, requireAuth } = require('../lib/auth');
const { friendCode } = require('../lib/ids');
const { badRequest, conflict, unauthorized } = require('../lib/errors');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток. Подождите немного и попробуйте снова.' }
});

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Телефон и почта необязательны. Пустое значение → null. Телефон храним в виде +79991234567.
function cleanPhone(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
  if (digits.length < 7 || digits.length > 15) throw badRequest('Проверьте номер телефона: в нём должно быть от 7 до 15 цифр.');
  return '+' + digits;
}
function cleanEmail(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase().slice(0, 120);
  if (!raw) return null;
  if (!EMAIL_RE.test(raw)) throw badRequest('Проверьте адрес электронной почты.');
  return raw;
}
function ensureContactsFree(phone, email, selfId) {
  if (phone && db.prepare('SELECT id FROM users WHERE phone = ? AND id <> ?').get(phone, selfId || 0)) throw conflict('Этот номер телефона уже указан в другом аккаунте.');
  if (email && db.prepare('SELECT id FROM users WHERE lower(email) = ? AND id <> ?').get(email, selfId || 0)) throw conflict('Эта электронная почта уже указана в другом аккаунте.');
}

router.post('/register', authLimiter, function (req, res, next) {
  try {
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const displayName = String(body.displayName || username).trim().slice(0, 60);
    const email = cleanEmail(body.email);
    const phone = cleanPhone(body.phone);

    if (!USERNAME_RE.test(username)) {
      throw badRequest('Имя пользователя должно быть от 3 до 32 символов: латинские буквы, цифры, точка, дефис или подчёркивание.');
    }
    if (Array.from(password).length < 4) {
      throw badRequest('Пароль должен быть не короче 4 символов.');
    }
    if (!displayName) {
      throw badRequest('Укажите имя, которое будут видеть другие.');
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) throw conflict('Это имя пользователя уже занято. Выберите другое.');

    ensureContactsFree(phone, email, 0);

    const hash = bcrypt.hashSync(password, 11);
    const t = Date.now();
    const info = db.prepare(`INSERT INTO users (username, email, phone, password_hash, role, display_name, avatar_emoji, status, friend_code, created_at, updated_at)
      VALUES (?,?,?,?,'USER',?,?,'active',?,?,?)`)
      .run(username, email, phone, hash, displayName, '🙂', friendCode(), t, t);
    db.prepare('INSERT INTO user_totals (user_id) VALUES (?)').run(info.lastInsertRowid);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    const token = signToken(user);
    res.status(201).json({ token: token, user: publicUser(user) });
  } catch (e) { next(e); }
});

router.post('/login', authLimiter, function (req, res, next) {
  try {
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      throw unauthorized('Неверное имя пользователя или пароль.');
    }
    if (user.status !== 'active') throw unauthorized('Аккаунт деактивирован. Обратитесь к администратору.');
    const token = signToken(user);
    res.json({ token: token, user: publicUser(user) });
  } catch (e) { next(e); }
});

router.get('/me', requireAuth, function (req, res) {
  res.json({ user: publicUser(req.user) });
});

// Изменение профиля: имя, телефон, почта. Телефон и почту можно оставить пустыми.
router.patch('/profile', requireAuth, function (req, res, next) {
  try {
    const body = req.body || {};
    const displayName = body.displayName === undefined ? req.user.display_name : String(body.displayName || '').trim().slice(0, 60);
    if (!displayName) throw badRequest('Укажите имя, которое будут видеть другие.');
    const phone = body.phone === undefined ? (req.user.phone || null) : cleanPhone(body.phone);
    const email = body.email === undefined ? (req.user.email || null) : cleanEmail(body.email);
    ensureContactsFree(phone, email, req.user.id);
    db.prepare('UPDATE users SET display_name=?, phone=?, email=?, updated_at=? WHERE id=?').run(displayName, phone, email, Date.now(), req.user.id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  } catch (e) { next(e); }
});

// Отзывает все ранее выданные сессии этого аккаунта, включая вход на других устройствах.
router.post('/logout', requireAuth, function (req, res) {
  db.prepare('UPDATE users SET auth_version=auth_version+1 WHERE id=?').run(req.user.id);
  res.json({ ok: true });
});
router.post('/password',requireAuth,function(req,res,next){
 try{const body=req.body||{};if(!bcrypt.compareSync(String(body.currentPassword||''),req.user.password_hash))throw unauthorized('Неверный текущий пароль.');if(typeof body.newPassword!=='string'||body.newPassword.length<12)throw badRequest('Новый пароль: не менее 12 символов.');db.prepare('UPDATE users SET password_hash=?,auth_version=auth_version+1,updated_at=? WHERE id=?').run(bcrypt.hashSync(body.newPassword,11),Date.now(),req.user.id);res.json({ok:true});}catch(e){next(e);}
});

module.exports = router;
