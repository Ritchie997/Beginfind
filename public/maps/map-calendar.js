// map-calendar.js — календарь мира для интерактивных карт: общий для
// браузера (window.MapCalendar, подключается до map-core.js) и сервера
// (require из src/services — пересчёт дат при смене календаря).
//
// Время на картах — целое число дней. Календарь только подписывает день:
//   - обычный (calendar.months пуст) — григорианский, день 0 = 01.01.1970,
//     как в Date; ввод и подпись «дд.мм.гг»;
//   - свой — список месяцев { name, days }, високосных лет нет, год = сумма
//     дней месяцев, день 0 = 1-е число первого месяца года 0. Ввод —
//     «дд.мм.гг» или «5 Снежень 313», подпись — с названием месяца.
// Год не обрезается до двух цифр: 05.03.12, 05.03.1245, 05.03.-40.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MapCalendar = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY_MS = 86400000;
  const TIME_LIMIT = 1e8 - 1; // дней — предел Date (±273 тыс. лет); тот же в maps-store.js
  const MAX_MONTHS = 60;
  const MAX_MONTH_DAYS = 1000;

  // Список месяцев своего календаря или null (обычный календарь).
  function customMonths(cal) {
    const list = cal && Array.isArray(cal.months) ? cal.months : null;
    return list && list.length ? list : null;
  }

  function yearLength(months) {
    return months.reduce((s, m) => s + m.days, 0);
  }

  // Календарь, записанный в данных (для сравнения «сменился ли»): месяцы
  // или null.
  function signature(cal) {
    const months = customMonths(cal);
    return months ? JSON.stringify(months.map((m) => [m.name, m.days])) : null;
  }

  // ----- день ↔ { d, m, y } -----

  function dayToDate(cal, t) {
    const months = customMonths(cal);
    if (!months) {
      const dt = new Date(t * DAY_MS);
      return { d: dt.getUTCDate(), m: dt.getUTCMonth() + 1, y: dt.getUTCFullYear() };
    }
    const len = yearLength(months);
    const y = Math.floor(t / len);
    let rest = t - y * len;
    let m = 0;
    while (m < months.length - 1 && rest >= months[m].days) { rest -= months[m].days; m += 1; }
    return { d: rest + 1, m: m + 1, y };
  }

  // Число месяцев и длина месяца (m с 1) в году y.
  function monthCount(cal) {
    const months = customMonths(cal);
    return months ? months.length : 12;
  }

  function monthLength(cal, y, m) {
    const months = customMonths(cal);
    if (months) return months[m - 1] ? months[m - 1].days : 0;
    const dt = new Date(0);
    dt.setUTCFullYear(y, m, 0); // нулевой день следующего месяца = последний день этого
    return dt.getUTCDate();
  }

  function dateToDay(cal, y, m, d) {
    const months = customMonths(cal);
    if (!months) {
      const dt = new Date(0);
      dt.setUTCFullYear(y, m - 1, d); // Date.UTC превращает годы 0–99 в 1900-е
      return Math.round(dt.getTime() / DAY_MS);
    }
    let t = y * yearLength(months);
    for (let i = 0; i < m - 1 && i < months.length; i += 1) t += months[i].days;
    return t + d - 1;
  }

  // ----- подпись и ввод -----

  const pad = (n) => String(n).padStart(2, '0');
  const yearText = (y) => `${y < 0 ? '-' : ''}${pad(Math.abs(y))}`;

  // Для полей ввода — всегда числами «дд.мм.гг».
  function formatInput(cal, t) {
    if (t === null || t === undefined || !Number.isFinite(t)) return '';
    const { d, m, y } = dayToDate(cal, t);
    return `${pad(d)}.${pad(m)}.${yearText(y)}`;
  }

  // Для чтения: свой календарь — с названием месяца («5 Снежень 313»).
  function format(cal, t) {
    if (t === null || t === undefined || !Number.isFinite(t)) return '';
    const months = customMonths(cal);
    if (!months) return formatInput(cal, t);
    const { d, m, y } = dayToDate(cal, t);
    return `${d} ${months[m - 1].name} ${y}`;
  }

  const norm = (s) => String(s || '').trim().toLowerCase().replace(/ё/g, 'е');

  // Номер месяца по названию: полное совпадение или однозначное начало
  // (от трёх букв).
  function monthByName(months, text) {
    const q = norm(text);
    if (!q) return 0;
    const exact = months.findIndex((mo) => norm(mo.name) === q);
    if (exact !== -1) return exact + 1;
    if (q.length < 3) return 0;
    const found = months.map((mo, i) => (norm(mo.name).startsWith(q) ? i + 1 : 0)).filter(Boolean);
    return found.length === 1 ? found[0] : 0;
  }

  // «дд.мм.гг», «5 Снежень 313» (свой календарь) или просто год — первый
  // день года; null — не разобрали (или нет такого дня: 31.02 и т. п.).
  function parse(cal, str) {
    const s = String(str || '').trim();
    const months = customMonths(cal);
    let d = 1; let m = 1; let y;
    const full = s.match(/^(\d{1,4})[./-](\d{1,2})[./-](-?\d{1,6})$/);
    const named = months && s.match(/^(\d{1,4})\s+(.+?)\s+(-?\d{1,6})$/);
    if (full) { d = +full[1]; m = +full[2]; y = +full[3]; }
    else if (named) { d = +named[1]; m = monthByName(months, named[2]); y = +named[3]; }
    else if (/^-?\d{1,6}$/.test(s)) y = +s;
    else return null;
    if (m < 1 || m > monthCount(cal) || d < 1 || d > monthLength(cal, y, m)) return null;
    const t = dateToDay(cal, y, m, d);
    return Math.abs(t) <= TIME_LIMIT ? t : null;
  }

  // Подсказка для поля даты.
  function inputHint(cal) {
    const months = customMonths(cal);
    return months
      ? `Дата: дд.мм.гг или «5 ${months[0].name} 313» (можно просто год — будет 1-е число первого месяца)`
      : 'Дата: дд.мм.гг (можно просто год — будет 1 января)';
  }

  // ----- смена календаря -----

  // День в старом календаре → день с теми же числом, месяцем и годом в
  // новом. Месяца нет — последний месяц; числа нет — последний день месяца.
  function convert(t, fromCal, toCal) {
    if (t === null || t === undefined || !Number.isFinite(t)) return t;
    const { d, m, y } = dayToDate(fromCal, t);
    const m2 = Math.min(m, monthCount(toCal));
    const d2 = Math.min(d, monthLength(toCal, y, m2));
    return Math.max(-TIME_LIMIT, Math.min(TIME_LIMIT, dateToDay(toCal, y, m2, d2)));
  }

  // Все даты карты (зоны, версии границ, метки, события, фоны, шкала) через
  // fn. Меняет data на месте.
  function mapTimes(data, fn) {
    const iv = (o) => {
      if (!o || typeof o !== 'object') return;
      if ('from' in o) o.from = fn(o.from);
      if ('to' in o) o.to = fn(o.to);
    };
    (data.zones || []).forEach((z) => { iv(z); (z.shapes || []).forEach((sh) => { if (sh) sh.from = fn(sh.from); }); });
    ['markers', 'events', 'basemaps'].forEach((k) => (data[k] || []).forEach(iv));
    const tl = data.timeline;
    if (tl && typeof tl === 'object') {
      ['initial', 'start', 'end'].forEach((k) => { if (k in tl) tl[k] = fn(tl[k]); });
      (tl.periods || []).forEach(iv);
    }
    return data;
  }

  return {
    TIME_LIMIT,
    MAX_MONTHS,
    MAX_MONTH_DAYS,
    customMonths,
    signature,
    yearLength,
    dayToDate,
    dateToDay,
    monthCount,
    monthLength,
    format,
    formatInput,
    parse,
    inputHint,
    convert,
    mapTimes
  };
});
