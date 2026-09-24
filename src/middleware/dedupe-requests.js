// dedupe-requests.js — защита от дублей на стороне сервера.
//
// Многократное нажатие кнопки "Создать" (статья, сервер, канал, роль, набор
// стикеров, комментарий, бэкап и т.д.) — или одно нажатие сразу в двух
// вкладках — присылает несколько одинаковых запросов, и каждый честно
// создавал свою копию. Клиентская защита (public/request-guard.js) закрывает
// только одну вкладку, поэтому окончательная проверка — здесь, общая для
// всего /api, чтобы не зависеть от того, не забыли ли её в конкретном
// маршруте.
//
// Одинаковый запрос = тот же пользователь (заголовок Authorization/cookie,
// без них — IP) + метод + URL + тело. Дублем считается:
//   1) такой же запрос, пришедший, пока первый ещё обрабатывается;
//   2) такой же запрос сразу следом (в пределах REPLAY_WINDOW_MS после
//      ответа), если между ними от этого пользователя не было других
//      изменяющих запросов.
// Дубль в обработчик не попадает: он получает копию ответа первого (тот же
// статус и тело) — клиент видит "создано", а объект существует в одном
// экземпляре.
//
// Условие "подряд" в п.2 важно: цепочка "в избранное → убрать → снова в
// избранное" (или "опубликовать → снять → опубликовать") — три разных
// осознанных действия, и третье должно реально выполниться, а не получить
// сохранённый ответ первого.
//
// Не трогаем:
//   - GET/HEAD/OPTIONS — ничего не меняют;
//   - multipart (загрузка файлов) — тело на этом этапе ещё не разобрано
//     (его разбирает multer в маршруте), сравнивать нечего;
//   - .../toggle (лайки, реакции) — два нажатия подряд там осознанно дают
//     "поставить → снять", а не дубль.

const crypto = require('crypto');

const REPLAY_WINDOW_MS = 3000;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const EXCLUDED_PATHS = [/\/toggle\/?$/];

const inFlight = new Map(); // key -> Promise<result|null>
const lastCompleted = new Map(); // identity -> { key, result, expiresAt }
const latestArrival = new Map(); // identity -> seq последнего пришедшего (не дубля) запроса
let seqCounter = 0;

function identityOf(req) {
  return req.headers.authorization || req.headers.cookie || req.ip || '';
}

function requestKey(identity, req) {
  let body;
  try { body = JSON.stringify(req.body ?? null); } catch (e) { return null; }
  return crypto.createHash('sha256')
    .update(`${identity}\n${req.method}\n${req.originalUrl}\n${body}`)
    .digest('hex');
}

function isExcluded(req) {
  if (req.is('multipart/form-data')) return true;
  const pathOnly = req.originalUrl.split('?')[0];
  return EXCLUDED_PATHS.some((re) => re.test(pathOnly));
}

function replay(res, result) {
  if (result.contentType) res.set('Content-Type', result.contentType);
  res.set('X-Deduplicated', '1');
  res.status(result.status);
  if (result.body === undefined) res.end();
  else res.send(result.body);
}

function dedupeRequests(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next();
  const identity = identityOf(req);
  const key = isExcluded(req) ? null : requestKey(identity, req);

  // Повтор только что выполненного запроса.
  const last = lastCompleted.get(identity);
  if (key && last && last.key === key && last.expiresAt > Date.now()) {
    return replay(res, last.result);
  }

  // Такой же запрос уже обрабатывается — ждём его ответ.
  const pending = key && inFlight.get(key);
  if (pending) {
    pending.then((result) => {
      // Первый запрос оборвался или упал с 5xx — проходим проверку заново:
      // первый из ожидавших станет новым "основным", остальные дождутся уже
      // его ответа (а не выполнятся все разом).
      if (!result) return dedupeRequests(req, res, next);
      replay(res, result);
    });
    return;
  }

  // Любое другое изменяющее действие (в т.ч. непроверяемое — загрузка,
  // toggle) обрывает цепочку повторов.
  lastCompleted.delete(identity);
  const seq = ++seqCounter;
  latestArrival.set(identity, seq);
  const clearArrival = () => { if (latestArrival.get(identity) === seq) latestArrival.delete(identity); };
  if (!key) {
    res.on('close', clearArrival);
    return next();
  }

  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  inFlight.set(key, done);

  // Запоминаем тело ответа: res.json() внутри вызывает res.send() уже со
  // строкой, поэтому сохраняем последний вызов.
  let sentBody;
  const originalSend = res.send;
  res.send = function (body) {
    sentBody = body;
    return originalSend.apply(this, arguments);
  };

  let settled = false;
  const settle = (result) => {
    if (settled) return;
    settled = true;
    if (inFlight.get(key) === done) inFlight.delete(key);
    // Пока шёл запрос, от пользователя мог прийти другой изменяющий
    // запрос — тогда этот ответ уже не "последний" и повторять его нельзя.
    const isLatest = latestArrival.get(identity) === seq;
    clearArrival();
    if (result && isLatest) {
      lastCompleted.set(identity, { key, result, expiresAt: Date.now() + REPLAY_WINDOW_MS });
      setTimeout(() => {
        const cur = lastCompleted.get(identity);
        if (cur && cur.key === key && cur.expiresAt <= Date.now()) lastCompleted.delete(identity);
      }, REPLAY_WINDOW_MS + 50).unref();
    }
    resolveDone(result);
  };

  res.on('finish', () => {
    // 5xx не повторяем: следующий такой же запрос пусть попробует заново.
    if (res.statusCode >= 500) return settle(null);
    settle({ status: res.statusCode, contentType: res.get('Content-Type'), body: sentBody });
  });
  res.on('close', () => settle(null));

  next();
}

module.exports = { dedupeRequests };
