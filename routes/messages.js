// Простой чат: личные сообщения и групповая рассылка тренера своей группе (раздел 15).
const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { badRequest, forbidden, notFound } = require('../lib/errors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../lib/config');
const { uid: newId } = require('../lib/ids');

// Вложения чата: голосовые, фото и документы. Расширение берётся ТОЛЬКО из этого списка —
// исполняемые и активные типы (html, svg, js) не принимаются.
const ATTACH_MIME = {
  'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'application/zip': '.zip',
  'application/msword': '.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx'
};
const MAX_ATTACH_MB = 20;
function baseMime(m) { return String(m || '').split(';')[0].trim().toLowerCase(); }
const attachUpload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) { cb(null, config.uploadDir); },
    filename: function (req, file, cb) { cb(null, 'chat-' + newId() + '-' + newId() + ATTACH_MIME[baseMime(file.mimetype)]); }
  }),
  limits: { fileSize: MAX_ATTACH_MB * 1024 * 1024, files: 1 },
  fileFilter: function (req, file, cb) {
    if (!ATTACH_MIME[baseMime(file.mimetype)]) return cb(new Error('Этот тип файла нельзя отправить. Подойдут фото, аудио, PDF, документы Word/Excel, текст и ZIP.'));
    cb(null, true);
  }
});
function attachmentOf(req) {
  const f = req.file; if (!f) return null;
  const type = baseMime(f.mimetype);
  const kind = req.body && req.body.kind === 'voice' && type.indexOf('audio/') === 0 ? 'voice' : type.indexOf('image/') === 0 ? 'image' : type.indexOf('audio/') === 0 ? 'audio' : 'file';
  const duration = Math.max(0, Math.min(3600, Math.round(Number(req.body && req.body.duration) || 0)));
  // multer отдаёт имя в latin1 — возвращаем кириллицу.
  let name = f.originalname || 'file'; try { name = Buffer.from(name, 'latin1').toString('utf8'); } catch (e) {}
  return { path: f.filename, name: name.replace(/[\\/\u0000-\u001f]/g, '').slice(0, 120) || 'file', type: type, size: f.size, kind: kind, duration: duration };
}
function previewText(m) {
  if (!m) return '';
  if (m.text) return m.text;
  if (m.attachment_kind === 'voice') return '🎤 Голосовое сообщение';
  if (m.attachment_kind === 'image') return '📷 Фото';
  return m.attachment_path ? '📎 ' + (m.attachment_name || 'Файл') : '';
}

const router = express.Router();

function areFriends(a, b) {
  return !!db.prepare(`SELECT 1 FROM friendships WHERE status='accepted' AND
    ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))`).get(a, b, b, a);
}
function isTrainerOfClient(trainerId, clientId) {
  return !!db.prepare(`SELECT 1 FROM group_members gm JOIN groups g ON g.id=gm.group_id
    WHERE g.trainer_id = ? AND gm.user_id = ?`).get(trainerId, clientId);
}
function canDirectMessage(a, b) {
  return areFriends(a, b) || isTrainerOfClient(a, b) || isTrainerOfClient(b, a);
}

// ---- Общая группа: один чат для всех пользователей приложения ----
// Сообщения хранятся в messages с recipient_id IS NULL и group_id IS NULL.
const GLOBAL_WHERE = 'm.recipient_id IS NULL AND m.group_id IS NULL AND m.audience IS NULL';
// ---- Чат друзей: общий чат, где каждый видит сообщения свои и своих подтверждённых друзей ----
const FRIENDS_WHERE = `m.audience='friends' AND (m.sender_id=@uid OR m.sender_id IN (
  SELECT CASE WHEN requester_id=@uid THEN addressee_id ELSE requester_id END FROM friendships
  WHERE status='accepted' AND (requester_id=@uid OR addressee_id=@uid)))`;
function friendsThread(user) {
  const last = db.prepare('SELECT m.* FROM messages m WHERE ' + FRIENDS_WHERE + ' ORDER BY m.id DESC LIMIT 1').get({ uid: user.id });
  const read = db.prepare('SELECT friends_read_id AS r FROM users WHERE id=?').get(user.id).r;
  const unread = db.prepare('SELECT COUNT(*) AS c FROM messages m WHERE ' + FRIENDS_WHERE + ' AND m.sender_id <> @uid AND m.id > @read').get({ uid: user.id, read: read }).c;
  return { type: 'friends', group: { id: 0, name: 'Чат друзей' }, canPost: true, lastText: previewText(last), lastAt: last ? last.created_at : 0, unread: unread };
}
function globalOpen() {
  const r = db.prepare("SELECT enabled FROM platform_modes WHERE key='global_chat'").get();
  return !r || !!r.enabled;
}
function globalThread(user) {
  const last = db.prepare('SELECT m.* FROM messages m WHERE ' + GLOBAL_WHERE + ' ORDER BY m.id DESC LIMIT 1').get();
  const read = db.prepare('SELECT global_read_id AS r FROM users WHERE id=?').get(user.id).r;
  const unread = db.prepare('SELECT COUNT(*) AS c FROM messages m WHERE ' + GLOBAL_WHERE + ' AND m.sender_id <> ? AND m.id > ?').get(user.id, read).c;
  const open = globalOpen();
  return { type: 'global', group: { id: 0, name: 'Общая группа' }, open: open, muted: !!user.chat_muted, canPost: user.role === 'ADMIN' || (open && !user.chat_muted), lastText: previewText(last), lastAt: last ? last.created_at : 0, unread: unread };
}

function tinyUser(u) {
  return { id: u.id, username: u.username, displayName: u.display_name, avatarEmoji: u.avatar_emoji };
}

router.get('/threads', requireAuth, function (req, res) {
  const uid = req.user.id;
  const dmPartners = db.prepare(`
    SELECT DISTINCT u.id, u.username, u.display_name, u.avatar_emoji FROM messages m
    JOIN users u ON u.id = (CASE WHEN m.sender_id = ? THEN m.recipient_id ELSE m.sender_id END)
    WHERE m.recipient_id IS NOT NULL AND (m.sender_id = ? OR m.recipient_id = ?)
  `).all(uid, uid, uid);

  const dmThreads = dmPartners.map(function (p) {
    const last = db.prepare(`SELECT * FROM messages WHERE recipient_id IS NOT NULL AND
      ((sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?))
      ORDER BY created_at DESC LIMIT 1`).get(uid, p.id, p.id, uid);
    const unread = db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE sender_id=? AND recipient_id=? AND read_at IS NULL`).get(p.id, uid).c;
    return { type: 'dm', user: tinyUser(p), lastText: previewText(last), lastAt: last ? last.created_at : 0, unread: unread };
  });

  const groupThreads = db.prepare(`
    SELECT g.id, g.name, COALESCE(MAX(gm.last_read_message_id),0) AS last_read, g.trainer_id, g.trainer_read_id AS trainer_read FROM groups g
    LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
    WHERE g.trainer_id = ? OR gm.user_id = ?
    GROUP BY g.id
  `).all(uid, uid, uid).map(function (g) {
    const last = db.prepare('SELECT * FROM messages WHERE group_id = ? ORDER BY created_at DESC LIMIT 1').get(g.id);
    // Непрочитанное в общей группе: чужие сообщения новее последнего прочитанного участником.
    // Тренер не состоит в group_members — его отметка прочтения хранится в groups.trainer_read_id.
    const readId = g.trainer_id === uid ? g.trainer_read : g.last_read;
    const unread = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE group_id = ? AND sender_id <> ? AND id > ?').get(g.id, uid, readId).c;
    return { type: 'group', group: { id: g.id, name: g.name }, canPost: true, lastText: previewText(last), lastAt: last ? last.created_at : 0, unread: unread };
  });

  const communityThreads=db.prepare('SELECT DISTINCT c.id,c.name FROM communities c LEFT JOIN community_members cm ON cm.community_id=c.id WHERE c.owner_id=? OR cm.user_id=?').all(uid,uid).map(c=>{
    const last=db.prepare('SELECT text,created_at FROM community_messages WHERE community_id=? ORDER BY id DESC LIMIT 1').get(c.id);
    return {type:'community',group:c,lastText:last?last.text:'',lastAt:last?last.created_at:0};
  });
  res.json({ threads: dmThreads.filter(t=>canDirectMessage(uid,t.user.id)).concat(groupThreads,communityThreads).sort(function (a, b) { return b.lastAt - a.lastAt; }).concat([globalThread(req.user), friendsThread(req.user)]) });
});

router.get('/', requireAuth, function (req, res, next) {
  try {
    const uid = req.user.id;
    if (req.query.friends) {
      const rows = db.prepare('SELECT * FROM (SELECT m.*, u.display_name AS sender_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE ' + FRIENDS_WHERE + ' ORDER BY m.id DESC LIMIT 300) ORDER BY id ASC').all({ uid: uid });
      const lastId = rows.length ? rows[rows.length - 1].id : 0;
      if (lastId) db.prepare('UPDATE users SET friends_read_id = ? WHERE id = ? AND friends_read_id < ?').run(lastId, uid, lastId);
      const friends = db.prepare("SELECT COUNT(*) AS c FROM friendships WHERE status='accepted' AND (requester_id=? OR addressee_id=?)").get(uid, uid).c;
      return res.json({ messages: rows.map(formatMessage), canPost: true, friends: friends });
    }
    if (req.query.global) {
      // Последние 300 сообщений общей группы; открытие помечает их прочитанными.
      const rows = db.prepare('SELECT * FROM (SELECT m.*, u.display_name AS sender_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE ' + GLOBAL_WHERE + ' ORDER BY m.id DESC LIMIT 300) ORDER BY id ASC').all();
      const lastId = rows.length ? rows[rows.length - 1].id : 0;
      if (lastId) db.prepare('UPDATE users SET global_read_id = ? WHERE id = ? AND global_read_id < ?').run(lastId, uid, lastId);
      const open = globalOpen(), isAdmin = req.user.role === 'ADMIN';
      return res.json({ messages: rows.map(formatMessage), open: open, muted: !!req.user.chat_muted, canPost: isAdmin || (open && !req.user.chat_muted), isAdmin: isAdmin });
    }
    if (req.query.with) {
      const otherId = Number(req.query.with);
      if (!canDirectMessage(uid, otherId)) throw forbidden('Переписка недоступна.');
      const rows = db.prepare(`SELECT * FROM messages WHERE recipient_id IS NOT NULL AND
        ((sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)) ORDER BY created_at ASC`).all(uid, otherId, otherId, uid);
      db.prepare('UPDATE messages SET read_at = ? WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL').run(Date.now(), otherId, uid);
      return res.json({ messages: rows.map(formatMessage) });
    }
    if (req.query.groupId) {
      const groupId = Number(req.query.groupId);
      const allowed = db.prepare('SELECT 1 FROM groups WHERE id=? AND trainer_id=?').get(groupId, uid) ||
        db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(groupId, uid);
      if (!allowed) throw forbidden('Эта группа вам недоступна.');
      const rows = db.prepare('SELECT m.*, u.display_name AS sender_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.group_id = ? ORDER BY m.created_at ASC').all(groupId);
      // Открытие чата группы помечает её сообщения прочитанными для этого участника.
      const lastId = rows.reduce(function (max, m) { return Math.max(max, m.id); }, 0);
      if (lastId) {
        db.prepare('UPDATE group_members SET last_read_message_id = ? WHERE group_id = ? AND user_id = ? AND last_read_message_id < ?').run(lastId, groupId, uid, lastId);
        db.prepare('UPDATE groups SET trainer_read_id = ? WHERE id = ? AND trainer_id = ? AND trainer_read_id < ?').run(lastId, groupId, uid, lastId);
      }
      const grp = db.prepare('SELECT trainer_id FROM groups WHERE id=?').get(groupId), me = db.prepare('SELECT chat_muted FROM group_members WHERE group_id=? AND user_id=?').get(groupId, uid);
      const isTrainer = !!grp && grp.trainer_id === uid, muted = !isTrainer && !!(me && me.chat_muted);
      return res.json({ messages: rows.map(formatMessage), canPost: !muted, muted: muted, isTrainer: isTrainer });
    }
    throw badRequest('Укажите ?with=ID пользователя или ?groupId=ID группы.');
  } catch (e) { next(e); }
});

function formatMessage(m) {
  return { id: m.id, senderName: m.sender_name || undefined, senderId: m.sender_id, recipientId: m.recipient_id, groupId: m.group_id, text: m.text, createdAt: m.created_at, readAt: m.read_at,
    attachment: m.attachment_path ? { url: '/uploads/' + m.attachment_path, name: m.attachment_name, type: m.attachment_type, size: m.attachment_size, kind: m.attachment_kind, duration: m.attachment_duration || 0 } : null };
}

function withAttachment(req, res, next) {
  if (String(req.headers['content-type'] || '').indexOf('multipart/') !== 0) return next();
  attachUpload.single('file')(req, res, function (err) {
    if (err) return next(badRequest(err.message && err.message.indexOf('File too large') > -1 ? 'Файл слишком большой (максимум ' + MAX_ATTACH_MB + ' МБ).' : err.message));
    next();
  });
}
function dropUpload(req) { if (req.file) fs.unlink(path.join(config.uploadDir, req.file.filename), function () {}); }

router.post('/', requireAuth, withAttachment, function (req, res, next) {
  try {
    const body = req.body || {};
    const text = String(body.text || '').trim().slice(0, 2000);
    const att = attachmentOf(req);
    if (!text && !att) throw badRequest('Сообщение не может быть пустым.');
    const t = Date.now();
    const INSERT = 'INSERT INTO messages (sender_id, recipient_id, group_id, text, created_at, attachment_path, attachment_name, attachment_type, attachment_size, attachment_kind, attachment_duration) VALUES (?,?,?,?,?,?,?,?,?,?,?)';
    const extra = att ? [att.path, att.name, att.type, att.size, att.kind, att.duration] : [null, null, null, null, null, null];

    if (body.friends === true || body.friends === '1' || body.friends === 'true') {
      const info = db.prepare(INSERT + ' RETURNING id').get(req.user.id, null, null, text, t, ...extra);
      db.prepare("UPDATE messages SET audience='friends' WHERE id=?").run(info.id);
      return res.status(201).json(formatMessage(db.prepare('SELECT m.*, u.display_name AS sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id = ?').get(info.id)));
    }
    if (body.global === true || body.global === '1' || body.global === 'true') {
      if (!globalOpen() && req.user.role !== 'ADMIN') throw forbidden('Общая группа закрыта администратором.');
      if (req.user.chat_muted && req.user.role !== 'ADMIN') throw forbidden('Администратор ограничил вам отправку сообщений в общую группу.');
      const info = db.prepare(INSERT).run(req.user.id, null, null, text, t, ...extra);
      return res.status(201).json(formatMessage(db.prepare('SELECT m.*, u.display_name AS sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id = ?').get(info.lastInsertRowid)));
    }
    if (body.recipientId) {
      const recipientId = Number(body.recipientId);
      if (!canDirectMessage(req.user.id, recipientId)) throw forbidden('Писать можно только друзьям, своему тренеру или своим клиентам.');
      const info = db.prepare(INSERT).run(req.user.id, recipientId, null, text, t, ...extra);
      return res.status(201).json(formatMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid)));
    }

    if (body.groupId) {
      const groupId = Number(body.groupId);
      const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
      if (!g) throw notFound('Группа не найдена.');
      // В чате группы общаются тренер и его ученики.
      if (g.trainer_id !== req.user.id) {
        const member = db.prepare('SELECT chat_muted FROM group_members WHERE group_id=? AND user_id=?').get(groupId, req.user.id);
        if (!member) throw forbidden('Писать в чат группы могут только тренер и её участники.');
        if (member.chat_muted) throw forbidden('Тренер ограничил вам отправку сообщений в этом чате.');
      }
      const info = db.prepare(INSERT).run(req.user.id, null, groupId, text, t, ...extra);
      return res.status(201).json(formatMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid)));
    }

    throw badRequest('Укажите recipientId, groupId или global.');
  } catch (e) { dropUpload(req); next(e); }
});

module.exports = router;
