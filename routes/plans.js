const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { activeSubscription } = require('../lib/subscription');
const { badRequest, notFound } = require('../lib/errors');

const router = express.Router();

function publicPlan(p) {
  return { id: p.id, key: p.key, name: p.name, price: p.price, clientLimit: p.client_limit, description: p.description, isTrainerPlan: !!p.is_trainer_plan };
}

router.get('/', function (req, res) {
  const plans = db.prepare("SELECT * FROM plans WHERE active = 1 AND key IN ('start','start_plus','trainer_pays') ORDER BY price DESC").all();
  res.json({ plans: plans.map(publicPlan) });
});

router.get('/me', requireAuth, function (req, res) {
  const sub = activeSubscription(req.user.id);
  res.json({
    subscription: sub ? {
      planKey: sub.plan_key, planName: sub.plan_name, clientLimit: sub.client_limit,
      price: sub.price, status: sub.status, activatedAt: sub.activated_at
    } : null
  });
});

// Пользователь "выбирает" платный тариф — создаётся заявка в статусе pending.
// Активирует её администратор вручную после проверки оплаты (раздел 31) — никакой
// автоматической фейковой оплаты здесь нет.
router.post('/select', requireAuth, function (req, res, next) {
  try {
    const key = String((req.body && req.body.planKey) || '');
    const plan = db.prepare('SELECT * FROM plans WHERE key = ? AND active = 1').get(key);
    if (!plan) throw notFound('Тариф не найден или временно недоступен.');
    // Бесплатный тариф ('free', price=0) не требует заявки на оплату. Платные тарифы — и
    // тренерские, и обычные (например 'pro', раздел 13) — идут через одну и ту же очередь.
    if (!plan.price) throw badRequest('Этот тариф не требует оплаты.');
    const t = Date.now();
    const existingPending = db.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND plan_id = ? AND status='pending'").get(req.user.id, plan.id);
    if (existingPending) return res.json({ ok: true, status: 'pending' });
    db.prepare(`INSERT INTO subscriptions (user_id, plan_id, status, requisites_shown_at, created_at, updated_at)
      VALUES (?,?,'pending',?,?,?)`).run(req.user.id, plan.id, t, t, t);
    res.status(201).json({ ok: true, status: 'pending' });
  } catch (e) { next(e); }
});

module.exports = router;
