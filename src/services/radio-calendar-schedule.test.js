const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const radioStore = require('./radio-store');

const rootDir = path.resolve(__dirname, '../../');

test('radio-calendar: CRUD and overlap validation for scheduled broadcasts', async () => {
  const uniqueFreq = Math.round((70 + Math.random() * 20) * 10) / 10;
  const station = await radioStore.createStation({
    frequency: uniqueFreq,
    name: 'Schedule Test Station',
    ownerId: 888,
    ownerName: 'ScheduleOwner'
  });

  const now = radioStore.getEffectiveNow();
  const startTime1 = new Date(now.getTime() + 86400 * 1000); // Завтра
  const endTime1 = new Date(startTime1.getTime() + 7200 * 1000); // +2 часа

  // 1. Создание запланированного эфира
  const event1 = await radioStore.createScheduledBroadcast(station.id, 888, true, {
    title: 'Вечерний джаз',
    description: 'Прямой эфир с редкими записями',
    start_time: startTime1.toISOString(),
    is_loop: true,
    fallback_action: 'return_to_normal',
    slots_data: [
      { title: 'Track 1', duration: 1800, audio_url: '/audio1.mp3' },
      { title: 'Track 2', duration: 1800, audio_url: '/audio2.mp3' }
    ]
  });

  assert.ok(event1.id, 'Эфир должен получить ID');
  assert.equal(event1.title, 'Вечерний джаз');
  assert.equal(event1.duration, 3600);
  assert.equal(event1.status, 'planned');
  assert.equal(Boolean(event1.is_loop), true);

  // 2. Валидация пересечений (Overlap)
  // Попытка создать эфир, пересекающийся с event1 (начинается за 30 мин до конца event1)
  const overlappingStart = new Date(startTime1.getTime() + 1800 * 1000);
  await assert.rejects(
    async () => {
      await radioStore.createScheduledBroadcast(station.id, 888, true, {
        title: 'Конфликтующий эфир',
        start_time: overlappingStart.toISOString(),
        slots_data: [{ title: 'Conflict Track', duration: 3600, audio_url: '/conflict.mp3' }]
      });
    },
    /Пересечение по времени/,
    'Должна быть ошибка пересечения времени эфиров'
  );

  // 3. Создание непересекающегося эфира (через 3 часа после первого)
  const startTime2 = new Date(endTime1.getTime() + 3600 * 1000);
  const event2 = await radioStore.createScheduledBroadcast(station.id, 888, true, {
    title: 'Ночной эмбиент',
    start_time: startTime2.toISOString(),
    slots_data: [{ title: 'Ambient 1', duration: 3600, audio_url: '/amb.mp3' }]
  });
  assert.ok(event2.id, 'Второй эфир должен успешно создаться');

  // 4. Получение списка запланированных эфиров
  const list = await radioStore.getScheduledBroadcasts(station.id);
  assert.ok(list.length >= 2, 'Должно быть минимум 2 эфира');
  const found1 = list.find(e => e.id === event1.id);
  assert.ok(found1, 'Первый эфир должен быть в списке');

  // 5. Обновление запланированного эфира
  const updated1 = await radioStore.updateScheduledBroadcast(event1.id, 888, true, {
    title: 'Вечерний джаз (Обновлено)',
    is_loop: false
  });
  assert.equal(updated1.title, 'Вечерний джаз (Обновлено)');
  assert.equal(Boolean(updated1.is_loop), false);

  // 6. Удаление запланированного эфира
  const delRes = await radioStore.deleteScheduledBroadcast(event2.id, 888, true);
  assert.equal(delRes, true);

  const afterDelete = await radioStore.getScheduledBroadcastById(event2.id);
  assert.equal(afterDelete, null, 'Удаленный эфир не должен находиться');

  // 7. Создание пустой передачи без слотов с кастомным хронометражем (пункт «Создать пустую передачу»)
  const emptyStart = new Date(endTime1.getTime() + 7200 * 1000);
  const emptyEvent = await radioStore.createScheduledBroadcast(station.id, 888, true, {
    title: 'Пустая запланированная передача',
    description: 'Наполнение сетки будет позже',
    start_time: emptyStart.toISOString(),
    duration: 5400, // 1.5 часа
    slots_data: []
  });
  assert.ok(emptyEvent.id, 'Пустая передача должна успешно создаться');
  assert.equal(emptyEvent.duration, 5400, 'Хронометраж должен быть 5400 секунд');
  assert.equal(emptyEvent.status, 'planned');
  const emptySlots = typeof emptyEvent.slots_data === 'string' ? JSON.parse(emptyEvent.slots_data) : emptyEvent.slots_data;
  assert.deepEqual(emptySlots, [], 'Слоты пустой передачи должны быть пустым массивом');

  // Очистка станции
  await radioStore.deleteStation(station.id, 888, true);
});

test('radio-calendar: Priority arbitration in getStationLiveState()', async () => {
  const uniqueFreq = Math.round((70 + Math.random() * 20) * 10) / 10;
  const station = await radioStore.createStation({
    frequency: uniqueFreq,
    name: 'Arbitration Station',
    ownerId: 888,
    ownerName: 'ScheduleOwner'
  });

  const now = radioStore.getEffectiveNow();

  // 1. Устанавливаем базовую регулярную сетку на 24ч
  await radioStore.setTimelineSlots(station.id, [
    { title: 'Regular Track 1', duration: 300, audio_url: '/reg1.mp3' },
    { title: 'Regular Track 2', duration: 300, audio_url: '/reg2.mp3' }
  ], now.toISOString(), { forceNow: true, status: 'live' });

  // 2. Создаем запланированный эфир, который активен прямо СЕЙЧАС (start_time 60 сек назад, duration 1200 сек)
  const activeStart = new Date(now.getTime() - 60 * 1000);
  const activeEvent = await radioStore.createScheduledBroadcast(station.id, 888, true, {
    title: 'Специальный запланированный выпуск',
    start_time: activeStart.toISOString(),
    is_loop: false,
    fallback_action: 'return_to_normal',
    slots_data: [
      { title: 'Special Show Track 1', duration: 600, audio_url: '/special1.mp3' },
      { title: 'Special Show Track 2', duration: 600, audio_url: '/special2.mp3' }
    ]
  });

  // Также создаем следующий будущий эфир через 2 часа для проверки nextScheduledEvent
  const nextStart = new Date(now.getTime() + 7200 * 1000);
  const nextEvent = await radioStore.createScheduledBroadcast(station.id, 888, true, {
    title: 'Будущий ночной эфир',
    start_time: nextStart.toISOString(),
    slots_data: [{ title: 'Future 1', duration: 1800, audio_url: '/fut1.mp3' }]
  });

  // 3. Вызываем getStationLiveState()
  const liveState = await radioStore.getStationLiveState(station.id);

  assert.equal(liveState.isScheduledEvent, true, 'Должен быть включен режим Priority 1: isScheduledEvent = true');
  assert.ok(liveState.scheduledEvent, 'scheduledEvent должен содержать объект активного эфира');
  assert.equal(liveState.scheduledEvent.id, activeEvent.id);
  assert.equal(liveState.scheduledEvent.title, 'Специальный запланированный выпуск');

  // Текущий трек должен быть из специального выпуска, а не из регулярной сетки!
  assert.ok(liveState.currentSlot, 'Должен играть активный слот');
  assert.equal(liveState.currentSlot.title, 'Special Show Track 1');
  assert.ok(liveState.offset >= 50 && liveState.offset <= 70, `Смещение трека должно быть около 60с (фактически: ${liveState.offset})`);

  // nextScheduledEvent должен быть заполнен
  assert.ok(liveState.nextScheduledEvent, 'nextScheduledEvent должен быть заполнен для прелоада');
  assert.equal(liveState.nextScheduledEvent.id, nextEvent.id);
  assert.equal(liveState.nextScheduledEvent.title, 'Будущий ночной эфир');

  // Очистка
  await radioStore.deleteStation(station.id, 888, true);
});

test('radio-calendar: HTML and CSS UI parity for calendar and scheduling', () => {
  const radioHtml = fs.readFileSync(path.join(rootDir, 'public/site/radio.html'), 'utf8');
  const radioCss = fs.readFileSync(path.join(rootDir, 'public/site/radio.css'), 'utf8');
  const radioJs = fs.readFileSync(path.join(rootDir, 'public/site/radio-client.js'), 'utf8');
  const globalPlayerJs = fs.readFileSync(path.join(rootDir, 'public/radio-global-player.js'), 'utf8');

  // 1. Переключатель режимов редактора в radio.html
  assert.ok(radioHtml.includes('id="radioEditorSubnav"'), 'radio.html должен содержать radioEditorSubnav');
  assert.ok(radioHtml.includes('id="btnSubnavTimeline"'), 'radio.html должен содержать btnSubnavTimeline');
  assert.ok(radioHtml.includes('id="btnSubnavCalendar"'), 'radio.html должен содержать btnSubnavCalendar');
  assert.ok(radioHtml.includes('id="editorScheduleCountBadge"'), 'radio.html должен содержать счетчик запланированных передач');
  assert.ok(radioHtml.includes('id="radioEditorTimelineMode"'), 'radio.html должен оборачивать ленту в radioEditorTimelineMode');
  assert.ok(radioHtml.includes('id="radioEditorCalendarMode"'), 'radio.html должен содержать контейнер radioEditorCalendarMode');

  // 2. Сетка и элементы календаря в radio.html
  assert.ok(radioHtml.includes('id="radioCalendarDaysGrid"'), 'radio.html должен содержать сетку дней radioCalendarDaysGrid');
  assert.ok(radioHtml.includes('id="calDayEventsList"'), 'radio.html должен содержать список событий дня calDayEventsList');
  assert.ok(radioHtml.includes('id="btnOpenCreateScheduleModal"'), 'radio.html должен содержать кнопку btnOpenCreateScheduleModal');
  assert.ok(radioHtml.includes('id="modalScheduleBroadcast"'), 'radio.html должен содержать модальное окно modalScheduleBroadcast');
  assert.ok(radioHtml.includes('id="formScheduleBroadcast"'), 'radio.html должен содержать форму formScheduleBroadcast');
  assert.ok(radioHtml.includes('id="schedEventStartTime"'), 'radio.html должен содержать ввод времени старта передачи');
  assert.ok(radioHtml.includes('id="schedSourceTimeline"'), 'radio.html должен содержать выбор источника текущей ленты');
  assert.ok(radioHtml.includes('id="schedSourceStationGrid"'), 'radio.html должен содержать выбор источника сетки станции');
  assert.ok(radioHtml.includes('id="schedStationGridSelect"'), 'radio.html должен содержать выпадающий список станций');
  assert.ok(radioHtml.includes('id="schedSourceTemplate"'), 'radio.html должен содержать выбор источника шаблона сетки');
  assert.ok(radioHtml.includes('id="schedTemplateSelect"'), 'radio.html должен содержать выпадающий список шаблонов');
  assert.ok(radioHtml.includes('id="btnSaveTemplateFromModal"'), 'radio.html должен содержать кнопку сохранения шаблона из модалки');
  assert.ok(radioHtml.includes('id="schedSourcePlaylist"'), 'radio.html должен содержать выбор источника плейлиста медиатеки');
  assert.ok(radioHtml.includes('id="schedPlaylistSelect"'), 'radio.html должен содержать выпадающий список плейлистов');
  assert.ok(radioHtml.includes('id="schedSourceEmpty"'), 'radio.html должен содержать выбор пустой передачи');
  assert.ok(radioHtml.includes('id="schedEmptyDurationSelect"'), 'radio.html должен содержать селектор длительности пустой передачи');

  // 3. CSS классы календаря в radio.css
  assert.ok(radioCss.includes('.radio-editor-subnav'), 'radio.css должен содержать стили для .radio-editor-subnav');
  assert.ok(radioCss.includes('.radio-cal-layout'), 'radio.css должен содержать 2-колоночный макет .radio-cal-layout');
  assert.ok(radioCss.includes('.radio-cal-day'), 'radio.css должен содержать стили ячеек .radio-cal-day');
  assert.ok(radioCss.includes('.radio-sched-card'), 'radio.css должен содержать стили карточки эфира .radio-sched-card');

  // 4. Клиентская логика в radio-client.js
  assert.ok(radioJs.includes('function switchEditorSubmode('), 'radio-client.js должен содержать функцию переключения режимов');
  assert.ok(radioJs.includes('function renderCalendar('), 'radio-client.js должен содержать функцию рендеринга сетки месяца');
  assert.ok(radioJs.includes('function renderSelectedDayEvents('), 'radio-client.js должен содержать функцию рендеринга событий дня');
  assert.ok(radioJs.includes('function loadEventToTimeline('), 'radio-client.js должен позволять загрузить эфир в ленту редактора');
  assert.ok(radioJs.includes('function syncClockWithServer('), 'radio-client.js должен выполнять NTP-калибровку часов с сервером');
  assert.ok(radioJs.includes('function populateScheduleStationsDropdown('), 'radio-client.js должен заполнять список сеток станций');
  assert.ok(radioJs.includes('function populateScheduleTemplatesDropdown('), 'radio-client.js должен заполнять список шаблонов');
  assert.ok(radioJs.includes('function populateSchedulePlaylistsDropdown('), 'radio-client.js должен заполнять список плейлистов');
  assert.ok(radioJs.includes('schedSourceTemplate.disabled = false'), 'radio-client.js должен держать радиокнопку шаблонов кликабельной');

  // 5. Глобальный плеер: бесшовный переход (Radio standard cutover)
  assert.ok(globalPlayerJs.includes('nextScheduledEvent'), 'radio-global-player.js должен отслеживать nextScheduledEvent');
  assert.ok(globalPlayerJs.includes('isScheduledEvent'), 'radio-global-player.js должен отслеживать isScheduledEvent');
  assert.ok(globalPlayerJs.includes('fade-out') || globalPlayerJs.includes('audio.volume'), 'radio-global-player.js должен поддерживать плавный fade-out перед переходом');
});
