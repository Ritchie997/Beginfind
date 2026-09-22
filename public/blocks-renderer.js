// blocks-renderer.js — дерево блоков статьи (см. src/services/blocks.js)
// -> безопасный HTML. Единственное место на фронтенде, которое знает, как
// выглядит каждый тип блока — используется и панелью "Просмотр" редактора
// (editor-manager.js/Editor.js-инструменты), и чтением статьи на Ibripedia
// (ibripedia.js), вместо двух независимых копий рендера, как было раньше
// с markdown+regex-блоками.
//
// Не зависит от editor-manager.js — ibripedia.js (просто чтение статьи)
// больше не требует, чтобы редактор вообще был загружен на странице.

(function () {
  'use strict';

  // ===== slugify — клиентское зеркало src/services/slugify.js (тот же
  // приём уже использовался в editor-manager.js для wiki-ссылок) =====
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

  // ===== marked / DOMPurify — та же CDN-схема, что и в editor-manager.js =====

  let markedPromise = null;
  function loadMarked() {
    if (!markedPromise) {
      markedPromise = import('https://cdn.jsdelivr.net/npm/marked@12/+esm').then((m) => {
        const marked = m.marked || m.default;
        registerInlineExtensions(marked);
        return marked;
      });
    }
    return markedPromise;
  }

  let dompurifyPromise = null;
  function loadDOMPurify() {
    if (!dompurifyPromise) {
      dompurifyPromise = import('https://cdn.jsdelivr.net/npm/dompurify@3/+esm').then((m) => m.default || m);
    }
    return dompurifyPromise;
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function escapeAttr(str) { return escapeHtml(str); }

  // Чёрный или белый текст поверх произвольного фона выделения (==текст==(#hex))
  // — по светлоте цвета, чтобы текст оставался читаемым при любом выборе в палитре.
  function pickTextColor(hex) {
    const c = hex.replace('#', '');
    const full = c.length === 3 ? c.split('').map((ch) => ch + ch).join('') : c.padEnd(6, '0').slice(0, 6);
    const r = parseInt(full.slice(0, 2), 16), g = parseInt(full.slice(2, 4), 16), b = parseInt(full.slice(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6 ? '#1a1a1a' : '#ffffff';
  }

  // Новый инлайн-синтаксис (см. решение "оставить инлайн markdown + тулбар
  // поверх"): ++подчёркнутый++ / ==выделение== / ||спойлер||. Жирный/курсив/
  // зачёркнутый/код/ссылки — штатные возможности marked, трогать не нужно.
  // Каждое расширение токенизирует вложенный инлайн-контент (this.lexer.
  // inlineTokens), чтобы внутри можно было писать **жирный** и т.п., как и
  // в стандартных marked-расширениях (strong/em).
  function registerInlineExtensions(marked) {
    if (marked.__blocksRendererExtRegistered) return;
    marked.__blocksRendererExtRegistered = true;

    function simpleWrapExtension(name, markerRe, open, close) {
      return {
        name,
        level: 'inline',
        start(src) {
          const idx = src.search(markerRe.start);
          return idx === -1 ? undefined : idx;
        },
        tokenizer(src) {
          const m = markerRe.full.exec(src);
          if (!m) return undefined;
          return { type: name, raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
        },
        renderer(token) {
          return `${open}${this.parser.parseInline(token.tokens)}${close}`;
        }
      };
    }

    marked.use({
      extensions: [
        simpleWrapExtension('underline', { start: /\+\+/, full: /^\+\+([^\n]+?)\+\+/ }, '<u class="mk-u">', '</u>'),
        {
          // ==текст== — выделение цветом; необязательный (#hex) сразу после
          // закрывающих == задаёт СВОЙ цвет вместо цвета по умолчанию (см.
          // тулбар — кнопка выделения открывает палитру). Текстовый цвет
          // считается по контрасту (pickTextColor), чтобы текст оставался
          // читаемым на любом выбранном фоне.
          name: 'highlight',
          level: 'inline',
          start(src) { const idx = src.indexOf('=='); return idx === -1 ? undefined : idx; },
          tokenizer(src) {
            const m = /^==([^\n]+?)==(?:\(#([0-9a-fA-F]{3,8})\))?/.exec(src);
            if (!m) return undefined;
            return { type: 'highlight', raw: m[0], text: m[1], color: m[2] ? `#${m[2]}` : null, tokens: this.lexer.inlineTokens(m[1]) };
          },
          renderer(token) {
            const style = token.color ? ` style="background:${token.color};color:${pickTextColor(token.color)}"` : '';
            return `<mark class="mk-hl"${style}>${this.parser.parseInline(token.tokens)}</mark>`;
          }
        },
        {
          name: 'spoiler',
          level: 'inline',
          start(src) { const idx = src.indexOf('||'); return idx === -1 ? undefined : idx; },
          tokenizer(src) {
            const m = /^\|\|([^\n]+?)\|\|/.exec(src);
            if (!m) return undefined;
            return { type: 'spoiler', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
          },
          renderer(token) {
            return `<span class="spoiler" data-spoiler>${this.parser.parseInline(token.tokens)}</span>`;
          }
        }
      ],
      renderer: {
        // Картинки теперь только блок `image` (см. blocks.js) — случайный
        // ![...](...) внутри текста параграфа не должен тихо создавать
        // нестилизованный <img>, обходящий ширину/выравнивание/рамку.
        image(href, title, text) { return escapeHtml(text || ''); }
      }
    });
  }

  // ===== Wiki-ссылки: маркеры из Private Use Area (см. объяснение в
  // старой версии editor-manager.js — DOMPurify вырезает нестандартные
  // href, поэтому подмена на <a> происходит уже ПОСЛЕ санитайзинга) =====

  // Wiki-ссылка — [Анатолий]((статья)): в квадратных скобках подпись, которая
  // видна на экране, в двойных круглых — статья, на которую ведёт ссылка (после
  // "#" может идти якорь). Классические markdown-ссылки [текст](url) сюда не
  // попадают — у них одна круглая скобка, а не две. Пустая подпись
  // []((статья)) допустима (см. WIKILINK_MARK_AUTO), пустая цель ((())) — нет.
  const WIKILINK_PARSE_RE_G = () => /\[([^\]\n]*)\]\(\(([^()#\n]+)(?:#([^()\n]*))?\)\)/g;
  const HASHTAG_RE_G = () => /(^|\s)#([a-zA-Zа-яА-ЯёЁ0-9_-]+)/g;
  const WIKILINK_MARK_START = String.fromCharCode(0xE000);
  const WIKILINK_MARK_SEP = String.fromCharCode(0xE001);
  const WIKILINK_MARK_END = String.fromCharCode(0xE002);
  // Стоит первым символом подписи, если у ссылки нет своего имени ([]((цель)),
  // а не [текст]((цель))): подпись такой ссылки — актуальное название статьи
  // (если она есть), а не то, что было набрано в тексте. Так упоминание не
  // отстаёт от переименования статьи. Сам набранный текст остаётся запасным
  // вариантом — для ссылок на ещё не созданные статьи.
  const WIKILINK_MARK_AUTO = String.fromCharCode(0xE003);

  function markWikilinks(md) {
    return String(md || '').replace(WIKILINK_PARSE_RE_G(), (full, label, target) => {
      const slug = slugify(target.trim());
      const ownLabel = label.trim();
      const text = ownLabel ? ownLabel : WIKILINK_MARK_AUTO + target.trim();
      return `${WIKILINK_MARK_START}${slug}${WIKILINK_MARK_SEP}${text}${WIKILINK_MARK_END}`;
    });
  }

  // ===== Вариативные подписи wiki-ссылки по слою цели =====
  // [вариант1:вариант2:...]((статья)), вариант := подпись|слой(,слой)* —
  // подпись зависит от того, на какой СЛОЙ цели резолвится ИМЕННО ЭТОТ
  // читатель (см. обсуждение "многослойные статьи", фаза 2). Разделители —
  // ':' между вариантами, '|' между подписью и списком слоёв, ',' между
  // несколькими слоями одного варианта (OR); внутри "кавычек" разделители не
  // действуют — только так можно вписать в подпись/название слоя пробел,
  // двоеточие, запятую и т.п. Пример:
  //   [Кальций|Кальций:"Бодер Фагос - Великий маг"|Бодер Фагос - Великий маг]((...))

  // Делит строку по delimiter, не трогая то, что внутри "кавычек".
  function splitRespectingQuotes(str, delimiter) {
    const parts = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '"') { inQuotes = !inQuotes; current += ch; continue; }
      if (ch === delimiter && !inQuotes) { parts.push(current); current = ''; continue; }
      current += ch;
    }
    parts.push(current);
    return parts;
  }

  function unquoteToken(token) {
    const t = token.trim();
    return (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') ? t.slice(1, -1) : t;
  }

  // Обратная операция — собрать label обратно из variants (используется
  // редактором: автозамена "/N" на название слоя, диалог вставки ссылки с
  // вариантами, см. editor-manager.js). В кавычки берём токен, только если
  // без них он бы сломал разбор (спецсимволы или пробел) — иначе минимально
  // загромождаем текст.
  function wikilinkTokenNeedsQuoting(token) {
    return /[|:,"\s]/.test(token);
  }
  function quoteWikilinkToken(token) {
    return wikilinkTokenNeedsQuoting(token) ? `"${token}"` : token;
  }
  function buildWikilinkVariantsLabel(variants) {
    return variants.map((v) =>
      `${quoteWikilinkToken(v.caption || '')}|${(v.layers || []).map(quoteWikilinkToken).join(',')}`
    ).join(':');
  }

  // Возвращает [{caption, layers:[...]}, ...] если в подписи есть хотя бы
  // один '|' (значит это вариативный синтаксис), иначе null — обычная
  // ссылка со статичной подписью, ничего не разбираем (без '|' синтаксис
  // вариантов невозможен — это единственный признак, ':' сам по себе
  // ничего не значит: он законно встречается в обычном тексте подписи).
  function parseWikilinkVariants(label) {
    if (!label.includes('|')) return null;
    return splitRespectingQuotes(label, ':').map((variantStr) => {
      const pipeParts = splitRespectingQuotes(variantStr, '|');
      const caption = unquoteToken(pipeParts[0] || '');
      const layersPart = pipeParts.slice(1).join('|');
      const layers = splitRespectingQuotes(layersPart, ',').map(unquoteToken).filter(Boolean);
      return { caption, layers };
    });
  }

  // Подпись первого варианта, чей список слоёв содержит resolvedTitle (без
  // учёта регистра) — resolvedTitle это заголовок СЛОЯ цели, резолвнутого
  // именно для текущего читателя (см. article.title в /api/articles-index —
  // он уже отдаётся per-viewer, см. articles.routes.js). Пустая подпись у
  // подошедшего варианта — тоже "авто" (сам resolvedTitle). Ничего не
  // подошло (слой переименовали/убрали, опечатка) — null, откатываемся на
  // обычный авто-заголовок цели вызывающим кодом (см. обсуждение, вариант А
  // — без каскада переименований, тихий фолбэк).
  function resolveWikilinkVariantCaption(variants, resolvedTitle) {
    if (!resolvedTitle) return null;
    const match = variants.find((v) => v.layers.some((l) => l.toLowerCase() === resolvedTitle.toLowerCase()));
    return match ? (match.caption || resolvedTitle) : null;
  }

  function splitWikilinkMarkers(text) {
    const parts = [];
    let pos = 0;
    while (pos < text.length) {
      const startIdx = text.indexOf(WIKILINK_MARK_START, pos);
      if (startIdx === -1) { parts.push({ type: 'text', value: text.slice(pos) }); break; }
      const sepIdx = text.indexOf(WIKILINK_MARK_SEP, startIdx + 1);
      const endIdx = sepIdx === -1 ? -1 : text.indexOf(WIKILINK_MARK_END, sepIdx + 1);
      if (sepIdx === -1 || endIdx === -1) { parts.push({ type: 'text', value: text.slice(pos) }); break; }
      if (startIdx > pos) parts.push({ type: 'text', value: text.slice(pos, startIdx) });
      parts.push({ type: 'link', slug: text.slice(startIdx + 1, sepIdx), label: text.slice(sepIdx + 1, endIdx) });
      pos = endIdx + 1;
    }
    return parts;
  }

  // restrictedSlugs — Set<slug> статей, которые СУЩЕСТВУЮТ, но этому
  // читателю не открыт ни один их слой (см. /api/articles-index,
  // restrictedSlugs в ответе) — раньше визуально ничем не отличались от
  // ссылки на несуществующую статью ("статьи ещё нет"); теперь отдельный
  // класс wiki-link-restricted и подпись "Недоступно" для пустых ((скобок)) —
  // настоящий заголовок цели читателю здесь показывать нельзя, он его и не
  // получает (см. articles-index на сервере — title для restrictedSlugs не
  // отдаётся вовсе). Собственную (не авто) подпись ссылки — ту, что явно
  // набрал автор ТЕКУЩЕЙ статьи — по-прежнему показываем как есть: это уже
  // текст, который читатель и так видит в этом же абзаце, ограничение цели
  // тут ничего нового не раскрывает.
  function replaceWikilinkMarkersInDom(root, articlesIndexBySlug, restrictedSlugs) {
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
        if (part.type === 'text') { frag.appendChild(document.createTextNode(part.value)); return; }
        const article = articlesIndexBySlug.get(part.slug);
        const exists = !!article;
        const restricted = !exists && !!(restrictedSlugs && restrictedSlugs.has(part.slug));
        let label = part.label;
        // Плейсхолдер "/N" (позиция слоя, набранная вслепую до того, как
        // дописана цель, см. обсуждение "многослойные статьи", фаза 2) —
        // должен был замениться на название слоя автозаменой в редакторе
        // (editor-manager.js, по выбору статьи из автодополнения). Если он
        // всё ещё тут — либо ссылку набрали вручную мимо автодополнения,
        // либо цель ещё не резолвилась (например, статья была недоступна в
        // момент набора) — честно помечаем как незавершённую, а не выдаём
        // вслепую что-то похожее на осмысленный результат.
        let hasUnresolvedPlaceholder = false;
        if (label.startsWith(WIKILINK_MARK_AUTO)) {
          if (exists && article.title) label = article.title;
          else if (restricted) label = 'Недоступно';
          else label = label.slice(1);
        } else {
          // Вариативная подпись по слою ([вариант1:вариант2]((...))) — см.
          // parseWikilinkVariants выше. Без '|' в подписи — это не она,
          // label остаётся как есть (обычная статичная подпись).
          const variants = parseWikilinkVariants(label);
          if (variants) {
            hasUnresolvedPlaceholder = variants.some((v) => v.layers.some((l) => /^\/\d+$/.test(l.trim())));
            const matched = exists ? resolveWikilinkVariantCaption(variants, article.title) : null;
            if (matched != null) label = matched;
            else if (exists && article.title) label = article.title; // ни один вариант не подошёл — обычный авто-заголовок
            // Недоступная/несуществующая статья — своего заголовка нет, но
            // подпись первого варианта уже написал автор ТЕКУЩЕЙ статьи, это
            // не утечка (тот же принцип, что и для обычной, не вариативной,
            // подписи, см. выше по файлу) — показываем её, а не "Недоступно"/
            // сырой синтаксис. Пустая подпись у варианта — тогда уже нечего
            // показать, вот там честное "Недоступно".
            else if (restricted) label = variants[0]?.caption || 'Недоступно';
            else label = variants[0]?.caption || label;
          }
        }
        const a = document.createElement('a');
        a.href = 'javascript:void(0)';
        a.className = exists ? 'wiki-link' : (restricted ? 'wiki-link-restricted' : 'wiki-link-missing');
        if (hasUnresolvedPlaceholder) {
          a.classList.add('wiki-link-unresolved-variant');
          a.title = 'Ссылка с вариантами по слою не дописана — есть незаполненный "/N"';
        }
        a.dataset.slug = part.slug;
        a.textContent = label;
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

  // ===== Рендер отдельных блоков =====

  // Инлайн markdown -> HTML-фрагмент (жирный/курсив/зачёркнутый/подчёркнутый/
  // выделение/спойлер/код/ссылки/wiki-ссылки [текст]((статья)) — хэштеги/wiki-ссылки
  // подсвечиваются позже, одним проходом по всему документу).
  function renderInline(marked, md) {
    if (!md) return '';
    const withMarks = markWikilinks(md);
    return marked.parseInline(withMarks, { gfm: true, breaks: true });
  }

  const IMG_ALIGN_CLASS = { left: 'blk-image-left', right: 'blk-image-right', center: 'blk-image-center', full: 'blk-image-full' };

  function renderImageBlock(data) {
    const align = IMG_ALIGN_CLASS[data.align] ? data.align : 'center';
    const style = [`--w:${data.widthPct}%`];
    if (data.frame && data.frame.show) style.push(`--frame-color:${data.frame.color}`);
    return `<figure class="blk-image ${IMG_ALIGN_CLASS[align]}${data.frame && data.frame.show ? ' blk-image-framed' : ''}" style="${style.join(';')}">`
      + `<img src="${escapeAttr(data.src)}" alt="${escapeAttr(data.alt)}" loading="lazy">`
      + (data.alt ? `<figcaption>${escapeHtml(data.alt)}</figcaption>` : '')
      + `</figure>`;
  }

  const CALLOUT_ICON = { info: 'fa-circle-info', tip: 'fa-lightbulb', warning: 'fa-triangle-exclamation' };
  const CALLOUT_LABEL = { info: 'Информация', tip: 'Совет', warning: 'Осторожно' };

  // Простановка id="blk-<id>"/data-block-id="<id>" на корневой тег
  // отрендеренного блока — общая точка привязки и для оглавления статьи
  // (по заголовкам, см. ibripediaManager.buildToc), и для закладок (хвостик
  // в поле слева от блока, см. ibripediaManager.renderBookmarkGutter в
  // ibripedia.js). id совпадает с block.id (см. src/services/blocks.js) —
  // стабилен, пока блок не пересоздали в редакторе, поэтому закладки
  // переживают правки других частей статьи.
  function withBlockAttrs(html, block) {
    if (!html) return html;
    const attrs = ` id="blk-${escapeAttr(block.id)}" data-block-id="${escapeAttr(block.id)}"`;
    return html.replace(/^(<[a-zA-Z0-9]+)/, `$1${attrs}`);
  }

  function renderBlock(block, marked) {
    return withBlockAttrs(renderBlockContent(block, marked), block);
  }

  function renderBlockContent(block, marked) {
    const d = block.data || {};
    switch (block.type) {
      case 'paragraph':
        return d.markdown.trim() ? `<p>${renderInline(marked, d.markdown)}</p>` : '';
      case 'heading': {
        const level = [1, 2, 3].includes(d.level) ? d.level : 2;
        return `<h${level}>${renderInline(marked, d.markdown)}</h${level}>`;
      }
      case 'quote':
        return `<blockquote>${renderInline(marked, d.markdown)}</blockquote>`;
      case 'code':
        return `<pre class="blk-code"><code${d.language ? ` class="language-${escapeAttr(d.language)}"` : ''}>${escapeHtml(d.code)}</code></pre>`;
      case 'list': {
        if (d.style === 'checklist') {
          const items = d.items.map((it) =>
            `<li class="blk-check-item"><input type="checkbox" disabled${it.checked ? ' checked' : ''}> <span>${renderInline(marked, it.markdown)}</span></li>`
          ).join('');
          return `<ul class="blk-checklist">${items}</ul>`;
        }
        const tag = d.style === 'ordered' ? 'ol' : 'ul';
        const items = d.items.map((it) => `<li>${renderInline(marked, it.markdown)}</li>`).join('');
        return `<${tag}>${items}</${tag}>`;
      }
      case 'table': {
        if (!d.rows.length) return '';
        const [headRow, ...bodyRows] = d.rows;
        const head = d.header
          ? `<thead><tr>${headRow.map((c) => `<th>${renderInline(marked, c)}</th>`).join('')}</tr></thead>`
          : '';
        const bodySource = d.header ? bodyRows : d.rows;
        const body = `<tbody>${bodySource.map((row) => `<tr>${row.map((c) => `<td>${renderInline(marked, c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
        return `<div class="blk-table-wrap"><table class="blk-table">${head}${body}</table></div>`;
      }
      case 'divider':
        return '<hr class="blk-divider">';
      case 'image':
        return renderImageBlock(d);
      case 'columns': {
        // --w — доля flex-grow (число, НЕ проценты, см. .blk-column в
        // editor-obsidian.css) — с процентным flex-basis ряд из колонок был
        // на 1 gap шире контейнера и переносился целиком на новую строку.
        const cols = d.columns.map((c) =>
          `<div class="blk-column" style="--w:${c.widthPct}">${renderBlocks(c.blocks, marked)}</div>`
        ).join('');
        return `<div class="blk-columns">${cols}</div>`;
      }
      case 'infobox': {
        const img = d.image
          ? `<div class="blk-infobox-art"><img src="${escapeAttr(d.image.src)}" alt="${escapeAttr(d.image.alt)}" loading="lazy"></div>`
          : '';
        // Значения/подписи строк — тот же инлайн-markdown, что и везде
        // (жирный/курсив/вики-ссылки и т.п.), а не сырой экранированный текст —
        // иначе, например, [Название]((статья)) в значении инфобокса
        // показывалось буквально в виде скобок вместо ссылки (баг "форматирование
        // в инфоблоке не работает").
        const rows = d.rows.map((r) =>
          `<div class="blk-infobox-row"><dt>${renderInline(marked, r.label)}</dt><dd>${renderInline(marked, r.value)}</dd></div>`
        ).join('');
        return `<aside class="blk-infobox">`
          + (d.title ? `<div class="blk-infobox-head">${renderInline(marked, d.title)}</div>` : '')
          + img
          + `<dl class="blk-infobox-rows">${rows}</dl>`
          + `</aside>`;
      }
      case 'callout': {
        const variant = CALLOUT_ICON[d.variant] ? d.variant : 'info';
        return `<div class="blk-callout blk-callout-${variant}">`
          + `<i class="fas ${CALLOUT_ICON[variant]}" aria-hidden="true"></i>`
          + `<div class="blk-callout-body"><b>${escapeHtml(d.title || CALLOUT_LABEL[variant])}</b>${renderInline(marked, d.markdown)}</div>`
          + `</div>`;
      }
      case 'spoiler-section':
        return `<details class="blk-spoiler-section"${d.openByDefault ? ' open' : ''}>`
          + `<summary>${escapeHtml(d.title)}</summary>`
          + `<div class="blk-spoiler-body">${renderBlocks(d.blocks, marked)}</div>`
          + `</details>`;
      default:
        return ''; // неизвестный тип блока (см. blocks.js normalizeBlockData) — просто пропускаем
    }
  }

  function renderBlocks(blockList, marked) {
    return (blockList || []).map((b) => renderBlock(b, marked)).join('\n');
  }

  /**
   * Рендерит документ статьи { version, blocks } в безопасный HTML.
   * articlesIndexBySlug — Map<slug, {slug,title,tags}> (см. loadArticlesIndex
   * в editor-manager.js / ibripedia.js) — нужна, чтобы отличить существующую
   * wiki-ссылку от несуществующей (класс wiki-link / wiki-link-missing).
   * restrictedSlugs — Set<slug> статей, которые существуют, но недоступны
   * читателю ни на одном слое (см. replaceWikilinkMarkersInDom выше) —
   * класс wiki-link-restricted вместо wiki-link-missing.
   */
  async function renderArticleBlocks(doc, articlesIndexBySlug, restrictedSlugs) {
    const blockList = doc && Array.isArray(doc.blocks) ? doc.blocks : [];
    if (!blockList.length) {
      return '<p class="preview-empty">Нечего показывать — в статье пока нет ни одного блока.</p>';
    }

    const marked = await loadMarked();
    const DOMPurify = await loadDOMPurify();

    const rawHtml = renderBlocks(blockList, marked);
    const clean = DOMPurify.sanitize(rawHtml, {
      // id/data-block-id — простановлены withBlockAttrs() выше, нужны
      // оглавлению (клик по заголовку) и закладкам (привязка к блоку) в
      // ibripedia.js; явно разрешаем, а не полагаемся на дефолтный список.
      ADD_ATTR: ['target', 'style', 'class', 'loading', 'open', 'id', 'data-block-id'],
      ADD_TAGS: ['details', 'summary', 'mark', 'figure', 'figcaption']
    });

    const container = document.createElement('div');
    container.innerHTML = clean;
    replaceWikilinkMarkersInDom(container, articlesIndexBySlug || new Map(), restrictedSlugs);
    highlightHashtagsInDom(container);
    return container.innerHTML;
  }

  /**
   * Вешает делегированный обработчик клика по инлайн-спойлерам ||текст|| —
   * раскрывает их по клику (см. .spoiler/.revealed в blocks-view.css).
   * Wiki-ссылки/#хэштеги по-прежнему обрабатываются вызывающим кодом
   * (ibripedia.js::handleViewContentClick и т.п.) — это единственное новое
   * интерактивное поведение, которого раньше не было.
   */
  function attachInteractions(container) {
    if (!container || container.__blocksInteractionsAttached) return;
    container.__blocksInteractionsAttached = true;
    container.addEventListener('click', (e) => {
      const el = e.target.closest('.spoiler');
      if (el) el.classList.toggle('revealed');
    });
  }

  // ===== Краткий текст статьи для карточек/excerpt (аналог старой
  // stripMarkdownForExcerpt, но по дереву блоков, а не по markdown-строке) =====

  function collectExcerptText(blockList) {
    const parts = [];
    (blockList || []).forEach((block) => {
      const d = block.data || {};
      switch (block.type) {
        case 'paragraph': case 'heading': case 'quote':
          if (d.markdown) parts.push(d.markdown); break;
        case 'callout':
          if (d.markdown) parts.push(d.markdown); break;
        case 'list':
          (d.items || []).forEach((it) => it.markdown && parts.push(it.markdown)); break;
        case 'columns':
          (d.columns || []).forEach((c) => parts.push(collectExcerptText(c.blocks))); break;
        case 'spoiler-section':
          parts.push(collectExcerptText(d.blocks)); break;
        default: break; // table/infobox/code/image/divider — не участвуют в excerpt
      }
    });
    return parts.join(' ');
  }

  // Подпись wiki-ссылки для excerpt — тот же резолв, что и в
  // replaceWikilinkMarkersInDom (пустая подпись -> заголовок цели,
  // вариативная по слою [вариант1|слой1:...]((цель)) -> вариант, подошедший
  // РЕЗОЛВНУТОМУ для ЭТОГО читателя заголовку цели, см. articlesIndexBySlug),
  // а не сырой синтаксис — иначе, например, [название]((статья)) в начале
  // текста показывалось в карточке буквально, со скобками, а вариативная
  // подпись по слою — как есть, с "|"/":" ("многослойная система статей":
  // пересылка на пересылку к под-статье должна показывать ПРАВИЛЬНЫЙ,
  // резолвнутый для читателя вариант, а не первый попавшийся/сырой).
  function resolveExcerptWikilinkLabel(label, target, articlesIndexBySlug) {
    const article = articlesIndexBySlug ? articlesIndexBySlug.get(slugify(target.trim())) : null;
    const ownLabel = label.trim();
    if (!ownLabel) return (article && article.title) || target.trim();
    const variants = parseWikilinkVariants(ownLabel);
    if (!variants) return ownLabel;
    const matched = article ? resolveWikilinkVariantCaption(variants, article.title) : null;
    if (matched != null) return matched;
    if (article && article.title) return article.title;
    return variants[0]?.caption || target.trim();
  }

  function blocksToExcerptText(doc, maxLen = 180, articlesIndexBySlug = null) {
    const blockList = doc && Array.isArray(doc.blocks) ? doc.blocks : [];
    const raw = collectExcerptText(blockList)
      // [Имя]((статья)) — подпись, а без неё ([]((статья))) — сама цель
      .replace(/\[([^\]\n]*)\]\(\(([^()#\n]+)(?:#[^()\n]*)?\)\)/g, (m, label, target) =>
        resolveExcerptWikilinkLabel(label, target, articlesIndexBySlug))
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^[ \t]*[-*+][ \t]+/gm, '')
      .replace(/^[ \t]*\d+\.[ \t]+/gm, '')
      .replace(/[*_~`]|\+\+|==|\|\|/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (raw.length <= maxLen) return raw;
    return raw.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
  }

  window.renderArticleBlocks = renderArticleBlocks;
  window.blocksToExcerptText = blocksToExcerptText;
  window.attachBlocksInteractions = attachInteractions;
  // Разбор/сборка вариативных подписей wiki-ссылки по слою цели ([вариант1:
  // вариант2]((статья))) — переиспользуются редактором (editor-manager.js):
  // автозамена "/N" на название слоя после выбора статьи в автодополнении,
  // подсветка нерезолвнутых плейсхолдеров, диалог вставки ссылки с вариантами.
  window.parseWikilinkVariants = parseWikilinkVariants;
  window.buildWikilinkVariantsLabel = buildWikilinkVariantsLabel;
  window.WIKILINK_PARSE_RE_G = WIKILINK_PARSE_RE_G;
})();
