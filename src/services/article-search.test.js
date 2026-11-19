// src/services/article-search.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const search = require('./article-search');

test('parseSearchQuery: basic parsing of words, quotes, hashtags, and authors', () => {
  const query = '@Поэт "Белое Древо" #персонажи эльфы «Тайный Орден» @[Иван Иванов]';
  const parsed = search.parseSearchQuery(query);

  assert.deepEqual(parsed.exactPhrases, ['белое древо', 'тайный орден']);
  assert.deepEqual(parsed.authorTerms, ['поэт', 'иван иванов']);
  assert.deepEqual(parsed.hashKeys, ['персонажи']);
  assert.deepEqual(parsed.textWords, ['эльфы']);
  assert.equal(parsed.hasCriteria, true);
  assert.equal(parsed.hasTextCriteria, true);
});

test('parseSearchQuery: empty and whitespace query', () => {
  const parsed = search.parseSearchQuery('   ');
  assert.equal(parsed.hasCriteria, false);
  assert.equal(parsed.hasTextCriteria, false);
  assert.deepEqual(parsed.textWords, []);
  assert.deepEqual(parsed.exactPhrases, []);
});

test('testWordBoundary: Unicode boundaries for Russian words ("поэт" vs "поэтому")', () => {
  assert.equal(search.testWordBoundary('Поэт пришел в замок', 'поэт'), true);
  assert.equal(search.testWordBoundary('О, великий Поэт!', 'поэт'), true);
  assert.equal(search.testWordBoundary('«Поэт» — псевдоним автора', 'поэт'), true);
  assert.equal(search.testWordBoundary('(Поэт)', 'поэт'), true);

  // Самое главное: "поэтому" НЕ должно матчиться при поиске "поэт"!
  assert.equal(search.testWordBoundary('Мы решили пойти, поэтому взяли факелы', 'поэт'), false);
  assert.equal(search.testWordBoundary('Поэтичный вечер', 'поэт'), false);
  assert.equal(search.testWordBoundary('Гипоэтес цветет весной', 'поэт'), false);
});

test('testWordBoundary: exact multi-word phrase matching', () => {
  assert.equal(search.testWordBoundary('В центре стоит Белое Древо Гондора', 'белое древо'), true);
  assert.equal(search.testWordBoundary('Белое   древо', 'белое древо'), true);
  assert.equal(search.testWordBoundary('Белое древовидное растение', 'белое древо'), false);
});

test('scoreArticleText: exact title match gets highest score', () => {
  const parsed = search.parseSearchQuery('Поэт');
  const scoreExact = search.scoreArticleText('Поэт', 'Текст статьи...', parsed);
  const scoreInTitle = search.scoreArticleText('Великий Поэт Серебряного Века', 'Текст статьи...', parsed);
  const scoreInContent = search.scoreArticleText('Биография', 'Там жил Поэт, пишущий стихи.', parsed);
  const scoreNoMatch = search.scoreArticleText('Магия', 'И поэтому мы пошли домой.', parsed);

  assert.equal(scoreExact, 100);
  assert.equal(scoreInTitle, 85);
  assert.ok(scoreInContent > 0);
  assert.equal(scoreNoMatch, 0);
});

test('scoreArticleText: exact quotes «Поэт» or "Поэт" strictly do not match "поэтому" anywhere', () => {
  for (const qStr of ['«Поэт»', '"Поэт"', '“Поэт”']) {
    const parsed = search.parseSearchQuery(qStr);
    assert.deepEqual(parsed.exactPhrases, ['поэт']);

    // Заголовок или контент содержит "поэтому" — не должно матчиться!
    const scoreTitlePoetomu = search.scoreArticleText('Поэтому мир так устроен', 'Текст...', parsed);
    const scoreContentPoetomu = search.scoreArticleText('Заметки', 'И поэтому мы ушли.', parsed);
    assert.equal(scoreTitlePoetomu, 0, `Title with 'поэтому' must not match ${qStr}`);
    assert.equal(scoreContentPoetomu, 0, `Content with 'поэтому' must not match ${qStr}`);

    // Реальный поэт — должно матчиться
    const scoreMatch = search.scoreArticleText('Биография', 'Великий Поэт написал стих.', parsed);
    assert.ok(scoreMatch > 0, `Article with 'Поэт' must match ${qStr}`);
  }
});

test('scoreArticleText: multiple words must all match (AND logic)', () => {
  const parsed = search.parseSearchQuery('эльфы горы');
  const matchBoth = search.scoreArticleText('История: эльфы', 'Они покоряли горы.', parsed);
  const matchOneOnly = search.scoreArticleText('История: эльфы', 'Они покоряли леса.', parsed);

  assert.ok(matchBoth > 0);
  assert.equal(matchOneOnly, 0);
});

test('textContainsAuthorMention: finds @name and @[name]', () => {
  assert.equal(search.textContainsAuthorMention('Автор главы: @Поэт.', 'поэт'), true);
  assert.equal(search.textContainsAuthorMention('Спасибо @[Иван Иванов] за помощь!', 'иван иванов'), true);
  assert.equal(search.textContainsAuthorMention('Никаких упоминаний здесь нет.', 'поэт'), false);
});

test('publicArticles integration: searching "Поэт" does not match article with "поэтому"', () => {
  const publicArticles = require('./public-articles');
  const mockArticles = [
    {
      slug: 'poet-bio',
      title: 'Поэт',
      created_at: '2026-01-01',
      layers: [
        {
          title: 'Поэт',
          content: {
            blocks: [{ type: 'paragraph', data: { markdown: 'Биография известного поэта.' } }]
          }
        }
      ]
    },
    {
      slug: 'logic-article',
      title: 'Логика и рассуждения',
      created_at: '2026-01-02',
      layers: [
        {
          title: 'Логика и рассуждения',
          content: {
            blocks: [{ type: 'paragraph', data: { markdown: 'У нас было мало времени, поэтому мы поспешили.' } }]
          }
        }
      ]
    }
  ];

  const result = publicArticles.listPublicArticles(mockArticles, { q: 'Поэт' });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].slug, 'poet-bio');
});

test('stemWord: Russian noun inflections reduce to base stem', () => {
  const poetForms = ['поэт', 'поэта', 'поэту', 'поэтом', 'поэте', 'поэты', 'поэтов', 'поэтам', 'поэтами', 'поэтах'];
  for (const form of poetForms) {
    assert.equal(search.stemWord(form), 'поэт', `Form '${form}' must stem to 'поэт'`);
  }

  // Защита стоп-слов: поэтому НЕ превращается в поэт!
  assert.equal(search.stemWord('поэтому'), 'поэтому');
  assert.notEqual(search.stemWord('поэтому'), 'поэт');

  // Другие склонения
  assert.equal(search.stemWord('эльфы'), 'эльф');
  assert.equal(search.stemWord('эльфов'), 'эльф');
  assert.equal(search.stemWord('горы'), 'гор');
  assert.equal(search.stemWord('горах'), 'гор');
});

test('scoreArticleText: unquoted query finds inflected forms (stemming)', () => {
  const parsed = search.parseSearchQuery('эльфы горы');
  // "эльфов" и "горах" — падежные формы "эльфы" и "горы"
  const scoreInflected = search.scoreArticleText('История эльфов', 'Они жили в высоких горах.', parsed);
  assert.ok(scoreInflected > 0, 'Must match inflected forms via stemming');

  // Кавычки "эльфы" требуют точную форму и не должны матчить только "эльфов"
  const parsedExact = search.parseSearchQuery('"эльфы"');
  const scoreExactFail = search.scoreArticleText('Заметки', 'Здесь упоминались эльфов.', parsedExact);
  assert.equal(scoreExactFail, 0, 'Exact phrase in quotes must not match inflected suffix');
});

test('switchKeyboardLayout: corrects mistyped keyboard layout', () => {
  assert.equal(search.switchKeyboardLayout("Gj'n"), 'Поэт');
  assert.equal(search.switchKeyboardLayout('ghbdtn'), 'привет');
  assert.equal(search.switchKeyboardLayout('руддщ'), 'hello');
});

test('scoreArticleText: automatic fallback to swapped layout (Gj\'n -> Поэт)', () => {
  // Пользователь забыл переключить раскладку и ввел "Gj'n"
  const parsed = search.parseSearchQuery("Gj'n");
  assert.ok(parsed.layoutAlternative);
  assert.deepEqual(parsed.layoutAlternative.textWords, ['поэт']);

  const score = search.scoreArticleText('Поэт', 'Биография великого поэта.', parsed);
  assert.ok(score > 0, 'Should find article using layout alternative');
});

test('parseSearchQuery: author queries with spaces, quotes, and brackets', () => {
  // 1. Одиночный автор без кавычек: @Качуа
  const p1 = search.parseSearchQuery('@Качуа');
  assert.deepEqual(p1.authorTerms, ['качуа']);
  assert.deepEqual(p1.textWords, []);

  // 2. Автор с пробелами в нике без кавычек: @Corepse Kodai
  const p2 = search.parseSearchQuery('@Corepse Kodai');
  assert.deepEqual(p2.authorTerms, ['corepse kodai']);
  assert.deepEqual(p2.textWords, []);

  // 3. Автор с пробелами в двойных кавычках: @"Corepse Kodai"
  const p3 = search.parseSearchQuery('@"Corepse Kodai"');
  assert.deepEqual(p3.authorTerms, ['corepse kodai']);
  assert.deepEqual(p3.textWords, []);

  // 4. Автор с пробелами в квадратных скобках: @[Corepse Kodai]
  const p4 = search.parseSearchQuery('@[Corepse Kodai]');
  assert.deepEqual(p4.authorTerms, ['corepse kodai']);
  assert.deepEqual(p4.textWords, []);

  // 5. Автор с пробелами + ключевое слово: @Corepse Kodai война
  const p5 = search.parseSearchQuery('@Corepse Kodai война');
  assert.deepEqual(p5.authorTerms, ['corepse kodai']);
  assert.deepEqual(p5.textWords, ['война']);
});
