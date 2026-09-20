// blocks.js — модель контента статьи "как дерево типизированных блоков"
// (JSON) вместо одной markdown-строки с самодельным синтаксисом в фигурных
// скобках (см. историю в articles-store.js/editor-manager.js до перехода).
//
// Документ статьи: { version: 1, blocks: Block[] }
// Block: { id: string, type: string, data: object }
//
// Типы блоков v1 и форма их data — см. normalizeBlockData() ниже, там же
// единственное место, которое знает форму каждого типа (нормализация при
// чтении/записи и дефолты для новых блоков — держим их рядом, чтобы не
// разъезжались).
//
// Текстовые блоки (paragraph/heading/quote/callout) хранят markdown-СТРОКУ
// (жирный/курсив/подчёркнутый/выделение/спойлер/код/ссылки/[[wiki-ссылки]]/
// #хэштеги — как и раньше, инлайн-форматирование остаётся markdown-текстом,
// см. решение "оставить инлайн markdown + тулбар поверх"). Позиционирование
// и раскладка (картинка, колонки, инфобокс, сворачиваемая секция) —
// СТРУКТУРА (поля блока), а не текстовый синтаксис — это и есть отказ от
// старых "рамок"/{width=...} костылей.

const crypto = require('crypto');

const BLOCK_TYPES = [
  'paragraph', 'heading', 'list', 'quote', 'code', 'table', 'divider',
  'image', 'columns', 'infobox', 'callout', 'spoiler-section'
];

// Типы, которые могут содержать вложенные блоки (columns — по колонке,
// spoiler-section — напрямую) — вложенность одна: колонка/спойлер сами не
// могут содержать columns/spoiler-section (см. normalizeBlockData), чтобы
// не открывать дорогу бесконечной рекурсии в редакторе ради функционала,
// который пока никто не просил.
const CONTAINER_TYPES = new Set(['columns', 'spoiler-section']);

function genId() {
  try {
    return crypto.randomUUID();
  } catch (e) {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
}

function createEmptyDocument() {
  return { version: 1, blocks: [] };
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Нормализует одну строку markdown-поля блока (title/markdown и т.д.) —
// всегда строка, никогда undefined/null/не-строка.
function str(v, fallback = '') {
  return typeof v === 'string' ? v : fallback;
}

function num(v, fallback) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampPct(v, fallback = 100) {
  const n = num(v, fallback);
  return Math.min(100, Math.max(5, n));
}

// Нормализует блоки внутри контейнера (columns/spoiler-section) — на один
// уровень вложенности, без columns/spoiler-section внутри columns/
// spoiler-section (см. CONTAINER_TYPES).
function normalizeChildBlocks(raw, { allowContainers = false } = {}) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b) => normalizeBlock(b, { allowContainers }))
    .filter(Boolean);
}

// Приводит data блока к ожидаемой форме по типу; неизвестные лишние поля
// отбрасываются (не копим мусор), отсутствующие — дополняются дефолтом.
// allowContainers=false — используется при нормализации блоков ВНУТРИ
// columns/spoiler-section, чтобы не пускать их друг в друга.
function normalizeBlockData(type, rawData, { allowContainers }) {
  const data = isPlainObject(rawData) ? rawData : {};

  switch (type) {
    case 'paragraph':
      return { markdown: str(data.markdown) };

    case 'heading':
      return {
        level: [1, 2, 3].includes(parseInt(data.level, 10)) ? parseInt(data.level, 10) : 2,
        markdown: str(data.markdown)
      };

    case 'quote':
      return { markdown: str(data.markdown) };

    case 'code':
      return { language: str(data.language), code: str(data.code) };

    case 'list': {
      const style = ['bullet', 'ordered', 'checklist'].includes(data.style) ? data.style : 'bullet';
      const items = Array.isArray(data.items)
        ? data.items.map((it) => ({
            markdown: str(isPlainObject(it) ? it.markdown : it),
            checked: !!(isPlainObject(it) && it.checked)
          }))
        : [];
      return { style, items };
    }

    case 'table': {
      const rows = Array.isArray(data.rows)
        ? data.rows.map((row) => (Array.isArray(row) ? row.map((cell) => str(cell)) : []))
        : [];
      return { header: data.header !== false, rows };
    }

    case 'divider':
      return {};

    case 'image':
      return {
        src: str(data.src),
        alt: str(data.alt),
        widthPct: clampPct(data.widthPct, 100),
        align: ['left', 'right', 'center', 'full'].includes(data.align) ? data.align : 'center',
        frame: {
          show: !!(isPlainObject(data.frame) && data.frame.show),
          color: (isPlainObject(data.frame) && /^#[0-9a-fA-F]{3,8}$/.test(data.frame.color || ''))
            ? data.frame.color
            : '#5865f2'
        }
      };

    case 'columns': {
      const rawCols = Array.isArray(data.columns) && data.columns.length ? data.columns : [{}, {}];
      const columns = rawCols.map((c) => ({
        widthPct: clampPct(isPlainObject(c) ? c.widthPct : null, Math.floor(100 / rawCols.length)),
        blocks: normalizeChildBlocks(isPlainObject(c) ? c.blocks : [], { allowContainers: false })
      }));
      return { columns };
    }

    case 'infobox': {
      const image = isPlainObject(data.image) && data.image.src
        ? { src: str(data.image.src), alt: str(data.image.alt) }
        : null;
      const rows = Array.isArray(data.rows)
        ? data.rows.map((r) => ({ label: str(isPlainObject(r) ? r.label : ''), value: str(isPlainObject(r) ? r.value : '') }))
        : [];
      return { title: str(data.title), image, rows };
    }

    case 'callout': {
      const variant = ['info', 'tip', 'warning'].includes(data.variant) ? data.variant : 'info';
      return { variant, title: str(data.title), markdown: str(data.markdown) };
    }

    case 'spoiler-section':
      return {
        title: str(data.title, 'Подробности'),
        openByDefault: !!data.openByDefault,
        blocks: normalizeChildBlocks(data.blocks, { allowContainers: false })
      };

    default:
      // Неизвестный тип (например, блок из более новой версии редактора) —
      // сохраняем данные как есть, не теряем их молча; рендерер/редактор
      // просто пропустят то, чего не понимают.
      return data;
  }
}

function normalizeBlock(raw, { allowContainers = true } = {}) {
  if (!isPlainObject(raw)) return null;
  const type = str(raw.type);
  if (!type) return null;
  if (CONTAINER_TYPES.has(type) && !allowContainers) return null; // без вложенности в глубину

  return {
    id: str(raw.id) || genId(),
    type,
    data: normalizeBlockData(type, raw.data, { allowContainers })
  };
}

/**
 * Приводит произвольные входные данные (то, что реально может прийти по
 * API/из файла) к валидному документу { version, blocks }.
 *
 * Отдельно обрабатывает case "raw — обычная markdown-строка": пока не весь
 * фронтенд переведён на блочный редактор (см. Этап "Editor.js"), сюда может
 * прийти старое значение — оборачиваем его в один paragraph-блок вместо
 * того, чтобы молча терять контент.
 */
function normalizeDocument(raw) {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return createEmptyDocument();
    // Фронтенд шлёт документ как JSON-строку (см. innerHTML-шим в
    // editor-manager.js — сохраняет совместимость со старым кодом
    // spa-router.js, читающим содержимое статьи через .innerHTML). Пробуем
    // разобрать JSON и только если это не он — считаем строку "сырым"
    // markdown-текстом (переходный период/ручной вызов API) и оборачиваем
    // в один paragraph-блок, а не теряем содержимое молча.
    if (trimmed[0] === '{') {
      try {
        const parsed = JSON.parse(trimmed);
        if (isPlainObject(parsed) && Array.isArray(parsed.blocks)) {
          return { version: 1, blocks: normalizeChildBlocks(parsed.blocks, { allowContainers: true }) };
        }
      } catch (e) { /* не JSON — падаем в ветку "сырой текст" ниже */ }
    }
    return { version: 1, blocks: [{ id: genId(), type: 'paragraph', data: { markdown: raw } }] };
  }
  if (!isPlainObject(raw) || !Array.isArray(raw.blocks)) {
    return createEmptyDocument();
  }
  return { version: 1, blocks: normalizeChildBlocks(raw.blocks, { allowContainers: true }) };
}

// ===== Обход дерева блоков =====

function childBlockLists(block) {
  if (block.type === 'columns') return (block.data.columns || []).map((c) => c.blocks || []);
  if (block.type === 'spoiler-section') return [block.data.blocks || []];
  return [];
}

/**
 * Рекурсивно обходит все блоки документа (включая вложенные в columns/
 * spoiler-section) и вызывает visit(block) для каждого.
 */
function visitBlocks(doc, visit) {
  const walk = (blocks) => {
    for (const block of blocks || []) {
      visit(block);
      for (const nested of childBlockLists(block)) walk(nested);
    }
  };
  walk(doc && doc.blocks);
}

// Текст одного блока для полнотекстового поиска/индексации. includeCode —
// включать ли содержимое code-блоков (для поиска — да; для извлечения
// [[wiki-ссылок]]/#хэштегов — нет, см. collectLinkableText, по аналогии со
// старым computeCodeRanges, который исключал fenced code из разбора ссылок).
function blockText(block, { includeCode }) {
  const d = block.data || {};
  switch (block.type) {
    case 'paragraph':
    case 'heading':
    case 'quote':
      return d.markdown || '';
    case 'callout':
      return [d.title, d.markdown].filter(Boolean).join('\n');
    case 'list':
      return (d.items || []).map((it) => it.markdown).join('\n');
    case 'table':
      return (d.rows || []).map((row) => row.join(' | ')).join('\n');
    case 'infobox':
      return [d.title, ...(d.rows || []).map((r) => `${r.label}: ${r.value}`)].filter(Boolean).join('\n');
    case 'spoiler-section':
      return d.title || '';
    case 'code':
      return includeCode ? (d.code || '') : '';
    default:
      return '';
  }
}

/**
 * Весь текст документа для полнотекстового поиска (searchArticles/
 * filterArticles) — включает код-блоки.
 */
function documentSearchText(doc) {
  const parts = [];
  visitBlocks(doc, (block) => {
    const t = blockText(block, { includeCode: true });
    if (t) parts.push(t);
  });
  return parts.join('\n\n');
}

/**
 * Текст документа для разбора [[wiki-ссылок]]/#хэштегов — код-блоки
 * исключены (в примерах кода `[[как-в-css-переменной]]` не должен считаться
 * ссылкой на статью).
 */
function documentLinkableText(doc) {
  const parts = [];
  visitBlocks(doc, (block) => {
    const t = blockText(block, { includeCode: false });
    if (t) parts.push(t);
  });
  return parts.join('\n\n');
}

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const HASHTAG_RE = /(^|\s)#([a-zA-Zа-яА-ЯёЁ0-9_-]+)/g;

function extractWikiLinksFromDocument(doc, slugify) {
  const text = documentLinkableText(doc);
  const links = new Set();
  let m;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const target = slugify(m[1].trim());
    if (target) links.add(target);
  }
  return Array.from(links);
}

function extractHashtagsFromDocument(doc) {
  const text = documentLinkableText(doc);
  const tags = new Set();
  let m;
  HASHTAG_RE.lastIndex = 0;
  while ((m = HASHTAG_RE.exec(text)) !== null) {
    tags.add(m[2].toLowerCase());
  }
  return Array.from(tags);
}

// ===== Картинки: сбор путей / переписывание (formatImageUrl, normalizeImagePath) =====

/**
 * Возвращает список всех "картиночных" путей в документе — image-блоки и
 * обложка infobox — для formatImageUrl (абсолютизация при отдаче клиенту).
 */
function collectImagePaths(doc) {
  const paths = [];
  visitBlocks(doc, (block) => {
    if (block.type === 'image' && block.data.src) paths.push(block.data.src);
    if (block.type === 'infobox' && block.data.image && block.data.image.src) paths.push(block.data.image.src);
  });
  return paths;
}

/**
 * Возвращает НОВЫЙ документ с путями картинок, пропущенными через mapFn
 * (src) => newSrc. Используется и для абсолютизации при отдаче (formatImageUrl
 * в routes), и для нормализации при сохранении (normalizeImagePath).
 */
function mapImages(doc, mapFn) {
  const mapBlock = (block) => {
    if (block.type === 'image' && block.data.src) {
      return { ...block, data: { ...block.data, src: mapFn(block.data.src) } };
    }
    if (block.type === 'infobox' && block.data.image && block.data.image.src) {
      return { ...block, data: { ...block.data, image: { ...block.data.image, src: mapFn(block.data.image.src) } } };
    }
    if (block.type === 'columns') {
      return {
        ...block,
        data: { columns: block.data.columns.map((c) => ({ ...c, blocks: c.blocks.map(mapBlock) })) }
      };
    }
    if (block.type === 'spoiler-section') {
      return { ...block, data: { ...block.data, blocks: block.data.blocks.map(mapBlock) } };
    }
    return block;
  };
  return { version: doc.version || 1, blocks: (doc.blocks || []).map(mapBlock) };
}

// ===== Изменение/удаление статьи: обновление [[wiki-ссылок]] в тексте блоков =====

// Те же части, что и в WIKILINK_RE, но с якорем и алиасом вместе с их
// разделителями (#/|) — чтобы заменить ссылку целиком, ничего не потеряв.
// Последняя группа — своё имя ссылки в круглых скобках сразу после ]]:
// [[статья]](Имя) (см. blocks-renderer.js); оно входит в совпадение целиком
// (со скобками), чтобы при удалении статьи не оставался хвост "(Имя)".
const WIKILINK_PARTS_RE = /\[\[([^\]|#]+)(#[^\]|]*)?(\|[^\]]*)?\]\](\([^()\n]+\))?/g;

/**
 * Переписывает [[wiki-ссылки]] во всех markdown-строках документа.
 * Ссылка распознаётся так же, как при разборе/рендере — по slugify(цель), а
 * не по точному тексту, поэтому [[Дракон]], [[дракон]] и [[drakon]] — одна
 * и та же ссылка.
 *
 * rewrite({ slug, target, anchor, alias, name }) получает slug цели, исходный
 * текст цели, а также якорь ("#раздел"), алиас ("|текст") и своё имя
 * ("(Имя)" сразу после ]]) — все с разделителями (или пустые строки) — и
 * возвращает строку-замену ссылки ЦЕЛИКОМ, включая "(Имя)", либо null, если
 * ссылку менять не нужно (поэтому переименование статьи само дописывает name
 * обратно, а удаление — нет). Возвращает { doc, changed }.
 */
function rewriteWikiLinksInDocument(doc, slugify, rewrite) {
  let changed = false;

  const rewriteText = (text) => {
    if (!text) return text;
    return text.replace(WIKILINK_PARTS_RE, (full, target, anchor, alias, name) => {
      const replacement = rewrite({ slug: slugify(target.trim()), target, anchor: anchor || '', alias: alias || '', name: name || '' });
      if (replacement == null || replacement === full) return full;
      changed = true;
      return replacement;
    });
  };

  const rewriteBlock = (block) => {
    const d = block.data || {};
    switch (block.type) {
      case 'paragraph':
      case 'heading':
      case 'quote':
        return { ...block, data: { ...d, markdown: rewriteText(d.markdown) } };
      case 'callout':
        return { ...block, data: { ...d, markdown: rewriteText(d.markdown) } };
      case 'list':
        return { ...block, data: { ...d, items: (d.items || []).map((it) => ({ ...it, markdown: rewriteText(it.markdown) })) } };
      case 'table':
        return { ...block, data: { ...d, rows: (d.rows || []).map((row) => row.map(rewriteText)) } };
      case 'columns':
        return { ...block, data: { columns: d.columns.map((c) => ({ ...c, blocks: c.blocks.map(rewriteBlock) })) } };
      case 'spoiler-section':
        return { ...block, data: { ...d, blocks: d.blocks.map(rewriteBlock) } };
      default:
        return block;
    }
  };

  const newDoc = { version: doc.version || 1, blocks: (doc.blocks || []).map(rewriteBlock) };
  return { doc: newDoc, changed };
}

module.exports = {
  BLOCK_TYPES,
  createEmptyDocument,
  normalizeDocument,
  normalizeBlock,
  visitBlocks,
  documentSearchText,
  documentLinkableText,
  extractWikiLinksFromDocument,
  extractHashtagsFromDocument,
  collectImagePaths,
  mapImages,
  rewriteWikiLinksInDocument
};
