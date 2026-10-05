const express = require('express');
const db = require('../lib/db');
const { requireAuth, requireRole } = require('../lib/auth');
const backupLib = require('../lib/backup');
const { badRequest } = require('../lib/errors');

const router = express.Router();
router.use(requireAuth, requireRole('ADMIN'));

function audit(adminId, action, details) {
  db.prepare('INSERT INTO admin_audit_log (admin_id, action, details_json, created_at) VALUES (?,?,?,?)')
    .run(adminId, action, JSON.stringify(details || {}), Date.now());
}

router.get('/', function (req, res) {
  const rows = backupLib.listBackups().map(function (b) {
    return { id: b.id, filename: b.filename, type: b.type, sizeBytes: b.size_bytes, status: b.status, errorText: b.error_text, createdAt: b.created_at };
  });
  const lastOk = rows.find(function (r) { return r.status === 'ok'; });
  res.json({ backups: rows, lastSuccessfulAt: lastOk ? lastOk.createdAt : null });
});

router.post('/', function (req, res, next) {
  try {
    const result = backupLib.createBackup('manual');
    if (!result.ok) throw badRequest('Не удалось создать резервную копию: ' + result.error);
    audit(req.user.id, 'create_backup', { filename: result.filename });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

router.post('/restore', function (req, res, next) {
  try {
    const filename = String((req.body && req.body.filename) || '');
    if (!req.body || req.body.confirm !== true) throw badRequest('Для полного восстановления требуется подтверждение (confirm: true).');
    const result = backupLib.restoreAll(filename);
    audit(req.user.id, 'restore_all', { filename: filename, safetyBackup: result.safetyBackup });
    res.json(result);
  } catch (e) { next(badRequest(e.message)); }
});

router.post('/restore-selected', function (req, res, next) {
  try {
    const filename = String((req.body && req.body.filename) || '');
    const userIds = Array.isArray(req.body && req.body.userIds) ? req.body.userIds.map(Number).filter(Boolean) : [];
    if (!req.body || req.body.confirm !== true) throw badRequest('Для восстановления требуется подтверждение (confirm: true).');
    if (!userIds.length) throw badRequest('Выберите хотя бы одного пользователя для восстановления.');
    const result = backupLib.restoreSelectedUsers(filename, userIds);
    audit(req.user.id, 'restore_selected_users', { filename: filename, userIds: userIds });
    res.json(result);
  } catch (e) { next(badRequest(e.message)); }
});

module.exports = router;
