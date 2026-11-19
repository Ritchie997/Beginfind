// src/services/article-search.js
// Модуль разбора поисковых запросов, проверки границ слов (Unicode),
// стемминга русского/английского языков, переключения раскладки клавиатуры
// и вычисления релевантности для витрины Antropedia и публичного каталога.

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Слова-исключения (стоп-слова/союзы/наречия русского языка).
 * Защищены от усечения стеммером (например, "поэтому" никогда не превратится в "поэт").
 */
const RUSSIAN_STOP_WORDS = new Set([
  'поэтому', 'потому', 'почему', 'зачем', 'откуда', 'куда', 'где', 'когда', 'как',
  'что', 'чтобы', 'если', 'хотя', 'будто', 'словно', 'точно',
  'или', 'либо', 'то', 'же', 'ли', 'бы', 'ведь', 'даже', 'лишь', 'только',
  'и', 'а', 'но', 'да', 'в', 'на', 'с', 'по', 'к', 'о', 'об', 'от', 'до', 'из', 'у', 'за', 'под', 'над', 'при'
]);

/**
 * Компактный стеммер русского языка (алгоритм Snowball / Портера).
 * Приводит словоформы (падежи, склонения) к единой основе без внешних зависимостей.
 *
 * @param {string} word
 * @returns {string}
 */
function stemRussian(word) {
  const w = word.toLowerCase();
  if (w.length <= 3 || RUSSIAN_STOP_WORDS.has(w)) return w;

  const VOWEL_RE = /[аеиоуыэюя]/;
  const m = w.search(VOWEL_RE);
  if (m === -1) return w;
  const start = w.slice(0, m + 1);
  let rv = w.slice(m + 1);

  // 1. Деепричастия (Perfective Gerund)
  const pf = /((?:ив|ивши|ившись|ыв|ывши|ывшись)|((?<=[ая])(в|вши|вшись)))$/;
  if (pf.test(rv)) {
    rv = rv.replace(pf, '');
  } else {
    // 2. Возвратные частицы (Reflexive)
    rv = rv.replace(/(с[яь])$/, '');

    // 3. Прилагательные и причастия (Adjective)
    const adj = /(ее|ие|ые|ое|ими|ыми|ей|ой|ем|им|ым|ом|его|ого|ему|ому|их|ых|ую|юю|ая|яя|ою|ею)$/;
    const part1 = /(?<=[ая])(ем|нн|вш|ющ|щ)$/;
    const part2 = /(ивш|ывш|ующ)$/;
    if (adj.test(rv)) {
      rv = rv.replace(adj, '');
      if (part1.test(rv)) rv = rv.replace(part1, '');
      else if (part2.test(rv)) rv = rv.replace(part2, '');
    } else {
      // 4. Глаголы (Verb)
      const verb = /((?:ила|ыла|ена|ейте|уйте|ите|или|ыли|ей|уй|ил|ыл|им|ым|ен|ило|ыло|ено|ят|ует|уют|ит|ыт|ены|ить|ыть|ишь|ую|ю)|((?<=[ая])(ла|на|ете|йте|ли|й|л|ем|н|ло|но|ет|ют|ны|ть|ешь|нно)))$/;
      if (verb.test(rv)) {
        rv = rv.replace(verb, '');
      } else {
        // 5. Существительные (Noun)
        const noun = /(а|ев|ов|ие|ье|е|иями|ями|ами|еи|ии|и|ией|ей|ой|ем|ям|ом|ам|ах|ях|ы|ь|ию|ью|ю|у|о|я)$/;
        rv = rv.replace(noun, '');
      }
    }
  }

  // 6. Снятие 'и', суффиксов и мягких знаков
  rv = rv.replace(/и$/, '');
  rv = rv.replace(/ост$/, '');
  rv = rv.replace(/(ейш|ейше)$/, '');
  rv = rv.replace(/нн$/, 'н');
  rv = rv.replace(/ь$/, '');

  return start + rv;
}

/**
 * Легковесный стеммер английского языка (множественное число, ing/ed).
 */
function stemEnglish(word) {
  const w = word.toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('es') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  return w;
}

/**
 * Приводит отдельное слово к основе (русский/английский).
 */
function stemWord(word) {
  const w = String(word || '').trim().toLowerCase();
  if (!w) return '';
  if (/[а-яё]/.test(w)) return stemRussian(w);
  return stemEnglish(w);
}

// Таблица переключения раскладки QWERTY <-> ЙЦУКЕН
const EN_TO_RU = {
  q:'й', w:'ц', e:'у', r:'к', t:'е', y:'н', u:'г', i:'ш', o:'щ', p:'з', '[':'х', ']':'ъ',
  a:'ф', s:'ы', d:'в', f:'а', g:'п', h:'р', j:'о', k:'л', l:'д', ';':'ж', "'":'э',
  z:'я', x:'ч', c:'с', v:'м', b:'и', n:'т', m:'ь', ',':'б', '.':'ю',
  Q:'Й', W:'Ц', E:'У', R:'К', T:'Е', Y:'Н', U:'Г', I:'Ш', O:'Щ', P:'З', '{':'Х', '}':'Ъ',
  A:'Ф', S:'Ы', D:'В', F:'А', G:'П', H:'Р', J:'О', K:'Л', L:'Д', ':':'Ж', '"':'Э',
  Z:'Я', X:'Ч', C:'С', V:'М', B:'И', N:'Т', M:'Ь', '<':'Б', '>':'Ю'
};
const RU_TO_EN = Object.fromEntries(Object.entries(EN_TO_RU).map(([en, ru]) => [ru, en]));

/**
 * Исправляет раскладку клавиатуры (например: "Gj'n" -> "Поэт", "руддщ" -> "hello").
 */
function switchKeyboardLayout(text) {
  if (!text) return '';
  return text.split('').map((c) => EN_TO_RU[c] || RU_TO_EN[c] || c).join('');
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
 * Извлекает все слова из текста.
 */
function extractWords(text) {
  if (!text) return [];
  return String(text).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
}

/**
 * Возвращает Set основ (стемм) всех слов текста.
 */
function extractStemsSet(text) {
  return new Set(extractWords(text).map(stemWord));
}

/**
 * Внутренний парсер компонентов запроса.
 */
function parseSearchQueryInternal(rawQuery) {
  const raw = String(rawQuery || '').trim();
  if (!raw) {
    return {
      raw: '',
      exactPhrases: [],
      authorTerms: [],
      hashKeys: [],
      textWords: [],
      textStems: [],
      hasCriteria: false,
      hasTextCriteria: false,
      cleanTextQuery: ''
    };
  }

  // Приводим все виды кавычек («», “”, „“, ‟, ‘’, ‚‛) к стандартным "
  let working = raw
    .replace(/[«»“”„‟‘’‚‛]/g, '"')
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

  const textStems = textWords.map(stemWord);
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
    textStems,
    hasCriteria,
    hasTextCriteria,
    cleanTextQuery
  };
}

/**
 * Разбирает поисковый запрос q на компоненты с поддержкой альтернативной раскладки.
 *
 * @param {string} rawQuery
 * @returns {ReturnType<typeof parseSearchQueryInternal> & { layoutAlternative: ReturnType<typeof parseSearchQueryInternal>|null }}
 */
function parseSearchQuery(rawQuery) {
  const primary = parseSearchQueryInternal(rawQuery);
  if (!primary.raw) {
    return { ...primary, layoutAlternative: null };
  }

  const swapped = switchKeyboardLayout(primary.raw);
  const layoutAlternative = (swapped && swapped !== primary.raw)
    ? parseSearchQueryInternal(swapped)
    : null;

  return {
    ...primary,
    layoutAlternative
  };
}

/**
 * Проверяет, удовлетворяет ли текст всем текстовым критериям запроса (AND логика)
 * с учетом точных фраз и стемминга.
 *
 * @param {string} text
 * @param {ReturnType<typeof parseSearchQuery>} parsedQuery
 * @returns {boolean}
 */
function matchesAllTerms(text, parsedQuery) {
  if (!parsedQuery.hasTextCriteria) return true;
  if (!text) return false;

  // 1. Точные фразы в кавычках должны быть строго на границах слов
  for (const phrase of parsedQuery.exactPhrases) {
    if (!testWordBoundary(text, phrase)) return false;
  }

  // 2. Свободные слова: проверяем точное совпадение или стемминг
  if (parsedQuery.textWords.length > 0) {
    const stems = extractStemsSet(text);
    for (let i = 0; i < parsedQuery.textWords.length; i++) {
      const word = parsedQuery.textWords[i];
      const stem = parsedQuery.textStems[i];
      const matchExact = testWordBoundary(text, word);
      const matchStem = stems.has(stem);
      if (!matchExact && !matchStem) return false;
    }
  }

  return true;
}

/**
 * Вычисляет балл релевантности для одного набора параметров запроса.
 */
function computeScore(title, content, parsed) {
  if (!parsed.hasTextCriteria) return 1;

  const titleStr = String(title || '').trim();
  const titleLower = titleStr.toLowerCase();
  const cleanQuery = parsed.cleanTextQuery.toLowerCase().replace(/"/g, '');

  // 1. Абсолютное точное совпадение всего заголовка
  if (cleanQuery && titleLower === cleanQuery) {
    return 100;
  }

  const fullText = `${titleStr}\n\n${content || ''}`;

  // 2. Если заданы фразы в кавычках — они ОБЯЗАНЫ быть строго на границах слов
  if (parsed.exactPhrases.length > 0) {
    for (const phrase of parsed.exactPhrases) {
      if (!testWordBoundary(fullText, phrase)) {
        return 0;
      }
    }
  }

  const allWords = parsed.textWords;
  const allStems = parsed.textStems;

  // Если были только фразы в кавычках и они совпали
  if (allWords.length === 0 && parsed.exactPhrases.length > 0) {
    return 80;
  }

  const titleWords = extractWords(titleStr);
  const titleStems = new Set(titleWords.map(stemWord));

  // 3. Все слова найдены в заголовке
  const titleMatchesExact = allWords.every((w) => testWordBoundary(titleStr, w));
  if (titleMatchesExact) {
    return 85;
  }
  const titleMatchesStem = allStems.every((s) => titleStems.has(s));
  if (titleMatchesStem) {
    return 75;
  }

  // 4. Комбинированная проверка (заголовок + тело)
  const fullWords = extractWords(fullText);
  const fullStems = new Set(fullWords.map(stemWord));

  const allInFullStems = allStems.every((s) => fullStems.has(s));
  if (allInFullStems) {
    const someInTitle = allStems.some((s) => titleStems.has(s));
    if (someInTitle) {
      return 60;
    }
    const allExactInContent = allWords.every((w) => testWordBoundary(fullText, w));
    return allExactInContent ? 50 : 40;
  }

  // 5. Мягкий фолбэк по префиксу заголовка (только если нет кавычек)
  if (parsed.exactPhrases.length === 0 && cleanQuery && cleanQuery.length >= 3) {
    if (testWordBoundary(titleStr, cleanQuery, { prefix: true })) {
      return 20;
    }
  }

  return 0;
}

/**
 * Вычисляет балл релевантности статьи на основе заголовка и содержимого
 * с поддержкой стемминга и альтернативной раскладки клавиатуры.
 *
 * @param {string} title
 * @param {string} content
 * @param {ReturnType<typeof parseSearchQuery>} parsedQuery
 * @returns {number} 0 если не подходит, >0 балл релевантности
 */
function scoreArticleText(title, content, parsedQuery) {
  if (!parsedQuery.hasTextCriteria) return 1;

  // Сначала проверяем основной запрос
  const primaryScore = computeScore(title, content, parsedQuery);
  if (primaryScore > 0) {
    return primaryScore;
  }

  // Если совпадений нет, но доступен вариант в альтернативной раскладке (например, Gj'n -> Поэт)
  if (parsedQuery.layoutAlternative && parsedQuery.layoutAlternative.hasTextCriteria) {
    const altScore = computeScore(title, content, parsedQuery.layoutAlternative);
    if (altScore > 0) {
      // Даем 90% от балла за автоисправление раскладки
      return Math.round(altScore * 0.9);
    }
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
  stemWord,
  stemRussian,
  stemEnglish,
  switchKeyboardLayout,
  makeWordRegex,
  testWordBoundary,
  extractWords,
  extractStemsSet,
  parseSearchQuery,
  matchesAllTerms,
  scoreArticleText,
  textContainsAuthorMention,
  RUSSIAN_STOP_WORDS
};
