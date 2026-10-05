const db = require('./db');

function activeSubscription(userId) {
  const legacy = db.prepare(`
    SELECT s.*, p.key AS plan_key, p.name AS plan_name, p.client_limit, p.price, p.is_trainer_plan
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id
    WHERE s.user_id = ? AND s.status = 'active'
    ORDER BY s.activated_at DESC LIMIT 1
  `).get(userId);
  const a=require('./billing').account(userId);if(a.demoActive)return {plan_key:'demo',plan_name:'Демо · полный доступ',client_limit:2147483647,price:0,is_trainer_plan:1,status:'active'};if(legacy&&!a.trainer_until)return legacy;
  return a.personalActive||a.trainerActive?{plan_key:a.trainerActive?(a.studentsPaid?'trainer_pays':'start_plus'):'start',plan_name:a.trainerActive?(a.studentsPaid?'Тренер платит':'Start Plus · тренер'):(a.coveredByTrainer?'Оплачено тренером':'Start'),client_limit:a.trainerActive?a.seat_limit:0,price:a.trainerActive?100*a.seat_limit:500,is_trainer_plan:a.trainerActive?1:0,status:'active',activated_at:null}:null;
}

function trainerClientLimit(trainerId) {
  const sub = activeSubscription(trainerId);
  return sub && sub.is_trainer_plan ? sub.client_limit : 0;
}

// Лимит считается по уникальным клиентам тренера суммарно по всем его группам —
// количество групп само по себе не увеличивает лимит (раздел 13).
function trainerClientCount(trainerId) {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT gm.user_id) AS c FROM group_members gm
    JOIN groups g ON g.id = gm.group_id
    WHERE g.trainer_id = ?
  `).get(trainerId);
  return row ? row.c : 0;
}

// Назначает пользователю тариф администратором. Если тариф тренерский — выдаёт роль TRAINER
// и активирует подписку; если это план "free" — возвращает роль USER (ADMIN не трогаем)
// и отменяет активные тренерские подписки. Существующие клиенты НИКОГДА не удаляются
// автоматически при понижении тарифа (раздел 13, 54) — только новые добавления блокируются
// на уровне проверки лимита в момент вступления в группу.
function adminSetUserPlan(adminId, userId, planKey) {
  if(['start','start_plus','trainer_pays'].includes(planKey))throw new Error('Для Start, Start Plus и «Тренер платит» подтвердите заявку на оплату: она содержит срок и количество учеников.');
  const plan = db.prepare('SELECT * FROM plans WHERE key = ? AND active = 1').get(planKey);
  if (!plan) throw new Error('Тариф не найден или отключён.');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('Пользователь не найден.');

  const t = Date.now();
  const tx = db.transaction(function () {
    db.prepare("UPDATE subscriptions SET status='cancelled', updated_at=? WHERE user_id = ? AND status='active'").run(t, userId);
    db.prepare(`INSERT INTO subscriptions (user_id, plan_id, status, activated_by_admin_id, activated_at, created_at, updated_at)
      VALUES (?,?,'active',?,?,?,?)`).run(userId, plan.id, adminId, t, t, t);
    if (plan.is_trainer_plan && plan.client_limit > 0) {
      if (user.role !== 'ADMIN') db.prepare("UPDATE users SET role='TRAINER', updated_at=? WHERE id=?").run(t, userId);
    } else if (user.role === 'TRAINER') {
      db.prepare("UPDATE users SET role='USER', updated_at=? WHERE id=?").run(t, userId);
    }
    db.prepare('INSERT INTO admin_audit_log (admin_id, action, details_json, created_at) VALUES (?,?,?,?)')
      .run(adminId, 'set_user_plan', JSON.stringify({ userId: userId, planKey: planKey }), t);
  });
  tx();
  return activeSubscription(userId);
}

// Лимит личных (не назначенных тренером) привычек обычного пользователя (раздел 13):
// бесплатно — 2, дальше нужен любой активный платный тариф (тренерский или 'pro').
// TRAINER/ADMIN — без лимита (считаем, что раз они уже на платном тарифе или администрируют
// систему, дополнительного ограничения для их собственных привычек нет).
function personalHabitLimit(user) {
  if (!user || user.role === 'ADMIN') return Infinity;
  const a=require('./billing').account(user.id);if(a.personalActive)return Infinity;if(a.trainer_until)return 0;
  return db.prepare("SELECT 1 FROM subscriptions WHERE user_id=? AND status='active'").get(user.id)?Infinity:0;
}

// Список заявок на оплату (раздел 16, 17) — все подписки с присоединённым пользователем
// и тарифом, чтобы администратор видел клиента/тариф/сумму/дату/статус в одном списке.
function listPaymentRequests() {
  const rows = db.prepare(`
    SELECT s.*, u.display_name AS user_name, u.username, p.key AS plan_key, p.name AS plan_name, p.price AS plan_price
    FROM subscriptions s
    JOIN users u ON u.id = s.user_id
    JOIN plans p ON p.id = s.plan_id
    ORDER BY s.created_at DESC
    LIMIT 300
  `).all();
  const legacyRequests=rows.map(function (r) {
    return {
      id: r.id,
      user: { id: r.user_id, displayName: r.user_name, username: r.username },
      plan: { key: r.plan_key, name: r.plan_name, price: r.plan_price },
      status: r.status,
      reviewedAs: r.reviewed_as || null,
      adminNote: r.admin_note || null,
      createdAt: r.created_at,
      activatedAt: r.activated_at
    };
  });
  const orders=db.prepare("SELECT o.*,u.display_name,u.username FROM billing_orders o JOIN users u ON u.id=o.user_id WHERE o.status<>'draft' AND o.status<>'cancelled' ORDER BY o.created_at DESC LIMIT 300").all().map(o=>({id:'b'+o.id,user:{id:o.user_id,displayName:o.display_name,username:o.username},plan:{key:o.plan_key,name:o.plan_key==='start'?'Start':(o.plan_key==='trainer_pays'?'Тренер платит':'Start Plus')+' · '+o.seat_count+' учеников',price:o.amount},seatCount:o.seat_count,includeStart:!!o.include_start,status:o.status==='approved'?'active':o.status==='rejected'?'cancelled':'pending',reviewedAs:o.status==='approved'?'confirmed':o.status==='rejected'?'rejected':null,adminNote:o.admin_note,createdAt:o.created_at}));
  return orders.concat(legacyRequests).sort((a,b)=>b.createdAt-a.createdAt);
}

function loadPendingOrThrow(subscriptionId) {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId);
  if (!sub) throw new Error('Заявка не найдена.');
  if (sub.status !== 'pending') throw new Error('Эта заявка уже обработана.');
  return sub;
}

// Подтверждение заявки администратором: активирует ИМЕННО эту заявку (сохраняя исходную
// дату создания), отменяет прочие активные подписки пользователя, при необходимости
// выдаёт роль TRAINER — та же логика, что и в adminSetUserPlan, но без создания новой
// строки подписки (раздел 16: "ADMIN нажимает Подтвердить").
function confirmPendingSubscription(adminId, subscriptionId) {
  if(/^b\d+$/.test(subscriptionId))return require('./billing').approve(adminId,Number(subscriptionId.slice(1)));
  const sub = loadPendingOrThrow(subscriptionId);
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(sub.plan_id);
  if (!plan) throw new Error('Тариф этой заявки больше не существует.');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(sub.user_id);
  if (!user) throw new Error('Пользователь не найден.');

  const t = Date.now();
  const tx = db.transaction(function () {
    db.prepare("UPDATE subscriptions SET status='cancelled', updated_at=? WHERE user_id = ? AND status='active'").run(t, sub.user_id);
    db.prepare(`UPDATE subscriptions SET status='active', activated_by_admin_id=?, activated_at=?, reviewed_as='confirmed', updated_at=? WHERE id=?`)
      .run(adminId, t, t, sub.id);
    if (plan.is_trainer_plan && plan.client_limit > 0) {
      if (user.role !== 'ADMIN') db.prepare("UPDATE users SET role='TRAINER', updated_at=? WHERE id=?").run(t, user.id);
    } else if (user.role === 'TRAINER') {
      db.prepare("UPDATE users SET role='USER', updated_at=? WHERE id=?").run(t, user.id);
    }
  });
  tx();
  return activeSubscription(sub.user_id);
}

// Отклонение заявки: заявка переходит в статус 'cancelled' (в существующей схеме нет отдельного
// значения 'rejected' — добавить его в CHECK(status IN (...)) для уже существующей таблицы
// небезопасно без пересборки, поэтому отличие "отклонено администратором" от обычной отмены
// хранится в новой колонке reviewed_as + необязательной причине admin_note).
function rejectPendingSubscription(adminId, subscriptionId, note) {
  if(/^b\d+$/.test(subscriptionId))return require('./billing').reject(adminId,Number(subscriptionId.slice(1)),note);
  const sub = loadPendingOrThrow(subscriptionId);
  const t = Date.now();
  db.prepare(`UPDATE subscriptions SET status='cancelled', activated_by_admin_id=?, reviewed_as='rejected', admin_note=?, updated_at=? WHERE id=?`)
    .run(adminId, note || null, t, sub.id);
}

module.exports = {
  activeSubscription, trainerClientLimit, trainerClientCount, adminSetUserPlan,
  personalHabitLimit, listPaymentRequests, confirmPendingSubscription, rejectPendingSubscription
};
