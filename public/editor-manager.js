// editor-manager.js — редактор статей в стиле Obsidian на CodeMirror 6.
//
// Заменяет прежний contenteditable-редактор (rich text -> HTML). Теперь
// содержимое статьи — обычный Markdown. CodeMirror 6 подключается прямо из
// CDN (jsDelivr, +esm-бандлы) через динамический import() — в проекте нет
// сборщика фронтенда, а классический <script> (не type="module") всё равно
// может использовать import() как выражение, поэтому подключение в
// index.html менять не пришлось.
//
// Совместимость со старым кодом spa-router.js: он читает/пишет содержимое
// статьи как document.getElementById('articleContent').innerHTML (раньше —
// HTML, теперь — Markdown). Вместо правки полутора десятков мест в
// spa-router.js эта совместимость обеспечена шимом: свойство innerHTML на
// контейнере редактора переопределено через Object.defineProperty и
// прозрачно читает/пишет текст документа CodeMirror. См. shimInnerHTML().

(function () {
  'use strict';

  // ===== Динамическая загрузка CodeMirror 6 / marked / DOMPurify =====
  //
  // Используем esm.sh, а не jsdelivr — jsdelivr резолвит зависимости каждого
  // +esm-бандла независимо (проверено: @codemirror/lang-markdown внутри себя
  // тянул @codemirror/state другого патч-релиза, чем при прямом импорте
  // @codemirror/state), из-за чего в один EditorState попадали бы расширения,
  // построенные на разных экземплярах Facet/StateField — CodeMirror такое не
  // принимает. esm.sh поддерживает параметр ?deps=, который заставляет пакет
  // и всё, что он импортирует, использовать ОДНИ и те же версии state/view —
  // это явно проверено (curl) перед тем, как закладывать сюда. Версии
  // зафиксированы точно (не "@6"), чтобы граф модулей был предсказуем.
  const CM_STATE_VERSION = '6.7.2';
  const CM_VIEW_VERSION = '6.43.11';
  const CM_DEPS = `@codemirror/state@${CM_STATE_VERSION},@codemirror/view@${CM_VIEW_VERSION}`;

  const CM = {
    state: `https://esm.sh/@codemirror/state@${CM_STATE_VERSION}`,
    view: `https://esm.sh/@codemirror/view@${CM_VIEW_VERSION}?deps=${CM_DEPS}`,
    commands: `https://esm.sh/@codemirror/commands@6.11.0?deps=${CM_DEPS}`,
    language: `https://esm.sh/@codemirror/language@6.12.4?deps=${CM_DEPS}`,
    langMarkdown: `https://esm.sh/@codemirror/lang-markdown@6.5.2?deps=${CM_DEPS}`,
    autocomplete: `https://esm.sh/@codemirror/autocomplete@6.20.3?deps=${CM_DEPS}`
  };

  let cmModulesPromise = null;
  function loadCodeMirror() {
    if (!cmModulesPromise) {
      cmModulesPromise = Promise.all([
        import(CM.state),
        import(CM.view),
        import(CM.commands),
        import(CM.language),
        import(CM.langMarkdown),
        import(CM.autocomplete)
      ]).then(([state, view, commands, language, langMarkdown, autocomplete]) => ({
        state, view, commands, language, langMarkdown, autocomplete
      }));
    }
    return cmModulesPromise;
  }

  let markedPromise = null;
  function loadMarked() {
    if (!markedPromise) {
      markedPromise = import('https://cdn.jsdelivr.net/npm/marked@12/+esm').then(m => m.marked || m.default);
    }
    return markedPromise;
  }

  let dompurifyPromise = null;
  function loadDOMPurify() {
    if (!dompurifyPromise) {
      dompurifyPromise = import('https://cdn.jsdelivr.net/npm/dompurify@3/+esm').then(m => m.default || m);
    }
    return dompurifyPromise;
  }

  // ===== slugify (клиентское зеркало src/services/slugify.js) =====

  const RU_TO_LAT = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
    и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
    с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
  };

  function slugify(text) {
    const transliterated = String(text || '')
      .split('')
      .map(ch => {
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

  // ===== Регэкспы wiki-ссылок / тегов (те же, что на сервере) =====

  const WIKILINK_RE_G = () => /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  const WIKILINK_PARSE_RE_G = () => /\[\[([^\]|#]+)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]/g;
  const HASHTAG_RE_G = () => /(^|\s)#([a-zA-Zа-яА-ЯёЁ0-9_-]+)/g;

  // ===== Markdown -> безопасный HTML для панели превью =====

  // Маркеры wiki-ссылок из символов Private Use Area — гарантированно не
  // встречаются в обычном тексте и не имеют смысла для markdown-парсера, так
  // что проходят через marked как обычный текст. Раньше здесь использовалась
  // временная ссылка вида [текст](wikilink://slug), но DOMPurify по
  // умолчанию вырезает href с нестандартной схемой (это его штатное
  // поведение защиты от XSS через javascript:-подобные схемы) — в итоге
  // подсветка "существует/не существует" не применялась вообще. Текстовые
  // маркеры эту фильтрацию не проходят, так как заменяются на <a> уже ПОСЛЕ
  // санитайзинга.
  const WIKILINK_MARK_START = String.fromCharCode(0xE000);
  const WIKILINK_MARK_SEP = String.fromCharCode(0xE001);
  const WIKILINK_MARK_END = String.fromCharCode(0xE002);

  async function renderMarkdownPreview(md, articlesIndexBySlug) {
    if (!md || !md.trim()) {
      return '<p class="preview-empty">Нечего показывать — начните писать в редакторе.</p>';
    }

    const marked = await loadMarked();
    const DOMPurify = await loadDOMPurify();

    const preprocessed = md.replace(WIKILINK_PARSE_RE_G(), (full, target, _anchor, alias) => {
      const slug = slugify(target.trim());
      const text = (alias && alias.trim()) || target.trim();
      return `${WIKILINK_MARK_START}${slug}${WIKILINK_MARK_SEP}${text}${WIKILINK_MARK_END}`;
    });

    const rawHtml = marked.parse(preprocessed, { gfm: true, breaks: false });
    const clean = DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target'] });

    const container = document.createElement('div');
    container.innerHTML = clean;

    replaceWikilinkMarkersInDom(container, articlesIndexBySlug);
    highlightHashtagsInDom(container);

    return container.innerHTML;
  }

  // Заменяет текстовые маркеры wiki-ссылок (см. константы выше) на настоящие
  // <a class="wiki-link"|"wiki-link-missing" data-slug="..."> элементы. Работает
  // по тексту (не по HTML-строке через regex), поэтому не задевает разметку,
  // которую вокруг маркера успел построить marked (параграфы, списки и т.п.).
  // Разбирает text на массив кусочков {type:'text', value} / {type:'link', slug, label},
  // где найдены полные маркеры START..SEP..END. Реализовано через indexOf/slice, а не
  // через RegExp — сопоставление символов из Private Use Area (-) внутри
  // построенного через new RegExp() паттерна на практике давало ложноотрицательный
  // результат (m.test()/exec() стабильно не находили заведомо присутствующие маркеры),
  // а indexOf с теми же символами работает надёжно.
  function splitWikilinkMarkers(text) {
    const parts = [];
    let pos = 0;
    while (pos < text.length) {
      const startIdx = text.indexOf(WIKILINK_MARK_START, pos);
      if (startIdx === -1) {
        parts.push({ type: 'text', value: text.slice(pos) });
        break;
      }
      const sepIdx = text.indexOf(WIKILINK_MARK_SEP, startIdx + 1);
      const endIdx = sepIdx === -1 ? -1 : text.indexOf(WIKILINK_MARK_END, sepIdx + 1);
      if (sepIdx === -1 || endIdx === -1) {
        // Маркер повреждён/не закрыт — оставляем остаток как обычный текст
        parts.push({ type: 'text', value: text.slice(pos) });
        break;
      }
      if (startIdx > pos) {
        parts.push({ type: 'text', value: text.slice(pos, startIdx) });
      }
      parts.push({
        type: 'link',
        slug: text.slice(startIdx + 1, sepIdx),
        label: text.slice(sepIdx + 1, endIdx)
      });
      pos = endIdx + 1;
    }
    return parts;
  }

  function replaceWikilinkMarkersInDom(root, articlesIndexBySlug) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.parentElement) return NodeFilter.FILTER_REJECT;
        if (node.parentElement.closest('code, pre')) return NodeFilter.FILTER_REJECT;
        return node.nodeValue.indexOf(WIKILINK_MARK_START) !== -1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);

    nodes.forEach((node) => {
      const parts = splitWikilinkMarkers(node.nodeValue);
      const frag = document.createDocumentFragment();
      parts.forEach((part) => {
        if (part.type === 'text') {
          frag.appendChild(document.createTextNode(part.value));
          return;
        }
        const exists = articlesIndexBySlug.has(part.slug);
        const a = document.createElement('a');
        a.href = 'javascript:void(0)';
        a.className = exists ? 'wiki-link' : 'wiki-link-missing';
        a.dataset.slug = part.slug;
        a.textContent = part.label;
        frag.appendChild(a);
      });
      node.parentNode.replaceChild(frag, node);
    });
  }

  function highlightHashtagsInDom(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.parentElement) return NodeFilter.FILTER_REJECT;
        if (node.parentElement.closest('code, pre, a')) return NodeFilter.FILTER_REJECT;
        return HASHTAG_RE_G().test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);

    nodes.forEach((node) => {
      const text = node.nodeValue;
      const frag = document.createDocumentFragment();
      let lastIndex = 0;
      const re = HASHTAG_RE_G();
      let m;
      while ((m = re.exec(text)) !== null) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex, m.index) + m[1]));
        const span = document.createElement('span');
        span.className = 'hashtag';
        span.dataset.tag = m[2].toLowerCase();
        span.textContent = '#' + m[2];
        frag.appendChild(span);
        lastIndex = m.index + m[0].length;
      }
      frag.appendChild(document.createTextNode(text.slice(lastIndex)));
      node.parentNode.replaceChild(frag, node);
    });
  }

  // ===== EditorManager =====

  class EditorManager {
    constructor() {
      this.view = null;
      this.container = null;
      this.panesEl = null;
      this.previewEl = null;
      this.mode = 'edit';
      this.articlesIndex = []; // [{slug, title, tags}]
      this.articlesIndexBySlug = new Map();
      this._pendingValue = null;
      this._articleIdObserver = null;
      this._previewTimer = null;
      this._lastObservedArticleId = undefined;
    }

    // Вызывается spa-router'ом при каждом открытии страницы /articles.
    async initializeEditor() {
      this.cleanup();

      this.container = document.getElementById('articleContent');
      if (!this.container) return; // не на странице статей

      this.panesEl = this.container.closest('.editor-panes');
      this.previewEl = document.getElementById('markdownPreviewPane');
      this.setupPreviewClickHandling();

      // Ставим шим ДО начала асинхронной загрузки CodeMirror — так любые
      // обращения к innerHTML в этот промежуток (маловероятно, но возможно
      // при очень медленной сети) не потеряются, а попадут в очередь.
      this.shimInnerHTML();

      await this.loadArticlesIndex();

      let cm;
      try {
        cm = await loadCodeMirror();
      } catch (e) {
        console.error('Не удалось загрузить CodeMirror с CDN:', e);
        if (window.showMessage) {
          window.showMessage('Не удалось загрузить редактор (нет соединения с CDN?)', 'error');
        }
        return;
      }

      // Контейнер мог быть заменён/удалён, пока грузился CodeMirror (быстрая
      // навигация) — перепроверяем, что мы всё ещё на странице статей.
      if (!document.body.contains(this.container)) return;

      this.buildEditorView(cm); // хоткеи (Ctrl+B/I/K/S/Shift+F) собираются внутри как CM6-расширение
      this.setupToolbar();
      this.setupModeTabs();
      this.observeArticleIdForBacklinks();
      this.scheduleRenderPreview();
    }

    // Шим innerHTML на #articleContent: spa-router.js по-прежнему читает и
    // пишет содержимое статьи через .innerHTML (раньше — HTML из
    // contenteditable, теперь — Markdown из CodeMirror). Подробности — в
    // комментарии в начале файла.
    shimInnerHTML() {
      const el = this.container;
      const self = this;
      try {
        Object.defineProperty(el, 'innerHTML', {
          configurable: true,
          get() {
            return self.view ? self.view.state.doc.toString() : (self._pendingValue || '');
          },
          set(value) {
            if (self.view) {
              self.setValue(value || '');
            } else {
              self._pendingValue = value || '';
            }
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

    buildEditorView(cm) {
      this.cmModules = cm; // нужен другим методам (wrapSelection и т.п.) для EditorSelection
      const { EditorState } = cm.state;
      const { EditorView, keymap, Decoration, ViewPlugin, placeholder } = cm.view;
      const { defaultKeymap, history, historyKeymap } = cm.commands;
      const { syntaxHighlighting, defaultHighlightStyle } = cm.language;
      const { markdown } = cm.langMarkdown;
      const { autocompletion } = cm.autocomplete;

      const self = this;
      const initialDoc = this._pendingValue != null ? this._pendingValue : '';
      this._pendingValue = null;

      const wikilinkPlugin = ViewPlugin.fromClass(class {
        constructor(view) {
          this.decorations = this.build(view);
        }

        update(update) {
          if (update.docChanged || update.viewportChanged) {
            this.decorations = this.build(update.view);
          }
        }

        build(view) {
          const { RangeSetBuilder } = cm.state;
          const builder = new RangeSetBuilder();
          const marks = [];
          for (const { from, to } of view.visibleRanges) {
            const text = view.state.doc.sliceString(from, to);
            const re = WIKILINK_RE_G();
            let m;
            while ((m = re.exec(text)) !== null) {
              const start = from + m.index;
              const end = start + m[0].length;
              const target = slugify(m[1].trim());
              const exists = self.articlesIndexBySlug.has(target);
              marks.push({ start, end, exists, target });
            }
            const hre = HASHTAG_RE_G();
            while ((m = hre.exec(text)) !== null) {
              const start = from + m.index + m[1].length;
              const end = start + 1 + m[2].length;
              marks.push({ start, end, tag: m[2].toLowerCase() });
            }
          }
          marks.sort((a, b) => a.start - b.start);
          for (const mark of marks) {
            if (mark.tag) {
              builder.add(mark.start, mark.end, Decoration.mark({ class: 'cm-hashtag', attributes: { 'data-tag': mark.tag } }));
            } else {
              builder.add(mark.start, mark.end, Decoration.mark({
                class: mark.exists ? 'cm-wikilink' : 'cm-wikilink-missing',
                attributes: { 'data-slug': mark.target, title: 'Ctrl+клик — перейти' }
              }));
            }
          }
          return builder.finish();
        }
      }, { decorations: v => v.decorations });

      const wikilinkAutocomplete = autocompletion({
        override: [(context) => {
          const before = context.matchBefore(/\[\[[^\]]*/);
          if (!before) return null;
          const query = before.text.slice(2).toLowerCase();
          const options = self.articlesIndex
            .filter(a => a.title.toLowerCase().includes(query))
            .slice(0, 30)
            .map(a => ({
              label: a.title,
              detail: a.tags && a.tags.length ? a.tags.map(t => '#' + t).join(' ') : undefined,
              apply: (view, completion, from, to) => {
                const after = view.state.doc.sliceString(to, to + 2);
                const insert = a.title + (after === ']]' ? '' : ']]');
                view.dispatch({
                  changes: { from, to, insert },
                  selection: { anchor: from + insert.length }
                });
              }
            }));
          return { from: before.from + 2, options, filter: false };
        }]
      });

      const clickHandler = EditorView.domEventHandlers({
        mousedown(event, view) {
          const target = event.target;
          if (!(target instanceof Element)) return false;

          const wikiEl = target.closest('.cm-wikilink, .cm-wikilink-missing');
          if (wikiEl && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            self.navigateToWikiLink(wikiEl.dataset.slug, wikiEl.classList.contains('cm-wikilink'));
            return true;
          }

          const tagEl = target.closest('.cm-hashtag');
          if (tagEl && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            self.showTagResults(tagEl.dataset.tag);
            return true;
          }

          return false;
        }
      });

      const theme = EditorView.theme({
        '&': {
          backgroundColor: 'var(--background-tertiary)',
          color: 'var(--text-normal)'
        },
        '.cm-content': { caretColor: 'var(--text-normal)' },
        '.cm-cursor': { borderLeftColor: 'var(--text-normal)' },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
          backgroundColor: 'rgba(88, 101, 242, 0.35) !important'
        },
        '.cm-placeholder': { color: 'var(--text-muted)' }
      });

      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          self.scheduleRenderPreview();
        }
      });

      const state = EditorState.create({
        doc: initialDoc,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          this.buildHotkeyExtensions(cm),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          placeholder('Начните писать статью в Markdown… Наберите [[ для ссылки на другую статью.'),
          wikilinkPlugin,
          wikilinkAutocomplete,
          clickHandler,
          theme,
          updateListener
        ]
      });

      this.view = new EditorView({ state, parent: this.container });
    }

    buildHotkeyExtensions(cm) {
      const { keymap } = cm.view;
      const self = this;
      return keymap.of([
        { key: 'Mod-b', run: () => { self.wrapSelection('**'); return true; } },
        { key: 'Mod-i', run: () => { self.wrapSelection('_'); return true; } },
        { key: 'Mod-k', run: () => { self.insertLink(); return true; } },
        {
          key: 'Mod-s',
          run: () => {
            document.getElementById('saveArticleBtn')?.click();
            return true;
          }
        },
        {
          key: 'Mod-Shift-f',
          run: () => {
            const search = document.getElementById('searchText');
            if (search) { search.scrollIntoView({ behavior: 'smooth', block: 'center' }); search.focus(); }
            return true;
          }
        }
      ]);
    }

    setValue(md) {
      if (!this.view) { this._pendingValue = md; return; }
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: md || '' }
      });
    }

    getValue() {
      return this.view ? this.view.state.doc.toString() : (this._pendingValue || '');
    }

    // ===== Тулбар =====

    setupToolbar() {
      const toolbar = document.getElementById('toolbar') || document.querySelector('.editor-toolbar-sticky');
      if (!toolbar) return;

      toolbar.querySelectorAll('[data-md-command]').forEach((btn) => {
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault(); // не терять фокус/выделение в редакторе
          this.runToolbarCommand(btn.getAttribute('data-md-command'));
        });
      });
    }

    runToolbarCommand(command) {
      if (!this.view) return;
      switch (command) {
        case 'bold': this.wrapSelection('**'); break;
        case 'italic': this.wrapSelection('_'); break;
        case 'strike': this.wrapSelection('~~'); break;
        case 'code': this.wrapSelection('`'); break;
        case 'codeblock': this.wrapBlock('```\n', '\n```'); break;
        case 'h1': this.toggleLinePrefix('# '); break;
        case 'h2': this.toggleLinePrefix('## '); break;
        case 'h3': this.toggleLinePrefix('### '); break;
        case 'quote': this.toggleLinePrefix('> '); break;
        case 'ul': this.toggleLinePrefix('- '); break;
        case 'ol': this.toggleLinePrefix('1. '); break;
        case 'checklist': this.toggleLinePrefix('- [ ] '); break;
        case 'hr': this.insertText('\n\n---\n\n'); break;
        case 'table': this.insertText('\n| Колонка 1 | Колонка 2 |\n| --- | --- |\n| значение | значение |\n'); break;
        case 'link': this.insertLink(); break;
        case 'image': this.insertImage(); break;
        case 'wikilink': this.wrapSelection('[[', ']]'); break;
      }
      this.view.focus();
    }

    wrapSelection(before, after = before) {
      const view = this.view;
      const { EditorSelection } = this.cmModules.state;
      const changes = view.state.changeByRange((range) => {
        const insert = before + view.state.sliceDoc(range.from, range.to) + after;
        const newFrom = range.from + before.length;
        const newTo = newFrom + (range.to - range.from);
        return {
          changes: { from: range.from, to: range.to, insert },
          range: range.empty
            ? EditorSelection.cursor(newFrom)
            : EditorSelection.range(newFrom, newTo)
        };
      });
      view.dispatch(view.state.update(changes));
    }

    wrapBlock(before, after) {
      const view = this.view;
      const sel = view.state.selection.main;
      const selected = view.state.sliceDoc(sel.from, sel.to);
      const insert = before + selected + after;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert },
        selection: { anchor: sel.from + before.length + selected.length }
      });
    }

    toggleLinePrefix(prefix) {
      const view = this.view;
      const sel = view.state.selection.main;
      const startLine = view.state.doc.lineAt(sel.from);
      const endLine = view.state.doc.lineAt(sel.to);

      const changes = [];
      for (let ln = startLine.number; ln <= endLine.number; ln++) {
        const line = view.state.doc.line(ln);
        if (line.text.startsWith(prefix)) {
          changes.push({ from: line.from, to: line.from + prefix.length, insert: '' });
        } else {
          changes.push({ from: line.from, to: line.from, insert: prefix });
        }
      }
      view.dispatch({ changes });
    }

    insertText(text) {
      const view = this.view;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.to, to: sel.to, insert: text },
        selection: { anchor: sel.to + text.length }
      });
    }

    insertLink() {
      const url = prompt('Введите URL ссылки:');
      if (!url) return;
      const view = this.view;
      const sel = view.state.selection.main;
      const text = view.state.sliceDoc(sel.from, sel.to) || 'ссылка';
      const insert = `[${text}](${url})`;
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert } });
    }

    async insertImage() {
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.onchange = async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
          window.showMessage?.('Пожалуйста, выберите файл изображения', 'error');
          return;
        }
        if (file.size > 5 * 1024 * 1024) {
          window.showMessage?.('Размер файла превышает допустимый лимит (5MB)', 'error');
          return;
        }
        try {
          const result = await window.apiClient.uploadImage(file);
          if (result.success) {
            this.insertText(`![изображение](${result.data.url})`);
          } else {
            window.showMessage?.('Ошибка при загрузке изображения: ' + result.error, 'error');
          }
        } catch (error) {
          window.showMessage?.('Произошла ошибка при загрузке изображения', 'error');
        }
      };
      fileInput.click();
    }

    // ===== Режимы (Редактирование / Просмотр / Двойной просмотр) =====

    setupModeTabs() {
      const tabs = document.querySelectorAll('.editor-mode-tab');
      tabs.forEach((tab) => {
        tab.addEventListener('click', () => this.setMode(tab.getAttribute('data-mode')));
      });
      this.setMode(this.mode || 'edit');
    }

    setMode(mode) {
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
      const run = () => this.renderPreview();
      this._previewTimer = setTimeout(run, immediate ? 0 : 250);
    }

    async renderPreview() {
      if (!this.previewEl || !this.view) return;
      try {
        this.previewEl.innerHTML = await renderMarkdownPreview(this.getValue(), this.articlesIndexBySlug);
      } catch (e) {
        console.error('Ошибка рендера превью:', e);
      }
    }

    // В превью (в отличие от редактора) клик по ссылке не конфликтует с
    // позиционированием курсора, поэтому здесь достаточно обычного клика —
    // без Ctrl, как в самом Obsidian при просмотре заметки.
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
      if (exists) {
        window.spaRouter.editArticle(slug);
        return;
      }
      const article = this.articlesIndex.find(a => a.slug === slug);
      const title = article ? article.title : slug;
      const create = confirm(`Статьи «${title}» ещё нет. Создать новую?`);
      if (create) {
        window.spaRouter.resetArticleForm?.();
        const titleInput = document.getElementById('articleTitle');
        if (titleInput) titleInput.value = title;
        this.view?.focus();
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
        const anchor = document.querySelector('.articles-section') || document.body;
        anchor.parentNode.insertBefore(panel, anchor);
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
        this.renderBacklinksPanel(id);
        this.renderRenameButton(id);
      };

      check();
      this._articleIdObserver = new MutationObserver(check);
      this._articleIdObserver.observe(saveBtn, { attributes: true, attributeFilter: ['data-article-id'] });
    }

    async renderBacklinksPanel(slug) {
      let panel = document.getElementById('backlinksPanel');
      const anchor = document.querySelector('.articles-section');
      if (!panel && anchor) {
        panel = document.createElement('div');
        panel.id = 'backlinksPanel';
        panel.className = 'backlinks-panel';
        anchor.parentNode.insertBefore(panel, anchor);
      }
      if (!panel) return;

      if (!slug) {
        panel.style.display = 'none';
        return;
      }

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

    // Кнопка "Переименовать" рядом с заголовком статьи — виден только при
    // редактировании существующей статьи (не при создании новой). Меняет
    // title и slug через PUT /api/articles/:slug/rename, который сам
    // обновляет [[wiki-ссылки]] на неё во всех остальных статьях.
    renderRenameButton(slug) {
      const titleGroup = document.getElementById('articleTitle')?.closest('.form-group');
      if (!titleGroup) return;

      let btn = document.getElementById('renameArticleBtn');
      if (!slug) {
        if (btn) btn.style.display = 'none';
        return;
      }

      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'renameArticleBtn';
        btn.className = 'btn-action-plus';
        btn.title = 'Переименовать статью (обновит [[ссылки]] на неё в других статьях)';
        btn.innerHTML = '<i class="fas fa-i-cursor"></i>';
        btn.style.marginLeft = '8px';
        btn.addEventListener('click', () => this.renameCurrentArticle());

        const label = titleGroup.querySelector('.form-label');
        const wrapper = document.createElement('span');
        wrapper.style.display = 'inline-flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.gap = '8px';
        label.replaceWith(wrapper);
        wrapper.appendChild(label);
        wrapper.appendChild(btn);
      }
      btn.style.display = 'inline-flex';
      btn.dataset.slug = slug;
    }

    async renameCurrentArticle() {
      const btn = document.getElementById('renameArticleBtn');
      const slug = btn?.dataset.slug;
      if (!slug) return;

      const titleInput = document.getElementById('articleTitle');
      const newTitle = prompt('Новый заголовок статьи:', titleInput?.value || '');
      if (!newTitle || !newTitle.trim() || newTitle.trim() === titleInput?.value) return;

      const result = await window.apiClient.makeAuthenticatedRequest(`/api/articles/${slug}/rename`, 'PUT', { title: newTitle.trim() });
      if (!result.success) {
        window.showMessage?.('Не удалось переименовать статью: ' + (result.data?.error || result.error || ''), 'error');
        return;
      }

      const { newSlug, updatedArticles } = result.data;
      if (titleInput) titleInput.value = newTitle.trim();
      const saveBtn = document.getElementById('saveArticleBtn');
      if (saveBtn) saveBtn.setAttribute('data-article-id', newSlug);

      const msg = updatedArticles && updatedArticles.length
        ? `Статья переименована. Обновлены ссылки в ${updatedArticles.length} других статьях.`
        : 'Статья переименована.';
      window.showMessage?.(msg, 'success');

      await this.loadArticlesIndex(); // slug изменился — обновляем индекс для wiki-ссылок/автодополнения
    }

    // ===== Совместимость со старым API editor-manager.js =====

    updateToolbarActiveStates() {
      // В CM6-редакторе активные кнопки формата не подсвечиваются так же,
      // как в contenteditable-версии — оставлено как no-op для совместимости
      // с вызовами из spa-router.js.
    }

    cleanup() {
      if (this._articleIdObserver) {
        this._articleIdObserver.disconnect();
        this._articleIdObserver = null;
      }
      clearTimeout(this._previewTimer);
      if (this.view) {
        this.view.destroy();
        this.view = null;
      }
      this._lastObservedArticleId = undefined;
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  window.editorManager = new EditorManager();
})();
