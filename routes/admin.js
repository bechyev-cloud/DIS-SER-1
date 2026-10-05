const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../lib/db');
const config = require('../lib/config');
const { requireAuth, requireRole, publicUser } = require('../lib/auth');
const { adminSetUserPlan, activeSubscription, trainerClientLimit, trainerClientCount,
  listPaymentRequests, confirmPendingSubscription, rejectPendingSubscription } = require('../lib/subscription');
const modesLib = require('../lib/modes');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { uid } = require('../lib/ids');

const router = express.Router();
router.use(requireAuth, requireRole('ADMIN'));
router.get('/sync/conflicts',function(req,res){res.json({conflicts:db.prepare('SELECT id,user_id,base_version,current_version,payload,created_at FROM sync_conflicts ORDER BY created_at DESC LIMIT 100').all()});});
router.delete('/sync/conflicts/:id',function(req,res){db.prepare('DELETE FROM sync_conflicts WHERE id=?').run(req.params.id);res.json({ok:true});});

function audit(adminId, action, details) {
  db.prepare('INSERT INTO admin_audit_log (admin_id, action, details_json, created_at) VALUES (?,?,?,?)')
    .run(adminId, action, JSON.stringify(details || {}), Date.now());
}

/* ---------------- overview (раздел 18) ---------------- */
router.get('/overview', function (req, res) {
  const totalUsers = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role != 'ADMIN'").get().c;
  const activeUsers = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role != 'ADMIN' AND status='active'").get().c;
  const trainers = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='TRAINER'").get().c;
  const groups = db.prepare('SELECT COUNT(*) AS c FROM groups').get().c;
  const activeSubs = db.prepare("SELECT COUNT(*) AS c FROM (SELECT user_id FROM subscriptions WHERE status='active' UNION SELECT user_id FROM billing_accounts WHERE personal_until>? OR trainer_until>?)").get(Date.now(),Date.now()).c;
  const trainerClients = db.prepare('SELECT COUNT(DISTINCT user_id) AS c FROM group_members').get().c;
  const pendingPayments = db.prepare("SELECT COUNT(*) AS c FROM subscriptions WHERE status='pending'").get().c+db.prepare("SELECT COUNT(*) AS c FROM billing_orders WHERE status='pending'").get().c;
  const lastBackup = db.prepare("SELECT * FROM backups WHERE status='ok' ORDER BY created_at DESC LIMIT 1").get();
  res.json({
    totalUsers, activeUsers, trainers, groups, activeSubscriptions: activeSubs,
    trainerClients, pendingPayments,
    lastBackupAt: lastBackup ? lastBackup.created_at : null
  });
});

/* ---------------- users (раздел 19-20, 56) ---------------- */
router.get('/users', function (req, res) {
  const search = String(req.query.search || '').trim().toLowerCase();
  const filter = String(req.query.filter || 'all');
  let rows = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();

  if (search) {
    rows = rows.filter(function (u) {
      return (u.username || '').toLowerCase().includes(search) ||
        (u.display_name || '').toLowerCase().includes(search) ||
        (u.email || '').toLowerCase().includes(search) ||
        String(u.id) === search;
    });
  }
  if (filter === 'users') rows = rows.filter(function (u) { return u.role === 'USER'; });
  else if (filter === 'trainers') rows = rows.filter(function (u) { return u.role === 'TRAINER'; });
  else if (filter === 'active') rows = rows.filter(function (u) { return u.status === 'active'; });
  else if (filter === 'inactive') rows = rows.filter(function (u) { return u.status === 'inactive'; });

  const result = rows.map(function (u) {
    const sub = activeSubscription(u.id);
    const trainerOf = db.prepare(`SELECT t.id, t.display_name FROM group_members gm
      JOIN groups g ON g.id = gm.group_id JOIN users t ON t.id = g.trainer_id
      WHERE gm.user_id = ? LIMIT 1`).get(u.id);
    const groupCount = db.prepare('SELECT COUNT(*) AS c FROM group_members WHERE user_id = ?').get(u.id).c;
    return {
      id: u.id, username: u.username, displayName: u.display_name, role: u.role,
      status: u.status, createdAt: u.created_at,
      planKey: sub ? sub.plan_key : 'free', planName: sub ? sub.plan_name : 'Обычный',
      trainer: trainerOf ? { id: trainerOf.id, name: trainerOf.display_name } : null,
      groupCount: groupCount
    };
  });
  res.json({ users: result });
});

router.get('/users/:id', function (req, res, next) {
  try {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) throw notFound('Пользователь не найден.');
    const sub = activeSubscription(u.id);
    res.json({ user: publicUser(u), billing:require('../lib/billing').account(u.id), subscription: sub ? { planKey: sub.plan_key, planName: sub.plan_name, clientLimit: sub.client_limit } : null });
  } catch (e) { next(e); }
});

router.patch('/users/:id/plan', function (req, res, next) {
  try {
    const planKey = String((req.body && req.body.planKey) || '');
    if (!planKey) throw badRequest('Укажите ключ тарифа.');
    const sub = adminSetUserPlan(req.user.id, Number(req.params.id), planKey);
    res.json({ ok: true, subscription: sub ? { planKey: sub.plan_key, planName: sub.plan_name } : null });
  } catch (e) { next(badRequest(e.message)); }
});

router.patch('/users/:id/status', function (req, res, next) {
  try {
    const status = String((req.body && req.body.status) || '');
    if (['active', 'inactive'].indexOf(status) === -1) throw badRequest('Статус должен быть active или inactive.');
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) throw notFound('Пользователь не найден.');
    if (u.role === 'ADMIN') throw badRequest('Нельзя деактивировать администратора.');
    db.prepare('UPDATE users SET status=?, auth_version=auth_version+1, updated_at=? WHERE id=?').run(status, Date.now(), u.id);
    audit(req.user.id, 'set_user_status', { userId: u.id, status: status });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Ограничение: запретить / разрешить пользователю писать в общую группу.
router.patch('/users/:id/chat', function (req, res, next) {
  try {
    if (!req.body || typeof req.body.muted !== 'boolean') throw badRequest('Укажите muted: true или false.');
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) throw notFound('Пользователь не найден.');
    if (u.role === 'ADMIN') throw badRequest('Нельзя ограничить администратора.');
    db.prepare('UPDATE users SET chat_muted=?, updated_at=? WHERE id=?').run(req.body.muted ? 1 : 0, Date.now(), u.id);
    audit(req.user.id, req.body.muted ? 'mute_user_chat' : 'unmute_user_chat', { userId: u.id });
    res.json({ ok: true, chatMuted: req.body.muted });
  } catch (e) { next(e); }
});

// Ручное управление подпиской (без заявки): продлить Start, продлить места тренера,
// изменить число мест, включить «Тренер платит», снять доступ.
router.patch('/users/:id/billing', function (req, res, next) {
  try {
    const billing = require('../lib/billing');
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) throw notFound('Пользователь не найден.');
    const action = String((req.body && req.body.action) || '');
    const result = db.transaction(function () {
      billing.account(u.id);
      const a = db.prepare('SELECT * FROM billing_accounts WHERE user_id=?').get(u.id), t = Date.now(), used = billing.roster(u.id);
      const set = function (fields) {
        const keys = Object.keys(fields);
        db.prepare('UPDATE billing_accounts SET ' + keys.map(function (k) { return k + '=?'; }).join(',') + ',updated_at=? WHERE user_id=?').run(...keys.map(function (k) { return fields[k]; }), t, u.id);
      };
      if (action === 'add_personal_month') set({ personal_until: billing.addMonth(Math.max(t, a.personal_until)) });
      else if (action === 'add_trainer_month') {
        const until = billing.addMonth(Math.max(t, a.trainer_until));
        set({ trainer_until: until, seat_limit: a.seat_limit || Math.max(1, used), seat_used: used, students_paid_until: a.students_paid_until > t ? until : a.students_paid_until });
        db.prepare("UPDATE users SET role=CASE WHEN role='ADMIN' THEN role ELSE 'TRAINER' END,updated_at=? WHERE id=?").run(t, u.id);
      } else if (action === 'set_seats') {
        const seats = Number(req.body.seats);
        if (!Number.isSafeInteger(seats) || seats < 1 || seats > 1000) throw badRequest('Количество мест: от 1 до 1000.');
        if (seats < used) throw badRequest('У тренера уже ' + used + ' учеников — мест не может быть меньше.');
        set({ seat_limit: seats, seat_used: used });
      } else if (action === 'set_trainer_pays') {
        if (typeof req.body.enabled !== 'boolean') throw badRequest('Укажите enabled: true или false.');
        if (req.body.enabled && a.trainer_until <= t) throw badRequest('Сначала продлите места тренера.');
        set({ students_paid_until: req.body.enabled ? a.trainer_until : 0 });
      } else if (action === 'revoke_personal') set({ personal_until: t - 1 });
      else if (action === 'revoke_trainer') set({ trainer_until: t - 1, students_paid_until: 0 });
      else throw badRequest('Неизвестное действие.');
      audit(req.user.id, 'manual_billing_' + action, { userId: u.id, seats: req.body.seats, enabled: req.body.enabled });
      return billing.account(u.id);
    })();
    res.json({ ok: true, billing: result });
  } catch (e) { next(e); }
});

// Полное удаление пользователя вместе с его данными. Необратимо.
router.delete('/users/:id', function (req, res, next) {
  try {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) throw notFound('Пользователь не найден.');
    if (u.role === 'ADMIN') throw badRequest('Нельзя удалить администратора.');
    const files = db.prepare('SELECT attachment_path FROM messages WHERE sender_id=? AND attachment_path IS NOT NULL').all(u.id);
    db.transaction(function () {
      for (const table of ['state_versions', 'operation_receipts', 'request_receipts', 'sync_conflicts']) db.prepare('DELETE FROM ' + table + ' WHERE user_id=?').run(u.id);
      db.prepare('DELETE FROM users WHERE id=?').run(u.id);
      audit(req.user.id, 'delete_user', { userId: u.id, username: u.username, displayName: u.display_name });
    })();
    files.forEach(function (f) { require('fs').unlink(path.join(config.uploadDir, f.attachment_path), function () {}); });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------------- trainers (раздел 21) ---------------- */
router.get('/trainers', function (req, res) {
  const trainers = db.prepare("SELECT * FROM users WHERE role = 'TRAINER'").all();
  res.json({
    trainers: trainers.map(function (t) {
      const sub = activeSubscription(t.id);
      const groupCount = db.prepare('SELECT COUNT(*) AS c FROM groups WHERE trainer_id = ?').get(t.id).c;
      return {
        id: t.id, name: t.display_name, username: t.username,
        planKey: sub ? sub.plan_key : null, planName: sub ? sub.plan_name : 'Нет активного тарифа',
        limit: trainerClientLimit(t.id), used: trainerClientCount(t.id), groupCount: groupCount
      };
    })
  });
});

/* ---------------- groups (раздел 22) ---------------- */
router.get('/groups', function (req, res) {
  const groups = db.prepare(`SELECT g.*, u.display_name AS trainer_name FROM groups g JOIN users u ON u.id = g.trainer_id ORDER BY g.created_at DESC`).all();
  res.json({
    groups: groups.map(function (g) {
      const memberCount = db.prepare('SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?').get(g.id).c;
      return { id: g.id, name: g.name, trainerName: g.trainer_name, trainerId: g.trainer_id, memberCount: memberCount, createdAt: g.created_at };
    })
  });
});

router.get('/groups/:id/members', function (req, res, next) {
  try {
    const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    if (!g) throw notFound('Группа не найдена.');
    const members = db.prepare(`SELECT u.id, u.display_name, u.username FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?`).all(g.id);
    res.json({ members: members });
  } catch (e) { next(e); }
});

/* ---------------- plans / tariffs (раздел 24) ---------------- */
router.get('/plans', function (req, res) {
  res.json({ plans: db.prepare('SELECT * FROM plans ORDER BY price ASC').all().map(function (p) {
    return { id: p.id, key: p.key, name: p.name, price: p.price, clientLimit: p.client_limit, description: p.description, active: !!p.active, isTrainerPlan: !!p.is_trainer_plan };
  }) });
});

router.post('/plans', function (req, res, next) {
  try {
    const b = req.body || {};
    const key = String(b.key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    const name = String(b.name || '').trim().slice(0, 60);
    if (!key || !name) throw badRequest('Укажите ключ и название тарифа.');
    if (db.prepare('SELECT 1 FROM plans WHERE key = ?').get(key)) throw conflict('Тариф с таким ключом уже существует.');
    const t = Date.now();
    const info = db.prepare(`INSERT INTO plans (key,name,price,client_limit,description,active,is_trainer_plan,created_at,updated_at)
      VALUES (?,?,?,?,?,1,?,?,?)`).run(key, name, Math.max(0, Number(b.price) || 0), Math.max(0, Number(b.clientLimit) || 0),
      String(b.description || '').slice(0, 300), b.isTrainerPlan === false ? 0 : 1, t, t);
    audit(req.user.id, 'create_plan', { key: key });
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) { next(e); }
});

router.patch('/plans/:id', function (req, res, next) {
  try {
    const p = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
    if (!p) throw notFound('Тариф не найден.');
    const b = req.body || {};
    const name = b.name != null ? String(b.name).trim().slice(0, 60) : p.name;
    const price = b.price != null ? Math.max(0, Number(b.price) || 0) : p.price;
    const clientLimit = b.clientLimit != null ? Math.max(0, Number(b.clientLimit) || 0) : p.client_limit;
    const description = b.description != null ? String(b.description).slice(0, 300) : p.description;
    const active = b.active != null ? (b.active ? 1 : 0) : p.active;
    db.prepare('UPDATE plans SET name=?, price=?, client_limit=?, description=?, active=?, updated_at=? WHERE id=?')
      .run(name, price, clientLimit, description, active, Date.now(), p.id);
    audit(req.user.id, 'update_plan', { planId: p.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------------- payment settings (раздел 27-28) ---------------- */
router.get('/payment', function (req, res) {
  const row = db.prepare('SELECT * FROM payment_settings WHERE id = 1').get();
  res.json({
    recipientName: row.recipient_name || '', phone: row.phone || '', cardRequisites: row.card_requisites || '',
    extraInfo: row.extra_info || '', whatsapp: row.whatsapp || '',
    qrUrl: row.qr_path ? ('/uploads/' + row.qr_path) : null, updatedAt: row.updated_at
  });
});

router.post('/payment', function (req, res, next) {
  try {
    const b = req.body || {};
    db.prepare(`UPDATE payment_settings SET recipient_name=?, phone=?, card_requisites=?, extra_info=?, whatsapp=?, updated_at=? WHERE id=1`)
      .run(String(b.recipientName || '').slice(0, 120), String(b.phone || '').slice(0, 40), String(b.cardRequisites || '').slice(0, 200),
        String(b.extraInfo || '').slice(0, 500), String(b.whatsapp || '').slice(0, 40), Date.now());
    audit(req.user.id, 'update_payment_settings', {});
    res.json({ ok: true });
  } catch (e) { next(e); }
});

const ALLOWED_QR_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const qrStorage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, config.uploadDir); },
  filename: function (req, file, cb) {
    const ext = ALLOWED_QR_MIME[file.mimetype] || '.bin';
    cb(null, 'qr-' + uid() + ext);
  }
});
const qrUpload = multer({
  storage: qrStorage,
  limits: { fileSize: 4 * 1024 * 1024 }, // 4 МБ
  fileFilter: function (req, file, cb) {
    if (!ALLOWED_QR_MIME[file.mimetype]) return cb(new Error('Разрешены только изображения PNG, JPEG или WEBP.'));
    cb(null, true);
  }
});

router.post('/payment/qr', function (req, res, next) {
  qrUpload.single('qr')(req, res, function (err) {
    if (err) return next(badRequest(err.message && err.message.indexOf('File too large') > -1 ? 'Файл слишком большой (максимум 4 МБ).' : err.message));
    try {
      if (!req.file) throw badRequest('Файл не получен.');
      const row = db.prepare('SELECT * FROM payment_settings WHERE id = 1').get();
      const oldPath = row && row.qr_path ? path.join(config.uploadDir, row.qr_path) : null;
      db.prepare('UPDATE payment_settings SET qr_path=?, updated_at=? WHERE id=1').run(req.file.filename, Date.now());
      if (oldPath && fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch (e) { /* не критично */ } }
      audit(req.user.id, 'upload_payment_qr', { filename: req.file.filename });
      res.json({ ok: true, qrUrl: '/uploads/' + req.file.filename });
    } catch (e) { next(e); }
  });
});

router.get('/audit-log', function (req, res) {
  const rows = db.prepare('SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT 200').all();
  res.json({ entries: rows.map(function (r) { return { id: r.id, adminId: r.admin_id, action: r.action, details: JSON.parse(r.details_json || '{}'), createdAt: r.created_at }; }) });
});

/* ---------------- режимы (раздел 4, 17) ---------------- */
router.get('/modes', function (req, res) {
  const platform = modesLib.getPlatformModes();
  res.json({ modes: modesLib.MODE_KEYS.map(function (k) { return { key: k, label: modesLib.MODE_LABELS[k], enabled: platform[k] }; }).concat([{key:'communities',label:'Показывать сообщества пользователям',enabled:!!(db.prepare("SELECT enabled FROM platform_modes WHERE key='communities'").get()||{}).enabled}]) });
});

router.patch('/modes/:key', function (req, res, next) {
  try {
    const enabled = !!(req.body && req.body.enabled);
    if(req.params.key==='communities')db.prepare("INSERT INTO platform_modes(key,enabled,updated_at) VALUES('communities',?,?) ON CONFLICT(key) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at").run(+enabled,Date.now());else modesLib.setPlatformModeEnabled(req.params.key, enabled);
    audit(req.user.id, 'set_platform_mode', { key: req.params.key, enabled: enabled });
    res.json({ ok: true });
  } catch (e) { next(badRequest(e.message)); }
});

/* ---------------- общая группа: открыть / закрыть, удалить сообщения ---------------- */
function globalChatState() {
  const r = db.prepare("SELECT enabled, updated_at FROM platform_modes WHERE key='global_chat'").get();
  const count = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE recipient_id IS NULL AND group_id IS NULL AND audience IS NULL').get().c;
  return { open: !r || !!r.enabled, updatedAt: r ? r.updated_at : 0, messages: count };
}
function removeGlobalFiles(rows) {
  rows.forEach(function (m) { if (m.attachment_path) require('fs').unlink(path.join(config.uploadDir, m.attachment_path), function () {}); });
}
router.get('/global-chat', function (req, res) { res.json(globalChatState()); });
// { open: true|false } — закрытая группа остаётся видимой, но писать в неё может только администратор.
router.post('/global-chat', function (req, res, next) {
  try {
    if (!req.body || typeof req.body.open !== 'boolean') throw badRequest('Укажите open: true или false.');
    db.prepare("INSERT INTO platform_modes(key,enabled,updated_at) VALUES('global_chat',?,?) ON CONFLICT(key) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at").run(req.body.open ? 1 : 0, Date.now());
    audit(req.user.id, req.body.open ? 'open_global_chat' : 'close_global_chat', {});
    res.json(globalChatState());
  } catch (e) { next(e); }
});
router.delete('/global-chat/messages/:id', function (req, res, next) {
  try {
    const m = db.prepare('SELECT * FROM messages WHERE id=? AND recipient_id IS NULL AND group_id IS NULL AND audience IS NULL').get(req.params.id);
    if (!m) throw notFound('Сообщение не найдено.');
    db.prepare('DELETE FROM messages WHERE id=?').run(m.id); removeGlobalFiles([m]);
    audit(req.user.id, 'delete_global_message', { messageId: m.id, senderId: m.sender_id, text: String(m.text || '').slice(0, 200) });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/global-chat/messages', function (req, res) {
  const rows = db.prepare('SELECT * FROM messages WHERE recipient_id IS NULL AND group_id IS NULL AND audience IS NULL').all();
  db.prepare('DELETE FROM messages WHERE recipient_id IS NULL AND group_id IS NULL AND audience IS NULL').run(); removeGlobalFiles(rows);
  audit(req.user.id, 'clear_global_chat', { deleted: rows.length });
  res.json({ ok: true, deleted: rows.length });
});

/* ---------------- сообщение от разработчика ---------------- */
router.get('/announcements', function (req, res) {
  res.json({ announcements: db.prepare('SELECT id,text,active,created_at AS createdAt,lock_seconds AS lockSeconds FROM announcements WHERE group_id IS NULL ORDER BY id DESC LIMIT 50').all().map(function (a) { return Object.assign(a, { active: !!a.active }); }) });
});
router.post('/announcements', function (req, res, next) {
  try {
    const text = String((req.body && req.body.text) || '').trim().slice(0, 20000);
    if (!text) throw badRequest('Введите текст сообщения.');
    const lock = Math.max(0, Math.min(300, Math.round(Number(req.body.lockSeconds) || 0)));
    const t = Date.now();
    // Показывается только одно сообщение — последнее; прежние снимаются.
    const id = db.transaction(function () {
      db.prepare('UPDATE announcements SET active=0 WHERE active=1 AND group_id IS NULL').run();
      return db.prepare('INSERT INTO announcements(text,active,created_by,created_at,group_id,lock_seconds) VALUES(?,1,?,?,NULL,?)').run(text, req.user.id, t, lock).lastInsertRowid;
    })();
    audit(req.user.id, 'send_announcement', { id: id, length: text.length });
    res.status(201).json({ ok: true, id: id });
  } catch (e) { next(e); }
});
router.delete('/announcements/:id', function (req, res, next) {
  try {
    const r = db.prepare('UPDATE announcements SET active=0 WHERE id=? AND group_id IS NULL').run(req.params.id);
    if (!r.changes) throw notFound('Сообщение не найдено.');
    audit(req.user.id, 'hide_announcement', { id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------------- просмотр переписок пользователей (модерация) ---------------- */
function adminMsg(m) {
  return { id: m.id, senderId: m.sender_id, senderName: m.sender_name, text: m.text, createdAt: m.created_at,
    attachment: m.attachment_path ? { url: '/uploads/' + m.attachment_path, name: m.attachment_name, kind: m.attachment_kind } : null };
}
router.get('/users/:id/chats', function (req, res, next) {
  try {
    const uid = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(uid)) throw notFound('Пользователь не найден.');
    const dms = db.prepare(`SELECT u.id, u.username, u.display_name AS displayName, COUNT(*) AS count, MAX(m.created_at) AS lastAt
      FROM messages m JOIN users u ON u.id = (CASE WHEN m.sender_id = ? THEN m.recipient_id ELSE m.sender_id END)
      WHERE m.recipient_id IS NOT NULL AND (m.sender_id = ? OR m.recipient_id = ?) GROUP BY u.id ORDER BY lastAt DESC`).all(uid, uid, uid);
    const groups = db.prepare(`SELECT g.id, g.name, (SELECT COUNT(*) FROM messages WHERE group_id=g.id) AS count FROM groups g
      LEFT JOIN group_members gm ON gm.group_id=g.id AND gm.user_id=? WHERE g.trainer_id=? OR gm.user_id=? GROUP BY g.id`).all(uid, uid, uid);
    const globalCount = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE sender_id=? AND recipient_id IS NULL AND group_id IS NULL AND audience IS NULL').get(uid).c;
    res.json({ dms: dms, groups: groups, globalCount: globalCount });
  } catch (e) { next(e); }
});
router.get('/chats', function (req, res, next) {
  try {
    const base = 'SELECT m.*, u.display_name AS sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE ';
    let rows;
    if (req.query.groupId) rows = db.prepare(base + 'm.group_id=? ORDER BY m.id DESC LIMIT 500').all(Number(req.query.groupId));
    else if (req.query.a && req.query.b) { const a = Number(req.query.a), b = Number(req.query.b); rows = db.prepare(base + 'm.recipient_id IS NOT NULL AND ((m.sender_id=? AND m.recipient_id=?) OR (m.sender_id=? AND m.recipient_id=?)) ORDER BY m.id DESC LIMIT 500').all(a, b, b, a); }
    else throw badRequest('Укажите groupId или пару a и b.');
    audit(req.user.id, 'view_chat', { groupId: req.query.groupId ? Number(req.query.groupId) : undefined, a: req.query.a ? Number(req.query.a) : undefined, b: req.query.b ? Number(req.query.b) : undefined });
    res.json({ messages: rows.reverse().map(adminMsg) });
  } catch (e) { next(e); }
});

/* ---------------- заявки на оплату (раздел 16, 17) ---------------- */
// Параллельно с прямым изменением тарифа (PATCH /users/:id/plan) — очередь заявок,
// созданных пользователем через POST /plans/select, с явным подтверждением/отклонением.
router.get('/payments', function (req, res) {
  res.json({ requests: listPaymentRequests() });
});

router.post('/payments/:id/confirm', function (req, res, next) {
  try {
    const sub = confirmPendingSubscription(req.user.id, req.params.id);
    audit(req.user.id, 'confirm_payment', { subscriptionId: req.params.id });
    res.json({ ok: true, subscription: sub });
  } catch (e) { next(badRequest(e.message)); }
});

router.post('/payments/:id/reject', function (req, res, next) {
  try {
    const note = req.body && req.body.note ? String(req.body.note).slice(0, 300) : '';
    rejectPendingSubscription(req.user.id, req.params.id, note);
    audit(req.user.id, 'reject_payment', { subscriptionId: Number(req.params.id), note: note });
    res.json({ ok: true });
  } catch (e) { next(badRequest(e.message)); }
});

module.exports = router;
