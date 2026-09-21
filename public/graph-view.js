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

  // Цвет узла без тегов (и тегов, для которых цвет не пришёл).
  const NO_TAG_COLOR = '#8e9297';

  function primaryTagOf(node, tagColors) {
    const map = tagColors || {};
    const key = (node.tags || []).find((t) => map[t]);
    return key ? { key, name: map[key].name || key, color: map[key].color } : null;
  }

  function tagNodeColor(node, tagColors) {
    const primary = primaryTagOf(node, tagColors);
    return primary ? primary.color : NO_TAG_COLOR;
  }

  /**
   * Отрисовывает граф в переданный контейнер.
   * @param {HTMLElement} container — куда монтировать SVG (заполняет его целиком)
   * @param {{nodes: {slug,title,server?,tags?}[], edges: {from,to}[]}} data
   * @param {{onNodeClick?: (slug:string)=>void, centerSlug?: string, compact?: boolean, colorByTag?: boolean, tagColors?: Object<string,{name:string,color:string}>}} options
   *   centerSlug — если задан, этот узел закрепляется в центре и подсвечивается
   *   (используется локальной панелью графа в редакторе).
   *   compact — уменьшенные подписи/радиусы для маленькой панели.
   *   colorByTag — красить узлы цветом тега статьи (первый тег узла, цвет из
   *   tagColors: { "тег": {name, color} }) вместо однотонного --blurple; статья
   *   без тегов — нейтрально-серая. Используется полной картой на дашборде, не
   *   локальной панелью редактора (там всегда включён centerSlug).
   *   uniformSize — все точки (и подписи) одного размера; по умолчанию false:
   *   размер точки и подписи растёт со степенью узла (см. SIZE ниже).
   * @returns {Promise<{destroy: () => void, setSearchHighlight: (query: string) => void, setUniformSize: (flag: boolean) => void}>}
   */
  async function renderGraph(container, data, options = {}) {
    const d3 = await loadD3();
    const { onNodeClick, centerSlug, compact, colorByTag, tagColors } = options;
    let uniformSize = !!options.uniformSize;

    container.innerHTML = '';
    const width = container.clientWidth || 400;
    const height = container.clientHeight || 400;

    if (!data.nodes.length) {
      const empty = document.createElement('div');
      empty.className = 'graph-empty';
      empty.textContent = 'Пока нет статей для отображения графа.';
      container.appendChild(empty);
      return { destroy() {}, setSearchHighlight() {}, setUniformSize() {} };
    }

    // Цвет узла — цвет ПЕРВОГО тега статьи (порядок тегов задаёт сервер: сперва
    // поле "Теги", затем #хэштеги из текста). У одного названия тега один цвет
    // во всей системе (см. src/services/tag-colors.js), поэтому статьи с одним
    // тегом окрашены одинаково.
    const colorFor = (n) => tagNodeColor(n, tagColors);

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

    // Размеры точек и подписей. Рост логарифмический: каждая следующая связь
    // прибавляет всё меньше (первая связь — заметный шаг, сотая — почти
    // незаметный), плюс жёсткий потолок max. Так хаб с десятками связей
    // остаётся "солнцем" среди "звёзд" (~4× крупнее листа), а не раздувается
    // до гигантского пятна при сотнях связей. Ориентиры для полной карты:
    //   связей 1 → 8px, 5 → 13px, 10 → 16px, 30 → 20px, 100 → 26px, потолок 30px.
    const SIZE = compact
      ? { base: 4, k: 1.8, max: 12, uniform: 5, center: 3, labelBase: 8, labelK: 1, labelMax: 11, labelHover: 15 }
      : { base: 5, k: 4.5, max: 30, uniform: 7, center: 5, labelBase: 9, labelK: 2.2, labelMax: 17, labelHover: 17 };

    const radiusFor = (n) => {
      const grown = uniformSize
        ? SIZE.uniform
        : Math.min(SIZE.base + SIZE.k * Math.log(1 + n.degree), SIZE.max);
      return grown + (n.slug === centerSlug ? SIZE.center : 0);
    };

    // Размер подписи растёт со степенью узла так же плавно, как и точка.
    const labelSizeFor = (n) => (uniformSize
      ? SIZE.labelBase
      : Math.min(SIZE.labelBase + SIZE.labelK * Math.log(1 + n.degree), SIZE.labelMax));

    // При наведении/поиске подпись увеличивается "лупой" примерно до одного
    // и того же размера (labelHover), а не в фиксированное число раз — иначе
    // уже крупная подпись хаба раздувалась бы до гигантской.
    const labelHoverScaleFor = (n) => Math.max(1.2, SIZE.labelHover / labelSizeFor(n));

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
          // Отпускаем узел обратно в свободную симуляцию (fx/fy = null).
          // Раньше держали его зафиксированным навсегда — это было нужно
          // только чтобы противостоять пружине кластеризации (её больше
          // нет). Постоянный пин сам стал багом: у
          // forceLink в d3 коррекция связи распределяется между двумя её
          // концами по степени узла (bias по count(source)/count(target)),
          // и это НЕ отключается через strength() — при связи с более
          // загруженным соседом физика ожидает, что бОльшую часть подстройки
          // возьмёт на себя менее загруженный (перетаскиваемый) узел. Если
          // он жёстко запинен, эта доля проваливается в никуда, и сосед
          // почти не двигается — то есть при перетаскивании края цепочки
          // "змейкой" сосед выглядит вкопанным в землю. Без постоянного
          // пина оба конца связи снова подстраиваются друг под друга
          // нормально.
          n.fx = null; n.fy = null;
        }));

    // Текущий поисковый запрос (в нижнем регистре) — нужен уже при первой
    // раскраске точек (fillFor), поэтому объявлен здесь, до создания кружков.
    let activeSearchQuery = '';

    // Цвет заливки: при активном поиске узел с тегом, подходящим под запрос,
    // красится цветом ЭТОГО тега (а не первого тега статьи); без поиска — как
    // раньше, цвет первого тега. null — заливка из CSS (центр локального графа
    // и однотонный режим без colorByTag).
    const fillFor = (n) => {
      if (!colorByTag || n.slug === centerSlug) return null;
      const matched = matchingTagOf(n);
      return matched ? tagColors[matched].color : colorFor(n);
    };

    const circle = node.append('circle')
      .attr('r', radiusFor)
      .attr('class', 'graph-node-circle')
      .style('fill', fillFor);

    node.append('title').text((n) => n.title);

    // Подписи — отдельным слоем ПОВЕРХ всех точек (а не внутри группы своего
    // узла): иначе кружок соседнего узла, нарисованный позже в DOM, закрывал
    // бы подпись. Слой не принимает мышь — hover/клик идут на точки под ним.
    // Порядок — по возрастанию степени, чтобы подпись хаба была над мелкими.
    // Каждая подпись — группа-обёртка с translate (CSS-scale на самом text
    // иначе перебил бы translate-атрибут) и теми же классами состояния
    // (hover/dim/search-match/center), что и у её узла — см. setNodeClass.
    const label = root.append('g')
      .attr('class', 'graph-labels')
      .style('pointer-events', 'none')
      .selectAll('g')
      .data([...nodes].sort((a, b) => a.degree - b.degree))
      .join('g')
      .attr('class', (n) => 'graph-label' + (n.slug === centerSlug ? ' graph-node-center' : ''));

    const labelText = label.append('text')
      .attr('class', 'graph-node-label')
      .attr('text-anchor', 'middle')
      .attr('dy', (n) => -(radiusFor(n) + 4))
      .style('font-size', (n) => `${labelSizeFor(n)}px`)
      .style('--label-hover-scale', labelHoverScaleFor)
      .text((n) => n.title);

    // Состояние подсветки живёт и на точке, и на её подписи.
    const setNodeClass = (name, predicate) => {
      node.classed(name, predicate);
      label.classed(name, predicate);
    };

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
    function applyHighlight(primarySlugs) {
      if (!primarySlugs || !primarySlugs.size) {
        setNodeClass('graph-node-dim', false);
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
      setNodeClass('graph-node-dim', (d) => !related.has(d.slug));
      link.classed('graph-link-dim', (l) => !(primarySlugs.has(l.source.slug) || primarySlugs.has(l.target.slug)));
      link.classed('graph-link-active', (l) => primarySlugs.has(l.source.slug) || primarySlugs.has(l.target.slug));
    }

    // Поиск. Запрос с "#" ищет только по тегам, без "#" — по названию статьи
    // ИЛИ по тегу (набрал имя тега — видно все статьи с ним). Теги статьи —
    // это и поле "Теги" в форме, и #хэштеги прямо в тексте (см. extractHashtags
    // на сервере). Тег подходит, если запрос — часть его ключа или названия.
    function searchTerm() {
      return (activeSearchQuery.startsWith('#') ? activeSearchQuery.slice(1) : activeSearchQuery).trim();
    }

    function tagMatchesTerm(key, term) {
      if (String(key).toLowerCase().includes(term)) return true;
      const name = tagColors?.[key]?.name;
      return !!name && name.toLowerCase().includes(term);
    }

    // Первый (в порядке тегов статьи) тег узла, подходящий под запрос, — его
    // цвет получает точка, пока идёт поиск. Только теги с известным цветом.
    function matchingTagOf(n) {
      const term = searchTerm();
      if (!term) return null;
      return (n.tags || []).find((t) => tagColors?.[t] && tagMatchesTerm(t, term)) ?? null;
    }

    function nodeMatchesQuery(n) {
      const term = searchTerm();
      if (!term) return false;
      if ((n.tags || []).some((t) => tagMatchesTerm(t, term))) return true;
      return !activeSearchQuery.startsWith('#') && n.title.toLowerCase().includes(term);
    }

    function searchMatches() {
      if (!activeSearchQuery) return null;
      return new Set(nodes.filter(nodeMatchesQuery).map((n) => n.slug));
    }

    node.on('mouseenter', function (event, n) {
      setNodeClass('graph-node-hover', (d) => d.slug === n.slug);
      // Увеличенная подпись — поверх соседних подписей.
      label.filter((d) => d.slug === n.slug).raise();
      applyHighlight(new Set([n.slug]));
    });

    node.on('mouseleave', function () {
      setNodeClass('graph-node-hover', false);
      applyHighlight(searchMatches());
    });

    // Раньше отталкивание (charge) действовало на неограниченную дистанцию и
    // ничем не компенсировалось, кроме общего forceCenter (который просто
    // сдвигает центроид всего графа, а не тянет к нему каждый узел). Из-за
    // этого узлы без связей — на них не действует forceLink — улетали на
    // окраины тем дальше, чем больше было узлов в графе. distanceMax обрезает
    // взаимное отталкивание на большой дистанции, а слабые forceX/forceY
    // добавляют каждому узлу индивидуальную "гравитацию" к центру — весь граф
    // становится заметно компактнее, особенно изолированные точки.
    //
    // Крупные узлы физически "весомее": чем больше точка, тем сильнее она
    // отталкивает соседей, тем длиннее её связи (чтобы звёзды не садились на
    // само "солнце") и тем сильнее её тянет к центру — хаб оказывается в
    // середине, а листья раскидываются вокруг. Для однотонного режима все
    // радиусы равны SIZE.uniform, и формулы дают исходные значения.
    const linkDistanceFor = (l) => (compact ? 40 : 60)
      + Math.max(0, radiusFor(l.source) - SIZE.uniform)
      + Math.max(0, radiusFor(l.target) - SIZE.uniform);
    const chargeFor = (n) => -((compact ? 60 : 110) + Math.max(0, radiusFor(n) - SIZE.uniform) * (compact ? 3 : 8));
    const gravityFor = (n) => (uniformSize ? 0.03 : 0.025 + 0.012 * Math.log(1 + n.degree));
    const collideFor = (n) => radiusFor(n) + 12;

    const linkForce = d3.forceLink(links).id((n) => n.slug).distance(linkDistanceFor).strength(0.7);
    const chargeForce = d3.forceManyBody().strength(chargeFor).distanceMax(compact ? 220 : 380);
    const xForce = d3.forceX(width / 2).strength(gravityFor);
    const yForce = d3.forceY(height / 2).strength(gravityFor);
    const collideForce = d3.forceCollide(collideFor);

    const simulation = d3.forceSimulation(nodes)
      .force('link', linkForce)
      .force('charge', chargeForce)
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('x', xForce)
      .force('y', yForce)
      .force('collide', collideForce);

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
      label.attr('transform', (n) => `translate(${n.x},${n.y})`);
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
        setNodeClass('graph-node-search-match', nodeMatchesQuery);
        // Перекраска под цвет найденного тега — только пока в поиске что-то
        // введено; пустой запрос возвращает цвет первого тега.
        circle.style('fill', fillFor);
        applyHighlight(searchMatches());
      },
      // Переключение "растущие / одинаковые" точки на лету, без пересоздания
      // графа: пересчитываем радиусы, подписи и физику (force-аксессоры
      // нужно переустановить, иначе d3 держит кэш старых значений) и слегка
      // "встряхиваем" симуляцию, чтобы узлы разошлись под новые размеры.
      setUniformSize(flag) {
        const next = !!flag;
        if (next === uniformSize) return;
        uniformSize = next;
        circle.attr('r', radiusFor);
        labelText
          .attr('dy', (n) => -(radiusFor(n) + 4))
          .style('font-size', (n) => `${labelSizeFor(n)}px`)
          .style('--label-hover-scale', labelHoverScaleFor);
        linkForce.distance(linkDistanceFor);
        chargeForce.strength(chargeFor);
        xForce.strength(gravityFor);
        yForce.strength(gravityFor);
        collideForce.radius(collideFor);
        simulation.alpha(0.6).restart();
      }
    };
  }

  // Клик по узлу на странице графа — открывает статью на ПРОСМОТР во вкладке
  // Ibripedia (а не в редакторе): граф — это навигация по знаниям, править
  // статью можно оттуда кнопкой "Редактировать". Тот же путь, что и у
  // закладок профиля (см. openBookmarkedArticle в spa-router.js): сначала
  // дожидаемся загрузки страницы Ibripedia, затем открываем статью.
  // Локальная панель графа внутри редактора (editor-manager.js) этим не
  // пользуется — у неё свой onNodeClick.
  async function navigateToArticle(slug) {
    if (!slug || !window.spaRouter) return;
    await window.spaRouter.navigateTo('/ibripedia');
    await window.ibripediaManager?.openArticleView(slug);
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
    const STYLE_PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-linejoin', 'paint-order', 'opacity', 'font-size', 'font-weight', 'font-family', 'text-anchor'];
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

  // Легенда: цвет узла = цвет его первого тега. Перечисляются самые частые
  // "первые" теги среди показанных узлов (не больше 12 — иначе легенда сама
  // заняла бы пол-графа), остальные сворачиваются в "+N".
  function renderGraphLegend(container, nodes, tagColors) {
    const legend = document.createElement('div');
    legend.className = 'graph-legend';

    const counts = new Map();
    let untagged = 0;
    nodes.forEach((n) => {
      const primary = primaryTagOf(n, tagColors);
      if (!primary) { untagged += 1; return; }
      const entry = counts.get(primary.key) || { ...primary, count: 0 };
      entry.count += 1;
      counts.set(primary.key, entry);
    });

    const LIMIT = 12;
    const sorted = [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
    const swatches = sorted.slice(0, LIMIT)
      .map((e) => `<span><span class="dot" style="background:${e.color}"></span>${escapeHtml(e.name)}</span>`)
      .join('');
    const more = sorted.length > LIMIT ? `<span>+${sorted.length - LIMIT} тегов</span>` : '';
    const noTag = untagged
      ? `<span><span class="dot" style="background:${NO_TAG_COLOR}"></span>Без тегов</span>`
      : '';

    legend.innerHTML = `
      ${swatches}${more}${noTag}
      <span>Цвет узла — цвет его первого тега (меняется во вкладке «Теги»), при поиске — цвет найденного тега · Размер — число связей · Наведите/ищите (# — только по тегам) — подсветка связей · Клик — открыть · Колесо — масштаб · Перетаскивание — сдвинуть</span>
    `;
    container.appendChild(legend);
  }

  // Инициализация графовой карточки на дашборде (public/views/dashboard.html):
  // ищет #graphContainer/#graphNodeCount и панель фильтров (#graphServerFilter,
  // #graphSearchInput/#graphSearchClear, #graphHideIsolated,
  // #graphHideLabels, #graphUniformSize, #graphExportPng) в уже вставленной разметке страницы.
  // Вызывается из spa-router.js (loadDashboard).
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
    const hideLabelsEl = document.getElementById('graphHideLabels');
    const uniformSizeEl = document.getElementById('graphUniformSize');
    const countEl = document.getElementById('graphNodeCount');
    const searchInput = document.getElementById('graphSearchInput');
    const searchClearBtn = document.getElementById('graphSearchClear');

    // При большом графе подписи всех узлов сразу превращаются в кашу —
    // по умолчанию включаем "подписи только при наведении/поиске", если
    // узлов много; пользователь может переключить вручную в любой момент.
    if (hideLabelsEl) {
      hideLabelsEl.checked = fullData.nodes.length > 50;
      container.classList.toggle('graph-hide-labels', hideLabelsEl.checked);
      hideLabelsEl.addEventListener('change', () => {
        container.classList.toggle('graph-hide-labels', hideLabelsEl.checked);
      });
    }

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
      instance = await renderGraph(container, data, {
        onNodeClick: navigateToArticle,
        colorByTag: true,
        tagColors: fullData.tagColors,
        uniformSize: !!uniformSizeEl?.checked
      });
      if (searchInput?.value.trim()) instance.setSearchHighlight(searchInput.value);
      if (data.nodes.length) renderGraphLegend(container, data.nodes, fullData.tagColors);
    }

    serverSelect?.addEventListener('change', rerender);
    hideIsolatedEl?.addEventListener('change', rerender);
    uniformSizeEl?.addEventListener('change', () => instance?.setUniformSize(uniformSizeEl.checked));

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

  window.GraphView = {
    renderGraph, loadD3, navigateToArticle, initGraphPage, exportGraphPng
  };
})();
