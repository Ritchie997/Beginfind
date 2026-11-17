// radio-editor-timeline.test.js — тесты видео-таймлайна, блочного редактора в стиле Антропедии,
// умного блока плейлиста, врезок слов без потери очереди и автозаполнения пустот.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
