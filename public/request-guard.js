// request-guard.js — защита от дублей при многократном нажатии кнопок.
//
// Если кнопку "Создать" (статья, сервер, канал, роль, набор стикеров и т.п.)
// прожать несколько раз, пока первый запрос ещё в пути, каждое нажатие
// уходило на сервер отдельным POST — и создавалось столько же копий.
// Здесь window.fetch оборачивается так, что одинаковый изменяющий запрос
// (тот же метод + URL + тело), отправленный, пока предыдущий такой же ещё
// не завершился, не уходит на сервер повторно: все вызывающие получают
// копию ответа первого запроса.
//
// Подключается ДО auth-system.js: тот при входе оборачивает window.fetch
// поверх текущего, а при выходе возвращает window.originalFetch — если бы
// эта обёртка ставилась позже, выход из аккаунта её бы снимал.
//
// Дедуп — только на время полёта запроса, без "окна" после ответа: иначе
// два осознанных нажатия лайка/реакции подряд (POST .../toggle с тем же
// телом) склеились бы в одно.
(function () {
  if (window.__requestGuardInstalled) return;
  window.__requestGuardInstalled = true;

  const nativeFetch = window.fetch.bind(window);
  const inFlight = new Map();
  const GUARDED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  function requestKey(input, init) {
    if (input instanceof Request) return null; // такие вызовы в проекте не используются — не трогаем
    const method = String((init && init.method) || 'GET').toUpperCase();
    if (!GUARDED_METHODS.has(method)) return null;
    const body = init && init.body;
    // FormData/Blob (загрузка файлов) сравнить по содержимому нельзя —
    // пропускаем как есть.
    if (body != null && typeof body !== 'string') return null;
    const url = new URL(String(input), window.location.href).href;
    return `${method} ${url}\n${body || ''}`;
  }

  window.fetch = function guardedFetch(input, init) {
    const key = requestKey(input, init);
    if (!key) return nativeFetch(input, init);

    let shared = inFlight.get(key);
    if (!shared) {
      shared = nativeFetch(input, init);
      inFlight.set(key, shared);
      const release = () => { if (inFlight.get(key) === shared) inFlight.delete(key); };
      shared.then(release, release);
    }
    // Тело ответа читается один раз — каждому вызывающему отдаём свою копию.
    return shared.then((response) => response.clone());
  };

  // Блокирует кнопку на время асинхронного действия и игнорирует повторные
  // вызовы для той же кнопки (в т.ч. по Enter в поле формы), пока первое
  // не завершится.
  const busyButtons = new WeakSet();
  window.runExclusive = async function (button, action) {
    if (!button) return action();
    if (busyButtons.has(button)) return undefined;
    busyButtons.add(button);
    const wasDisabled = button.disabled;
    button.disabled = true;
    try {
      return await action();
    } finally {
      busyButtons.delete(button);
      button.disabled = wasDisabled;
    }
  };
})();
