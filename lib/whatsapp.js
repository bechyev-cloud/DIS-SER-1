// Нормализация номера телефона в международный формат без пробелов/скобок/дефисов
// и построение диплинка WhatsApp (раздел 30).
function normalizePhone(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/[^\d+]/g, '');
  digits = digits.replace(/^\+/, '');
  if (digits.startsWith('8') && digits.length === 11) digits = '7' + digits.slice(1); // РФ: 8XXXXXXXXXX -> 7XXXXXXXXXX
  return digits;
}

function buildWhatsappLink(rawPhone, text) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;
  const base = 'https://wa.me/' + phone;
  return text ? base + '?text=' + encodeURIComponent(text) : base;
}

module.exports = { normalizePhone, buildWhatsappLink };
