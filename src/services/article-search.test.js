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
  assert.equal(scoreInTitle, 80);
  assert.equal(scoreInContent, 40);
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
