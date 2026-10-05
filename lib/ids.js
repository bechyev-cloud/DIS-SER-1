const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих символов (0/O, 1/I)

function randomCode(len) {
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// Пример: DISC-8F3K2
function groupInviteCode() {
  return 'DISC-' + randomCode(5);
}

// Код друга пользователя: FR-7KQ2P1
function friendCode() {
  return 'FR-' + randomCode(6);
}

function uid() {
  return Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
}

module.exports = { randomCode, groupInviteCode, friendCode, uid };
