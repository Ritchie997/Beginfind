// src/services/article-search.js
// Модуль разбора поисковых запросов, проверки границ слов (Unicode)
// и вычисления релевантности для витрины Antropedia и публичного каталога.

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Строит регулярное выражение с Unicode-границами слов (\p{L}\p{N}_).
 * Решает проблему ложных совпадений (например, "поэт" не должен находить "поэтому").
 *
 * @param {string} term Искомое слово или фраза
 * @param {Object} [options]
 * @param {boolean} [options.prefix=false] Если true, граница проверяется только в начале
 * @returns {RegExp|null}
 */
function makeWordRegex(term, { prefix = false } = {}) {
  const parts = String(term || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const pattern = parts.map(escapeRegex).join('\\s+');
  const endBoundary = prefix ? '' : '([^\\p{L}\\p{N}_]|$)';
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${pattern}${endBoundary}`, 'iu');
}

/**
 * Проверяет наличие слова/фразы в тексте с соблюдением границ слов.
 */
function testWordBoundary(text, term, options = {}) {
  if (!text || !term) return false;
  const re = makeWordRegex(term, options);
  return re ? re.test(text) : false;
}

/**
 * Разбирает поисковый запрос q на компоненты:
 * - фразы в кавычках ("точная фраза", «русские кавычки», “английские”)
 * - упоминания авторов (@username, @[Имя Фамилия])
 * - хэштеги (#тег)
 * - обычные текстовые слова
 *
 * @param {string} rawQuery
 * @returns {{
 *   raw: string,
 *   exactPhrases: string[],
 *   authorTerms: string[],
 *   hashKeys: string[],
 *   textWords: string[],
 *   hasCriteria: boolean,
 *   hasTextCriteria: boolean,
 *   cleanTextQuery: string
 * }}
 */
function parseSearchQuery(rawQuery) {
  const raw = String(rawQuery || '').trim();
  if (!raw) {
    return {
      raw: '',
      exactPhrases: [],
      authorTerms: [],
      hashKeys: [],
      textWords: [],
      hasCriteria: false,
      hasTextCriteria: false,
      cleanTextQuery: ''
    };
  }

  // Приводим все виды кавычек («», “”, „“) к стандартным "
  let working = raw
    .replace(/[«»“”„]/g, '"')
    .slice(0, 300);

  const exactPhrases = [];
  const authorTerms = [];
  const hashKeys = [];
  const textWords = [];

  // 1. Извлекаем фразы в кавычках: "точная фраза"
  working = working.replace(/"([^"\n]+)"/g, (match, phrase) => {
    const trimmed = phrase.trim().toLowerCase();
    if (trimmed) exactPhrases.push(trimmed);
    return ' ';
  });

  // 2. Извлекаем авторов: @username или @[Имя с пробелами]
  working = working.replace(/(?:^|\s)@(?:\[([^\]\n]{1,64})\]|([\p{L}\p{N}_.-]{1,64}))/gu, (match, bracketed, simple) => {
    const name = (bracketed || simple || '').trim().toLowerCase();
    if (name) authorTerms.push(name);
    return ' ';
  });

  // 3. Извлекаем хэштеги: #тег
  working = working.replace(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu, (match, tag) => {
    const key = tag.trim().toLowerCase();
    if (key) hashKeys.push(key);
    return ' ';
  });

  // 4. Оставшиеся слова — свободный текст
  const words = working.split(/\s+/).map((w) => w.trim().toLowerCase()).filter(Boolean);
  words.forEach((w) => textWords.push(w));

  const hasTextCriteria = exactPhrases.length > 0 || textWords.length > 0;
  const hasCriteria = hasTextCriteria || authorTerms.length > 0 || hashKeys.length > 0;

  // Текстовая строка для обратной совместимости
  const cleanParts = [
    ...exactPhrases.map((p) => `"${p}"`),
    ...textWords
  ];
  const cleanTextQuery = cleanParts.join(' ');

  return {
    raw,
    exactPhrases,
    authorTerms,
    hashKeys,
    textWords,
    hasCriteria,
    hasTextCriteria,
    cleanTextQuery
  };
}

/**
 * Проверяет, удовлетворяет ли текст всем текстовым критериям запроса (AND логика).
 * Каждое слово и каждая точная фраза должны присутствовать с соблюдением границ слов.
 *
 * @param {string} text
 * @param {ReturnType<typeof parseSearchQuery>} parsedQuery
 * @returns {boolean}
 */
function matchesAllTerms(text, parsedQuery) {
  if (!parsedQuery.hasTextCriteria) return true;
  if (!text) return false;

  for (const phrase of parsedQuery.exactPhrases) {
    if (!testWordBoundary(text, phrase)) return false;
  }
  for (const word of parsedQuery.textWords) {
    if (!testWordBoundary(text, word)) return false;
  }
  return true;
}

/**
 * Вычисляет балл релевантности статьи на основе заголовка и содержимого.
 *
 * Шкала:
 * - 100: Полное совпадение заголовка с запросом (title === query).
 * - 80:  Заголовок содержит ВСЕ искомые термины на границах слов.
 * - 60:  Заголовок содержит хотя бы один термин, а остальные — в тексте.
 * - 40:  Текст содержит ВСЕ искомые термины на границах слов.
 * - 20:  Заголовок содержит подстроку (мягкий фолбэк для префиксов в заголовке).
 * - 0:   Статья не подходит.
 *
 * @param {string} title
 * @param {string} content
 * @param {ReturnType<typeof parseSearchQuery>} parsedQuery
 * @returns {number} 0 если не подходит, >0 балл релевантности
 */
function scoreArticleText(title, content, parsedQuery) {
  if (!parsedQuery.hasTextCriteria) return 1; // Без текстового фильтра совпадение базовое
  const titleStr = String(title || '').trim();
  const titleLower = titleStr.toLowerCase();
  const cleanQuery = parsedQuery.cleanTextQuery.toLowerCase().replace(/"/g, '');

  // 1. Точное совпадение всего заголовка
  if (cleanQuery && titleLower === cleanQuery) {
    return 100;
  }

  const allTerms = [...parsedQuery.exactPhrases, ...parsedQuery.textWords];
  if (!allTerms.length) return 1;

  // 2. Все термины найдены в самом заголовке с границами слов
  const allInTitle = allTerms.every((term) => testWordBoundary(titleStr, term));
  if (allInTitle) {
    return 80;
  }

  // 3. Комбинированная проверка (заголовок + тело)
  const fullText = `${titleStr}\n\n${content || ''}`;
  const allInFullText = allTerms.every((term) => testWordBoundary(fullText, term));
  if (allInFullText) {
    // Если часть терминов в заголовке — даем повышенный балл
    const someInTitle = allTerms.some((term) => testWordBoundary(titleStr, term));
    return someInTitle ? 60 : 40;
  }

  // 4. Мягкий фолбэк: если пользователь искал по префиксу заголовка (например, "Арагор" в "Арагорн")
  if (cleanQuery && cleanQuery.length >= 3 && titleLower.includes(cleanQuery)) {
    return 20;
  }

  return 0;
}

/**
 * Проверяет, упоминается ли автор в тексте статьи (синтаксис @Имя или @[Имя Фамилия]).
 */
function textContainsAuthorMention(text, authorTerm) {
  if (!text || !authorTerm) return false;
  const escaped = escapeRegex(authorTerm);
  const re = new RegExp(
    `(^|[^\\p{L}\\p{N}_])@(?:\\[[^\\]\\n]*${escaped}[^\\]\\n]*\\]|[\\p{L}\\p{N}_.-]*${escaped}[\\p{L}\\p{N}_.-]*)`,
    'iu'
  );
  return re.test(text);
}

module.exports = {
  escapeRegex,
  makeWordRegex,
  testWordBoundary,
  parseSearchQuery,
  matchesAllTerms,
  scoreArticleText,
  textContainsAuthorMention
};
