// Единый формат ошибок API: дружелюбное русское сообщение для пользователя +
// техническая деталь только в server log (никогда не уходит в ответ клиенту).
class ApiError extends Error {
  constructor(status, userMessage, logDetail) {
    super(userMessage);
    this.status = status;
    this.userMessage = userMessage;
    this.logDetail = logDetail || userMessage;
  }
}

const GENERIC_MESSAGE = 'Не удалось выполнить действие. Проверьте соединение и попробуйте ещё раз.';

function notFound(msg) { return new ApiError(404, msg || 'Не найдено.'); }
function badRequest(msg) { return new ApiError(400, msg || 'Некорректный запрос.'); }
function unauthorized(msg) { return new ApiError(401, msg || 'Требуется вход в аккаунт.'); }
function forbidden(msg) { return new ApiError(403, msg || 'Недостаточно прав для этого действия.'); }
function conflict(msg) { return new ApiError(409, msg || 'Конфликт данных.'); }

// Express error-handling middleware (4 аргумента обязательны для Express).
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof ApiError) {
    if (err.status >= 500) console.error('[api-error]', err.logDetail);
    return res.status(err.status).json({ error: err.userMessage });
  }
  console.error('[unhandled-error]', err && err.stack ? err.stack : err);
  res.status(500).json({ error: GENERIC_MESSAGE });
}

module.exports = { ApiError, notFound, badRequest, unauthorized, forbidden, conflict, errorHandler, GENERIC_MESSAGE };
