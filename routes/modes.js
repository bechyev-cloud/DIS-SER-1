// Личные настройки режимов пользователя (раздел 4-5). Монтируется под /api/me.
const express = require('express');
const { requireAuth } = require('../lib/auth');
const modesLib = require('../lib/modes');

const router = express.Router();

router.get('/modes', requireAuth, function (req, res) {
  res.json({ modes: modesLib.getUserModes(req.user.id) });
});

router.put('/modes', requireAuth, function (req, res, next) {
  try {
    const body = req.body || {};
    const patch = {};
    modesLib.MODE_KEYS.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(body, k)) patch[k] = !!body[k];
    });
    res.json({ modes: modesLib.setUserModes(req.user.id, patch) });
  } catch (e) { next(e); }
});

module.exports = router;
