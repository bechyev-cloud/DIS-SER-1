// Друзья (раздел 9 инструкции) и Сообщества (существующая функция приложения,
// теперь опирающаяся на реальные аккаунты вместо вручную вписанных имён).
const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { badRequest, notFound, forbidden, conflict } = require('../lib/errors');

const router = express.Router();

function tinyUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, displayName: u.display_name, avatarEmoji: u.avatar_emoji };
}

/* ---------------- friends ---------------- */

router.get('/friends', requireAuth, function (req, res) {
  const uid = req.user.id;
  const accepted = db.prepare(`
    SELECT u.*, f.id AS friendship_id FROM friendships f
    JOIN users u ON u.id = (CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END)
    WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?)
  `).all(uid, uid, uid).map(function (r) { return Object.assign(tinyUser(r), { friendshipId: r.friendship_id }); });

  const incoming = db.prepare(`
    SELECT u.*, f.id AS friendship_id, f.created_at FROM friendships f
    JOIN users u ON u.id = f.requester_id
    WHERE f.status = 'pending' AND f.addressee_id = ?
  `).all(uid).map(function (r) { return Object.assign(tinyUser(r), { friendshipId: r.friendship_id, createdAt: r.created_at }); });

  const outgoing = db.prepare(`
    SELECT u.*, f.id AS friendship_id, f.created_at FROM friendships f
    JOIN users u ON u.id = f.addressee_id
    WHERE f.status = 'pending' AND f.requester_id = ?
  `).all(uid).map(function (r) { return Object.assign(tinyUser(r), { friendshipId: r.friendship_id, createdAt: r.created_at }); });

  res.json({ friends: accepted, incoming: incoming, outgoing: outgoing, myFriendCode: req.user.friend_code });
});

router.post('/friends/request', requireAuth, function (req, res, next) {
  try {
    const code = String((req.body && req.body.friendCode) || '').trim().toUpperCase();
    const userId=Number(req.body && req.body.userId);
    if (!code&&!userId) throw badRequest('Выберите друга или введите код.');
    const target = userId ? db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(userId) : db.prepare("SELECT * FROM users WHERE friend_code = ? AND status='active'").get(code);
    if (!target) throw notFound('Пользователь с таким кодом не найден.');
    if (target.id === req.user.id) throw badRequest('Нельзя добавить самого себя в друзья.');

    const existing = db.prepare(`SELECT * FROM friendships WHERE
      (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`)
      .get(req.user.id, target.id, target.id, req.user.id);

    if (existing) {
      if (existing.status === 'accepted') throw conflict('Вы уже друзья.');
      if (existing.status === 'pending' && existing.requester_id === target.id) {
        throw conflict('У вас уже есть приглашение от этого пользователя. Примите его в разделе приглашений.');
      }
      if(existing.status==='declined'){db.prepare("UPDATE friendships SET requester_id=?,addressee_id=?,status='pending',created_at=?,updated_at=? WHERE id=?").run(req.user.id,target.id,Date.now(),Date.now(),existing.id);return res.status(201).json({ok:true,status:'pending'});}
      throw conflict('Запрос в друзья уже отправлен и ожидает ответа.');
    }

    const t = Date.now();
    db.prepare("INSERT INTO friendships (requester_id, addressee_id, status, created_at, updated_at) VALUES (?,?,'pending',?,?)")
      .run(req.user.id, target.id, t, t);
    res.status(201).json({ ok: true, status: 'pending', user: tinyUser(target) });
  } catch (e) { next(e); }
});

router.post('/friends/:id/accept', requireAuth, function (req, res, next) {
  try {
    const f = db.prepare('SELECT * FROM friendships WHERE id = ?').get(req.params.id);
    if (!f || f.addressee_id !== req.user.id) throw notFound('Запрос не найден.');
    if (f.status !== 'pending') throw conflict('Этот запрос уже обработан.');
    db.prepare("UPDATE friendships SET status='accepted', updated_at=? WHERE id=?").run(Date.now(), f.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/friends/:id/decline', requireAuth, function (req, res, next) {
  try {
    const f = db.prepare('SELECT * FROM friendships WHERE id = ?').get(req.params.id);
    if (!f || f.addressee_id !== req.user.id) throw notFound('Запрос не найден.');
    db.prepare("UPDATE friendships SET status='declined', updated_at=? WHERE id=?").run(Date.now(), f.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/friends/:id', requireAuth, function (req, res, next) {
  try {
    const f = db.prepare('SELECT * FROM friendships WHERE id = ?').get(req.params.id);
    if (!f || (f.requester_id !== req.user.id && f.addressee_id !== req.user.id)) throw notFound('Связь не найдена.');
    db.prepare('DELETE FROM friendships WHERE id = ?').run(f.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------------- communities (общие цели) ---------------- */

function communityForUser(communityId, userId) {
  const c = db.prepare('SELECT * FROM communities WHERE id = ?').get(communityId);
  if (!c) return null;
  const isMember = db.prepare('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?').get(communityId, userId);
  if (!isMember && c.owner_id !== userId) return null;
  return c;
}

function buildCommunityPayload(c) {
  const memberRows = db.prepare(`SELECT u.id, u.username, u.display_name, u.avatar_emoji FROM community_members cm
    JOIN users u ON u.id = cm.user_id WHERE cm.community_id = ?`).all(c.id);
  const owner = db.prepare('SELECT id, username, display_name, avatar_emoji FROM users WHERE id = ?').get(c.owner_id);
  const members = [owner].concat(memberRows.filter(function (m) { return m.id !== owner.id; }))
    .map(function (m) { return { id: m.id, name: m.display_name, username: m.username, avatarEmoji: m.avatar_emoji }; });

  const goals = db.prepare('SELECT * FROM community_goals WHERE community_id = ?').all(c.id).map(function (g) {
    const contribRows = db.prepare('SELECT user_id, amount FROM community_goal_contrib WHERE goal_id = ?').all(g.id);
    const contrib = {};
    contribRows.forEach(function (r) { contrib[r.user_id] = r.amount; });
    return { id: g.id, name: g.name, target: g.target, unit: g.unit, contrib: contrib };
  });

  return { id: c.id, name: c.name, emoji: c.emoji, ownerId: c.owner_id, friends: members, goals: goals, createdAt: c.created_at };
}

router.get('/communities', requireAuth, function (req, res) {
  const uid = req.user.id;
  const rows = db.prepare(`
    SELECT DISTINCT c.* FROM communities c
    LEFT JOIN community_members cm ON cm.community_id = c.id
    WHERE c.owner_id = ? OR cm.user_id = ?
  `).all(uid, uid);
  res.json({ communities: rows.map(buildCommunityPayload) });
});

router.post('/communities', requireAuth, function (req, res, next) {
  try {
    const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
    const emoji = String((req.body && req.body.emoji) || '👥').trim().slice(0, 4) || '👥';
    if (!name) throw badRequest('Укажите название сообщества.');
    const t = Date.now();
    const info = db.prepare('INSERT INTO communities (owner_id, name, emoji, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(req.user.id, name, emoji, t, t);
    const c = db.prepare('SELECT * FROM communities WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(buildCommunityPayload(c));
  } catch (e) { next(e); }
});

router.delete('/communities/:id', requireAuth, function (req, res, next) {
  try {
    const c = db.prepare('SELECT * FROM communities WHERE id = ?').get(req.params.id);
    if (!c || c.owner_id !== req.user.id) throw forbidden('Удалить сообщество может только его создатель.');
    db.prepare('DELETE FROM communities WHERE id = ?').run(c.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/communities/:id/members', requireAuth, function (req, res, next) {
  try {
    const c = db.prepare('SELECT * FROM communities WHERE id = ?').get(req.params.id);
    if (!c || c.owner_id !== req.user.id) throw forbidden('Добавлять друзей может только создатель сообщества.');
    const friendUserId = Number(req.body && req.body.userId);
    if (!friendUserId) throw badRequest('Не указан друг для добавления.');
    const isFriend = db.prepare(`SELECT 1 FROM friendships WHERE status='accepted' AND
      ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`)
      .get(req.user.id, friendUserId, friendUserId, req.user.id);
    if (!isFriend) throw badRequest('Добавить в сообщество можно только принятого друга.');
    db.prepare('INSERT OR IGNORE INTO community_members (community_id, user_id, added_at) VALUES (?,?,?)')
      .run(c.id, friendUserId, Date.now());
    res.json(buildCommunityPayload(c));
  } catch (e) { next(e); }
});

router.delete('/communities/:id/members/:userId', requireAuth, function (req, res, next) {
  try {
    const c = db.prepare('SELECT * FROM communities WHERE id = ?').get(req.params.id);
    if (!c || c.owner_id !== req.user.id) throw forbidden('Удалять участников может только создатель сообщества.');
    db.prepare('DELETE FROM community_members WHERE community_id = ? AND user_id = ?').run(c.id, req.params.userId);
    db.prepare(`DELETE FROM community_goal_contrib WHERE user_id = ? AND goal_id IN
      (SELECT id FROM community_goals WHERE community_id = ?)`).run(req.params.userId, c.id);
    res.json(buildCommunityPayload(c));
  } catch (e) { next(e); }
});

router.post('/communities/:id/goals', requireAuth, function (req, res, next) {
  try {
    const c = communityForUser(req.params.id, req.user.id);
    if (!c) throw notFound('Сообщество не найдено.');
    const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
    const target = Math.max(1, Number(req.body && req.body.target) || 0);
    const unit = String((req.body && req.body.unit) || '').trim().slice(0, 20);
    if (!name || !target) throw badRequest('Укажите название и цель (число больше 0).');
    const info = db.prepare('INSERT INTO community_goals (community_id, name, target, unit, created_at) VALUES (?,?,?,?,?)')
      .run(c.id, name, target, unit, Date.now());
    db.prepare('INSERT INTO community_goal_contrib (goal_id, user_id, amount, updated_at) VALUES (?,?,0,?)')
      .run(info.lastInsertRowid, req.user.id, Date.now());
    res.status(201).json(buildCommunityPayload(c));
  } catch (e) { next(e); }
});

router.delete('/communities/:id/goals/:goalId', requireAuth, function (req, res, next) {
  try {
    const c = db.prepare('SELECT * FROM communities WHERE id = ?').get(req.params.id);
    if (!c || c.owner_id !== req.user.id) throw forbidden('Удалять цели может только создатель сообщества.');
    db.prepare('DELETE FROM community_goals WHERE id = ? AND community_id = ?').run(req.params.goalId, c.id);
    res.json(buildCommunityPayload(c));
  } catch (e) { next(e); }
});

router.post('/communities/:id/goals/:goalId/contrib', requireAuth, function (req, res, next) {
  try {
    const c = communityForUser(req.params.id, req.user.id);
    if (!c) throw notFound('Сообщество не найдено.');
    const goal = db.prepare('SELECT * FROM community_goals WHERE id = ? AND community_id = ?').get(req.params.goalId, c.id);
    if (!goal) throw notFound('Цель не найдена.');
    const amount = Number(req.body && req.body.amount) || 0;
    const t = Date.now();
    // Каждый участник может отмечать только свой собственный вклад — это реальные аккаунты,
    // а не локальная симуляция, поэтому "за друга" отмечать нельзя.
    const existing = db.prepare('SELECT * FROM community_goal_contrib WHERE goal_id = ? AND user_id = ?').get(goal.id, req.user.id);
    const next_ = Math.max(0, (existing ? existing.amount : 0) + amount);
    db.prepare(`INSERT INTO community_goal_contrib (goal_id, user_id, amount, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(goal_id, user_id) DO UPDATE SET amount=excluded.amount, updated_at=excluded.updated_at`)
      .run(goal.id, req.user.id, next_, t);
    res.json(buildCommunityPayload(c));
  } catch (e) { next(e); }
});

module.exports = router;
