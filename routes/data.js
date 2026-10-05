// Синхронизация привычек/логов/тренировок/прогресса пользователя.
// Контракт зеркалит прежнюю (нерабочую) идею pushRemote/initSync из исходного приложения,
// но теперь реально хранит данные на сервере и является источником правды.
const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { personalHabitLimit } = require('../lib/subscription');
const { badRequest } = require('../lib/errors');
const crypto = require('crypto');

const router = express.Router();

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

function loadFullState(userId) {
  const ownHabits = db.prepare('SELECT * FROM habits WHERE user_id = ? AND assigned_by IS NULL').all(userId);

  const assignedHabits = db.prepare(`
    SELECT h.* FROM habits h
    JOIN group_members gm ON gm.group_id = h.group_id AND gm.user_id = ?
    WHERE h.assigned_by IS NOT NULL AND (h.target_user_id IS NULL OR h.target_user_id = ?)
  `).all(userId, userId);

  const habits = ownHabits.concat(assignedHabits).map(function (h) {
    return {
      id: h.id,
      name: h.name,
      emoji: h.emoji,
      type: h.type,
      config: safeJsonParse(h.config_json, {}),
      createdAt: h.created_at,
      groupId: h.group_id || null,
      assignedBy: h.assigned_by || null
    };
  });

  const habitIds = habits.map(function (h) { return h.id; });
  const logs = {};
  const progress = {};

  if (habitIds.length) {
    const placeholders = habitIds.map(function () { return '?'; }).join(',');
    const logRows = db.prepare(`SELECT habit_id, date_key, done FROM habit_logs WHERE user_id = ? AND habit_id IN (${placeholders})`).all(userId, ...habitIds);
    logRows.forEach(function (r) {
      if (!r.done) return;
      if (!logs[r.date_key]) logs[r.date_key] = {};
      logs[r.date_key][r.habit_id] = true;
    });
    const progRows = db.prepare(`SELECT habit_id, date_key, progress_json FROM habit_progress WHERE user_id = ? AND habit_id IN (${placeholders})`).all(userId, ...habitIds);
    progRows.forEach(function (r) {
      if (!progress[r.date_key]) progress[r.date_key] = {};
      progress[r.date_key][r.habit_id] = safeJsonParse(r.progress_json, {});
    });
  }

  const workouts = db.prepare('SELECT * FROM workouts WHERE user_id = ? ORDER BY created_at DESC').all(userId).map(function (w) {
    return { id: w.id, type: w.type, date: w.date_key, duration: w.duration, note: w.note, habitId: w.habit_id, createdAt: w.created_at };
  });

  const totalsRow = db.prepare('SELECT * FROM user_totals WHERE user_id = ?').get(userId) ||
    { zikr_count: 0, timer_sessions: 0, timer_minutes: 0, checklist_done: 0 };
  const totals = {
    zikrCount: totalsRow.zikr_count,
    timerSessions: totalsRow.timer_sessions,
    timerMinutes: totalsRow.timer_minutes,
    checklistDone: totalsRow.checklist_done
  };

  const updatedAtRow = db.prepare('SELECT MAX(updated_at) AS m FROM habits WHERE user_id = ?').get(userId);
  const updatedAt = updatedAtRow && updatedAtRow.m ? updatedAtRow.m : Date.now();

  const version=(db.prepare('SELECT version FROM state_versions WHERE user_id=?').get(userId)||{version:0}).version;
  return { habits, logs, workouts, progress, totals, updatedAt, version };
}

router.get('/state', requireAuth, function (req, res) {
  res.json(loadFullState(req.user.id));
});

// Полная перезапись "своих" данных пользователя (аналог прежнего dbDoc.set(state)).
// Назначенные тренером привычки (assigned_by не null) этим эндпойнтом не трогаются —
// ими управляет тренер через /api/groups.
router.put('/state', requireAuth, function (req, res, next) {
  try {
    const body = req.body || {};
    const userId = req.user.id;
    const opId=String(body.operationId||'');
    if(!/^[a-zA-Z0-9-]{8,100}$/.test(opId)||!Number.isSafeInteger(body.baseVersion))return res.status(400).json({error:'Нужны версия состояния и идентификатор операции.'});
    const receiptId=userId+':'+opId;
    const hash=crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const previous=db.prepare('SELECT * FROM operation_receipts WHERE id=?').get(receiptId);
    if(previous){if(previous.hash!==hash)return res.status(409).json({error:'Идентификатор операции уже использован.'});return res.json(JSON.parse(previous.response));}
    const version=(db.prepare('SELECT version FROM state_versions WHERE user_id=?').get(userId)||{version:0}).version;
    if(version!==body.baseVersion){
      db.prepare('INSERT OR IGNORE INTO sync_conflicts VALUES(?,?,?,?,?,?)').run(receiptId,userId,body.baseVersion,version,JSON.stringify(body),Date.now());
      return res.status(409).json({error:'Данные изменились на другом устройстве. Ваш вариант сохранён для согласования.',code:'STATE_CONFLICT',version});
    }
    const habits = Array.isArray(body.habits) ? body.habits : [];
    const logs = body.logs && typeof body.logs === 'object' ? body.logs : {};
    const progress = body.progress && typeof body.progress === 'object' ? body.progress : {};
    const workouts = Array.isArray(body.workouts) ? body.workouts : [];
    const totals = body.totals && typeof body.totals === 'object' ? body.totals : {};

    for (const h of habits) {
      if (!h || typeof h.id !== 'string' || typeof h.name !== 'string') {
        throw badRequest('Некорректные данные привычки при синхронизации.');
      }
    }

    // Лимит бесплатных личных привычек (раздел 13). Клиент присылает ПОЛНЫЙ список своих
    // привычек, включая назначенные тренером (они просто не станут "своими" — см. WHERE в
    // upsertHabit ниже), поэтому из лимита исключаем id, которые уже существуют как чужое
    // назначение. Блокируем только ДОБАВЛЕНИЕ новой привычки сверх лимита — если у пользователя
    // уже было больше (например, импорт старых данных), синхронизация существующих не ломается.
    const existingOwnCountRow = db.prepare('SELECT COUNT(*) AS c FROM habits WHERE user_id = ? AND assigned_by IS NULL').get(userId);
    const existingOwnCount = existingOwnCountRow ? existingOwnCountRow.c : 0;
    const incomingIdsAll = habits.map(function (h) { return h.id; });
    let assignedIncomingCount = 0;
    if (incomingIdsAll.length) {
      const ph = incomingIdsAll.map(function () { return '?'; }).join(',');
      assignedIncomingCount = db.prepare(`SELECT COUNT(*) AS c FROM habits WHERE id IN (${ph}) AND assigned_by IS NOT NULL`).get(...incomingIdsAll).c;
    }
    const eligibleOwnCount = incomingIdsAll.length - assignedIncomingCount;
    const limit = personalHabitLimit(req.user);
    if(limit===0)return res.status(403).json({error:'Период Start закончился. Продлите тариф в настройках. Ваши данные сохранены.',code:'START_EXPIRED'});
    if (eligibleOwnCount > limit && eligibleOwnCount > existingOwnCount) {
      throw badRequest('Бесплатно доступно ' + limit + ' привыч' + (limit === 1 ? 'ка' : 'ки') + '. Чтобы добавить больше, оформите платный тариф в настройках.');
    }

    const t = Date.now();
    const tx = db.transaction(function () {
      // Собственные привычки пользователя: полностью заменяем набором с клиента.
      const existingOwnIds = db.prepare('SELECT id FROM habits WHERE user_id = ? AND assigned_by IS NULL').all(userId).map(function (r) { return r.id; });
      const incomingIds = habits.map(function (h) { return h.id; });
      const toDelete = existingOwnIds.filter(function (id) { return incomingIds.indexOf(id) === -1; });
      if (toDelete.length) {
        const ph = toDelete.map(function () { return '?'; }).join(',');
        db.prepare(`DELETE FROM habits WHERE id IN (${ph}) AND user_id = ?`).run(...toDelete, userId);
      }
      const upsertHabit = db.prepare(`INSERT INTO habits (id, user_id, name, emoji, type, config_json, group_id, assigned_by, created_at, updated_at)
        VALUES (@id,@user_id,@name,@emoji,@type,@config_json,NULL,NULL,@created_at,@updated_at)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, emoji=excluded.emoji, type=excluded.type,
          config_json=excluded.config_json, updated_at=excluded.updated_at
        WHERE habits.user_id = @user_id AND habits.assigned_by IS NULL`);
      habits.forEach(function (h) {
        if(h.assignedBy)return;
        upsertHabit.run({
          id: h.id, user_id: userId, name: String(h.name).slice(0, 200), emoji: h.emoji || '✅',
          type: h.type || 'simple', config_json: JSON.stringify(h.config || {}),
          created_at: h.createdAt || new Date().toISOString().slice(0, 10), updated_at: t
        });
      });

      // Логи/прогресс/тренировки — пользователь всегда может перезаписывать свои собственные
      // записи выполнения, в том числе по привычкам, назначенным тренером.
      db.prepare('DELETE FROM habit_logs WHERE user_id = ?').run(userId);
      const insLog = db.prepare('INSERT INTO habit_logs (user_id, habit_id, date_key, done, updated_at) VALUES (?,?,?,1,?)');
      const allowed=new Set(loadFullState(userId).habits.map(h=>h.id));
      Object.keys(logs).forEach(function (dateKey) {
        const dayLog = logs[dateKey] || {};
        Object.keys(dayLog).forEach(function (habitId) {
          if (dayLog[habitId] && allowed.has(habitId)) insLog.run(userId, habitId, dateKey, t);
        });
      });

      db.prepare('DELETE FROM habit_progress WHERE user_id = ?').run(userId);
      const insProg = db.prepare('INSERT INTO habit_progress (user_id, habit_id, date_key, progress_json, updated_at) VALUES (?,?,?,?,?)');
      Object.keys(progress).forEach(function (dateKey) {
        const dayProg = progress[dateKey] || {};
        Object.keys(dayProg).forEach(function (habitId) {
          if(allowed.has(habitId))insProg.run(userId, habitId, dateKey, JSON.stringify(dayProg[habitId] || {}), t);
        });
      });

      db.prepare('DELETE FROM workouts WHERE user_id = ?').run(userId);
      const insW = db.prepare('INSERT INTO workouts (id, user_id, type, date_key, duration, note, habit_id, created_at) VALUES (?,?,?,?,?,?,?,?)');
      workouts.forEach(function (w) {
        insW.run(w.id, userId, w.type || 'other', w.date, w.duration || null, w.note || '', w.habitId || null, w.createdAt || t);
      });

      db.prepare(`INSERT INTO user_totals (user_id, zikr_count, timer_sessions, timer_minutes, checklist_done)
        VALUES (?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET zikr_count=excluded.zikr_count, timer_sessions=excluded.timer_sessions,
          timer_minutes=excluded.timer_minutes, checklist_done=excluded.checklist_done`)
        .run(userId, totals.zikrCount || 0, totals.timerSessions || 0, totals.timerMinutes || 0, totals.checklistDone || 0);
    });
    const result=db.transaction(()=>{
      tx();
      db.prepare('INSERT INTO state_versions VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET version=version+1').run(userId);
      const response=loadFullState(userId);
      db.prepare('INSERT INTO operation_receipts VALUES(?,?,?,?)').run(receiptId,userId,hash,JSON.stringify(response));
      return response;
    })();
    res.json(result);
  } catch (e) { next(e); }
});

// Отдельная быстрая точка для логирования выполнения одной привычки за один день —
// используется, когда клиент не хочет пересылать весь state ради одного тапа.
router.post('/log', requireAuth, function (req, res, next) {
  try {
    const body = req.body || {};
    const habitId = String(body.habitId || '');
    const dateKey = String(body.dateKey || '');
    const done = !!body.done;
    const progressObj = body.progress;
    if (!habitId || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw badRequest('Некорректные параметры отметки.');

    const habit = db.prepare(`SELECT h.* FROM habits h
      LEFT JOIN group_members gm ON gm.group_id = h.group_id AND gm.user_id = ?
      WHERE h.id = ? AND (h.user_id = ? OR (gm.user_id = ? AND (h.target_user_id IS NULL OR h.target_user_id = ?)))`).get(req.user.id, habitId, req.user.id, req.user.id, req.user.id);
    if (!habit) throw badRequest('Привычка не найдена или недоступна.');

    const t = Date.now();
    const tx = db.transaction(function () {
      if (done) {
        db.prepare(`INSERT INTO habit_logs (user_id, habit_id, date_key, done, updated_at) VALUES (?,?,?,1,?)
          ON CONFLICT(user_id, habit_id, date_key) DO UPDATE SET done=1, updated_at=excluded.updated_at`).run(req.user.id, habitId, dateKey, t);
      } else {
        db.prepare('DELETE FROM habit_logs WHERE habit_id = ? AND date_key = ? AND user_id = ?').run(habitId, dateKey, req.user.id);
      }
      if (progressObj) {
        db.prepare(`INSERT INTO habit_progress (user_id, habit_id, date_key, progress_json, updated_at) VALUES (?,?,?,?,?)
          ON CONFLICT(user_id, habit_id, date_key) DO UPDATE SET progress_json=excluded.progress_json, updated_at=excluded.updated_at`)
          .run(req.user.id, habitId, dateKey, JSON.stringify(progressObj), t);
      }
      db.prepare('INSERT INTO state_versions VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET version=version+1').run(req.user.id);
    });
    tx();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.loadFullState = loadFullState;
