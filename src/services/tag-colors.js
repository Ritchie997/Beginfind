// tag-colors.js — цвет тега: один цвет на тег во всей системе (граф связей,
// вкладка "Теги"). Хранится в articles.db (таблица tag_colors), а не в файлах
// статей: цвет принадлежит ТЕГУ, а не статье — все статьи с тем же тегом
// показывают один и тот же цвет.
//
// Правило выдачи: тег, встретившийся первым ("тег-родитель"), получает
// случайный цвет и сохраняет его; любые последующие теги с тем же названием
// получают уже выданный цвет (см. ensureColors). Существующим тегам цвет
// выдаётся так же — при первом обращении к списку тегов/графу или при
// сохранении статьи. Сменить цвет тега на собственный можно во вкладке "Теги"
// (setColor).
//
// Название тега сравнивается без учёта регистра и без ведущего "#" — та же
// нормализация, что и в articles-store.collectTags (tagKey).

const { articlesDb } = require('../db/connections');

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    articlesDb.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    articlesDb.run(sql, params, function (err) { if (err) reject(err); else resolve(this); });
  });
}

// --- цвет: HSL <-> hex, чтобы случайные цвета были яркими и читались на тёмной теме ---

function hslToHex(h, s, l) {
  const sat = s / 100;
  const light = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function hexToHue(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Случайный цвет для нового тега. Из нескольких случайных кандидатов берётся
 * тот, чей оттенок дальше всего от уже выданных, — цвет остаётся случайным, но
 * два новых тега подряд реже получают почти одинаковый оттенок.
 * @param {string[]} takenColors — уже выданные цвета (#rrggbb)
 */
function randomTagColor(takenColors = []) {
  const takenHues = takenColors.filter((c) => HEX_RE.test(c)).map(hexToHue);
  let best = null;
  let bestScore = -1;
  for (let i = 0; i < 8; i++) {
    const hue = Math.floor(Math.random() * 360);
    const score = takenHues.length ? Math.min(...takenHues.map((h) => hueDistance(h, hue))) : 360;
    if (score > bestScore) { bestScore = score; best = hue; }
  }
  return hslToHex(best, 65 + Math.floor(Math.random() * 15), 55 + Math.floor(Math.random() * 8));
}

/**
 * Гарантирует цвет каждому переданному тегу и возвращает Map(ключ -> {name, color}).
 * Существующий цвет не меняется; отсутствующий выдаётся случайно и сохраняется
 * (INSERT OR IGNORE + повторное чтение — если параллельный запрос выдал цвет
 * тому же тегу первым, побеждает он, и оба увидят один и тот же цвет).
 * @param {{key: string, name: string}[]} tags — key уже нормализован (tagKey)
 */
async function ensureColors(tags) {
  const wanted = new Map();
  (tags || []).forEach((t) => { if (t && t.key && !wanted.has(t.key)) wanted.set(t.key, t.name || t.key); });
  if (!wanted.size) return new Map();

  let rows = await all('SELECT tag_key, tag_name, color FROM tag_colors');
  const known = new Map(rows.map((r) => [r.tag_key, r]));
  const missing = [...wanted.keys()].filter((k) => !known.has(k));

  if (missing.length) {
    const taken = rows.map((r) => r.color);
    for (const key of missing) {
      const color = randomTagColor(taken);
      taken.push(color);
      await run('INSERT OR IGNORE INTO tag_colors (tag_key, tag_name, color) VALUES (?, ?, ?)', [key, wanted.get(key), color]);
    }
    rows = await all('SELECT tag_key, tag_name, color FROM tag_colors');
  }

  const byKey = new Map(rows.map((r) => [r.tag_key, r]));
  const result = new Map();
  wanted.forEach((name, key) => {
    const row = byKey.get(key);
    if (row) result.set(key, { name: row.tag_name || name, color: row.color });
  });
  return result;
}

/**
 * Задать тегу собственный цвет (#rrggbb). Строка создаётся, если у тега ещё
 * не было цвета.
 */
async function setColor(key, name, color) {
  if (!HEX_RE.test(String(color || ''))) throw new Error('Цвет должен быть в формате #rrggbb');
  const normalized = String(color).toLowerCase();
  await run(
    `INSERT INTO tag_colors (tag_key, tag_name, color) VALUES (?, ?, ?)
     ON CONFLICT(tag_key) DO UPDATE SET color = excluded.color, updated_at = CURRENT_TIMESTAMP`,
    [key, name || key, normalized]
  );
  return normalized;
}

module.exports = { HEX_RE, randomTagColor, ensureColors, setColor };
