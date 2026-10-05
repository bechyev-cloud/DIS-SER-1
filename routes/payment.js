// Публичный (для авторизованных) просмотр реквизитов оплаты — раздел 29.
const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { buildWhatsappLink } = require('../lib/whatsapp');

const router = express.Router();

router.get('/', requireAuth, function (req, res) {
  const row = db.prepare('SELECT * FROM payment_settings WHERE id = 1').get();
  const text = 'Здравствуйте! Я оплатил тариф Дисциплина Pro. Отправляю чек.';
  res.json({
    recipientName: row.recipient_name || '',
    phone: row.phone || '',
    cardRequisites: row.card_requisites || '',
    extraInfo: row.extra_info || '',
    whatsapp: row.whatsapp || '',
    whatsappLink: row.whatsapp ? buildWhatsappLink(row.whatsapp, text) : null,
    qrUrl: row.qr_path ? ('/uploads/' + row.qr_path) : null
  });
});

module.exports = router;
