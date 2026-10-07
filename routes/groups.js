const express = require('express');
const db = require('../lib/db');
const { requireAuth, requireRole } = require('../lib/auth');
const { groupInviteCode, uid } = require('../lib/ids');
const { badRequest, notFound, forbidden, conflict } = require('../lib/errors');
const { trainerClientLimit, trainerClientCount } = require('../lib/subscription');

const router = express.Router();

function tinyUser(u) {
  return { id: u.id, username: u.username, displayName: u.display_name, avatarEmoji: u.avatar_emoji };
}

function groupSummary(g) {
  const memberCount = db.prepare('SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?').get(g.id).c;
  return {
    id: g.id, name: g.name, description: g.description, inviteCode: g.invite_code,
    memberCount: memberCount, createdAt: g.created_at
  };
}

function ownedGroupOrThrow(groupId, trainerId) {
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!g) throw notFound('Группа не найдена.');
  if (g.trainer_id !== trainerId) throw forbidden('Эта группа принадлежит другому тренеру.');
  return g;
}

/* ---- trainer: own groups ---- */

router.get('/', requireAuth, requireRole('TRAINER', 'ADMIN'), function (req, res) {
  const groups = db.prepare('SELECT * FROM groups WHERE trainer_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({
    groups: groups.map(groupSummary),
    limit: trainerClientLimit(req.user.id),
    billing:require('../lib/billing').account(req.user.id),
    clientCount: trainerClientCount(req.user.id)
  });
});

router.post('/', requireAuth, requireRole('TRAINER', 'ADMIN'), function (req, res, next) {
  try {
    const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
    const description = String((req.body && req.body.description) || '').trim().slice(0, 300);
    if (!name) throw badRequest('Укажите название группы.');
    let code;
    for (let i = 0; i < 8; i++) {
      code = groupInviteCode();
      if (!db.prepare('SELECT 1 FROM groups WHERE invite_code = ?').get(code)) break;
    }
    const t = Date.now();
    const info = db.prepare('INSERT INTO groups (trainer_id, name, description, invite_code, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(req.user.id, name, description, code, t, t);
    const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(groupSummary(g));
  } catch (e) { next(e); }
});

router.patch('/:id', requireAuth, requireRole('TRAINER', 'ADMIN'), function (req, res, next) {
  try {
    const g = ownedGroupOrThrow(req.params.id, req.user.id);
    const name = req.body && req.body.name != null ? String(req.body.name).trim().slice(0, 80) : g.name;
    const description = req.body && req.body.description != null ? String(req.body.description).trim().slice(0, 300) : g.description;
    if (!name) throw badRequest('Название группы не может быть пустым.');
    db.prepare('UPDATE groups SET name=?, description=?, updated_at=? WHERE id=?').run(name, description, Date.now(), g.id);
    res.json(groupSummary(db.prepare('SELECT * FROM groups WHERE id = ?').get(g.id)));
  } catch (e) { next(e); }
});

router.delete('/:id', requireAuth, requireRole('TRAINER', 'ADMIN'), function (req, res, next) {
  try {
    const g = ownedGroupOrThrow(req.params.id, req.user.id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(g.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/:id/members', requireAuth, requireRole('TRAINER', 'ADMIN'), function (req, res, next) {
  try {
    const g = ownedGroupOrThrow(req.params.id, req.user.id);
    const members = db.prepare(`SELECT u.*, gm.joined_at, gm.chat_muted AS member_muted FROM group_members gm JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ? ORDER BY gm.joined_at ASC`).all(g.id)
      .map(function (u) { return Object.assign(tinyUser(u), { joinedAt: u.joined_at, chatMuted: !!u.member_muted }); });
    res.json({ members: members });
  } catch (e) { next(e); }
});

router.delete('/:id/members/:userId', requireAuth, requireRole('TRAINER', 'ADMIN'), function (req, res, next) {
  try {
    const g = ownedGroupOrThrow(req.params.id, req.user.id);
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(g.id, req.params.userId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Тренер запрещает или разрешает ученику писать в чат группы.
router.patch('/:id/members/:userId/chat', requireAuth, requireRole('TRAINER', 'ADMIN'), function (req, res, next) {
  try {
    const g = ownedGroupOrThrow(req.params.id, req.user.id);
    if (!req.body || typeof req.body.muted !== 'boolean') throw badRequest('Укажите muted: true или false.');
    const r = db.prepare('UPDATE group_members SET chat_muted = ? WHERE group_id = ? AND user_id = ?').run(req.body.muted ? 1 : 0, g.id, req.params.userId);
    if (!r.changes) throw notFound('Ученик не состоит в этой группе.');
    res.json({ ok: true, chatMuted: req.body.muted });
  } catch (e) { next(e); }
});

// Тренер отправляет всем ученикам группы сообщение, которое откроется в центре экрана.
router.post('/:id/announce', requireAuth, requireRole('TRAINER', 'ADMIN'), function (req, res, next) {
  try {
    const g = ownedGroupOrThrow(req.params.id, req.user.id);
    const text = String((req.body && req.body.text) || '').trim().slice(0, 5000);
    if (!text) throw badRequest('Введите текст сообщения.');
    const lock = Math.max(0, Math.min(300, Math.round(Number(req.body.lockSeconds) || 0)));
    const id = db.transaction(function () {
      db.prepare('UPDATE announcements SET active=0 WHERE active=1 AND group_id=?').run(g.id);
      return db.prepare('INSERT INTO announcements(text,active,created_by,created_at,group_id,lock_seconds) VALUES(?,1,?,?,?,?)').run(text, req.user.id, Date.now(), g.id, lock).lastInsertRowid;
    })();
    const recipients = db.prepare('SELECT COUNT(*) AS c FROM group_members WHERE group_id=?').get(g.id).c;
    res.status(201).json({ ok: true, id: id, recipients: recipients });
  } catch (e) { next(e); }
});

/* ---- client: join / leave / my groups ---- */

router.get('/mine', requireAuth, function (req, res) {
  const rows = db.prepare(`
    SELECT g.*, t.display_name AS trainer_name, t.avatar_emoji AS trainer_emoji FROM group_members gm
    JOIN groups g ON g.id = gm.group_id
    JOIN users t ON t.id = g.trainer_id
    WHERE gm.user_id = ?
  `).all(req.user.id);
  res.json({
    groups: rows.map(function (g) {
      // trainerId нужен клиенту для кнопки "Связь" (раздел 23) — открыть личный чат с тренером.
      return { id: g.id, name: g.name, description: g.description, trainerId: g.trainer_id, trainerName: g.trainer_name, trainerEmoji: g.trainer_emoji };
    })
  });
});

router.post('/join', requireAuth, function (req, res, next) {
  try {
    const code = String((req.body && req.body.code) || '').trim().toUpperCase();
    if (!code) throw badRequest('Введите код приглашения.');
    const g = db.prepare('SELECT * FROM groups WHERE invite_code = ?').get(code);
    if (!g) throw notFound('Неверный код приглашения. Проверьте и попробуйте снова.');
    if (g.trainer_id === req.user.id) throw badRequest('Нельзя вступить в собственную группу.');

    const already = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(g.id, req.user.id);
    if (already) throw conflict('Вы уже состоите в этой группе.');

    if(require('../lib/billing').account(g.trainer_id).trainer_until>0||require('../lib/billing').account(g.trainer_id).demo_until>0){require('../lib/billing').enroll(g,req.user.id);return res.status(201).json({ok:true,group:{id:g.id,name:g.name}});}
    const limit = trainerClientLimit(g.trainer_id);
    const alreadyClient = db.prepare(`SELECT 1 FROM group_members gm JOIN groups gg ON gg.id = gm.group_id
      WHERE gg.trainer_id = ? AND gm.user_id = ?`).get(g.trainer_id, req.user.id);
    if (!alreadyClient) {
      const count = trainerClientCount(g.trainer_id);
      if (count >= limit) throw forbidden('У тренера достигнут лимит клиентов по текущему тарифу. Вступление сейчас невозможно.');
    }

    db.prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?,?,?)').run(g.id, req.user.id, Date.now());
    res.status(201).json({ ok: true, group: { id: g.id, name: g.name, description: g.description } });
  } catch (e) { next(e); }
});

router.post('/:id/leave', requireAuth, function (req, res, next) {
  try {
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---- trainer: assign habits/tasks to whole group or to one student (раздел 20) ---- */

// Сводка группы за день: участники, задания и процент выполнения каждого задания каждым участником.
// Тренер видит всё; участник видит общие задания группы и свои личные.
router.get('/:id/overview', requireAuth, function (req, res, next) {
  try {
    const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(Number(req.params.id));
    const isTrainer = g && g.trainer_id === req.user.id;
    const allowed = g && (isTrainer || db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(g.id, req.user.id));
    if (!allowed) throw badRequest('Группа недоступна.');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : new Date().toISOString().slice(0, 10);
    const members = db.prepare(`SELECT u.id, u.display_name, u.avatar_emoji FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? AND u.status = 'active' ORDER BY u.display_name`).all(g.id);
    const habits = db.prepare('SELECT id, name, emoji, type, config_json, target_user_id FROM habits WHERE group_id = ? AND assigned_by IS NOT NULL AND (target_user_id IS NULL OR target_user_id = ? OR ? = 1) ORDER BY created_at, id').all(g.id, req.user.id, isTrainer ? 1 : 0);
    const logQ = db.prepare('SELECT done FROM habit_logs WHERE habit_id = ? AND user_id = ? AND date_key = ?');
    const progQ = db.prepare('SELECT progress_json FROM habit_progress WHERE habit_id = ? AND user_id = ? AND date_key = ?');
    const cells = {}, raw = {};
    const sumQ = db.prepare('SELECT progress_json FROM habit_progress WHERE habit_id = ? AND user_id = ? AND date_key <> ?');
    habits.forEach(function (h) {
      let cfg = {}; try { cfg = JSON.parse(h.config_json || '{}'); } catch (e) {}
      members.forEach(function (m) {
        if (h.target_user_id && h.target_user_id !== m.id) return;
        const log = logQ.get(h.id, m.id, date); let pct = 0;
        if (log && log.done) pct = 100;
        else {
          const row = progQ.get(h.id, m.id, date); let p = {}; try { p = row ? JSON.parse(row.progress_json || '{}') : {}; } catch (e) {}
          const goal = cfg.goal && cfg.goal.enabled ? cfg.goal : null;
          if (goal && p.goalAmount != null) pct = Number(p.goalAmount) / (Number(goal.daily || goal.total) || 1) * 100;
          else if (p.amount != null) pct = Number(p.amount) / (Number(cfg.target) || 1) * 100;
          else if (Array.isArray(p.done) && Array.isArray(cfg.items) && cfg.items.length) pct = p.done.length / cfg.items.length * 100;
        }
        cells[m.id + ':' + h.id] = Math.max(0, Math.min(100, Math.round(pct) || 0));
        // Сырые данные за день — приложение считает процент тем же способом, что и для своих задач.
        const rowT = progQ.get(h.id, m.id, date); let pT = null; try { pT = rowT ? JSON.parse(rowT.progress_json || 'null') : null; } catch (e) {}
        let before = 0; if (cfg.goal && cfg.goal.enabled) sumQ.all(h.id, m.id, date).forEach(function (r) { try { before += Number(JSON.parse(r.progress_json).goalAmount) || 0; } catch (e) {} });
        raw[m.id + ':' + h.id] = { done: !!(log && log.done), p: pT, before: before };
      });
    });
    res.json({
      date: date, isTrainer: !!isTrainer, group: { id: g.id, name: g.name },
      members: members.map(function (m) { return { id: m.id, displayName: m.display_name, avatarEmoji: m.avatar_emoji, me: m.id === req.user.id }; }),
      habits: habits.map(function (h) { let c = {}; try { c = JSON.parse(h.config_json || '{}'); } catch (e) {} return { id: h.id, name: h.name, emoji: h.emoji, type: h.type, config: c, targetUserId: h.target_user_id || null }; }),
      cells: cells, raw: raw
    });
  } catch (e) { next(e); }
});

// Состав группы для её участника: тренер, участники и задания (общие и личные для него самого).
router.get('/:id/roster', requireAuth, function (req, res, next) {
  try {
    const g = db.prepare('SELECT g.*, t.display_name AS trainer_name, t.avatar_emoji AS trainer_emoji FROM groups g JOIN users t ON t.id = g.trainer_id WHERE g.id = ?').get(Number(req.params.id));
    const allowed = g && (g.trainer_id === req.user.id || db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(g.id, req.user.id));
    if (!allowed) throw badRequest('Группа недоступна.');
    const members = db.prepare(`SELECT u.id, u.display_name, u.avatar_emoji FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? AND u.status = 'active' ORDER BY u.display_name`).all(g.id);
    const habits = db.prepare('SELECT id, name, emoji, target_user_id FROM habits WHERE group_id = ? AND assigned_by IS NOT NULL AND (target_user_id IS NULL OR target_user_id = ? OR ? = 1)').all(g.id, req.user.id, g.trainer_id === req.user.id ? 1 : 0);
    res.json({
      group: { id: g.id, name: g.name, description: g.description, trainerName: g.trainer_name, trainerEmoji: g.trainer_emoji },
      members: members.map(function (m) { return { id: m.id, displayName: m.display_name, avatarEmoji: m.avatar_emoji, me: m.id === req.user.id }; }),
      habits: habits.map(function (h) { return { id: h.id, name: h.name, emoji: h.emoji, personal: !!h.target_user_id }; })
    });
  } catch (e) { next(e); }
});

router.get('/:id/habits', requireAuth, requireRole('TRAINER', 'ADMIN'), function (req, res, next) {
  try {
    const g = ownedGroupOrThrow(req.params.id, req.user.id);
    const habits = db.prepare(`
      SELECT h.*, u.display_name AS target_name FROM habits h
      LEFT JOIN users u ON u.id = h.target_user_id
      WHERE h.group_id = ? AND h.assigned_by IS NOT NULL
    `).all(g.id)
      .map(function (h) {
        return {
          id: h.id, name: h.name, emoji: h.emoji, type: h.type, config: JSON.parse(h.config_json || '{}'), createdAt: h.created_at,
          targetUserId: h.target_user_id || null, targetName: h.target_name || null
        };
      });
    res.json({ habits: habits });
  } catch (e) { next(e); }
});

// Прогресс каждого ученика по конкретному заданию (раздел 20-21): для назначения всей
// группе — все участники группы; для персонального назначения — только тот один ученик.
router.get('/:id/habits/:habitId/progress', requireAuth, requireRole('TRAINER', 'ADMIN'), function (req, res, next) {
  try {
    const g = ownedGroupOrThrow(req.params.id, req.user.id);
    const habit = db.prepare('SELECT * FROM habits WHERE id = ? AND group_id = ? AND assigned_by IS NOT NULL').get(req.params.habitId, g.id);
    if (!habit) throw notFound('Задание не найдено.');

    const targets = habit.target_user_id
      ? db.prepare('SELECT id, display_name, username FROM users WHERE id = ?').all(habit.target_user_id)
      : db.prepare(`SELECT u.id, u.display_name, u.username FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY gm.joined_at ASC`).all(g.id);

    const result = targets.map(function (u) {
      const doneCount = db.prepare('SELECT COUNT(*) AS c FROM habit_logs WHERE habit_id = ? AND user_id = ? AND done = 1').get(habit.id, u.id).c;
      const last = db.prepare('SELECT progress_json, date_key FROM habit_progress WHERE habit_id = ? AND user_id = ? ORDER BY date_key DESC LIMIT 1').get(habit.id, u.id);
      return {
        id: u.id, displayName: u.display_name, username: u.username,
        doneCount: doneCount,
        lastProgress: last ? JSON.parse(last.progress_json || '{}') : null,
        lastDate: last ? last.date_key : null,
        lastDoneDate: (db.prepare('SELECT MAX(date_key) AS d FROM habit_logs WHERE habit_id = ? AND user_id = ? AND done = 1').get(habit.id, u.id) || {}).d || null
      };
    });
    res.json({ targetUserId: habit.target_user_id || null, students: result });
  } catch (e) { next(e); }
});

router.post('/:id/habits', requireAuth, requireRole('TRAINER', 'ADMIN'), function (req, res, next) {
  try {
    const g = ownedGroupOrThrow(req.params.id, req.user.id);
    if(require('../lib/billing').account(req.user.id).trainer_until>0||require('../lib/billing').account(req.user.id).demo_until>0)require('../lib/billing').requireTrainer(req.user.id);
    const body = req.body || {};
    const name = String(body.name || '').trim().slice(0, 200);
    if (!name) throw badRequest('Укажите название задания.');

    let targetUserId = null;
    if (body.targetUserId) {
      targetUserId = Number(body.targetUserId);
      const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(g.id, targetUserId);
      if (!isMember) throw badRequest('Этот ученик не состоит в группе.');
    }

    const id = uid();
    const t = Date.now();
    db.prepare(`INSERT INTO habits (id, user_id, name, emoji, type, config_json, group_id, assigned_by, target_user_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, req.user.id, name, body.emoji || '🎯', body.type || 'simple', JSON.stringify(body.config || {}),
      g.id, req.user.id, targetUserId, new Date().toISOString().slice(0, 10), t
    );
    res.status(201).json({ id: id, name: name, targetUserId: targetUserId });
  } catch (e) { next(e); }
});

// Изменение задания: название, значок и кому назначено (вся группа или один ученик).
router.patch('/:id/habits/:habitId', requireAuth, requireRole('TRAINER', 'ADMIN'), function (req, res, next) {
  try {
    const g = ownedGroupOrThrow(req.params.id, req.user.id);
    const habit = db.prepare('SELECT * FROM habits WHERE id = ? AND group_id = ? AND assigned_by IS NOT NULL').get(req.params.habitId, g.id);
    if (!habit) throw badRequest('Задание не найдено.');
    const body = req.body || {};
    const name = body.name === undefined ? habit.name : String(body.name || '').trim().slice(0, 200);
    if (!name) throw badRequest('Укажите название задания.');
    const emoji = body.emoji === undefined ? habit.emoji : (String(body.emoji || '').trim().slice(0, 8) || '🎯');
    let targetUserId = habit.target_user_id || null;
    if (body.targetUserId !== undefined) {
      targetUserId = body.targetUserId ? Number(body.targetUserId) : null;
      if (targetUserId && !db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(g.id, targetUserId)) throw badRequest('Этот ученик не состоит в группе.');
    }
    db.prepare('UPDATE habits SET name = ?, emoji = ?, target_user_id = ?, updated_at = ? WHERE id = ?').run(name, emoji, targetUserId, Date.now(), habit.id);
    res.json({ id: habit.id, name: name, emoji: emoji, targetUserId: targetUserId });
  } catch (e) { next(e); }
});

router.delete('/:id/habits/:habitId', requireAuth, requireRole('TRAINER', 'ADMIN'), function (req, res, next) {
  try {
    const g = ownedGroupOrThrow(req.params.id, req.user.id);
    db.prepare('DELETE FROM habits WHERE id = ? AND group_id = ? AND assigned_by IS NOT NULL').run(req.params.habitId, g.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
