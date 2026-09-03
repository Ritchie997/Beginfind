// graph-view.js — переиспользуемый рендер графа связей статей (SVG + d3-force).
// Используется на дашборде (карточка "Граф связей статей", initGraphPage
// монтируется в #graphContainer из views/dashboard.html) и локальной
// панелью графа внутри редактора (editor-manager.js).
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

  /**
   * Отрисовывает граф в переданный контейнер.
   * @param {HTMLElement} container — куда монтировать SVG (заполняет его целиком)
   * @param {{nodes: {slug,title}[], edges: {from,to}[]}} data
   * @param {{onNodeClick?: (slug:string)=>void, centerSlug?: string, compact?: boolean}} options
   *   centerSlug — если задан, этот узел закрепляется в центре и подсвечивается
   *   (используется локальной панелью графа в редакторе).
   *   compact — уменьшенные подписи/радиусы для маленькой панели.
   * @returns {Promise<{destroy: () => void}>}
   */
  async function renderGraph(container, data, options = {}) {
    const d3 = await loadD3();
    const { onNodeClick, centerSlug, compact } = options;

    container.innerHTML = '';
    const width = container.clientWidth || 400;
    const height = container.clientHeight || 400;

    if (!data.nodes.length) {
      const empty = document.createElement('div');
      empty.className = 'graph-empty';
      empty.textContent = 'Пока нет статей для отображения графа.';
      container.appendChild(empty);
      return { destroy() {} };
    }

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

    // Соседи каждого узла — для подсветки при наведении
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
      .attr('class', 'graph-node-circle');

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

    node.on('mouseenter', function (event, n) {
      const related = neighbors.get(n.slug) || new Set([n.slug]);
      node.classed('graph-node-dim', (d) => !related.has(d.slug));
      node.classed('graph-node-hover', (d) => d.slug === n.slug);
      link.classed('graph-link-dim', (l) => l.source.slug !== n.slug && l.target.slug !== n.slug);
      link.classed('graph-link-active', (l) => l.source.slug === n.slug || l.target.slug === n.slug);
    });

    node.on('mouseleave', function () {
      node.classed('graph-node-dim', false);
      node.classed('graph-node-hover', false);
      link.classed('graph-link-dim', false);
      link.classed('graph-link-active', false);
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
      }
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

  // Инициализация графовой карточки на дашборде (public/views/dashboard.html):
  // ищет #graphContainer/#graphNodeCount в уже вставленной разметке страницы
  // и рисует в них граф. Вызывается из spa-router.js (loadDashboard).
  async function initGraphPage() {
    const container = document.getElementById('graphContainer');
    if (!container) return;

    container.innerHTML = '<div class="graph-empty">Загрузка графа…</div>';

    const result = await window.apiClient.makeAuthenticatedRequest('/api/articles-graph');
    if (!result.success) {
      container.innerHTML = '<div class="graph-empty">Не удалось загрузить граф связей.</div>';
      return;
    }

    const countEl = document.getElementById('graphNodeCount');
    if (countEl) {
      countEl.textContent = `Статей: ${result.data.nodes.length} · Связей: ${result.data.edges.length}`;
    }

    await renderGraph(container, result.data, { onNodeClick: navigateToArticle });

    const legend = document.createElement('div');
    legend.className = 'graph-legend';
    legend.innerHTML = `
      <span><span class="dot dot-normal"></span>Статья</span>
      <span>Наведите — увидите название и связи · Клик — открыть · Колесо — масштаб · Перетаскивание — сдвинуть</span>
    `;
    container.appendChild(legend);
  }

  window.GraphView = { renderGraph, loadD3, navigateToArticle, initGraphPage };
})();
