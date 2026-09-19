// editor-manager.js — редактор статей как список блоков (см.
// src/services/blocks.js) вместо одного Markdown-документа с самодельным
// {width=...}-синтаксисом для картинок/рамок. Текст ВНУТРИ блока
// (paragraph/heading/quote/callout/пункт списка/ячейка таблицы) остаётся
// обычным markdown-текстом (**жирный**, [[wiki-ссылка]], #тег, новый
// ++подчёркнутый++/==выделение==/||спойлер||) — тулбар оборачивает
// выделение нужными символами (см. applyInlineFormat), полноценного
// WYSIWYG-редактирования HTML нет по решению "оставить инлайн markdown +
// тулбар поверх". Раскладка (картинка, колонки, инфобокс, сворачиваемая
// секция) — это уже СТРУКТУРА (тип блока + его поля), а не текстовый
// синтаксис — отказ от старых "рамок"/{align=column}.
//
// Показ готовой статьи (панель "Просмотр"/"Разделить" и страница Ibripedia)
// рендерится общим модулем public/blocks-renderer.js — здесь его не
// дублируем.
//
// Совместимость со старым кодом spa-router.js: он читает/пишет содержимое
// статьи как document.getElementById('articleContent').innerHTML (было —
// Markdown-текст, теперь — JSON документа блоков). Вместо правки полутора
// десятков мест в spa-router.js эта совместимость обеспечена тем же
// приёмом, что и раньше — шимом innerHTML (см. shimInnerHTML) — только
// значение теперь JSON-строка, а не markdown. Документ хранится в this.doc
// синхронно и всегда доступен немедленно (без промисов) — это сознательный
// отказ от использования библиотеки Editor.js для этой части: её
// единственный публичный способ прочитать содержимое, editor.save(),
// асинхронный (возвращает Promise), а синхронный шим на innerHTML с
// Promise не построить, не переписывая обращения к .innerHTML в
// spa-router.js. Внешнее поведение (тулбар/типы блоков) от этого не
// меняется — только реализация.

(function () {
  'use strict';

  // ===== slugify — клиентское зеркало src/services/slugify.js =====
  const RU_TO_LAT = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
    и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
    с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
  };
  function slugify(text) {
    const transliterated = String(text || '')
      .split('')
      .map((ch) => {
        const lower = ch.toLowerCase();
        return Object.prototype.hasOwnProperty.call(RU_TO_LAT, lower) ? RU_TO_LAT[lower] : ch;
      })
      .join('');
    return transliterated
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 80) || 'article';
  }

  const WIKILINK_OPEN_RE = /\[\[([^\]|#]*)$/; // "[[частичный текст" перед курсором, без закрытия
  const DEFAULT_FRAME_COLOR = '#5865f2';

  // Цвет выделения "по умолчанию" (без (#hex) в markdown — см. .mk-hl в
  // editor-obsidian.css) + готовые пресеты для палитры кнопки "выделение".
  const DEFAULT_HIGHLIGHT_COLOR = '#faa81a';
  const HIGHLIGHT_PRESETS = [
    { hex: '#faa81a', label: 'Жёлтый (по умолчанию)' },
    { hex: '#3ba55d', label: 'Зелёный' },
    { hex: '#5865f2', label: 'Синий' },
    { hex: '#ed4245', label: 'Красный' },
    { hex: '#eb459e', label: 'Розовый' }
  ];

  function genId() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  const TYPE_LABELS = {
    paragraph: 'Текст', heading: 'Заголовок', quote: 'Цитата', code: 'Код',
    list: 'Список', table: 'Таблица', divider: 'Линия', image: 'Картинка',
    columns: 'Колонки', infobox: 'Инфобокс', callout: 'Плашка', 'spoiler-section': 'Спойлер-секция'
  };

  function blockTypeTag(block) {
    if (block.type === 'heading') return `Заголовок H${block.data.level}`;
    if (block.type === 'list') return { bullet: 'Список', ordered: 'Нумерованный список', checklist: 'Чек-лист' }[block.data.style] || 'Список';
    return TYPE_LABELS[block.type] || block.type;
  }

  // Типы, разрешённые ВНУТРИ columns/spoiler-section — без вложенности
  // контейнеров друг в друга (см. CONTAINER_TYPES в src/services/blocks.js).
  const NESTED_ALLOWED_TYPES = ['paragraph', 'heading', 'list', 'quote', 'image', 'table', 'code', 'divider'];

  // Иконки для меню "+ добавить блок" (renderNestedAddButton/openBlockTypeMenu)
  // — те же, что и на кнопках основного тулбара (см. data-block-command в
  // views/articles.html), чтобы один и тот же тип блока узнавался одинаково
  // в обоих местах.
  const NESTED_TYPE_ICONS = {
    paragraph: 'fa-paragraph', heading: 'fa-heading', list: 'fa-list-ul',
    quote: 'fa-quote-right', image: 'fa-image', table: 'fa-table',
    code: 'fa-file-code', divider: 'fa-minus'
  };

  function makeBlock(type, data) {
    return { id: genId(), type, data };
  }

  function defaultBlockData(type, extra) {
    switch (type) {
      case 'paragraph': return { markdown: '' };
      case 'heading': return { level: (extra && extra.level) || 2, markdown: '' };
      case 'quote': return { markdown: '' };
      case 'code': return { language: '', code: '' };
      case 'list': return { style: (extra && extra.style) || 'bullet', items: [{ markdown: '', checked: false }] };
      case 'table': return { header: true, rows: [['', ''], ['', '']] };
      case 'divider': return {};
      case 'columns': return { columns: [{ widthPct: 50, blocks: [] }, { widthPct: 50, blocks: [] }] };
      case 'infobox': return { title: '', image: null, rows: [{ label: '', value: '' }] };
      case 'callout': return { variant: 'info', title: '', markdown: '' };
      case 'spoiler-section': return { title: 'Подробности', openByDefault: false, blocks: [] };
      case 'image': return Object.assign({ src: '', alt: '', widthPct: 100, align: 'center', frame: { show: false, color: DEFAULT_FRAME_COLOR } }, extra || {});
      default: return {};
    }
  }

  // ===== EditorManager =====

  class EditorManager {
    constructor() {
      this.container = null;
      this.panesEl = null;
      this.previewEl = null;
      // По умолчанию — "Разделить": иначе результат форматирования (жирный,
      // цвет выделения и т.д.) не виден, пока не переключишься на "Просмотр"
      // вручную — а textarea с сырым markdown сама по себе жирным не рисует.
      this.mode = 'split';
      this.doc = { version: 1, blocks: [] };
      this._pendingDoc = null;
      this.articlesIndex = [];
      this.articlesIndexBySlug = new Map();
      this._activeTextInput = null; // { el, list, block } — последнее сфокусированное markdown-поле (для тулбара форматирования)
      this._active = null; // { list, block } — последний сфокусированный блок любого типа (для "вставить после")
      this._pendingFocusBlockId = null;
      this._articleIdObserver = null;
      this._previewTimer = null;
      this._lastObservedArticleId = undefined;
      this._loadedArticleTitle = null;
      this._suggestEl = null;
    }

    // Вызывается spa-router'ом при каждом открытии страницы /articles.
    async initializeEditor() {
      this.cleanup();

      this.container = document.getElementById('articleContent');
      if (!this.container) return; // не на странице статей

      this.panesEl = this.container.closest('.editor-panes');
      this.previewEl = document.getElementById('markdownPreviewPane');
      this.setupPreviewClickHandling();
      this.setupTitleRenameHint();

      this.shimInnerHTML();
      this.doc = this._pendingDoc || { version: 1, blocks: [] };
      this._pendingDoc = null;

      await this.loadArticlesIndex();

      this.setupToolbar();
      this.setupModeTabs();
      this.setupHotkeys();
      this.renderAll();
      this.observeArticleIdForBacklinks();
      this.scheduleRenderPreview();
    }

    // Шим innerHTML на #articleContent: spa-router.js по-прежнему читает и
    // пишет содержимое статьи через .innerHTML — раньше markdown-текст,
    // теперь JSON документа блоков (см. комментарий в начале файла).
    // Пустой документ отдаётся как ПУСТАЯ строка (а не "{}"), чтобы не
    // сломать проверки вида `if (!content.trim())` в spa-router.js
    // (saveDraft/checkAndOfferDraft/previewArticle считают форму пустой).
    shimInnerHTML() {
      const el = this.container;
      const self = this;
      try {
        Object.defineProperty(el, 'innerHTML', {
          configurable: true,
          get() {
            const doc = self.doc || { version: 1, blocks: [] };
            return (doc.blocks && doc.blocks.length) ? JSON.stringify(doc) : '';
          },
          set(value) {
            let doc;
            if (value && typeof value === 'object') {
              doc = value; // articleId.content от API — уже объект
            } else if (typeof value === 'string' && value.trim()) {
              try { doc = JSON.parse(value); } catch (e) { doc = { version: 1, blocks: [] }; }
            } else {
              doc = { version: 1, blocks: [] };
            }
            if (!doc || !Array.isArray(doc.blocks)) doc = { version: 1, blocks: [] };
            if (self.container) { self.doc = doc; self.renderAll(); self.scheduleRenderPreview(); }
            else self._pendingDoc = doc;
          }
        });
      } catch (e) {
        console.error('Не удалось установить innerHTML-шим редактора:', e);
      }
    }

    async loadArticlesIndex() {
      try {
        const result = await window.apiClient.makeAuthenticatedRequest('/api/articles-index');
        this.articlesIndex = (result.success && Array.isArray(result.data)) ? result.data : [];
      } catch (e) {
        this.articlesIndex = [];
      }
      this.articlesIndexBySlug = new Map(this.articlesIndex.map(a => [a.slug, a]));
    }

    cleanup() {
      if (this._articleIdObserver) { this._articleIdObserver.disconnect(); this._articleIdObserver = null; }
      clearTimeout(this._previewTimer);
      if (this._localGraphInstance) { this._localGraphInstance.destroy(); this._localGraphInstance = null; }
      this._lastObservedArticleId = undefined;
      this._loadedArticleTitle = null;
      this.closeSuggest();
      this.closeHighlightPicker();
      this.closeBlockTypeMenu();
      this.closeBlockActionsMenu();
    }

    // ===== Документ: вставка/удаление/перемещение блоков =====

    getActiveList() {
      return (this._active && this._active.list) || this.doc.blocks;
    }

    setActive(list, block, textInputEl) {
      this._active = { list, block };
      if (textInputEl) this._activeTextInput = { el: textInputEl, list, block };
    }

    insertBlockAfterActive(type, extra) {
      const list = this.getActiveList();
      const block = makeBlock(type, defaultBlockData(type, extra));
      const active = this._active && list.includes(this._active.block) ? this._active.block : null;
      const idx = active ? list.indexOf(active) + 1 : list.length;
      list.splice(idx, 0, block);
      this._pendingFocusBlockId = block.id;
      this._active = { list, block };
      this.renderAll();
      this.scheduleRenderPreview();
      return block;
    }

    removeBlockFrom(list, block) {
      const idx = list.indexOf(block);
      if (idx === -1) return;
      if (!confirm('Удалить этот блок?')) return;
      list.splice(idx, 1);
      if (this._active && this._active.block === block) this._active = null;
      this.renderAll();
      this.scheduleRenderPreview();
    }

    moveBlockIn(list, block, dir) {
      const idx = list.indexOf(block);
      const to = idx + dir;
      if (idx === -1 || to < 0 || to >= list.length) return;
      [list[idx], list[to]] = [list[to], list[idx]];
      this.renderAll();
      this.scheduleRenderPreview();
    }

    // ===== Рендер списка блоков (используется и для верхнего уровня, и для
    // вложенных columns/spoiler-section) =====

    renderAll() {
      // Пустой документ должен оставаться печатаемым сразу, без похода в
      // тулбар за первым блоком — гарантируем хотя бы один пустой paragraph
      // (в статью он не попадёт: пустой markdown ничего не рендерит, см.
      // blocks-renderer.js).
      if (!this.doc.blocks.length) {
        const first = makeBlock('paragraph', defaultBlockData('paragraph'));
        this.doc.blocks.push(first);
        this._pendingFocusBlockId = first.id;
      }

      while (this.container.firstChild) this.container.removeChild(this.container.firstChild);
      this.renderBlockList(this.doc.blocks, this.container, { nested: false });

      // Авторазмер по высоте (см. .eb-text/.eb-code-text/.eb-input-auto) у
      // каждого текстового поля сам себя выставляет через requestAnimationFrame
      // при создании — годится, пока печатаешь (каждая клавиша дозапускает
      // autosize() заново), но при ОТКРЫТИИ уже готовой статьи с длинным
      // текстом это "будущее" измерение сразу после вставки в детач-ветку
      // DOM иногда даёт заниженный scrollHeight, и поле остаётся в одну
      // строку, пока не тронешь его. Один проход по уже полностью
      // вставленному дереву — сразу с верными размерами.
      this.container.querySelectorAll('textarea').forEach((ta) => {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
      });

      if (this._pendingFocusBlockId) {
        const id = this._pendingFocusBlockId;
        this._pendingFocusBlockId = null;
        const target = this.container.querySelector(`[data-block-id="${id}"] [data-autofocus]`);
        if (target) target.focus();
      }
    }

    renderBlockList(list, containerEl, ctx) {
      list.forEach((block) => {
        const wrap = this.renderBlockWrapper(block, list, ctx);
        containerEl.appendChild(wrap);
      });
    }

    renderBlockWrapper(block, list, ctx) {
      const wrap = document.createElement('div');
      wrap.className = 'eb-block eb-' + block.type + (block.type === 'heading' ? ` eb-heading-${block.data.level}` : '');
      wrap.dataset.blockId = block.id;

      const controls = document.createElement('div');
      controls.className = 'eb-block-controls';
      const upBtn = document.createElement('button'); upBtn.type = 'button'; upBtn.title = 'Переместить выше'; upBtn.innerHTML = '<i class="fas fa-chevron-up"></i>';
      upBtn.addEventListener('click', () => this.moveBlockIn(list, block, -1));
      const downBtn = document.createElement('button'); downBtn.type = 'button'; downBtn.title = 'Переместить ниже'; downBtn.innerHTML = '<i class="fas fa-chevron-down"></i>';
      downBtn.addEventListener('click', () => this.moveBlockIn(list, block, 1));
      const delBtn = document.createElement('button'); delBtn.type = 'button'; delBtn.title = 'Удалить блок'; delBtn.className = 'eb-remove'; delBtn.innerHTML = '<i class="fas fa-trash"></i>';
      delBtn.addEventListener('click', () => this.removeBlockFrom(list, block));
      controls.append(upBtn, downBtn, delBtn);

      // Та же тройка действий, но одной кнопкой "⋮" с попап-меню — только для
      // тач-экрана (см. .eb-block-more-btn в editor-blocks.css). Стек из трёх
      // кнопок ПО ВЫСОТЕ (~100px) не помещается в короткие блоки (разделитель,
      // однострочный заголовок) и наезжает на соседний блок снизу — этого не
      // было видно на десктопе, пока контролы появлялись только по :hover, но
      // стало заметно, когда на тач-устройствах их сделали видимыми всегда
      // (там :hover нет физически). Одна кнопка высотой ~26px помещается
      // в любой блок.
      const moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'eb-block-more-btn';
      moreBtn.title = 'Действия с блоком';
      moreBtn.innerHTML = '<i class="fas fa-ellipsis-vertical"></i>';
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openBlockActionsMenu(moreBtn, list, block);
      });

      const tag = document.createElement('span');
      tag.className = 'eb-block-type-tag';
      tag.textContent = blockTypeTag(block);

      wrap.addEventListener('focusin', () => { this._active = { list, block }; });

      const body = this.renderBlockBody(block, list, ctx) || document.createElement('div');
      wrap.append(controls, moreBtn, tag, body);
      return wrap;
    }

    renderBlockBody(block, list, ctx) {
      switch (block.type) {
        case 'paragraph': return this.renderTextBody(block, list, { placeholder: 'Начните писать текст… Enter — новый абзац, Shift+Enter — перенос строки.', autofocus: true, splitOnEnter: true });
        case 'heading': return this.renderTextBody(block, list, { placeholder: `Заголовок H${block.data.level}`, autofocus: true, splitOnEnter: true });
        case 'quote': return this.renderTextBody(block, list, { placeholder: 'Текст цитаты…', autofocus: true });
        case 'code': return this.renderCodeBody(block, list);
        case 'list': return this.renderListBody(block, list);
        case 'table': return this.renderTableBody(block, list);
        case 'divider': return this.renderDividerBody();
        case 'image': return this.renderImageBody(block);
        case 'columns': return this.renderColumnsBody(block);
        case 'infobox': return this.renderInfoboxBody(block);
        case 'callout': return this.renderCalloutBody(block, list);
        case 'spoiler-section': return this.renderSpoilerSectionBody(block);
        default: return document.createElement('div');
      }
    }

    // ===== Текстовое markdown-поле (paragraph/heading/quote/callout-текст/
    // пункт списка/ячейка таблицы) — общая логика авторазмера, привязки
    // фокуса к тулбару и автодополнения [[wiki-ссылок]] =====

    makeTextArea(value, { placeholder, className, autofocus, splitOnEnter, onInput, list, block } = {}) {
      const ta = document.createElement('textarea');
      ta.className = 'eb-text' + (className ? ' ' + className : '');
      ta.value = value || '';
      ta.rows = 1;
      if (placeholder) ta.placeholder = placeholder;
      if (autofocus) ta.dataset.autofocus = '1';
      if (splitOnEnter) ta.dataset.splitOnEnter = '1';

      const autosize = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
      requestAnimationFrame(autosize);

      ta.addEventListener('focus', () => this.setActive(list, block, ta));
      ta.addEventListener('input', () => {
        autosize();
        if (onInput) onInput(ta.value);
        this.scheduleRenderPreview();
        this.updateWikilinkSuggest(ta);
      });
      ta.addEventListener('keydown', (e) => this.handleTextKeydown(e, ta));
      ta.addEventListener('blur', () => setTimeout(() => this.closeSuggest(), 150));

      return ta;
    }

    handleTextKeydown(e, ta) {
      if (this._suggestEl && !this._suggestEl.hidden) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.moveSuggestSelection(e.key === 'ArrowDown' ? 1 : -1); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.applySuggestSelection(ta); return; }
        if (e.key === 'Escape') { this.closeSuggest(); return; }
      }
      // Enter — новый abzац-блок сразу после текущего (текст после курсора
      // переезжает в него); Shift+Enter — обычный перенос строки внутри
      // блока (браузер обрабатывает сам, здесь ничего не перехватываем).
      // Так пишется "просто текст" без похода в тулбар за каждым абзацем.
      if (ta.dataset.splitOnEnter && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.splitTextBlockAtCursor(ta);
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); this.applyInlineFormat('**'); }
      else if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); this.applyInlineFormat('_'); }
      else if (mod && e.key.toLowerCase() === 'u') { e.preventDefault(); this.applyInlineFormat('++'); }
      else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); this.insertLinkInline(); }
    }

    splitTextBlockAtCursor(ta) {
      const active = this._activeTextInput;
      if (!active) return;
      const { list, block } = active;
      const pos = ta.selectionStart;
      const before = ta.value.slice(0, pos);
      const after = ta.value.slice(pos);
      block.data.markdown = before;
      const newBlock = makeBlock('paragraph', { markdown: after });
      const idx = list.indexOf(block);
      list.splice(idx === -1 ? list.length : idx + 1, 0, newBlock);
      this._pendingFocusBlockId = newBlock.id;
      this.renderAll();
      this.scheduleRenderPreview();
    }

    renderTextBody(block, list, { placeholder, className, autofocus, splitOnEnter }) {
      return this.makeTextArea(block.data.markdown, {
        placeholder, className, autofocus, splitOnEnter, list, block,
        onInput: (val) => { block.data.markdown = val; }
      });
    }

    // ===== Форматирование выделения в активном текстовом поле =====

    applyInlineFormat(before, after = before) {
      const target = this._activeTextInput;
      if (!target || !document.body.contains(target.el)) {
        window.showMessage?.('Сначала кликните в текстовый блок', 'warning');
        return;
      }
      const el = target.el;
      const start = el.selectionStart, end = el.selectionEnd;
      const value = el.value;
      const selected = value.slice(start, end);

      // Пробелы на краях выделения (например, двойной клик по слову часто
      // прихватывает пробел после него) ломают markdown — маркер сразу
      // после/перед пробелом невалиден по CommonMark ("**test **" не
      // распознаётся как жирный) и просто остаётся сырым текстом в
      // превью. Подрезаем маркеры к границам текста без пробелов, а сами
      // пробелы оставляем СНАРУЖИ обёртки.
      const leadWs = selected.match(/^\s*/)[0];
      const trailWs = selected.match(/\s*$/)[0];
      const core = selected.slice(leadWs.length, selected.length - trailWs.length);

      el.value = value.slice(0, start) + leadWs + before + core + after + trailWs + value.slice(end);
      const coreStart = start + leadWs.length + before.length;
      el.selectionStart = coreStart;
      el.selectionEnd = coreStart + core.length;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
    }

    insertLinkInline() {
      const target = this._activeTextInput;
      if (!target) { window.showMessage?.('Сначала кликните в текстовый блок', 'warning'); return; }
      const url = prompt('Введите URL ссылки:');
      if (!url) return;
      const el = target.el;
      const start = el.selectionStart, end = el.selectionEnd;
      const text = el.value.slice(start, end) || 'ссылка';
      const insert = `[${text}](${url})`;
      el.value = el.value.slice(0, start) + insert + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + insert.length;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
    }

    insertWikilinkInline() {
      const target = this._activeTextInput;
      if (!target) { window.showMessage?.('Сначала кликните в текстовый блок', 'warning'); return; }
      this.applyInlineFormat('[[', ']]');
    }

    // ===== Автодополнение [[wiki-ссылок]] =====

    ensureSuggestEl() {
      if (this._suggestEl) return this._suggestEl;
      const el = document.createElement('div');
      el.className = 'eb-wikilink-suggest';
      el.hidden = true;
      document.body.appendChild(el);
      this._suggestEl = el;
      return el;
    }

    closeSuggest() {
      if (this._suggestEl) this._suggestEl.hidden = true;
    }

    updateWikilinkSuggest(ta) {
      const before = ta.value.slice(0, ta.selectionStart);
      const m = WIKILINK_OPEN_RE.exec(before);
      if (!m) { this.closeSuggest(); return; }
      const query = m[1].toLowerCase();
      const options = this.articlesIndex.filter((a) => a.title.toLowerCase().includes(query)).slice(0, 20);
      if (!options.length) { this.closeSuggest(); return; }

      const el = this.ensureSuggestEl();
      el.innerHTML = '';
      options.forEach((a, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = a.title;
        if (i === 0) btn.classList.add('eb-suggest-active');
        btn.addEventListener('mousedown', (e) => { e.preventDefault(); this.applySuggestSelection(ta); });
        el.appendChild(btn);
      });
      // position:fixed — чистые viewport-координаты, без +scrollX/Y (см.
      // комментарий у .eb-wikilink-suggest в editor-blocks.css).
      const rect = ta.getBoundingClientRect();
      el.style.left = `${rect.left}px`;
      el.style.top = `${rect.bottom + 4}px`;
      el.hidden = false;
      this._suggestTarget = ta;
    }

    moveSuggestSelection(dir) {
      const el = this._suggestEl;
      if (!el) return;
      const buttons = Array.from(el.querySelectorAll('button'));
      let idx = buttons.findIndex((b) => b.classList.contains('eb-suggest-active'));
      buttons[idx]?.classList.remove('eb-suggest-active');
      idx = (idx + dir + buttons.length) % buttons.length;
      buttons[idx]?.classList.add('eb-suggest-active');
    }

    applySuggestSelection(ta) {
      const el = this._suggestEl;
      const active = el && el.querySelector('button.eb-suggest-active');
      if (!active) { this.closeSuggest(); return; }
      const title = active.textContent;
      const before = ta.value.slice(0, ta.selectionStart);
      const m = WIKILINK_OPEN_RE.exec(before);
      if (!m) { this.closeSuggest(); return; }
      const openStart = ta.selectionStart - m[1].length;
      const after = ta.value.slice(ta.selectionStart);
      const closeAlready = after.startsWith(']]');
      const insert = title + (closeAlready ? '' : ']]');
      ta.value = ta.value.slice(0, openStart) + insert + after;
      const pos = openStart + insert.length;
      ta.selectionStart = ta.selectionEnd = pos;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      this.closeSuggest();
      ta.focus();
    }

    // ===== Код-блок =====

    renderCodeBody(block, list) {
      const wrap = document.createElement('div');
      const lang = document.createElement('input');
      lang.type = 'text';
      lang.className = 'eb-input';
      lang.placeholder = 'язык (необязательно, например js)';
      lang.style.marginBottom = '6px';
      lang.value = block.data.language || '';
      lang.addEventListener('input', () => { block.data.language = lang.value; this.scheduleRenderPreview(); });

      const code = document.createElement('textarea');
      code.className = 'eb-text eb-code-text';
      code.rows = 3;
      code.value = block.data.code || '';
      code.dataset.autofocus = '1';
      const autosize = () => { code.style.height = 'auto'; code.style.height = code.scrollHeight + 'px'; };
      requestAnimationFrame(autosize);
      code.addEventListener('input', () => { block.data.code = code.value; autosize(); this.scheduleRenderPreview(); });
      code.addEventListener('focus', () => { this._active = { list, block }; this._activeTextInput = null; });

      wrap.append(lang, code);
      return wrap;
    }

    // ===== Список =====

    renderListBody(block, list) {
      const wrap = document.createElement('div');
      const styleGroup = document.createElement('div');
      styleGroup.className = 'eb-list-style-group';
      [['bullet', 'Маркеры'], ['ordered', 'Нумерация'], ['checklist', 'Чек-лист']].forEach(([style, label]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.classList.toggle('active', block.data.style === style);
        btn.addEventListener('click', () => { block.data.style = style; this.renderAll(); this.scheduleRenderPreview(); });
        styleGroup.appendChild(btn);
      });
      wrap.appendChild(styleGroup);

      const itemsEl = document.createElement('div');
      itemsEl.className = 'eb-gap';
      block.data.items.forEach((item, idx) => itemsEl.appendChild(this.renderListItem(block, item, idx, list)));
      wrap.appendChild(itemsEl);

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'eb-mini-btn';
      addBtn.innerHTML = '<i class="fas fa-plus"></i> Пункт';
      addBtn.addEventListener('click', () => {
        block.data.items.push({ markdown: '', checked: false });
        this._pendingFocusBlockId = block.id;
        this.renderAll();
      });
      wrap.appendChild(addBtn);
      return wrap;
    }

    renderListItem(block, item, idx, list) {
      const row = document.createElement('div');
      row.className = 'eb-list-item';

      if (block.data.style === 'checklist') {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!item.checked;
        cb.addEventListener('change', () => { item.checked = cb.checked; this.scheduleRenderPreview(); });
        row.appendChild(cb);
      } else {
        const marker = document.createElement('span');
        marker.className = 'eb-list-marker';
        marker.textContent = block.data.style === 'ordered' ? `${idx + 1}.` : '•';
        row.appendChild(marker);
      }

      const ta = this.makeTextArea(item.markdown, {
        placeholder: 'Пункт списка…',
        list, block,
        autofocus: idx === block.data.items.length - 1 && idx > 0,
        onInput: (val) => { item.markdown = val; }
      });
      ta.addEventListener('keydown', (e) => {
        if (this._suggestEl && !this._suggestEl.hidden) return; // автодополнение уже перехватило клавиши
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          block.data.items.splice(idx + 1, 0, { markdown: '', checked: false });
          this._pendingFocusBlockId = block.id;
          this.renderAll();
        } else if (e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0 && block.data.items.length > 1) {
          e.preventDefault();
          block.data.items.splice(idx, 1);
          this._pendingFocusBlockId = block.id;
          this.renderAll();
        }
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'eb-icon-btn';
      del.title = 'Удалить пункт';
      del.innerHTML = '<i class="fas fa-xmark"></i>';
      del.addEventListener('click', () => {
        if (block.data.items.length <= 1) return;
        block.data.items.splice(idx, 1);
        this.renderAll();
        this.scheduleRenderPreview();
      });

      row.append(ta, del);
      return row;
    }

    // ===== Таблица =====

    renderTableBody(block, list) {
      const wrap = document.createElement('div');
      const table = document.createElement('table');
      table.className = 'eb-table';
      block.data.rows.forEach((row, r) => {
        const tr = document.createElement('tr');
        row.forEach((cell, c) => {
          const td = document.createElement('td');
          const input = document.createElement('input');
          input.type = 'text';
          input.value = cell;
          input.placeholder = block.data.header && r === 0 ? `Колонка ${c + 1}` : '';
          input.addEventListener('focus', () => { this._activeTextInput = { el: input, list, block }; this._active = { list, block }; });
          input.addEventListener('input', () => { block.data.rows[r][c] = input.value; this.scheduleRenderPreview(); });
          td.appendChild(input);
          tr.appendChild(td);
        });
        table.appendChild(tr);
      });
      wrap.appendChild(table);

      const toolbar = document.createElement('div');
      toolbar.className = 'eb-table-toolbar';
      const addRow = document.createElement('button'); addRow.type = 'button'; addRow.className = 'eb-mini-btn'; addRow.innerHTML = '<i class="fas fa-plus"></i> Строка';
      addRow.addEventListener('click', () => { block.data.rows.push(block.data.rows[0].map(() => '')); this.renderAll(); this.scheduleRenderPreview(); });
      const addCol = document.createElement('button'); addCol.type = 'button'; addCol.className = 'eb-mini-btn'; addCol.innerHTML = '<i class="fas fa-plus"></i> Колонка';
      addCol.addEventListener('click', () => { block.data.rows.forEach((row) => row.push('')); this.renderAll(); this.scheduleRenderPreview(); });
      const headerToggle = document.createElement('label'); headerToggle.className = 'eb-row'; headerToggle.style.fontSize = '12px'; headerToggle.style.color = 'var(--text-muted)';
      const headerCb = document.createElement('input'); headerCb.type = 'checkbox'; headerCb.checked = block.data.header;
      headerCb.addEventListener('change', () => { block.data.header = headerCb.checked; this.scheduleRenderPreview(); });
      headerToggle.append(headerCb, document.createTextNode(' первая строка — заголовок'));
      toolbar.append(addRow, addCol, headerToggle);
      wrap.appendChild(toolbar);
      return wrap;
    }

    // ===== Разделитель =====

    renderDividerBody() {
      const wrap = document.createElement('div');
      wrap.className = 'eb-divider-block';
      wrap.innerHTML = '<i class="fas fa-minus"></i><hr><span>Разделитель</span>';
      return wrap;
    }

    // ===== Картинка =====

    renderImageBody(block) {
      const wrap = document.createElement('div');
      if (!block.data.src) {
        const placeholder = document.createElement('div');
        placeholder.className = 'eb-image-placeholder';
        placeholder.innerHTML = '<i class="fas fa-image"></i> Нажмите, чтобы загрузить изображение';
        placeholder.addEventListener('click', () => this.pickAndUploadImageForBlock(block));
        wrap.appendChild(placeholder);
        return wrap;
      }

      const holder = document.createElement('div');
      holder.className = 'eb-image-block';
      const img = document.createElement('img');
      img.src = block.data.src;
      img.alt = block.data.alt || '';
      img.style.width = block.data.align === 'full' ? '100%' : `${block.data.widthPct}%`;
      if (block.data.frame && block.data.frame.show) img.style.border = `3px solid ${block.data.frame.color}`;
      const settingsBtn = document.createElement('button');
      settingsBtn.type = 'button';
      settingsBtn.className = 'eb-image-settings-btn';
      settingsBtn.innerHTML = '<i class="fas fa-gear"></i> Настроить';
      settingsBtn.addEventListener('click', () => this.editImageBlock(block));
      holder.append(img, settingsBtn);
      wrap.appendChild(holder);
      return wrap;
    }

    async pickAndUploadImageForBlock(block) {
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.onchange = async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        const url = await this.uploadImageFile(file);
        if (!url) return;
        const choice = await this.openImageDialog({ title: 'Вставить изображение', src: url, alt: '', width: 100, align: 'center', frameShow: false, frameColor: DEFAULT_FRAME_COLOR, allowDelete: false, allowReplace: true });
        if (!choice || choice.action !== 'save') return;
        block.data = { src: url, alt: choice.alt, widthPct: choice.width, align: choice.align, frame: { show: choice.frameShow, color: choice.frameColor } };
        this.renderAll();
        this.scheduleRenderPreview();
      };
      fileInput.click();
    }

    async editImageBlock(block) {
      const list = this.getActiveList();
      const choice = await this.openImageDialog({
        title: 'Настройки изображения', src: block.data.src, alt: block.data.alt,
        width: block.data.widthPct, align: block.data.align,
        frameShow: block.data.frame && block.data.frame.show, frameColor: (block.data.frame && block.data.frame.color) || DEFAULT_FRAME_COLOR,
        allowDelete: true, allowReplace: true
      });
      if (!choice) return;
      if (choice.action === 'delete') {
        this.removeBlockFrom(this.findBlockList(block) || list, block);
        return;
      }
      block.data = { src: choice.replacedSrc || block.data.src, alt: choice.alt, widthPct: choice.width, align: choice.align, frame: { show: choice.frameShow, color: choice.frameColor } };
      this.renderAll();
      this.scheduleRenderPreview();
    }

    // Ищет, в каком списке блоков (верхний уровень / колонка / спойлер-секция)
    // сейчас лежит блок — нужно, если удаление картинки инициировано из
    // диалога, а не прямым кликом (тогда точный list уже неизвестен).
    findBlockList(block, blocks = this.doc.blocks) {
      if (blocks.includes(block)) return blocks;
      for (const b of blocks) {
        if (b.type === 'columns') {
          for (const col of b.data.columns) {
            const found = this.findBlockList(block, col.blocks);
            if (found) return found;
          }
        } else if (b.type === 'spoiler-section') {
          const found = this.findBlockList(block, b.data.blocks);
          if (found) return found;
        }
      }
      return null;
    }

    async uploadImageFile(file) {
      if (!file.type.startsWith('image/')) { window.showMessage?.('Пожалуйста, выберите файл изображения', 'error'); return null; }
      if (file.size > 5 * 1024 * 1024) { window.showMessage?.('Размер файла превышает допустимый лимит (5MB)', 'error'); return null; }
      try {
        const result = await window.apiClient.uploadImage(file);
        if (!result.success) { window.showMessage?.('Ошибка при загрузке изображения: ' + result.error, 'error'); return null; }
        return result.data.url;
      } catch (e) {
        window.showMessage?.('Произошла ошибка при загрузке изображения', 'error');
        return null;
      }
    }

    // ===== Диалог размера/положения/рамки картинки (упрощён относительно
    // прежней версии — режим "колонка" убран: та же задача "картинка +
    // текст рядом фиксированной ширины" теперь явный блок `columns`, а не
    // атрибут картинки, см. решение "отказ от {align=column}") =====

    ensureImageDialogEl() {
      if (this._imgDialogEl) return this._imgDialogEl;
      const el = document.createElement('div');
      el.className = 'img-dialog-backdrop';
      el.hidden = true;
      el.innerHTML = `
        <div class="img-dialog" role="dialog" aria-modal="true">
          <div class="img-dialog-header">
            <h3 id="imgDialogTitle">Изображение</h3>
            <button type="button" class="btn-close" id="imgDialogClose" title="Закрыть">&times;</button>
          </div>
          <div class="img-dialog-body">
            <div class="img-dialog-preview"><img id="imgDialogThumb" src="" alt=""></div>
            <div class="img-dialog-field">
              <label for="imgDialogAlt">Подпись (alt)</label>
              <input type="text" id="imgDialogAlt" class="form-input" placeholder="Описание изображения">
            </div>
            <div class="img-dialog-field">
              <label>Положение</label>
              <div class="img-dialog-align-group" id="imgDialogAlignGroup">
                <button type="button" data-align="left" title="Слева — текст обтекает справа"><i class="fas fa-align-left"></i></button>
                <button type="button" data-align="center" title="По центру"><i class="fas fa-align-center"></i></button>
                <button type="button" data-align="right" title="Справа — текст обтекает слева"><i class="fas fa-align-right"></i></button>
                <button type="button" data-align="full" title="Во всю ширину"><i class="fas fa-arrows-left-right"></i></button>
              </div>
            </div>
            <div class="img-dialog-field" id="imgDialogWidthField">
              <label>Размер: <span id="imgDialogWidthValue">100</span>% ширины текста</label>
              <div class="img-dialog-presets">
                <button type="button" data-width="25">25%</button>
                <button type="button" data-width="50">50%</button>
                <button type="button" data-width="75">75%</button>
                <button type="button" data-width="100">100%</button>
              </div>
              <input type="range" id="imgDialogWidthRange" min="10" max="100" step="1" value="100">
            </div>
            <div class="img-dialog-field img-dialog-frame-field">
              <label class="img-dialog-checkbox">
                <input type="checkbox" id="imgDialogFrameShow">
                <span>Показывать рамку вокруг картинки</span>
              </label>
              <div class="img-dialog-frame-color" id="imgDialogFrameColorRow">
                <label for="imgDialogFrameColor">Цвет рамки</label>
                <input type="color" id="imgDialogFrameColor" value="#5865f2">
              </div>
            </div>
          </div>
          <div class="img-dialog-footer">
            <button type="button" class="btn btn-danger" id="imgDialogDelete" hidden>Удалить</button>
            <button type="button" class="btn btn-secondary" id="imgDialogReplace" hidden>Заменить файл</button>
            <div class="img-dialog-footer-spacer"></div>
            <button type="button" class="btn btn-secondary" id="imgDialogCancel">Отмена</button>
            <button type="button" class="btn btn-primary" id="imgDialogSave">Готово</button>
          </div>
        </div>`;
      document.body.appendChild(el);
      this._imgDialogEl = el;

      el.addEventListener('mousedown', (e) => { if (e.target === el) this.closeImageDialog(null); });
      el.querySelector('#imgDialogClose').addEventListener('click', () => this.closeImageDialog(null));
      el.querySelector('#imgDialogCancel').addEventListener('click', () => this.closeImageDialog(null));
      el.querySelector('#imgDialogSave').addEventListener('click', () => this.closeImageDialog('save'));
      el.querySelector('#imgDialogDelete').addEventListener('click', () => this.closeImageDialog('delete'));
      el.querySelector('#imgDialogReplace').addEventListener('click', () => this.replaceImageDialogFile());

      el.querySelectorAll('#imgDialogAlignGroup button').forEach((btn) => {
        btn.addEventListener('click', () => {
          el.querySelectorAll('#imgDialogAlignGroup button').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          this._imgDialogState.align = btn.getAttribute('data-align');
          this.updateImageDialogWidthUI();
        });
      });
      el.querySelectorAll('#imgDialogWidthField .img-dialog-presets button').forEach((btn) => {
        btn.addEventListener('click', () => {
          const w = parseInt(btn.getAttribute('data-width'), 10);
          this._imgDialogState.width = w;
          el.querySelector('#imgDialogWidthRange').value = String(w);
          el.querySelector('#imgDialogWidthValue').textContent = String(w);
        });
      });
      el.querySelector('#imgDialogWidthRange').addEventListener('input', (e) => {
        const w = parseInt(e.target.value, 10) || 100;
        this._imgDialogState.width = w;
        el.querySelector('#imgDialogWidthValue').textContent = String(w);
      });
      el.querySelector('#imgDialogFrameShow').addEventListener('change', (e) => {
        this._imgDialogState.frameShow = e.target.checked;
        this.updateImageDialogFrameUI();
      });
      el.querySelector('#imgDialogFrameColor').addEventListener('input', (e) => { this._imgDialogState.frameColor = e.target.value; });

      return el;
    }

    openImageDialog(opts) {
      const el = this.ensureImageDialogEl();
      this._imgDialogState = {
        src: opts.src, alt: opts.alt || '', width: opts.width != null ? opts.width : 100,
        align: ['left', 'right', 'center', 'full'].includes(opts.align) ? opts.align : 'center',
        frameShow: !!opts.frameShow, frameColor: opts.frameColor || DEFAULT_FRAME_COLOR
      };
      el.querySelector('#imgDialogTitle').textContent = opts.title || 'Изображение';
      el.querySelector('#imgDialogThumb').src = opts.src || '';
      el.querySelector('#imgDialogAlt').value = this._imgDialogState.alt;
      el.querySelectorAll('#imgDialogAlignGroup button').forEach((b) => b.classList.toggle('active', b.getAttribute('data-align') === this._imgDialogState.align));
      el.querySelector('#imgDialogWidthRange').value = String(this._imgDialogState.width);
      el.querySelector('#imgDialogWidthValue').textContent = String(this._imgDialogState.width);
      el.querySelector('#imgDialogFrameShow').checked = this._imgDialogState.frameShow;
      el.querySelector('#imgDialogFrameColor').value = this._imgDialogState.frameColor;
      el.querySelector('#imgDialogDelete').hidden = !opts.allowDelete;
      el.querySelector('#imgDialogReplace').hidden = !opts.allowReplace;
      this.updateImageDialogWidthUI();
      this.updateImageDialogFrameUI();
      el.hidden = false;
      setTimeout(() => el.querySelector('#imgDialogAlt')?.focus(), 0);
      return new Promise((resolve) => { this._imgDialogResolve = resolve; });
    }

    updateImageDialogWidthUI() {
      const el = this._imgDialogEl;
      if (!el) return;
      const isFull = this._imgDialogState.align === 'full';
      el.querySelector('#imgDialogWidthRange').disabled = isFull;
      el.querySelectorAll('#imgDialogWidthField .img-dialog-presets button').forEach((b) => { b.disabled = isFull; });
    }

    updateImageDialogFrameUI() {
      const el = this._imgDialogEl;
      if (!el) return;
      const show = this._imgDialogState.frameShow;
      el.querySelector('#imgDialogFrameColorRow').classList.toggle('img-dialog-field-disabled', !show);
      el.querySelector('#imgDialogFrameColor').disabled = !show;
    }

    closeImageDialog(result) {
      const el = this._imgDialogEl;
      if (!el) return;
      el.hidden = true;
      const resolve = this._imgDialogResolve;
      this._imgDialogResolve = null;
      if (!resolve) return;
      if (result === 'save') {
        resolve({
          action: 'save', alt: el.querySelector('#imgDialogAlt').value.trim(),
          width: this._imgDialogState.width, align: this._imgDialogState.align,
          src: this._imgDialogState.src, frameShow: this._imgDialogState.frameShow, frameColor: this._imgDialogState.frameColor,
          replacedSrc: this._imgDialogState.replacedSrc
        });
      } else if (result === 'delete') {
        resolve({ action: 'delete' });
      } else {
        resolve(null);
      }
    }

    replaceImageDialogFile() {
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.onchange = async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        const url = await this.uploadImageFile(file);
        if (!url) return;
        this._imgDialogState.src = url;
        this._imgDialogState.replacedSrc = url;
        this._imgDialogEl.querySelector('#imgDialogThumb').src = url;
      };
      fileInput.click();
    }

    // ===== Инфобокс =====

    renderInfoboxBody(block) {
      const wrap = document.createElement('div');
      wrap.className = 'eb-infobox-editor eb-gap';

      const titleInput = document.createElement('input');
      titleInput.type = 'text'; titleInput.className = 'eb-input'; titleInput.placeholder = 'Название (например «Ранг «Ветеран»»)';
      titleInput.value = block.data.title || '';
      titleInput.dataset.autofocus = '1';
      titleInput.addEventListener('input', () => { block.data.title = titleInput.value; this.scheduleRenderPreview(); });
      wrap.appendChild(titleInput);

      const coverRow = document.createElement('div');
      coverRow.className = 'eb-infobox-cover';
      if (block.data.image) {
        const img = document.createElement('img'); img.src = block.data.image.src;
        const removeBtn = document.createElement('button'); removeBtn.type = 'button'; removeBtn.className = 'eb-mini-btn'; removeBtn.textContent = 'Убрать картинку';
        removeBtn.addEventListener('click', () => { block.data.image = null; this.renderAll(); this.scheduleRenderPreview(); });
        coverRow.append(img, removeBtn);
      } else {
        const addBtn = document.createElement('button'); addBtn.type = 'button'; addBtn.className = 'eb-mini-btn';
        addBtn.innerHTML = '<i class="fas fa-image"></i> Добавить картинку';
        addBtn.addEventListener('click', async () => {
          const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.accept = 'image/*';
          fileInput.onchange = async (e) => {
            const file = e.target.files[0]; if (!file) return;
            const url = await this.uploadImageFile(file);
            if (!url) return;
            block.data.image = { src: url, alt: block.data.title || '' };
            this.renderAll(); this.scheduleRenderPreview();
          };
          fileInput.click();
        });
        coverRow.appendChild(addBtn);
      }
      wrap.appendChild(coverRow);

      const rowsLabel = document.createElement('span'); rowsLabel.className = 'eb-field-label'; rowsLabel.textContent = 'Характеристики';
      wrap.appendChild(rowsLabel);

      block.data.rows.forEach((row, idx) => {
        const rowEl = document.createElement('div'); rowEl.className = 'eb-infobox-row';
        const label = document.createElement('input'); label.type = 'text'; label.className = 'eb-input'; label.placeholder = 'Поле'; label.value = row.label;
        label.addEventListener('input', () => { row.label = label.value; this.scheduleRenderPreview(); });

        // Значение — как обычные текстовые блоки (eb-text): textarea, сама
        // растёт по высоте, а не однострочный input, где длинный текст
        // просто уезжает за край и не виден целиком (см. запрос "сделай
        // расширяемой, как обычные блоки с текстом").
        const value = document.createElement('textarea');
        value.className = 'eb-input eb-input-auto'; value.rows = 1; value.placeholder = 'Значение'; value.value = row.value;
        const autosizeValue = () => { value.style.height = 'auto'; value.style.height = value.scrollHeight + 'px'; };
        requestAnimationFrame(autosizeValue);
        value.addEventListener('input', () => { row.value = value.value; autosizeValue(); this.scheduleRenderPreview(); });

        const del = document.createElement('button'); del.type = 'button'; del.className = 'eb-icon-btn'; del.innerHTML = '<i class="fas fa-xmark"></i>';
        del.addEventListener('click', () => { if (block.data.rows.length <= 1) return; block.data.rows.splice(idx, 1); this.renderAll(); this.scheduleRenderPreview(); });
        rowEl.append(label, value, del);
        wrap.appendChild(rowEl);
      });

      const addRowBtn = document.createElement('button'); addRowBtn.type = 'button'; addRowBtn.className = 'eb-mini-btn'; addRowBtn.innerHTML = '<i class="fas fa-plus"></i> Строка';
      addRowBtn.addEventListener('click', () => { block.data.rows.push({ label: '', value: '' }); this.renderAll(); this.scheduleRenderPreview(); });
      wrap.appendChild(addRowBtn);
      return wrap;
    }

    // ===== Плашка-примечание (callout) =====

    renderCalloutBody(block, list) {
      const wrap = document.createElement('div');
      wrap.className = `eb-callout-editor eb-variant-${block.data.variant} eb-gap`;

      const variants = document.createElement('div'); variants.className = 'eb-callout-variant-group';
      [['info', 'fa-circle-info', 'Информация'], ['tip', 'fa-lightbulb', 'Совет'], ['warning', 'fa-triangle-exclamation', 'Осторожно']].forEach(([variant, icon, label]) => {
        const btn = document.createElement('button'); btn.type = 'button';
        btn.innerHTML = `<i class="fas ${icon}"></i> ${label}`;
        btn.classList.toggle('active', block.data.variant === variant);
        btn.addEventListener('click', () => { block.data.variant = variant; this.renderAll(); this.scheduleRenderPreview(); });
        variants.appendChild(btn);
      });
      wrap.appendChild(variants);

      const titleInput = document.createElement('input');
      titleInput.type = 'text'; titleInput.className = 'eb-input'; titleInput.placeholder = 'Заголовок плашки';
      titleInput.value = block.data.title || '';
      titleInput.addEventListener('input', () => { block.data.title = titleInput.value; this.scheduleRenderPreview(); });
      wrap.appendChild(titleInput);

      wrap.appendChild(this.makeTextArea(block.data.markdown, {
        placeholder: 'Текст примечания…', list, block, autofocus: true,
        onInput: (val) => { block.data.markdown = val; }
      }));
      return wrap;
    }

    // ===== Колонки =====

    renderColumnsBody(block) {
      const wrap = document.createElement('div');
      const colsWrap = document.createElement('div'); colsWrap.className = 'eb-columns-wrap';

      block.data.columns.forEach((col, idx) => {
        const colEl = document.createElement('div'); colEl.className = 'eb-column';
        const head = document.createElement('div'); head.className = 'eb-column-head';
        const widthInput = document.createElement('input'); widthInput.type = 'number'; widthInput.min = '10'; widthInput.max = '90'; widthInput.className = 'eb-input'; widthInput.value = col.widthPct;
        widthInput.addEventListener('input', () => { col.widthPct = parseInt(widthInput.value, 10) || 50; this.scheduleRenderPreview(); });
        head.append(document.createTextNode(`Колонка ${idx + 1}, `), widthInput, document.createTextNode('%'));
        colEl.appendChild(head);

        const nested = document.createElement('div'); nested.className = 'eb-nested-blocklist';
        this.renderBlockList(col.blocks, nested, { nested: true });
        colEl.appendChild(nested);

        colEl.appendChild(this.renderNestedAddButton(col.blocks));
        colsWrap.appendChild(colEl);
      });
      wrap.appendChild(colsWrap);

      const toolbar = document.createElement('div'); toolbar.className = 'eb-columns-toolbar';
      const addCol = document.createElement('button'); addCol.type = 'button'; addCol.className = 'eb-mini-btn'; addCol.innerHTML = '<i class="fas fa-plus"></i> Колонка';
      addCol.addEventListener('click', () => {
        if (block.data.columns.length >= 4) return;
        block.data.columns.push({ widthPct: Math.floor(100 / (block.data.columns.length + 1)), blocks: [] });
        this.renderAll(); this.scheduleRenderPreview();
      });
      const removeCol = document.createElement('button'); removeCol.type = 'button'; removeCol.className = 'eb-mini-btn'; removeCol.innerHTML = '<i class="fas fa-minus"></i> Колонка';
      removeCol.addEventListener('click', () => {
        if (block.data.columns.length <= 2) return;
        block.data.columns.pop();
        this.renderAll(); this.scheduleRenderPreview();
      });
      toolbar.append(addCol, removeCol);
      wrap.appendChild(toolbar);
      return wrap;
    }

    // ===== Сворачиваемая секция =====

    renderSpoilerSectionBody(block) {
      const wrap = document.createElement('div');
      wrap.className = 'eb-spoiler-section-editor eb-gap';

      const titleInput = document.createElement('input');
      titleInput.type = 'text'; titleInput.className = 'eb-input'; titleInput.placeholder = 'Заголовок секции (например «Патч-ноуты»)';
      titleInput.value = block.data.title || '';
      titleInput.dataset.autofocus = '1';
      titleInput.addEventListener('input', () => { block.data.title = titleInput.value; this.scheduleRenderPreview(); });
      wrap.appendChild(titleInput);

      const openLabel = document.createElement('label'); openLabel.className = 'eb-row'; openLabel.style.fontSize = '12px'; openLabel.style.color = 'var(--text-muted)';
      const openCb = document.createElement('input'); openCb.type = 'checkbox'; openCb.checked = !!block.data.openByDefault;
      openCb.addEventListener('change', () => { block.data.openByDefault = openCb.checked; this.scheduleRenderPreview(); });
      openLabel.append(openCb, document.createTextNode(' открыта по умолчанию у читателя'));
      wrap.appendChild(openLabel);

      const nested = document.createElement('div'); nested.className = 'eb-nested-blocklist';
      this.renderBlockList(block.data.blocks, nested, { nested: true });
      wrap.appendChild(nested);
      wrap.appendChild(this.renderNestedAddButton(block.data.blocks));
      return wrap;
    }

    // Маленькое меню "+ добавить блок" для вложенных списков (колонка/
    // спойлер-секция) — ограниченный набор типов, без бесконечной
    // вложенности контейнеров (см. NESTED_ALLOWED_TYPES). Список типов
    // вместо prompt() с вводом названия блока вручную — пользователь не
    // обязан помнить/угадывать, как называется нужный тип.
    renderNestedAddButton(list) {
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'eb-mini-btn eb-nested-add';
      addBtn.innerHTML = '<i class="fas fa-plus"></i> Добавить блок';
      addBtn.addEventListener('click', () => this.openBlockTypeMenu(addBtn, list));
      return addBtn;
    }

    // ===== Попап-меню выбора типа блока (та же схема "fixed-попап у кнопки
    // + закрытие по клику снаружи", что и у ensureHighlightPickerEl) =====

    ensureBlockTypeMenuEl() {
      if (this._blockTypeMenuEl) return this._blockTypeMenuEl;
      const el = document.createElement('div');
      el.className = 'eb-block-type-menu';
      el.hidden = true;
      document.body.appendChild(el);
      this._blockTypeMenuEl = el;

      document.addEventListener('mousedown', (e) => {
        if (el.hidden) return;
        if (el.contains(e.target)) return;
        if (this._blockTypeMenuAnchor && this._blockTypeMenuAnchor.contains(e.target)) return;
        this.closeBlockTypeMenu();
      });
      return el;
    }

    openBlockTypeMenu(anchorBtn, list) {
      const el = this.ensureBlockTypeMenuEl();
      this._blockTypeMenuAnchor = anchorBtn;
      el.innerHTML = '';
      NESTED_ALLOWED_TYPES.forEach((type) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.innerHTML = `<i class="fas ${NESTED_TYPE_ICONS[type] || 'fa-square'}"></i> ${TYPE_LABELS[type] || type}`;
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.closeBlockTypeMenu();
          const block = makeBlock(type, defaultBlockData(type));
          list.push(block);
          this._pendingFocusBlockId = block.id;
          this.renderAll();
          this.scheduleRenderPreview();
          if (type === 'image') this.pickAndUploadImageForBlock(block);
        });
        el.appendChild(btn);
      });
      const rect = anchorBtn.getBoundingClientRect();
      el.style.left = `${rect.left}px`;
      el.style.top = `${rect.bottom + 6}px`;
      el.hidden = false;
    }

    closeBlockTypeMenu() {
      if (this._blockTypeMenuEl) this._blockTypeMenuEl.hidden = true;
    }

    // ===== Попап-меню действий с блоком (▲▼🗑 одной кнопкой "⋮") — то же
    // самое, чем эта тройка была всегда, просто под кнопкой вместо стека
    // (см. .eb-block-more-btn, видна только на тач-устройствах). Переиспользует
    // класс .eb-block-type-menu — визуально это тот же попап-список. =====

    ensureBlockActionsMenuEl() {
      if (this._blockActionsMenuEl) return this._blockActionsMenuEl;
      const el = document.createElement('div');
      el.className = 'eb-block-type-menu';
      el.hidden = true;
      document.body.appendChild(el);
      this._blockActionsMenuEl = el;

      document.addEventListener('mousedown', (e) => {
        if (el.hidden) return;
        if (el.contains(e.target)) return;
        if (this._blockActionsMenuAnchor && this._blockActionsMenuAnchor.contains(e.target)) return;
        this.closeBlockActionsMenu();
      });
      return el;
    }

    openBlockActionsMenu(anchorBtn, list, block) {
      const el = this.ensureBlockActionsMenuEl();
      this._blockActionsMenuAnchor = anchorBtn;
      el.innerHTML = '';

      const items = [
        { icon: 'fa-chevron-up', label: 'Переместить выше', action: () => this.moveBlockIn(list, block, -1) },
        { icon: 'fa-chevron-down', label: 'Переместить ниже', action: () => this.moveBlockIn(list, block, 1) },
        { icon: 'fa-trash', label: 'Удалить блок', action: () => this.removeBlockFrom(list, block) }
      ];
      items.forEach(({ icon, label, action }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.innerHTML = `<i class="fas ${icon}"></i> ${label}`;
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.closeBlockActionsMenu();
          action();
        });
        el.appendChild(btn);
      });

      const rect = anchorBtn.getBoundingClientRect();
      el.style.left = `${rect.left}px`;
      el.style.top = `${rect.bottom + 6}px`;
      el.hidden = false;
    }

    closeBlockActionsMenu() {
      if (this._blockActionsMenuEl) this._blockActionsMenuEl.hidden = true;
    }

    // ===== Тулбар =====

    setupToolbar() {
      const toolbar = document.getElementById('toolbar') || document.querySelector('.editor-toolbar-sticky');
      if (!toolbar) return;

      toolbar.querySelectorAll('[data-inline-command]').forEach((btn) => {
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.runInlineCommand(btn.getAttribute('data-inline-command'), btn);
        });
      });
      toolbar.querySelectorAll('[data-block-command]').forEach((btn) => {
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.runBlockCommand(btn.getAttribute('data-block-command'), btn.dataset);
        });
      });

      this.setupToolbarScrollFade();
    }

    // Тень+стрелка у края ленты форматирования, пока есть куда прокрутить в
    // эту сторону (см. .toolbar-fade в views/articles.html) — актуально
    // только на телефоне (там лента становится overflow-x:auto, см. @media
    // в том же файле); на десктопе/планшете кнопки помещаются целиком,
    // scrollWidth === clientWidth, и классы can-scroll-* просто никогда не
    // появляются.
    //
    // #toolbarFormatRow — часть партиала articles.html, который spa-router
    // перезагружает fetch'ем при каждом заходе на страницу, поэтому сам
    // элемент каждый раз новый — слушатель скролла вешаем заново без
    // "once"-охраны. А вот window переживает такие заходы, так что resize-
    // слушатель на нём — ровно один на всё приложение (иначе с каждым новым
    // заходом на /articles копился бы ещё один, ссылающийся на уже
    // отсоединённые старые row/wrap) — и ищет актуальные элементы сам,
    // при каждом срабатывании, а не через захваченные при первом вызове.
    setupToolbarScrollFade() {
      const update = () => {
        const row = document.getElementById('toolbarFormatRow');
        const wrap = document.getElementById('toolbarFormatScroll');
        if (!row || !wrap) return;
        const maxScroll = row.scrollWidth - row.clientWidth;
        wrap.classList.toggle('can-scroll-l', row.scrollLeft > 2);
        wrap.classList.toggle('can-scroll-r', row.scrollLeft < maxScroll - 2);
      };
      document.getElementById('toolbarFormatRow')?.addEventListener('scroll', update, { passive: true });
      if (!this._toolbarFadeResizeBound) {
        this._toolbarFadeResizeBound = true;
        window.addEventListener('resize', update);
      }
      update();
    }

    runInlineCommand(command, btn) {
      switch (command) {
        case 'bold': this.applyInlineFormat('**'); break;
        case 'italic': this.applyInlineFormat('_'); break;
        case 'underline': this.applyInlineFormat('++'); break;
        case 'strike': this.applyInlineFormat('~~'); break;
        case 'highlight': this.openHighlightPicker(btn); break;
        case 'code': this.applyInlineFormat('`'); break;
        case 'spoiler': this.applyInlineFormat('||'); break;
        case 'link': this.insertLinkInline(); break;
        case 'wikilink': this.insertWikilinkInline(); break;
      }
    }

    // ===== Палитра цвета для выделения (==текст==(#hex), см.
    // blocks-renderer.js) — маленький попап у кнопки тулбара с готовыми
    // цветами + свой через нативный <input type="color">. =====

    ensureHighlightPickerEl() {
      if (this._hlPickerEl) return this._hlPickerEl;
      const el = document.createElement('div');
      el.className = 'eb-color-picker';
      el.hidden = true;
      const swatches = document.createElement('div');
      swatches.className = 'eb-color-picker-swatches';
      HIGHLIGHT_PRESETS.forEach(({ hex, label }) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'eb-color-swatch';
        b.style.background = hex;
        b.title = label;
        b.addEventListener('mousedown', (e) => { e.preventDefault(); this.applyHighlightColor(hex === DEFAULT_HIGHLIGHT_COLOR ? null : hex); });
        swatches.appendChild(b);
      });
      const custom = document.createElement('input');
      custom.type = 'color';
      custom.className = 'eb-color-swatch-custom';
      custom.title = 'Свой цвет';
      custom.value = DEFAULT_HIGHLIGHT_COLOR;
      custom.addEventListener('input', () => this.applyHighlightColor(custom.value));
      custom.addEventListener('mousedown', (e) => e.stopPropagation());
      swatches.appendChild(custom);
      el.appendChild(swatches);
      document.body.appendChild(el);
      this._hlPickerEl = el;

      // Клик вне попапа закрывает его — кроме клика по самой кнопке-якорю
      // (у неё свой mousedown-обработчик уже открывает попап; без этого
      // исключения тот же клик тут же закрывал бы то, что сам открыл).
      document.addEventListener('mousedown', (e) => {
        if (el.hidden) return;
        if (el.contains(e.target)) return;
        if (this._hlPickerAnchor && this._hlPickerAnchor.contains(e.target)) return;
        this.closeHighlightPicker();
      });
      return el;
    }

    openHighlightPicker(anchorBtn) {
      if (!this._activeTextInput || !document.body.contains(this._activeTextInput.el)) {
        window.showMessage?.('Сначала выделите текст в текстовом блоке', 'warning');
        return;
      }
      const el = this.ensureHighlightPickerEl();
      this._hlPickerAnchor = anchorBtn;
      // position:fixed — чистые viewport-координаты (см. комментарий у
      // .eb-color-picker в editor-blocks.css: тулбар — sticky с z-index:100,
      // absolute-попап на координатах документа мог оказаться под ним).
      const rect = anchorBtn.getBoundingClientRect();
      el.style.left = `${rect.left}px`;
      el.style.top = `${rect.bottom + 6}px`;
      el.hidden = false;
    }

    closeHighlightPicker() {
      if (this._hlPickerEl) this._hlPickerEl.hidden = true;
    }

    applyHighlightColor(hex) {
      this.closeHighlightPicker();
      const suffix = hex ? `(${hex})` : '';
      this.applyInlineFormat('==', '==' + suffix);
    }

    runBlockCommand(command, dataset) {
      switch (command) {
        case 'paragraph': this.insertBlockAfterActive('paragraph'); break;
        case 'heading': this.insertBlockAfterActive('heading', { level: parseInt(dataset.level, 10) || 2 }); break;
        case 'list': this.insertBlockAfterActive('list', { style: dataset.style || 'bullet' }); break;
        case 'quote': this.insertBlockAfterActive('quote'); break;
        case 'code': this.insertBlockAfterActive('code'); break;
        case 'table': this.insertBlockAfterActive('table'); break;
        case 'divider': this.insertBlockAfterActive('divider'); break;
        case 'infobox': this.insertBlockAfterActive('infobox'); break;
        case 'callout': this.insertBlockAfterActive('callout'); break;
        case 'columns': this.insertBlockAfterActive('columns'); break;
        case 'spoiler-section': this.insertBlockAfterActive('spoiler-section'); break;
        case 'image': {
          const block = this.insertBlockAfterActive('image', {});
          this.pickAndUploadImageForBlock(block);
          break;
        }
      }
    }

    setupHotkeys() {
      if (this._hotkeysBound) return;
      this._hotkeysBound = true;
      document.addEventListener('keydown', (e) => {
        if (!this.container || !document.body.contains(this.container)) return;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === 's' && this.container.contains(document.activeElement)) {
          e.preventDefault();
          document.getElementById('saveArticleBtn')?.click();
        }
      });
    }

    // ===== Режимы (Редактирование / Просмотр / Двойной просмотр) =====

    setupModeTabs() {
      const tabs = document.querySelectorAll('.editor-mode-tab');
      tabs.forEach((tab) => {
        tab.addEventListener('click', () => this.setMode(tab.getAttribute('data-mode')));
      });
      this.setMode(this.mode || 'edit');

      // Сузили окно/повернули телефон, пока был открыт "Разделить" —
      // уводим с него тем же путём, что и при первом заходе (setMode сам
      // прогоняет проверку ширины). В обратную сторону (растянули шире)
      // ничего не переключаем — сам факт того, что человек в 'edit'/'preview',
      // не значит, что он хотел 'split', это его собственный выбор.
      if (!this._modeResizeBound) {
        this._modeResizeBound = true;
        window.addEventListener('resize', () => {
          // this.container/this.mode переживают уход со страницы статей
          // (тот же singleton editorManager) — не трогаем режим, если
          // редактора сейчас вообще нет на странице.
          if (this.mode === 'split' && this.container && document.body.contains(this.container)) {
            this.setMode('split');
          }
        });
      }
    }

    setMode(mode) {
      // "Разделить" — два узких столбца, на телефоне попросту нечитаемых
      // (вкладка и сама скрыта в CSS, см. editor-obsidian.css). setMode
      // вызывается не только по клику на вкладку — ещё при первом заходе
      // (this.mode по умолчанию 'split') и при ресайзе окна — поэтому
      // проверка тут одна на всех, а не в каждом месте вызова отдельно.
      if (mode === 'split' && window.matchMedia('(max-width: 640px)').matches) mode = 'edit';
      this.mode = mode;
      if (this.panesEl) this.panesEl.setAttribute('data-mode', mode);
      document.querySelectorAll('.editor-mode-tab').forEach((tab) => {
        tab.classList.toggle('active', tab.getAttribute('data-mode') === mode);
      });
      if (mode !== 'edit') this.scheduleRenderPreview(true);
    }

    scheduleRenderPreview(immediate) {
      if (!this.previewEl) return;
      clearTimeout(this._previewTimer);
      this._previewTimer = setTimeout(() => this.renderPreview(), immediate ? 0 : 300);
    }

    async renderPreview() {
      if (!this.previewEl || !window.renderArticleBlocks) return;
      try {
        this.previewEl.innerHTML = await window.renderArticleBlocks(this.doc, this.articlesIndexBySlug);
        window.attachBlocksInteractions?.(this.previewEl);
      } catch (e) {
        console.error('Ошибка рендера превью:', e);
      }
    }

    setupPreviewClickHandling() {
      if (!this.previewEl || this.previewEl.dataset.clickBound) return;
      this.previewEl.dataset.clickBound = 'true';
      this.previewEl.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const wikiEl = target.closest('.wiki-link, .wiki-link-missing');
        if (wikiEl) {
          event.preventDefault();
          this.navigateToWikiLink(wikiEl.dataset.slug, wikiEl.classList.contains('wiki-link'));
          return;
        }
        const tagEl = target.closest('.hashtag');
        if (tagEl) {
          event.preventDefault();
          this.showTagResults(tagEl.dataset.tag);
        }
      });
    }

    // ===== Wiki-ссылки: навигация =====

    navigateToWikiLink(slug, exists) {
      if (!window.spaRouter) return;
      if (exists) { window.spaRouter.editArticle(slug); return; }
      const article = this.articlesIndex.find(a => a.slug === slug);
      const title = article ? article.title : slug;
      if (confirm(`Статьи «${title}» ещё нет. Создать новую?`)) {
        window.spaRouter.resetArticleForm?.();
        const titleInput = document.getElementById('articleTitle');
        if (titleInput) titleInput.value = title;
      }
    }

    // ===== Теги: результаты по клику =====

    async showTagResults(tag) {
      const result = await window.apiClient.makeAuthenticatedRequest(`/api/articles?tag=${encodeURIComponent(tag)}`);
      const articles = (result.success && Array.isArray(result.data)) ? result.data : [];

      let panel = document.getElementById('tagResultsPanel');
      if (!panel) {
        panel = document.createElement('div');
        panel.id = 'tagResultsPanel';
        panel.className = 'tag-results-panel';
        const anchor = document.getElementById('editorSidePanels') || document.body;
        anchor.appendChild(panel);
      }

      const list = articles.length
        ? articles.map(a => `<li><a href="javascript:void(0)" data-slug="${a.slug || a.id}">${escapeHtml(a.title)}</a></li>`).join('')
        : '<li style="color: var(--text-muted);">Статей с этим тегом не найдено</li>';

      panel.innerHTML = `
        <button type="button" class="close-tag-results" title="Закрыть">&times;</button>
        <h4>Статьи с тегом #${escapeHtml(tag)}</h4>
        <ul>${list}</ul>
      `;
      panel.querySelector('.close-tag-results').addEventListener('click', () => panel.remove());
      panel.querySelectorAll('a[data-slug]').forEach((a) => {
        a.addEventListener('click', () => window.spaRouter?.editArticle(a.getAttribute('data-slug')));
      });
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // ===== Backlinks =====

    observeArticleIdForBacklinks() {
      const saveBtn = document.getElementById('saveArticleBtn');
      if (!saveBtn) return;

      const check = () => {
        const id = saveBtn.getAttribute('data-article-id');
        if (id === this._lastObservedArticleId) return;
        this._lastObservedArticleId = id;
        this._loadedArticleTitle = id ? (document.getElementById('articleTitle')?.value.trim() || '') : null;
        this.renderBacklinksPanel(id);
        this.updateTitleRenameHint();
        this.renderLocalGraphPanel(id);
      };

      check();
      this._articleIdObserver = new MutationObserver(check);
      this._articleIdObserver.observe(saveBtn, { attributes: true, attributeFilter: ['data-article-id'] });
    }

    async renderBacklinksPanel(slug) {
      let panel = document.getElementById('backlinksPanel');
      const anchor = document.getElementById('editorSidePanels');
      if (!panel && anchor) {
        panel = document.createElement('div');
        panel.id = 'backlinksPanel';
        panel.className = 'backlinks-panel';
        anchor.appendChild(panel);
      }
      if (!panel) return;
      if (!slug) { panel.style.display = 'none'; return; }

      panel.style.display = 'block';
      panel.innerHTML = '<h3>Ссылки на эту статью</h3><div class="backlinks-empty">Загрузка…</div>';

      const result = await window.apiClient.makeAuthenticatedRequest(`/api/articles/${slug}/backlinks`);
      const backlinks = (result.success && Array.isArray(result.data)) ? result.data : [];

      panel.innerHTML = '<h3>Ссылки на эту статью</h3>' + (
        backlinks.length
          ? `<ul>${backlinks.map(b => `<li><a href="javascript:void(0)" data-slug="${b.slug}">${escapeHtml(b.title)}</a></li>`).join('')}</ul>`
          : '<div class="backlinks-empty">Пока никто не сослался на эту статью через [[wiki-ссылку]]</div>'
      );
      panel.querySelectorAll('a[data-slug]').forEach((a) => {
        a.addEventListener('click', () => window.spaRouter?.editArticle(a.getAttribute('data-slug')));
      });
    }

    async renderLocalGraphPanel(slug) {
      let panel = document.getElementById('localGraphPanel');
      const anchor = document.getElementById('editorSidePanels');
      if (!panel && anchor) {
        panel = document.createElement('div');
        panel.id = 'localGraphPanel';
        panel.className = 'backlinks-panel';
        anchor.appendChild(panel);
      }
      if (!panel) return;

      if (this._localGraphInstance) { this._localGraphInstance.destroy(); this._localGraphInstance = null; }
      if (!slug || !window.GraphView) { panel.style.display = 'none'; return; }

      panel.style.display = 'block';
      panel.innerHTML = '<h3>Локальный граф</h3><div class="graph-container graph-container-compact" id="localGraphContainer"><div class="graph-empty">Загрузка…</div></div>';

      const result = await window.apiClient.makeAuthenticatedRequest('/api/articles-graph');
      if (!result.success) return;

      const { nodes, edges } = result.data;
      const neighborSlugs = new Set([slug]);
      edges.forEach((e) => { if (e.from === slug) neighborSlugs.add(e.to); if (e.to === slug) neighborSlugs.add(e.from); });

      const localNodes = nodes.filter((n) => neighborSlugs.has(n.slug));
      const localEdges = edges.filter((e) => neighborSlugs.has(e.from) && neighborSlugs.has(e.to));

      const container = document.getElementById('localGraphContainer');
      if (!container) return;

      this._localGraphInstance = await window.GraphView.renderGraph(container, { nodes: localNodes, edges: localEdges }, {
        centerSlug: slug, compact: true,
        onNodeClick: (targetSlug) => { if (targetSlug !== slug) window.spaRouter?.editArticle(targetSlug); }
      });
    }

    // ===== Подсказка "переименовать статью" =====

    setupTitleRenameHint() {
      const titleInput = document.getElementById('articleTitle');
      if (!titleInput || titleInput.dataset.renameHintBound) return;
      titleInput.dataset.renameHintBound = 'true';
      titleInput.addEventListener('input', () => this.updateTitleRenameHint());
    }

    ensureTitleRenameHintEl() {
      let hint = document.getElementById('titleRenameHint');
      if (hint) return hint;
      const titleGroup = document.getElementById('articleTitle')?.closest('.form-group');
      if (!titleGroup) return null;
      hint = document.createElement('div');
      hint.id = 'titleRenameHint';
      hint.className = 'title-rename-hint';
      hint.innerHTML = `
        <i class="fas fa-arrow-turn-up"></i>
        <span>Заголовок изменён — обычное сохранение оставит прежний адрес статьи.</span>
        <button type="button" id="renameArticleBtn" class="title-rename-hint-btn">Переименовать и обновить ссылки</button>
      `;
      titleGroup.appendChild(hint);
      hint.querySelector('#renameArticleBtn').addEventListener('click', () => this.renameCurrentArticle());
      return hint;
    }

    updateTitleRenameHint() {
      const titleInput = document.getElementById('articleTitle');
      const hint = this.ensureTitleRenameHintEl();
      if (!hint || !titleInput) return;
      const current = titleInput.value.trim();
      const isDirty = this._loadedArticleTitle !== null && this._loadedArticleTitle !== undefined
        && current && current !== this._loadedArticleTitle;
      hint.style.display = isDirty ? 'flex' : 'none';
    }

    async renameCurrentArticle() {
      const slug = this._lastObservedArticleId;
      const titleInput = document.getElementById('articleTitle');
      const newTitle = titleInput?.value.trim();
      if (!slug || !newTitle || newTitle === this._loadedArticleTitle) return;

      const result = await window.apiClient.makeAuthenticatedRequest(`/api/articles/${slug}/rename`, 'PUT', { title: newTitle });
      if (!result.success) {
        window.showMessage?.('Не удалось переименовать статью: ' + (result.data?.error || result.error || ''), 'error');
        return;
      }

      const { newSlug, updatedArticles } = result.data;
      const saveBtn = document.getElementById('saveArticleBtn');
      if (saveBtn) saveBtn.setAttribute('data-article-id', newSlug);
      this._lastObservedArticleId = newSlug;
      this._loadedArticleTitle = newTitle;
      this.updateTitleRenameHint();

      const msg = updatedArticles && updatedArticles.length
        ? `Статья переименована. Обновлены ссылки в ${updatedArticles.length} других статьях.`
        : 'Статья переименована.';
      window.showMessage?.(msg, 'success');

      await this.loadArticlesIndex();
    }

    // ===== Совместимость со старым API =====

    updateToolbarActiveStates() {
      // В блочном редакторе активные кнопки формата не подсвечиваются так же,
      // как в contenteditable-версии — оставлено как no-op для совместимости
      // с вызовами из spa-router.js.
    }
  }

  window.editorManager = new EditorManager();
})();
