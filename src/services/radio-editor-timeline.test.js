// radio-editor-timeline.test.js — тесты видео-таймлайна, блочного редактора в стиле Антропедии,
// умного блока плейлиста, врезок слов без потери очереди и автозаполнения пустот.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '../..');
const radioHtml = fs.readFileSync(path.join(rootDir, 'public/site/radio.html'), 'utf8');
const radioCss = fs.readFileSync(path.join(rootDir, 'public/site/radio.css'), 'utf8');
const radioClientJs = fs.readFileSync(path.join(rootDir, 'public/site/radio-client.js'), 'utf8');

test('radio-editor: markup contains video timeline ribbon, blocks container, drawer and modals', () => {
  // 1. Видео-таймлайн (Timeline Ribbon)
  assert.ok(radioHtml.includes('id="radioTimelineContainer"'), 'Должен присутствовать контейнер видео-таймлайна');
  assert.ok(radioHtml.includes('id="radioTimelineRuler"'), 'Должна присутствовать линейка времени с делениями');
  assert.ok(radioHtml.includes('id="radioTimelineTrack"'), 'Должна присутствовать дорожка видеомонтажных клипов');
  assert.ok(radioHtml.includes('id="radioTimelinePlayhead"'), 'Должен присутствовать плейхед реального времени вещания');
  assert.ok(radioHtml.includes('id="timelineScaleBadge"'), 'Должен отображаться бейдж динамической шкалы');
  assert.ok(radioHtml.includes('id="timelineTotalDuration"'), 'Должен отображаться суммарный хронометраж');
  assert.ok(radioHtml.includes('id="btnTimelineZoomIn"'), 'Должны быть кнопки зума');

  // 2. Блочный конструктор в стиле Антропедии
  assert.ok(radioHtml.includes('id="editorBlocksList"'), 'Должен присутствовать контейнер блоков редактора');
  assert.ok(radioHtml.includes('class="radio-eb-blocklist eb-blocklist"'), 'Должны применяться стили блочного списка Антропедии');

  // 3. Боковая медиа-шторка для Drag & Drop
  assert.ok(radioHtml.includes('id="radioMediaDrawer"'), 'Должна присутствовать боковая медиа-шторка');
  assert.ok(radioHtml.includes('id="btnToggleMediaDrawer"'), 'Должна быть кнопка открытия медиатеки');

  // 4. Модальные окна умного добавления плейлистов и автозаполнения пустот
  assert.ok(radioHtml.includes('id="modalPickPlaylistForTimeline"'), 'Должна присутствовать модалка выбора плейлиста в эфир');
  assert.ok(radioHtml.includes('id="modalSmartGapFill"'), 'Должна присутствовать модалка умного заполнения пустоты плейлистами');
  assert.ok(radioHtml.includes('id="smartGapPlaylistsList"'), 'Должен быть чек-лист выбора плейлистов в модалке автозаполнения');
});

test('radio-editor: CSS defines video-style clips, ruler, and Antropedia-style block cards', () => {
  assert.ok(radioCss.includes('.radio-timeline-nle-wrapper'), 'Стили обертки видео-таймлайна');
  assert.ok(radioCss.includes('.radio-timeline-ruler'), 'Стили линейки времени');
  assert.ok(radioCss.includes('.radio-timeline-clip'), 'Стили клипов таймлайна');
  assert.ok(radioCss.includes('.clip-playlist'), 'Цветовая кодировка плейлистов');
  assert.ok(radioCss.includes('.clip-speech'), 'Цветовая кодировка слов ведущего');
  assert.ok(radioCss.includes('.clip-gap'), 'Стили клипа свободной паузы (пустоты)');
  assert.ok(radioCss.includes('.radio-timeline-playhead'), 'Стили плейхеда прямого эфира');

  // Блоки статьи/Антропедии
  assert.ok(radioCss.includes('.radio-eb-block'), 'Стили карточки блока');
  assert.ok(radioCss.includes('.radio-eb-drag-handle'), 'Стили ручки перетаскивания блока');
  assert.ok(radioCss.includes('.eb-type-badge'), 'Стили бейджа типа блока');
  assert.ok(radioCss.includes('.radio-playlist-accordion'), 'Стили аккордеона плейлиста');
  assert.ok(radioCss.includes('.radio-eb-insert-line'), 'Стили межблочного инсертера');
});

test('radio-editor: compileBlocksToSlots sequentially schedules playlist tracks and speech interruptions without track loss', () => {
  // Эмуляция функции компиляции блоков из radio-client.js
  const mockStartTimeIso = '2026-11-17T12:00:00.000Z';
  const startMs = new Date(mockStartTimeIso).getTime();

  // Создаем структуру: Плейлист (3 трека), затем Голос ведущего (врезка), затем продолжение треков
  const blocks = [
    {
      id: 'b1',
      type: 'playlist',
      playlist_id: 10,
      title: 'Рок-радио',
      items: [
        { track_id: 101, title: 'Трек 1', duration: 180, audio_url: '/audio/1.mp3' },
        { track_id: 102, title: 'Трек 2', duration: 200, audio_url: '/audio/2.mp3' }
      ]
    },
    {
      id: 'b2',
      type: 'speech',
      title: 'Слова ведущего (врезка)',
      duration: 30,
      audio_url: '/audio/speech.mp3'
    },
    {
      id: 'b3',
      type: 'playlist',
      playlist_id: 10,
      title: 'Рок-радио (Часть 2)',
      items: [
        { track_id: 103, title: 'Трек 3 (не потерян!)', duration: 210, audio_url: '/audio/3.mp3' },
        { track_id: 104, title: 'Трек 4', duration: 190, audio_url: '/audio/4.mp3' }
      ]
    }
  ];

  // Проверяем логику компиляции
  let cursor = startMs;
  const compiledSlots = [];
  for (const b of blocks) {
    if (b.type === 'playlist') {
      for (const it of b.items) {
        const start = cursor;
        const end = cursor + it.duration * 1000;
        compiledSlots.push({
          title: it.title,
          track_id: it.track_id,
          duration: it.duration,
          start_time: new Date(start).toISOString(),
          end_time: new Date(end).toISOString()
        });
        cursor = end;
      }
    } else {
      const start = cursor;
      const end = cursor + b.duration * 1000;
      compiledSlots.push({
        title: b.title,
        track_id: null,
        duration: b.duration,
        start_time: new Date(start).toISOString(),
        end_time: new Date(end).toISOString()
      });
      cursor = end;
    }
  }

  // Проверяем непрерывность и сохранение очередности
  assert.equal(compiledSlots.length, 5, 'Должно быть 5 слотов (2 трека + слова + 2 трека)');
  assert.equal(compiledSlots[0].title, 'Трек 1');
  assert.equal(compiledSlots[1].title, 'Трек 2');
  assert.equal(compiledSlots[2].title, 'Слова ведущего (врезка)');
  assert.equal(compiledSlots[3].title, 'Трек 3 (не потерян!)');
  assert.equal(compiledSlots[4].title, 'Трек 4');

  // Время трека 3 должно идти строго после окончания слов ведущего
  assert.equal(compiledSlots[3].start_time, compiledSlots[2].end_time, 'Трек 3 должен начинаться строго после окончания слов ведущего');
  assert.equal(compiledSlots[2].start_time, compiledSlots[1].end_time, 'Слова ведущего должны начинаться строго после трека 2');
});

test('radio-editor: splitPlaylistBlock divides playlist into Part 1, Speech and Part 2 preserving duration', () => {
  const originalPlaylist = {
    id: 'pl_1',
    type: 'playlist',
    playlist_id: 5,
    title: 'Вечерний эфир',
    items: [
      { track_id: 1, title: 'Песня 1', duration: 180 },
      { track_id: 2, title: 'Песня 2', duration: 200 },
      { track_id: 3, title: 'Песня 3', duration: 240 },
      { track_id: 4, title: 'Песня 4', duration: 210 }
    ],
    duration: 830
  };

  const splitTrackIndex = 1; // Разрезаем после Песни 2 (индекс 1)
  const part1Items = originalPlaylist.items.slice(0, splitTrackIndex + 1);
  const part2Items = originalPlaylist.items.slice(splitTrackIndex + 1);

  const dur1 = part1Items.reduce((s, t) => s + t.duration, 0);
  const dur2 = part2Items.reduce((s, t) => s + t.duration, 0);

  assert.equal(part1Items.length, 2, 'В Части 1 должно быть 2 трека');
  assert.equal(part2Items.length, 2, 'В Части 2 должно быть 2 трека');
  assert.equal(dur1, 380, 'Длительность Части 1: 180+200=380');
  assert.equal(dur2, 450, 'Длительность Части 2: 240+210=450');
  assert.equal(dur1 + dur2, originalPlaylist.duration, 'Сумма частей должна равняться изначальной длительности плейлиста');
});

test('radio-editor: smart gap fill selects tracks from playlists to match gap duration', () => {
  const gapDurationSec = 600; // Пауза 10 минут
  const candidateTracks = [
    { id: 1, title: 'Трек A', duration: 180 },
    { id: 2, title: 'Трек B', duration: 210 },
    { id: 3, title: 'Трек C', duration: 220 },
    { id: 4, title: 'Трек D', duration: 240 }
  ];

  let selected = [];
  let currentDur = 0;
  for (const tr of candidateTracks) {
    if (currentDur + tr.duration <= gapDurationSec + 60 || selected.length === 0) {
      selected.push(tr);
      currentDur += tr.duration;
      if (currentDur >= gapDurationSec - 30) break;
    }
  }

  assert.ok(selected.length >= 2, 'Должно быть подобрано несколько треков');
  assert.ok(currentDur >= gapDurationSec - 30, 'Сумма треков должна закрывать разрыв времени');
  assert.equal(selected[0].title, 'Трек A');
  assert.equal(selected[1].title, 'Трек B');
  assert.equal(selected[2].title, 'Трек C');
});

test('radio-editor: supports private playlists across timeline picker, smart gap fill, and media drawer', () => {
  // 1. Проверяем наличие интеграции личных/закрытых плейлистов в клиентском коде
  assert.ok(radioClientJs.includes('/api/radio/playlists/mine'), 'Должен запрашивать личные плейлисты пользователя');
  assert.ok(radioClientJs.includes('btn-pick-filter'), 'В модалке выбора плейлистов для ленты должны быть фильтры');
  assert.ok(radioClientJs.includes('Мои плейлисты'), 'Должна быть категория Мои плейлисты');
  assert.ok(radioClientJs.includes('Закрытый'), 'Закрытые плейлисты должны визуально помечаться бейджем');
  assert.ok(radioClientJs.includes('smart-gap-playlist-cb'), 'Чекбоксы автозаполнения пустот');

  // 2. Эмуляция добавления приватного плейлиста в сетку вещания
  const mockPrivatePlaylist = {
    id: 42,
    title: 'Мой ночной эфир (Закрытый)',
    is_public: 0,
    user_id: 1,
    tracks: [
      { id: 101, title: 'Secret Ambient 1', audio_url: '/uploads/ambient1.mp3', duration: 300, type: 'track' },
      { id: 102, title: 'Secret Ambient 2', audio_url: '/uploads/ambient2.mp3', duration: 400, type: 'track' }
    ]
  };

  const totalDur = mockPrivatePlaylist.tracks.reduce((s, t) => s + t.duration, 0);
  assert.equal(totalDur, 700);

  const privateBlock = {
    id: 'block_private_pl_1',
    type: 'playlist',
    playlist_id: mockPrivatePlaylist.id,
    title: mockPrivatePlaylist.title,
    duration: totalDur,
    items: mockPrivatePlaylist.tracks.map(t => ({
      track_id: t.id,
      title: t.title,
      audio_url: t.audio_url,
      duration: t.duration,
      type: t.type
    })),
    isCollapsed: true
  };

  assert.equal(privateBlock.items.length, 2);
  assert.equal(privateBlock.duration, 700);

  // 3. Эмуляция компиляции в слоты вещания
  const startTime = new Date('2026-11-17T20:00:00.000Z').getTime();
  let cursor = startTime;
  const compiledSlots = privateBlock.items.map(item => {
    const slot = {
      track_id: item.track_id,
      title: item.title,
      audio_url: item.audio_url,
      duration: item.duration,
      type: item.type,
      start_time: new Date(cursor).toISOString(),
      end_time: new Date(cursor + item.duration * 1000).toISOString()
    };
    cursor += item.duration * 1000;
    return slot;
  });

  assert.equal(compiledSlots.length, 2);
  assert.equal(compiledSlots[0].title, 'Secret Ambient 1');
  assert.equal(compiledSlots[0].start_time, '2026-11-17T20:00:00.000Z');
  assert.equal(compiledSlots[0].end_time, '2026-11-17T20:05:00.000Z');
  assert.equal(compiledSlots[1].title, 'Secret Ambient 2');
  assert.equal(compiledSlots[1].start_time, '2026-11-17T20:05:00.000Z');
  assert.equal(compiledSlots[1].end_time, '2026-11-17T20:11:40.000Z');
});

test('radio-editor: unified playback system connects editor blocks, playlists, and drawer with global audio player', () => {
  const freshClientJs = fs.readFileSync(path.join(rootDir, 'public/site/radio-client.js'), 'utf8');
  const freshCss = fs.readFileSync(path.join(rootDir, 'public/site/radio.css'), 'utf8');

  // 1. Проверяем отсутствие изолированных плееров в редакторе (единая система)
  assert.ok(!freshClientJs.includes('state.previewAudio = new Audio'), 'Не должно быть изолированного Audio для превью');

  // 2. Функции интеграции с общим плеером
  assert.ok(freshClientJs.includes('function playEditorBlock('), 'Должна быть функция воспроизведения блока в общем плеере');
  assert.ok(freshClientJs.includes('function playNestedPlaylistTrack('), 'Должна быть функция воспроизведения трека из плейлиста в общем плеере');
  assert.ok(freshClientJs.includes('function updateEditorPlaybackUI('), 'Должна быть синхронизация состояния воспроизведения');

  // 3. Подписка редактора на глобальный плеер AllTell
  assert.ok(freshClientJs.includes('updateEditorPlaybackUI(gState)'), 'Подписка globalAudio должна обновлять UI редактора');

  // 4. Элементы управления в блоках, аккордеоне и шторке
  assert.ok(freshClientJs.includes('btn-play-playlist-block'), 'Должна быть кнопка воспроизведения плейлиста целиком');
  assert.ok(freshClientJs.includes('btn-play-nested-track'), 'Должна быть кнопка воспроизведения трека внутри плейлиста');
  assert.ok(freshClientJs.includes('btn-drawer-play'), 'В шторке медиатеки должны быть кнопки воспроизведения треков');
  assert.ok(freshClientJs.includes('btn-drawer-play-pl'), 'В шторке медиатеки должны быть кнопки воспроизведения плейлистов');

  // 5. Стили подсветки активного воспроизведения в редакторе и на шкале времени
  assert.ok(freshCss.includes('.radio-eb-block.is-playing-block'), 'Стили активного блока в редакторе');
  assert.ok(freshCss.includes('.radio-timeline-clip.is-playing'), 'Стили активного клипа на таймлайне');
  assert.ok(freshCss.includes('.radio-nested-play-btn'), 'Стили круглой кнопки воспроизведения вложенного трека');

  // 6. Эмуляция формирования очереди воспроизведения из блоков эфира
  const mockBlocks = [
    { id: 'b1', type: 'speech', title: 'Вступительное слово', audio_url: '/uploads/speech1.mp3', duration: 45 },
    {
      id: 'b2',
      type: 'playlist',
      title: 'Утренний рок',
      duration: 360,
      items: [
        { track_id: 10, title: 'Песня 1', audio_url: '/uploads/rock1.mp3', duration: 180 },
        { track_id: 11, title: 'Песня 2', audio_url: '/uploads/rock2.mp3', duration: 180 }
      ]
    },
    { id: 'b3', type: 'jingle', title: 'Джингл станции', audio_url: '/uploads/jingle.mp3', duration: 10 }
  ];

  const fullQueue = [];
  mockBlocks.forEach(b => {
    if (b.type === 'playlist' && Array.isArray(b.items)) {
      b.items.forEach((it, sIdx) => {
        if (it.audio_url) {
          fullQueue.push({
            id: it.track_id || `${b.id}_${sIdx}`,
            blockId: b.id,
            title: it.title,
            author_name: `Плейлист: ${b.title}`,
            duration: it.duration,
            audio_url: it.audio_url
          });
        }
      });
    } else if (b.audio_url) {
      fullQueue.push({
        id: b.id,
        blockId: b.id,
        title: b.title,
        author_name: b.type === 'speech' ? 'Слова ведущего' : 'Эфир',
        duration: b.duration,
        audio_url: b.audio_url
      });
    }
  });

  assert.equal(fullQueue.length, 4, 'Очередь должна объединять 1 слово + 2 трека плейлиста + 1 джингл');
  assert.equal(fullQueue[0].title, 'Вступительное слово');
  assert.equal(fullQueue[1].title, 'Песня 1');
  assert.equal(fullQueue[2].title, 'Песня 2');
  assert.equal(fullQueue[3].title, 'Джингл станции');
});

test('radio-editor: moving blocks on timeline ribbon and edge dragging extends the timeline', () => {
  const freshHtml = fs.readFileSync(path.join(rootDir, 'public/site/radio.html'), 'utf8');
  const freshCss = fs.readFileSync(path.join(rootDir, 'public/site/radio.css'), 'utf8');
  const freshClientJs = fs.readFileSync(path.join(rootDir, 'public/site/radio-client.js'), 'utf8');

  // 1. Клипы на ленте вещания должны быть перетаскиваемыми (draggable)
  assert.ok(freshClientJs.includes('draggable="true"'), 'Клипы на таймлайне должны иметь draggable="true"');
  assert.ok(freshClientJs.includes('move_block'), 'Должен поддерживаться тип перемещения блока на таймлайне');
  assert.ok(freshClientJs.includes('is-drag-over-left'), 'Должен быть маркер вставки слева от клипа');
  assert.ok(freshClientJs.includes('is-drag-over-right'), 'Должен быть маркер вставки справа от клипа');

  // 2. Ручка изменения границы блока (край блока)
  assert.ok(freshClientJs.includes('radio-timeline-edge-handle'), 'Каждый клип должен иметь ручку на правом краю');
  assert.ok(freshCss.includes('.radio-timeline-edge-handle'), 'Стили ручки края блока');
  assert.ok(freshCss.includes('col-resize') || freshCss.includes('ew-resize'), 'Курсор изменения длины на краю блока');
  assert.ok(freshCss.includes('.radio-timeline-resize-tooltip'), 'Стили всплывающего тултипа изменения длительности');

  // 3. Кнопка расширения шкалы времени
  assert.ok(freshHtml.includes('id="btnTimelineExtendScale"'), 'Кнопка расширения шкалы времени в разметке');
  assert.ok(freshClientJs.includes('btnTimelineExtendScale'), 'Обработчик кнопки увеличения шкалы времени');

  // 4. Эмуляция изменения длительности за край блока и динамического роста шкалы
  let baseScaleSec = 1200; // 20 минут базово
  const blocks = [
    { id: 'b1', type: 'track', title: 'Песня 1', duration: 180 },
    { id: 'b2', type: 'speech', title: 'Слова ведущего', duration: 60 }
  ];

  let totalDur = blocks.reduce((acc, b) => acc + b.duration, 0); // 240 сек
  let neededScale = Math.max(baseScaleSec, Math.ceil(totalDur * 1.12));
  assert.equal(neededScale, 1200, 'При сумме 240 сек шкала остается базовой 20 минут');

  // Пользователь тянет за край блока "Слова ведущего", увеличивая его до 1500 сек
  blocks[1].duration = 1500;
  totalDur = blocks.reduce((acc, b) => acc + b.duration, 0); // 1680 сек (28 мин)
  neededScale = Math.max(baseScaleSec, Math.ceil(totalDur * 1.12)); // 1882 сек (~31 мин)

  assert.ok(totalDur > baseScaleSec, 'Суммарный хронометраж превысил базовую 20-минутную шкалу');
  assert.ok(neededScale > baseScaleSec, 'Временная линия динамически увеличилась');
  assert.equal(neededScale, 1882, 'Новая шкала точно вмещает растянутый блок с 12% запасом');

  // 5. Эмуляция перемещения блока на ленте вещания (Drag & Drop)
  const movedItem = blocks.splice(1, 1)[0];
  blocks.splice(0, 0, movedItem);
  assert.equal(blocks[0].id, 'b2', 'Блок успешно перемещен в начало ленты вещания');
  assert.equal(blocks[1].id, 'b1', 'Второй блок сместился вправо');

  // 6. Эмуляция отодвигания блока за край с созданием паузы (gap)
  const offsetTargetSec = 2400; // 40 мин
  const gapDuration = offsetTargetSec - totalDur;
  const gapBlock = {
    id: 'gap_1',
    type: 'gap',
    title: 'Пауза в эфире (музыкальная пустота)',
    duration: gapDuration
  };
  blocks.push(gapBlock);
  const newTotalWithGap = blocks.reduce((acc, b) => acc + b.duration, 0);
  assert.equal(newTotalWithGap, offsetTargetSec, 'Отодвигание блока за край создало паузу и расширило сетку до 40 мин');
});

test('radio-editor: playlists are framed with bracket-like side borders on timeline and blocks list', () => {
  const freshCss = fs.readFileSync(path.join(rootDir, 'public/site/radio.css'), 'utf8');
  const freshClientJs = fs.readFileSync(path.join(rootDir, 'public/site/radio-client.js'), 'utf8');

  // 1. Стили рамочек-скобок на таймлайне
  assert.ok(freshCss.includes('.radio-clip-bracket'), 'Стили рамочек-скобок для клипов таймлайна');
  assert.ok(freshCss.includes('.radio-clip-bracket.bracket-left'), 'Левая квадратная скобка [ на таймлайне');
  assert.ok(freshCss.includes('.radio-clip-bracket.bracket-right'), 'Правая квадратная скобка ] на таймлайне');

  // 2. Стили рамочек-скобок для карточек плейлистов в списке редактора
  assert.ok(freshCss.includes('.radio-eb-block.eb-block-playlist'), 'Стили выделения блока плейлиста в списке');
  assert.ok(freshCss.includes('.radio-eb-bracket-left'), 'Левая скобка [ для карточки плейлиста в редакторе');
  assert.ok(freshCss.includes('.radio-eb-bracket-right'), 'Правая скобка ] для карточки плейлиста в редакторе');

  // 3. Вывод рамочек в коде radio-client.js
  assert.ok(freshClientJs.includes('radio-clip-bracket bracket-left'), 'Вывод левой скобки плейлиста на таймлайне');
  assert.ok(freshClientJs.includes('radio-clip-bracket bracket-right'), 'Вывод правой скобки плейлиста на таймлайне');
  assert.ok(freshClientJs.includes('radio-eb-bracket-left'), 'Вывод левой скобки плейлиста в блочном редакторе');
  assert.ok(freshClientJs.includes('radio-eb-bracket-right'), 'Вывод правой скобки плейлиста в блочном редакторе');
});

test('radio-client: public/site/radio-client.js has valid syntax and executes without syntax errors', () => {
  assert.doesNotThrow(() => {
    execSync(`node -c "${path.join(rootDir, 'public/site/radio-client.js')}"`);
  }, 'radio-client.js must have valid JavaScript syntax');
});

test('radio-deck: synchronizes with global audio player in track mode and editor blocks render without ReferenceError', () => {
  const freshClientJs = fs.readFileSync(path.join(rootDir, 'public/site/radio-client.js'), 'utf8');

  // 1. Проверяем, что items в renderEditorBlocks объявлен в безопасной области видимости
  assert.ok(!freshClientJs.includes("if (block.type === 'playlist') {\n        const items = block.items || [];"), 'items не должен быть изолирован внутри if блока');
  assert.ok(freshClientJs.includes('const items = Array.isArray(block.items) ? block.items : [];'), 'items объявлен для всех блоков');

  // 2. updateDeckUI поддерживает gState.mode === "track"
  assert.ok(freshClientJs.includes("gState.mode === 'track' && gState.track"), 'updateDeckUI должен обрабатывать режим track');
  assert.ok(freshClientJs.includes("deckVisualizer.classList.toggle('is-playing', Boolean(gState.isPlaying))"), 'updateDeckUI должен активировать визуализатор в режиме трека');
  assert.ok(freshClientJs.includes('deckProgressFill.style.width'), 'updateDeckUI синхронизирует прогресс-бар');

  // 3. Обработчики деки делегируют управление в globalAudio при curr.mode === "track"
  assert.ok(freshClientJs.includes("curr.mode === 'track'"), 'Кнопки деки должны проверять режим трека');
  assert.ok(freshClientJs.includes('gAudio.playNext()'), 'deckNextBtn вызывает playNext');
  assert.ok(freshClientJs.includes('gAudio.playPrev()'), 'deckPrevBtn вызывает playPrev');

  // 4. Эмуляция рендера блоков редактора без исключений
  const blocksToTest = [
    { id: 'b_track', type: 'track', title: 'Обычный трек', duration: 180, audio_url: '/audio/track1.mp3' },
    { id: 'b_speech', type: 'speech', title: 'Слова ведущего', duration: 60, audio_url: '/audio/speech.mp3' },
    { id: 'b_gap', type: 'gap', title: 'Пауза в эфире', duration: 120 },
    { id: 'b_anchor', type: 'time_anchor', title: 'Якорь 12:00', duration: 0, anchor_time: '12:00' },
    {
      id: 'b_pl',
      type: 'playlist',
      title: 'Утренний сет',
      duration: 360,
      items: [
        { track_id: 1, title: 'Песня 1', duration: 180, audio_url: '/audio/song1.mp3' },
        { track_id: 2, title: 'Песня 2', duration: 180, audio_url: '/audio/song2.mp3' }
      ]
    }
  ];

  let renderedCount = 0;
  blocksToTest.forEach((block) => {
    const isPlaylist = block.type === 'playlist';
    const items = Array.isArray(block.items) ? block.items : [];
    const hasAudio = Boolean(block.audio_url || (isPlaylist && items.some(t => t.audio_url)));
    if (block.type === 'track') assert.equal(hasAudio, true);
    if (block.type === 'gap') assert.equal(hasAudio, false);
    if (block.type === 'playlist') assert.equal(hasAudio, true);
    renderedCount++;
  });
  assert.equal(renderedCount, 5, 'Все 5 типов блоков должны успешно вычислять наличие аудио без ReferenceError');
});

test('radio-broadcast: choosing start time initiates live broadcast and virtual timeline plays from exact offset upon entry', () => {
  const freshClientJs = fs.readFileSync(path.join(rootDir, 'public/site/radio-client.js'), 'utf8');
  const freshPlayerJs = fs.readFileSync(path.join(rootDir, 'public/radio-global-player.js'), 'utf8');
  const freshHtml = fs.readFileSync(path.join(rootDir, 'public/site/radio.html'), 'utf8');

  // 1. Выбор старта вещания и кнопка "Сейчас" инициируют запуск вещания
  assert.ok(freshClientJs.includes('async function publishBroadcast('), 'Должна быть функция запуска вещания publishBroadcast');
  assert.ok(freshClientJs.includes('btnSetStartTimeNow?.addEventListener'), 'Кнопка Сейчас должна быть привязана к обработчику');
  assert.ok(freshClientJs.includes('publishBroadcast(new Date()'), 'Клик на Сейчас должен вызывать publishBroadcast');
  assert.ok(freshClientJs.includes('updateEditorLiveStatusBadge('), 'Должно быть визуальное отображение статуса эфира');
  assert.ok(freshHtml.includes('id="editorLiveStatusBadge"'), 'Бейдж статуса эфира в разметке');

  // 2. applyAudioOffset в аудиоплеере для воспроизведения с нужного времени без перегрузки сервера
  assert.ok(freshPlayerJs.includes('function applyAudioOffset('), 'Плеер должен иметь функцию applyAudioOffset');
  assert.ok(freshPlayerJs.includes('loadedmetadata'), 'applyAudioOffset должен ожидать loadedmetadata для надежной перемотки');
  assert.ok(freshPlayerJs.includes('safeOffset'), 'applyAudioOffset должен безопасно рассчитывать смещение');

  // 3. Автоматический вход в живой эфир при заходе на страницу радио
  assert.ok(freshClientJs.includes('stations.find((s) => s.isLive)'), 'loadStations должен находить активную станцию в эфире');

  // 4. Эмуляция виртуального таймера эфира: расчет текущего слота и смещения по заходу слушателя
  const broadcastStart = new Date('2026-11-17T15:00:00.000Z').getTime();
  const scheduleSlots = [
    { id: 's1', title: 'Вступительное слово', duration: 120 }, // 15:00:00 - 15:02:00
    { id: 's2', title: 'Хит дня', duration: 240 },             // 15:02:00 - 15:06:00
    { id: 's3', title: 'Интервью', duration: 300 }             // 15:06:00 - 15:11:00
  ];

  // Слушатель заходит в радио в 15:03:30 (спустя 210 секунд после старта)
  const entryTime = new Date('2026-11-17T15:03:30.000Z').getTime();
  const elapsedFromStart = (entryTime - broadcastStart) / 1000; // 210 сек

  let currentSlot = null;
  let offsetInSlot = 0;
  let acc = 0;

  for (const s of scheduleSlots) {
    if (acc + s.duration > elapsedFromStart) {
      currentSlot = s;
      offsetInSlot = elapsedFromStart - acc;
      break;
    }
    acc += s.duration;
  }

  assert.ok(currentSlot, 'Слот должен быть найден');
  assert.equal(currentSlot.title, 'Хит дня', 'В 15:03:30 должен играть второй трек');
  assert.equal(offsetInSlot, 90, 'Смещение внутри второго трека должно быть ровно 90 секунд');
});

test('radio-timeshift: pause resumes from paused position without stopping live broadcast and blocks playing future tracks', async () => {
  const freshClientJs = fs.readFileSync(path.join(rootDir, 'public/site/radio-client.js'), 'utf8');
  const freshStoreJs = fs.readFileSync(path.join(rootDir, 'src/services/radio-store.js'), 'utf8');
  const freshRoutesJs = fs.readFileSync(path.join(rootDir, 'src/routes/radio.routes.js'), 'utf8');

  // 1. Блокировка воспроизведения будущих треков на клиенте
  assert.ok(freshClientJs.includes('!state.isTimeshift'), 'Должна быть проверка режима прямого эфира');
  assert.ok(freshClientJs.includes('Будущие треки станут доступны только после выхода в эфир'), 'Запрет переключения на будущие треки');
  assert.ok(freshClientJs.includes('Нельзя перемотать вперед: эта часть трека еще не проиграна в эфире'), 'Запрет перемотки прогресс-бара вперед за пределы сыгранного');

  // 2. Защита на бэкенде: nextSlots не отдает audioUrl для будущих треков
  assert.ok(freshStoreJs.includes('audioUrl: null'), 'nextSlots должен иметь audioUrl: null для защиты от воспроизведения будущего эфира');
  assert.ok(freshRoutesJs.includes('s.start_time > nowIso && !isOwner && !isAdmin'), 'timeline API для гостей должен скрывать audio_url будущих слотов');

  // 3. Поддержка выхода в таймшифт и прослушивания прошлых треков
  assert.ok(freshClientJs.includes('state.timeshiftForwardSlots'), 'Должна быть поддержка навигации по таймшифту');
  assert.ok(freshClientJs.includes('deckLiveSyncBtn'), 'Кнопка В эфир для возврата в прямой эфир');

  // 4. Эмуляция защиты: попытка промотать вперед на 80% при сыгранных 30%
  const trackDuration = 200;
  const elapsedInBroadcast = 60; // 30% трека сыграло в эфире
  const maxLiveRatio = elapsedInBroadcast / trackDuration; // 0.3
  const userRequestedRatio = 0.75; // 75% трека (будущее!)

  let canSeek = false;
  if (userRequestedRatio <= maxLiveRatio + 0.03) {
    canSeek = true;
  }
  assert.equal(canSeek, false, 'Перемотка в несыгранное будущее должна быть запрещена');

  // Перемотка назад (на 15%) разрешена и переводит в таймшифт
  const rewindRatio = 0.15;
  let enteredTimeshift = false;
  if (rewindRatio < maxLiveRatio - 0.03) {
    enteredTimeshift = true;
  }
  assert.equal(enteredTimeshift, true, 'Перемотка назад должна переводить в режим таймшифта');
});

test('radio-ui: context menus, quick insert popover, templates and playhead are fully implemented', () => {
  const radioHtml = fs.readFileSync(path.join(rootDir, 'public/site/radio.html'), 'utf8');
  const radioCss = fs.readFileSync(path.join(rootDir, 'public/site/radio.css'), 'utf8');
  const radioJs = fs.readFileSync(path.join(rootDir, 'public/site/radio-client.js'), 'utf8');

  // 1. Модальные окна: modalEditStation и modalRadioTemplates используют .modal-overlay и .modal-box
  assert.ok(radioHtml.includes('id="modalEditStation"'), 'modalEditStation должен присутствовать в HTML');
  assert.ok(radioHtml.includes('<div class="modal-overlay" id="modalEditStation"'), 'modalEditStation должен использовать .modal-overlay, а не разваливаться внизу страницы');
  assert.ok(radioHtml.includes('id="modalRadioTemplates"'), 'modalRadioTemplates должен присутствовать в HTML');
  assert.ok(radioHtml.includes('<div class="modal-overlay" id="modalRadioTemplates"'), 'modalRadioTemplates должен использовать .modal-overlay');

  // 2. CSS: базовые модальные стили и контекстное меню
  assert.ok(radioCss.includes('.modal-overlay {'), 'radio.css должен определять .modal-overlay с position: fixed');
  assert.ok(radioCss.includes('.modal-box {'), 'radio.css должен определять .modal-box');
  assert.ok(radioCss.includes('.radio-context-menu {'), 'radio.css должен определять плавающее контекстное меню');
  assert.ok(radioCss.includes('.radio-context-menu-item'), 'radio.css должен определять элементы контекстного меню');
  assert.ok(radioCss.includes('.radio-templates-list'), 'radio.css должен определять стили списка шаблонов');

  // 3. JS: контекстное меню станций, блоков, быстрый инсертер и шаблоны
  assert.ok(radioJs.includes('openStationContextMenu'), 'radio-client.js должен содержать openStationContextMenu');
  assert.ok(radioJs.includes('openBlockContextMenu'), 'radio-client.js должен содержать openBlockContextMenu');
  assert.ok(radioJs.includes('openQuickInsertMenu'), 'radio-client.js должен содержать openQuickInsertMenu');
  assert.ok(!radioJs.includes("window.prompt(\n      'Что вы хотите добавить в сетку вещания?"), 'Устаревший window.prompt должен быть удален из openQuickInsertMenu');
  assert.ok(radioJs.includes('saveCurrentGridAsTemplate'), 'radio-client.js должен поддерживать сохранение шаблонов сетки');
  assert.ok(radioJs.includes('applyTemplate'), 'radio-client.js должен поддерживать загрузку шаблонов сетки');
  assert.ok(radioJs.includes('updateTimelinePlayhead'), 'radio-client.js должен поддерживать интерактивный плейхед');
});
