// graph-view.js — переиспользуемый рендер графа связей статей (SVG + d3-force).
// Используется на дашборде (карточка "Граф связей статей", initGraphPage
// монтируется в #graphContainer из views/dashboard.html, вместе с панелью
// фильтров — сервер / поиск / изолированные статьи / экспорт в PNG) и
// локальной панелью графа внутри редактора (editor-manager.js, без фильтров
// — там граф и так уже сужен до соседей одной статьи).
//
// d3 подключается так же, как CodeMirror в editor-manager.js: динамическим
// import() из CDN, версии зафиксированы и явно согласованы через ?deps=,
// чтобы d3-drag/d3-zoom ссылались на тот же экземпляр d3-selection.

(function () {
  'use strict';

  const D3_SELECTION_VERSION = '3.0.0';
  const D3_DEPS = `d3-selection@${D3_SELECTION_VERSION}`;

  const D3_URLS = {
    selection: `https://esm.sh/d3-selection@${D3_SELECTION_VERSION}`,
    force: 'https://esm.sh/d3-force@3.0.0',
    drag: `https://esm.sh/d3-drag@3.0.0?deps=${D3_DEPS}`,
    zoom: `https://esm.sh/d3-zoom@3.0.0?deps=${D3_DEPS}`
  };

  let d3Promise = null;
  function loadD3() {
    if (!d3Promise) {
      d3Promise = Promise.all([
        import(D3_URLS.selection),
        import(D3_URLS.force),
        import(D3_URLS.drag),
        import(D3_URLS.zoom)
      ]).then(([selection, force, drag, zoom]) => ({ ...selection, ...force, ...drag, ...zoom }));
    }
    return d3Promise;
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Палитра для раскраски узлов по категории — намеренно не пересекается с
  // семантическими цветами темы (--blurple/--green/--yellow/--red уже заняты
  // под обычный узел/центр/hover/недостающую ссылку в другом месте UI).
  const CATEGORY_PALETTE = ['#eb459e', '#f57e42', '#2dd4bf', '#a78bfa', '#84cc16', '#38bdf8', '#f472b6', '#fbbf24', '#22c55e', '#f87171'];
  const NO_CATEGORY_COLOR = '#8e9297';

  function buildCategoryColorMap(nodes) {
    const names = [...new Set(nodes.map((n) => (n.category || '').trim()).filter(Boolean))].sort();
    const map = new Map();
    names.forEach((name, i) => map.set(name, CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]));
    return map;
  }

  /**
   * Отрисовывает граф в переданный контейнер.
   * @param {HTMLElement} container — куда монтировать SVG (заполняет его целиком)
   * @param {{nodes: {slug,title,server?,category?}[], edges: {from,to}[]}} data
   * @param {{onNodeClick?: (slug:string)=>void, centerSlug?: string, compact?: boolean, colorByCategory?: boolean}} options
   *   centerSlug — если задан, этот узел закрепляется в центре и подсвечивается
   *   (используется локальной панелью графа в редакторе).
   *   compact — уменьшенные подписи/радиусы для маленькой панели.
   *   colorByCategory — красить узлы по категории статьи вместо однотонного
   *   --blurple (используется полной картой на дашборде, не локальной панелью
   *   — там всегда включён centerSlug, а не colorByCategory, конфликта нет).
   * @returns {Promise<{destroy: () => void, setSearchHighlight: (query: string) => void, categoryColors: Map<string,string>}>}
   */
  async function renderGraph(container, data, options = {}) {
    const d3 = await loadD3();
    const { onNodeClick, centerSlug, compact, colorByCategory } = options;

    container.innerHTML = '';
    const width = container.clientWidth || 400;
    const height = container.clientHeight || 400;

    if (!data.nodes.length) {
      const empty = document.createElement('div');
      empty.className = 'graph-empty';
      empty.textContent = 'Пока нет статей для отображения графа.';
      container.appendChild(empty);
      return { destroy() {}, setSearchHighlight() {}, categoryColors: new Map() };
    }

    const categoryColors = colorByCategory ? buildCategoryColorMap(data.nodes) : new Map();
    const colorFor = (n) => {
      const cat = (n.category || '').trim();
      return cat ? (categoryColors.get(cat) || NO_CATEGORY_COLOR) : NO_CATEGORY_COLOR;
    };

    // Степень узла (кол-во связей) — влияет на радиус точки
    const degree = new Map(data.nodes.map(n => [n.slug, 0]));
    data.edges.forEach(e => {
      degree.set(e.from, (degree.get(e.from) || 0) + 1);
      degree.set(e.to, (degree.get(e.to) || 0) + 1);
    });

    const nodes = data.nodes.map(n => ({ ...n, degree: degree.get(n.slug) || 0 }));
    const nodeBySlug = new Map(nodes.map(n => [n.slug, n]));
    const links = data.edges
      .filter(e => nodeBySlug.has(e.from) && nodeBySlug.has(e.to))
      .map(e => ({ source: e.from, target: e.to }));

    // Соседи каждого узла — для подсветки при наведении/поиске
    const neighbors = new Map(nodes.map(n => [n.slug, new Set([n.slug])]));
    links.forEach(l => {
      neighbors.get(l.source)?.add(l.target);
      neighbors.get(l.target)?.add(l.source);
    });

    const radiusFor = (n) => {
      const base = compact ? 4 : 6;
      const bonus = Math.min(n.degree * (compact ? 1 : 1.5), compact ? 6 : 14);
      const centerBonus = n.slug === centerSlug ? (compact ? 3 : 5) : 0;
      return base + bonus + centerBonus;
    };

    const svg = d3.select(container)
      .append('svg')
      .attr('class', 'graph-svg')
      .attr('viewBox', [0, 0, width, height]);

    const root = svg.append('g');

    svg.call(d3.zoom()
      .scaleExtent([0.2, 4])
      .on('zoom', (event) => root.attr('transform', event.transform)));

    const link = root.append('g')
      .attr('class', 'graph-links')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('class', 'graph-link');

    const node = root.append('g')
      .attr('class', 'graph-nodes')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .attr('class', (n) => 'graph-node' + (n.slug === centerSlug ? ' graph-node-center' : ''))
      .call(d3.drag()
        .on('start', (event, n) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          n.fx = n.x; n.fy = n.y;
        })
        .on('drag', (event, n) => { n.fx = event.x; n.fy = event.y; })
        .on('end', (event, n) => {
          if (!event.active) simulation.alphaTarget(0);
          n.fx = null; n.fy = null;
        }));

    node.append('circle')
      .attr('r', radiusFor)
      .attr('class', 'graph-node-circle')
      .style('fill', (n) => (colorByCategory && n.slug !== centerSlug) ? colorFor(n) : null);

    node.append('text')
      .attr('class', 'graph-node-label')
      .attr('text-anchor', 'middle')
      .attr('dy', (n) => -(radiusFor(n) + 4))
      .text((n) => n.title);

    node.append('title').text((n) => n.title);

    node.style('cursor', onNodeClick ? 'pointer' : 'default');
    if (onNodeClick) {
      node.on('click', (event, n) => onNodeClick(n.slug));
    }

    // Подсветка: набор "главных" slug (наведённый узел, либо совпадения
    // поиска) — подсвечивает их соседей и рёбра, остальное приглушает.
    // Используется и hover'ом, и setSearchHighlight ниже; при уходе курсора
    // мышью hover не сбрасывает подсветку "в ноль", а возвращается к текущему
    // активному поиску (если он есть) — иначе наведение мышью на граф во
    // время поиска сбивало бы результат при каждом movemove.
    let activeSearchQuery = '';

    function applyHighlight(primarySlugs) {
      if (!primarySlugs || !primarySlugs.size) {
        node.classed('graph-node-dim', false);
        link.classed('graph-link-dim', false).classed('graph-link-active', false);
        return;
      }
      const related = new Set(primarySlugs);
      links.forEach(l => {
        if (primarySlugs.has(l.source.slug) || primarySlugs.has(l.target.slug)) {
          related.add(l.source.slug);
          related.add(l.target.slug);
        }
      });
      node.classed('graph-node-dim', (d) => !related.has(d.slug));
      link.classed('graph-link-dim', (l) => !(primarySlugs.has(l.source.slug) || primarySlugs.has(l.target.slug)));
      link.classed('graph-link-active', (l) => primarySlugs.has(l.source.slug) || primarySlugs.has(l.target.slug));
    }

    function searchMatches() {
      if (!activeSearchQuery) return null;
      const matched = new Set(
        nodes.filter((n) => n.title.toLowerCase().includes(activeSearchQuery)).map((n) => n.slug)
      );
      return matched;
    }

    node.on('mouseenter', function (event, n) {
      node.classed('graph-node-hover', (d) => d.slug === n.slug);
      applyHighlight(new Set([n.slug]));
    });

    node.on('mouseleave', function () {
      node.classed('graph-node-hover', false);
      applyHighlight(searchMatches());
    });

    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id((n) => n.slug).distance(compact ? 45 : 70).strength(0.6))
      .force('charge', d3.forceManyBody().strength(compact ? -80 : -160))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide((n) => radiusFor(n) + 12));

    if (centerSlug && nodeBySlug.has(centerSlug)) {
      const c = nodeBySlug.get(centerSlug);
      c.fx = width / 2;
      c.fy = height / 2;
    }

    simulation.on('tick', () => {
      link
        .attr('x1', (l) => l.source.x)
        .attr('y1', (l) => l.source.y)
        .attr('x2', (l) => l.target.x)
        .attr('y2', (l) => l.target.y);
      node.attr('transform', (n) => `translate(${n.x},${n.y})`);
    });

    return {
      destroy() {
        simulation.stop();
        container.innerHTML = '';
      },
      // query='' снимает подсветку/приглушение целиком (обычный вид графа).
      // Непустой query без совпадений приглушает вообще все узлы — так видно,
      // что поиск отработал, а не завис/сломался.
      setSearchHighlight(query) {
        activeSearchQuery = (query || '').trim().toLowerCase();
        node.classed('graph-node-search-match', (d) => !!activeSearchQuery && d.title.toLowerCase().includes(activeSearchQuery));
        applyHighlight(searchMatches());
      },
      categoryColors
    };
  }

  // Навигация к статье по slug — используется и полной страницей графа
  // (сначала переключается на /articles), и локальной панелью (уже там).
  async function navigateToArticle(slug) {
    if (!window.spaRouter) return;
    if (window.spaRouter.normalizePathForRouting?.(window.location.pathname) !== '/articles') {
      await window.spaRouter.navigateTo('/articles');
    }
    window.spaRouter.editArticle(slug);
  }

  // Экспорт текущего вида графа (с учётом применённого зума/панорамирования)
  // в PNG. Внешние стили из editor-obsidian.css в сериализованный SVG не
  // попадают, поэтому перед экспортом реальные вычисленные цвета/толщины
  // линий переносятся на клон как inline style — иначе картинка вышла бы
  // бесцветной (чёрные линии и точки на прозрачном фоне).
  async function exportGraphPng(container) {
    const svgEl = container.querySelector('svg.graph-svg');
    if (!svgEl || !svgEl.clientWidth) {
      window.showMessage?.('Граф ещё не отрисован — нечего экспортировать.', 'error');
      return;
    }

    const width = svgEl.clientWidth;
    const height = svgEl.clientHeight;

    const clone = svgEl.cloneNode(true);
    const originals = svgEl.querySelectorAll('*');
    const clones = clone.querySelectorAll('*');
    const STYLE_PROPS = ['fill', 'stroke', 'stroke-width', 'opacity', 'font-size', 'font-weight', 'font-family', 'text-anchor'];
    originals.forEach((origEl, i) => {
      const cs = getComputedStyle(origEl);
      let styleStr = '';
      STYLE_PROPS.forEach((p) => { styleStr += `${p}:${cs.getPropertyValue(p)};`; });
      clones[i].setAttribute('style', styleStr);
    });
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));

    const bg = getComputedStyle(container).backgroundColor || '#202225';
    const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bgRect.setAttribute('width', '100%');
    bgRect.setAttribute('height', '100%');
    bgRect.setAttribute('fill', bg);
    clone.insertBefore(bgRect, clone.firstChild);

    const svgString = new XMLSerializer().serializeToString(clone);
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });

      const scale = 2; // экспорт в 2x для чёткости на ретине/печати
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement('a');
        const stamp = new Date().toISOString().slice(0, 10);
        a.href = URL.createObjectURL(blob);
        a.download = `articles-graph-${stamp}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, 'image/png');
    } catch (e) {
      console.error('Не удалось экспортировать граф в PNG:', e);
      window.showMessage?.('Не удалось экспортировать граф в PNG', 'error');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function renderCategoryLegend(container, categoryColors) {
    const legend = document.createElement('div');
    legend.className = 'graph-legend';
    const swatches = [...categoryColors.entries()]
      .map(([name, color]) => `<span><span class="dot" style="background:${color}"></span>${escapeHtml(name)}</span>`)
      .join('');
    legend.innerHTML = `
      ${swatches}
      <span><span class="dot" style="background:${NO_CATEGORY_COLOR}"></span>Без категории</span>
      <span>Наведите/ищите — подсветка связей · Клик — открыть · Колесо — масштаб · Перетаскивание — сдвинуть</span>
    `;
    container.appendChild(legend);
  }

  // Инициализация графовой карточки на дашборде (public/views/dashboard.html):
  // ищет #graphContainer/#graphNodeCount и панель фильтров (#graphServerFilter,
  // #graphSearchInput/#graphSearchClear, #graphHideIsolated, #graphExportPng)
  // в уже вставленной разметке страницы. Вызывается из spa-router.js (loadDashboard).
  async function initGraphPage() {
    const container = document.getElementById('graphContainer');
    if (!container) return;

    container.innerHTML = '<div class="graph-empty">Загрузка графа…</div>';

    const result = await window.apiClient.makeAuthenticatedRequest('/api/articles-graph');
    if (!result.success) {
      container.innerHTML = '<div class="graph-empty">Не удалось загрузить граф связей.</div>';
      return;
    }
    const fullData = result.data;

    const serverSelect = document.getElementById('graphServerFilter');
    if (serverSelect) {
      const serversResult = await window.apiClient.makeAuthenticatedRequest('/api/servers');
      const servers = (serversResult.success && Array.isArray(serversResult.data)) ? serversResult.data : [];
      serverSelect.innerHTML = '<option value="">Все серверы</option>'
        + servers.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
    }

    const hideIsolatedEl = document.getElementById('graphHideIsolated');
    const countEl = document.getElementById('graphNodeCount');
    const searchInput = document.getElementById('graphSearchInput');
    const searchClearBtn = document.getElementById('graphSearchClear');

    let instance = null;

    function visibleData() {
      const serverVal = serverSelect?.value || '';
      let nodes = fullData.nodes;
      if (serverVal) {
        nodes = nodes.filter((n) => String(n.server ?? '') === serverVal);
      }
      let slugSet = new Set(nodes.map((n) => n.slug));
      let edges = fullData.edges.filter((e) => slugSet.has(e.from) && slugSet.has(e.to));

      if (hideIsolatedEl?.checked) {
        const connected = new Set();
        edges.forEach((e) => { connected.add(e.from); connected.add(e.to); });
        nodes = nodes.filter((n) => connected.has(n.slug));
        slugSet = new Set(nodes.map((n) => n.slug));
        edges = edges.filter((e) => slugSet.has(e.from) && slugSet.has(e.to));
      }
      return { nodes, edges };
    }

    async function rerender() {
      if (instance) { instance.destroy(); instance = null; }
      const data = visibleData();
      if (countEl) countEl.textContent = `Статей: ${data.nodes.length} · Связей: ${data.edges.length}`;
      instance = await renderGraph(container, data, { onNodeClick: navigateToArticle, colorByCategory: true });
      if (searchInput?.value.trim()) instance.setSearchHighlight(searchInput.value);
      if (data.nodes.length) renderCategoryLegend(container, instance.categoryColors);
    }

    serverSelect?.addEventListener('change', rerender);
    hideIsolatedEl?.addEventListener('change', rerender);

    searchInput?.addEventListener('input', () => {
      const q = searchInput.value.trim();
      if (searchClearBtn) searchClearBtn.hidden = !q;
      instance?.setSearchHighlight(q);
    });
    searchClearBtn?.addEventListener('click', () => {
      if (!searchInput) return;
      searchInput.value = '';
      searchClearBtn.hidden = true;
      instance?.setSearchHighlight('');
      searchInput.focus();
    });

    document.getElementById('graphExportPng')?.addEventListener('click', () => exportGraphPng(container));

    await rerender();
  }

  window.GraphView = { renderGraph, loadD3, navigateToArticle, initGraphPage, exportGraphPng };
})();
