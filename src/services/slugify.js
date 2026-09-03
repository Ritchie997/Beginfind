// slugify.js — превращает заголовок статьи (в т.ч. кириллический) в
// безопасное имя файла/идентификатор для wiki-ссылок ([[slug]]).

// Простая таблица транслитерации кириллицы в латиницу (RU -> EN)
const RU_TO_LAT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
};

function transliterate(text) {
  return text
    .split('')
    .map((ch) => {
      const lower = ch.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(RU_TO_LAT, lower)) {
        const replacement = RU_TO_LAT[lower];
        // Сохраняем регистр первой буквы для красоты не будем — slug всё равно lower-case ниже
        return replacement;
      }
      return ch;
    })
    .join('');
}

/**
 * Превращает произвольную строку (заголовок статьи) в slug: строчные латинские
 * буквы, цифры и дефисы. Используется и как имя файла (<slug>.md), и как
 * идентификатор для wiki-ссылок [[slug]].
 */
function slugify(text) {
  const transliterated = transliterate(String(text || ''));
  return transliterated
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-') // всё, что не буква/цифра — в дефис
    .replace(/^-+|-+$/g, '')     // обрезаем дефисы по краям
    .replace(/-{2,}/g, '-')      // схлопываем повторяющиеся дефисы
    .slice(0, 80) || 'article';  // не даём получить пустую строку
}

module.exports = { slugify };
