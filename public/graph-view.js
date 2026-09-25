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

  // Выход из полноэкранного режима графа по Escape — один обработчик на весь
  // модуль (а не по одному на каждый visit дашборда через SPA-роутер), чтобы
  // не копить дублирующиеся document-level листенеры при повторных заходах
  // на вкладку. initGraphPage переписывает ссылку при каждом входе в
  // fullscreen и обнуляет её при уходе/перезаходе на страницу.
  let exitActiveGraphFullscreen = null;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && exitActiveGraphFullscreen) exitActiveGraphFullscreen();
  });

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

  // Узел-заглушка (locked:true, см. /api/articles-graph на сервере) — статья
  // существует, но этому читателю не открыт ни один её слой; сервер
  // сознательно не отдаёт её title/tags (не спойлерить сам факт секрета
  // названием), поэтому и подпись, и тултип — заглушка, а не n.title
  // (который для таких узлов null).
  function nodeDisplayTitle(n) {
    return n.locked ? '???' : (n.title || n.slug);
  }

  // ---------------------------------------------------------------------------
  // Космический фон графа: мерцающие звёзды на <canvas> под SVG.
  // Canvas, а не SVG-элементы: сотни постоянно меняющихся звёзд на SVG-узлах
  // тормозили бы граф, а один requestAnimationFrame по canvas почти бесплатен.
  // Звёзды не интерактивны (pointer-events: none) — клики/наведение идут в граф.
  //
  // Жизнь звезды: плавно загорается, (часть звёзд) мерцает, плавно гаснет до
  // нуля и возрождается в другом месте — поле постоянно меняется. Цвета — как в
  // реальном небе: больше всего белых, много голубых, немного красных.
  // Параллакс: у каждой звезды своя "глубина"; при панорамировании/зуме графа
  // звёзды смещаются медленнее его (далёкие — почти стоят), поэтому граф
  // как будто парит перед бесконечностью.
  // ---------------------------------------------------------------------------
  const TAU = Math.PI * 2;

  // [цвет "r,g,b", вес]: белые 50%, голубые 30%, красные 20%.
  const STAR_COLORS = [
    ['255,255,255', 34], ['235,242,255', 16],
    ['170,200,255', 16], ['135,175,255', 14],
    ['255,150,130', 12], ['255,110,95', 8]
  ];
  const STAR_COLOR_TOTAL = STAR_COLORS.reduce((sum, c) => sum + c[1], 0);

  function pickStarColor() {
    let r = Math.random() * STAR_COLOR_TOTAL;
    for (const [rgb, w] of STAR_COLORS) {
      r -= w;
      if (r < 0) return rgb;
    }
    return STAR_COLORS[0][0];
  }

  function createStarfield(container) {
    const canvas = document.createElement('canvas');
    canvas.className = 'graph-starfield';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    // При "уменьшить движение" в системе звёзды рисуются статично (без мерцания
    // и анимации), но параллакс при зуме/панораме остаётся.
    const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    let W = 0;
    let H = 0;
    let FW = 0; // поле звёзд шире видимой области (в 1.6 раза) — запас под параллакс и зум-аут
    let FH = 0;
    let dpr = 1;
    let stars = [];
    let transform = { x: 0, y: 0, k: 1 };
    let enabled = false;
    let inView = true;
    let rafId = 0;
    let lastTs = 0;

    const rand = (a, b) => a + Math.random() * (b - a);
    const wrap = (v, m) => ((v % m) + m) % m;

    function spawn(s, initial) {
      // Слой = глубина: 60% далёких мелких, 30% средних, 10% ближних.
      const roll = Math.random();
      const layer = roll < 0.6 ? 0 : (roll < 0.9 ? 1 : 2);
      s.big = layer === 2 && Math.random() < 0.2; // единицы ярких звёзд со свечением и лучами
      s.depth = [0.1, 0.22, 0.38][layer];
      s.r = s.big ? rand(1.5, 2.1) : [rand(0.35, 0.7), rand(0.6, 1.0), rand(0.9, 1.4)][layer];
      s.x = Math.random() * FW;
      s.y = Math.random() * FH;
      s.rgb = pickStarColor();
      s.maxA = s.big ? rand(0.85, 1) : rand(0.35, 0.85);
      s.dur = rand(6, 16);
      s.age = initial ? Math.random() * s.dur : 0;
      s.tw = Math.random() < 0.55 ? rand(0.25, 0.7) : 0; // ~55% звёзд мерцают
      s.period = rand(0.9, 3.2);
      s.phase = Math.random() * TAU;
      return s;
    }

    function draw(dt) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2;
      const cy = H / 2;
      const ox = (FW - W) / 2;
      const oy = (FH - H) / 2;

      for (const s of stars) {
        if (dt) {
          s.age += dt;
          if (s.age >= s.dur) spawn(s, false);
        }
        const u = reduceMotion ? 0.5 : s.age / s.dur;
        let a = s.maxA * Math.pow(Math.sin(Math.PI * u), 0.6);
        if (s.tw && !reduceMotion) {
          a *= 1 - s.tw * (0.5 + 0.5 * Math.sin(TAU * s.age / s.period + s.phase));
        }
        if (a < 0.02) continue;

        const zs = 1 + (transform.k - 1) * s.depth * 0.6;
        const px = cx + (wrap(s.x + transform.x * s.depth, FW) - ox - cx) * zs;
        const py = cy + (wrap(s.y + transform.y * s.depth, FH) - oy - cy) * zs;
        if (px < -12 || px > W + 12 || py < -12 || py > H + 12) continue;

        ctx.globalAlpha = a;
        if (s.big) {
          const g = ctx.createRadialGradient(px, py, 0, px, py, s.r * 6);
          g.addColorStop(0, `rgba(${s.rgb},0.45)`);
          g.addColorStop(1, `rgba(${s.rgb},0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(px, py, s.r * 6, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = a * 0.45;
          ctx.strokeStyle = `rgb(${s.rgb})`;
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.moveTo(px - s.r * 5, py); ctx.lineTo(px + s.r * 5, py);
          ctx.moveTo(px, py - s.r * 5); ctx.lineTo(px, py + s.r * 5);
          ctx.stroke();
          ctx.globalAlpha = a;
        }
        ctx.fillStyle = `rgb(${s.rgb})`;
        ctx.beginPath();
        ctx.arc(px, py, s.r, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function resize() {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      W = w;
      H = h;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      FW = W * 1.6;
      FH = H * 1.6;
      const count = Math.max(90, Math.min(700, Math.round((FW * FH) / 2600)));
      stars = Array.from({ length: count }, () => spawn({}, true));
      if (enabled) draw(0);
    }

    const shouldRun = () => enabled && inView && !document.hidden && !reduceMotion && container.isConnected;

    function frame(ts) {
      rafId = 0;
      if (!shouldRun()) return;
      const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.1) : 0;
      lastTs = ts;
      draw(dt);
      rafId = requestAnimationFrame(frame);
    }

    // Цикл живёт только пока звёзды видны: выключен переключателем, вкладка
    // скрыта или карточка вне экрана/убрана из DOM — анимация стоит.
    function sync() {
      if (shouldRun()) {
        if (!rafId) { lastTs = 0; rafId = requestAnimationFrame(frame); }
      } else if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    }

    const onVisibility = () => sync();
    document.addEventListener('visibilitychange', onVisibility);

    let intersectionObserver = null;
    if (typeof IntersectionObserver !== 'undefined') {
      intersectionObserver = new IntersectionObserver((entries) => {
        inView = entries[entries.length - 1].isIntersecting;
        sync();
      });
      intersectionObserver.observe(container);
    }

    let resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(container);
    }
    resize();

    return {
      setEnabled(flag) {
        enabled = !!flag;
        if (enabled) {
          if (!stars.length) resize();
          if (stars.length) draw(0);
        } else if (W) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, W, H);
        }
        sync();
      },
      // Вызывается из d3.zoom при каждом зуме/панораме графа (параллакс).
      setTransform(t) {
        transform = { x: t.x, y: t.y, k: t.k };
        if (enabled && !rafId && stars.length) draw(0);
      },
      destroy() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        enabled = false;
        document.removeEventListener('visibilitychange', onVisibility);
        intersectionObserver?.disconnect();
        resizeObserver?.disconnect();
        canvas.remove();
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Висячие цепочки: поиск и распутывание
  // ---------------------------------------------------------------------------
  // "Висячая цепочка" — хвост из нескольких узлов, который держится на графе
  // ровно одной связью (мост) и сам не содержит циклов — точка на конце
  // цепочки, цепочка из двух-трёх точек и т.п. Для каждой такой связи храним
  // якорь (конец, что остаётся в графе), голову хвоста и сам хвост.
  //
  // Зачем: силовая раскладка d3 имеет локальные минимумы. Хвост может
  // оказаться ВНУТРИ чужого цикла (типично: треугольник статей, от угла идёт
  // точка, от неё ещё одна — и крайняя точка запирается внутри треугольника):
  // отталкивание от вершин цикла давит на неё со всех сторон, а пружина
  // связи слишком слаба, чтобы протолкнуть её через "барьер" между двумя
  // вершинами. Такое положение физика сама не исправит, пока хвост не
  // перенесут руками — это делает untangle().
  //
  // Куда переносить. Раньше хвост зеркально отражали через пересечённое ребро
  // на то же расстояние. Пока запертый хвост один, это работает, но в плотном
  // графе с несколькими треугольниками отражение падает в СОСЕДНИЙ цикл, хвост
  // снова "пересекает" ребро, его отражают обратно — и так, пока не кончится
  // общий лимит срабатываний; каждый перенос перезапускает всю симуляцию,
  // поэтому граф дёргался, а часть хвостов так и оставалась запертой. Теперь
  // для хвоста ищется заведомо СВОБОДНОЕ место: на кольцах вокруг якоря,
  // начиная с направления "от остального графа", хвост целиком (все его
  // связи и точки) не пересекает чужих рёбер и не налезает на чужие точки.
  // Если хвост снова оказался запертым, следующая попытка начинается с
  // кольца подальше — то есть хвост расселяется всё дальше от цикла, пока не
  // найдёт место, и у каждого хвоста своё число попыток (а не общий лимит).
  const PENDANT_MAX = 8; // длиннее — это уже не "хвост", а часть графа
  const RELOCATE_RINGS = [0.6, 0.8, 1, 1.3, 1.7, 2.2, 3, 4, 5.5]; // радиус кольца в длинах связи
  const RELOCATE_ANGLE_STEPS = 48;                    // 48 направлений (шаг 7.5°): просветы между рёбрами бывают узкими
  const RELOCATE_MAX_ATTEMPTS = RELOCATE_RINGS.length;
  const RELOCATE_MAX_FAILURES = 6;  // безуспешных поисков места, после чего хвост оставляем в покое
  const NODE_GAP = 8;   // зазор между точкой хвоста и чужой точкой
  const LINK_GAP = 4;   // зазор между связью хвоста и чужой точкой

  // Пересечение отрезков p1p2 и p3p4. Проход ровно через конец чужого ребра
  // (вершину цикла) тоже считается пересечением — иначе связь, идущая через
  // угол треугольника, оставалась бы "незамеченной"; лежащие на одной прямой
  // отрезки пропускаем.
  const orient = (a, b, c) => {
    const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    return Math.abs(v) < 1e-6 ? 0 : v;
  };
  const segmentsCross = (p1, p2, p3, p4) => {
    const d1 = orient(p3, p4, p1);
    const d2 = orient(p3, p4, p2);
    const d3 = orient(p1, p2, p3);
    const d4 = orient(p1, p2, p4);
    if (!d1 && !d2) return false;
    return d1 * d2 <= 0 && d3 * d4 <= 0;
  };

  // Расстояние от точки p до отрезка ab.
  const distToSegment = (p, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };

  /**
   * @param {{nodeBySlug: Map, neighbors: Map<string, Set<string>>, pairs: {a, b}[],
   *   linkLength: (a, b) => number, radiusFor: (n) => number}} ctx
   *   pairs — уникальные связи (узлы, а не slug'и); узлы — те же объекты, что
   *   в симуляции (x/y обновляются на месте).
   * @returns {{pendants: object[], untangle: () => number, reset: () => void}}
   *   untangle() переносит запертые хвосты и возвращает, сколько перенесено;
   *   reset() возвращает хвостам все попытки (после ручного движения узлов).
   */
  function createPendantLayout({ nodeBySlug, neighbors, pairs, linkLength, radiusFor, pinnedSlug }) {
    const allNodes = [...nodeBySlug.values()];

    // Хвост за мостом anchor→head: Map slug→узел, либо null, если это не
    // мост, хвост длиннее PENDANT_MAX или в нём есть свои циклы.
    const pendantBeyond = (anchor, head) => {
      const comp = new Map([[head.slug, head]]);
      const stack = [head];
      while (stack.length) {
        const cur = stack.pop();
        for (const s of neighbors.get(cur.slug)) {
          if (s === cur.slug) continue;
          if (cur === head && s === anchor.slug) continue; // сама связь-мост
          if (s === anchor.slug) return null; // есть обход — это не мост
          if (comp.has(s)) continue;
          if (comp.size >= PENDANT_MAX) return null;
          const next = nodeBySlug.get(s);
          comp.set(s, next);
          stack.push(next);
        }
      }
      // Дерево (без своих циклов): рёбер внутри хвоста ровно "узлов − 1".
      let inner = 0;
      comp.forEach((n) => neighbors.get(n.slug).forEach((s) => { if (s !== n.slug && comp.has(s)) inner += 1; }));
      return inner / 2 === comp.size - 1 ? comp : null;
    };

    let pendants = [];
    pairs.forEach(({ a, b }) => {
      const sides = [[a, b], [b, a]]
        .map(([anchor, head]) => ({ anchor, head, comp: pendantBeyond(anchor, head) }))
        .filter((s) => s.comp);
      if (!sides.length) return;
      sides.sort((x, y) => x.comp.size - y.comp.size);
      pendants.push(sides[0]);
    });
    // Закреплённый узел (центр локального графа) никогда не переносится —
    // хвостом его не считаем.
    if (pinnedSlug) pendants = pendants.filter((p) => !p.comp.has(pinnedSlug));

    // Все узлы, которые входят в какой-нибудь хвост. Остальное — "ядро" графа.
    const tailSlugs = new Set();
    pendants.forEach((p) => p.comp.forEach((_, slug) => tailSlugs.add(slug)));

    pendants.forEach((p) => {
      p.attempts = 0; // сколько раз хвост уже переносили: с каждым разом — на кольцо дальше
      p.failures = 0; // сколько раз свободного места не нашлось
      p.nodes = [...p.comp.values()];
      // все связи хвоста: мост и то, что внутри
      p.edges = [[p.anchor, p.head]];
      p.nodes.forEach((n) => neighbors.get(n.slug).forEach((s) => {
        if (s !== n.slug && n.slug < s && p.comp.has(s)) p.edges.push([n, nodeBySlug.get(s)]);
      }));
    });
    // Сначала короткие хвосты: мелкую точку проще пристроить, чем сдвигать целую цепочку.
    pendants.sort((x, y) => x.comp.size - y.comp.size);

    const isPinned = (p) => p.nodes.some((n) => n.fx != null || n.fy != null);

    // Мост хвоста пересекает чужое ребро — хвост оказался по ту сторону
    // чужого ребра (внутри чужого цикла).
    const isTrapped = (p) => {
      const { anchor, head, comp } = p;
      for (const { a, b } of pairs) {
        if (a === anchor || b === anchor || comp.has(a.slug) || comp.has(b.slug)) continue;
        if (segmentsCross(anchor, head, a, b)) return true;
      }
      return false;
    };

    // "Стоимость" положения хвоста в ТЕКУЩИХ координатах: 0 — место свободно.
    // Штрафуются пересечения его связей с чужими рёбрами (главное), точки,
    // налезающие на чужие точки, и чужие точки, лежащие на его связях. Счёт
    // прерывается, как только стоимость дошла до limit — кандидат уже не лучше
    // текущего лучшего, дальше считать незачем.
    const COST_CROSS = 100; // жёсткий: пересечение важнее любой тесноты
    const COST_NODE = 2;
    const COST_LINK = 1;
    const tailCost = (p, limit) => {
      const { anchor, comp, nodes: tail, edges } = p;
      let cost = 0;
      for (const [u, v] of edges) {
        for (const { a, b } of pairs) {
          if (comp.has(a.slug) || comp.has(b.slug)) continue; // свои же связи
          if (a === u || a === v || b === u || b === v) continue; // общий конец
          if (a.x == null || b.x == null) continue; // ещё не расставлены
          if (segmentsCross(u, v, a, b)) {
            cost += COST_CROSS;
            if (cost >= limit) return cost;
          }
        }
      }
      for (const other of allNodes) {
        if (other === anchor || comp.has(other.slug) || other.x == null) continue;
        const or = radiusFor(other);
        for (const n of tail) {
          if (Math.hypot(n.x - other.x, n.y - other.y) < radiusFor(n) + or + NODE_GAP) cost += COST_NODE;
        }
        for (const [u, v] of edges) {
          if (u === other || v === other) continue;
          if (distToSegment(other, u, v) < or + LINK_GAP) cost += COST_LINK;
        }
        if (cost >= limit) return cost;
      }
      return cost;
    };

    // Перенос хвоста на ближайшее лучшее место вокруг якоря — свободное, а
    // если такого нет (плотный граф), то с меньшим числом пересечений, чем
    // сейчас. Хвост переносится целиком, сохраняя форму (поворот вокруг якоря
    // и растяжение). Кандидаты перебираются от близких колец к дальним и от
    // направления "наружу" к противоположному, поэтому первое же свободное
    // место — и есть ближайшее. initial — первичная расстановка хвоста:
    // берётся лучший из кандидатов, даже если он не лучше текущего положения.
    const relocate = (p, initial = false) => {
      const { anchor, head, comp, nodes: tail } = p;

      // "Наружу": от центра тяжести остальных соседей якоря.
      let cx = 0;
      let cy = 0;
      let k = 0;
      neighbors.get(anchor.slug).forEach((s) => {
        if (s === anchor.slug || comp.has(s)) return;
        const m = nodeBySlug.get(s);
        if (m.x == null) return;
        cx += m.x; cy += m.y; k += 1;
      });
      const base = k
        ? Math.atan2(anchor.y - cy / k, anchor.x - cx / k)
        : Math.atan2(head.y - anchor.y, head.x - anchor.x);

      // Форма хвоста в системе координат "якорь в нуле, голова на оси X".
      const L = Math.max(linkLength(anchor, head), 30);
      const d = Math.max(Math.hypot(head.x - anchor.x, head.y - anchor.y), 1);
      const phi = Math.atan2(head.y - anchor.y, head.x - anchor.x);
      const cosP = Math.cos(-phi);
      const sinP = Math.sin(-phi);
      const shape = tail.map((n) => {
        const ox = n.x - anchor.x;
        const oy = n.y - anchor.y;
        return { n, x0: n.x, y0: n.y, lx: ox * cosP - oy * sinP, ly: ox * sinP + oy * cosP };
      });
      const put = (theta, scale) => {
        const c = Math.cos(theta);
        const sn = Math.sin(theta);
        shape.forEach((f) => {
          f.n.x = anchor.x + scale * (f.lx * c - f.ly * sn);
          f.n.y = anchor.y + scale * (f.lx * sn + f.ly * c);
        });
      };
      const step = (2 * Math.PI) / RELOCATE_ANGLE_STEPS;

      let best = null;
      let bestCost = initial ? Infinity : tailCost(p, Infinity); // иначе — строго лучше, чем сейчас
      // Каждая новая попытка стартует с кольца дальше предыдущей.
      search:
      for (let ring = initial ? 0 : Math.min(p.attempts, RELOCATE_RINGS.length - 1); ring < RELOCATE_RINGS.length; ring++) {
        const scale = (L * RELOCATE_RINGS[ring]) / d;
        for (let j = 0; j < RELOCATE_ANGLE_STEPS; j++) {
          // 0, +1, −1, +2, −2 … шагов от направления "наружу"
          const theta = base + Math.ceil(j / 2) * step * (j % 2 ? 1 : -1);
          put(theta, scale);
          const cost = tailCost(p, bestCost);
          if (cost < bestCost) {
            bestCost = cost;
            best = { theta, scale };
            if (!cost) break search; // свободное место — лучшего не бывает
          }
        }
      }

      // При починке (не первичной расстановке) полумеры не нужны: перенос на
      // место, где хвост всё равно что-то пересекает, лишь перетряхивает
      // раскладку, не давая ничего взамен. Теснота же (зазоры) не помеха —
      // физика разведёт.
      if (!best || (!initial && bestCost >= COST_CROSS)) {
        shape.forEach((f) => { f.n.x = f.x0; f.n.y = f.y0; }); // свободного места не нашлось — оставляем как есть
        p.failures += 1; // ничего не изменилось — попытка ("дальше") не тратится
        return false;
      }
      put(best.theta, best.scale);
      tail.forEach((n) => { n.vx = 0; n.vy = 0; });
      if (!initial) p.attempts += 1;
      return true;
    };

    // Заготовка формы хвоста "по лучу" от якоря: голова на расстоянии L,
    // каждый следующий уровень — ещё на L дальше, ветви — веером в стороны.
    // Нужна лишь как исходная форма для relocate (поворачивается и
    // растягивается под найденное место), затем её доводит физика.
    const layTemplate = (p) => {
      const { anchor, head, comp } = p;
      const L = Math.max(linkLength(anchor, head), 30);
      const placed = new Map([[head.slug, { x: L, y: 0 }]]);
      const queue = [head];
      while (queue.length) {
        const cur = queue.shift();
        const at = placed.get(cur.slug);
        const kids = [...neighbors.get(cur.slug)].filter((s) => s !== cur.slug && comp.has(s) && !placed.has(s));
        kids.forEach((s, i) => {
          placed.set(s, { x: at.x + L, y: at.y + (i - (kids.length - 1) / 2) * L * 0.8 });
          queue.push(nodeBySlug.get(s));
        });
      }
      placed.forEach((pt, slug) => {
        const n = nodeBySlug.get(slug);
        n.x = anchor.x + pt.x;
        n.y = anchor.y + pt.y;
        n.vx = 0;
        n.vy = 0;
      });
    };

    // Корни: хвосты, чей якорь — в ядре. Вложенные хвосты (цепочка, ветвь)
    // расставляются вместе со своим корнем.
    const roots = pendants.filter((p) => !tailSlugs.has(p.anchor.slug));

    // Группа хвоста: корневой якорь и все узлы корневого хвоста. Связи внутри
    // группы (и сам мост) хвостовой точке не "чужие" — от них она не отталкивается.
    const groupOf = new Map();
    roots.forEach((r) => {
      const group = new Set(r.comp.keys());
      group.add(r.anchor.slug);
      r.comp.forEach((_, slug) => groupOf.set(slug, group));
    });

    // Сила "рёбра — стенки": точки хвостов отталкиваются от чужих связей.
    // Связи для d3-физики не препятствие (она двигает только точки), поэтому
    // хвост, поставленный на свободное место, отталкиванием от соседних
    // точек мог сползти через ребро — и всё начиналось заново. Тут ребро
    // держит хвост, пока тот не подошёл к нему ближе зазора.
    const EDGE_GAP = 14;      // зазор от линии до края точки
    const EDGE_PUSH = 5;      // "жёсткость" стенки, пикселей за тик у самой линии
    const EDGE_FORCE_MAX_WORK = 4e6; // хвостов × связей: дороже — не считаем (страхуют перенос и untangle)
    const tailNodes = [...tailSlugs].map((slug) => nodeBySlug.get(slug));
    const edgeForce = (alpha) => {
      if (tailNodes.length * pairs.length > EDGE_FORCE_MAX_WORK) return;
      const push = EDGE_PUSH * (0.4 + alpha);
      for (const n of tailNodes) {
        if (n.x == null || n.fx != null) continue;
        const group = groupOf.get(n.slug);
        const gap = radiusFor(n) + EDGE_GAP;
        for (const { a, b } of pairs) {
          if (group.has(a.slug) || group.has(b.slug) || a.x == null || b.x == null) continue;
          // грубая отсечка: точка далеко от отрезка по обеим осям
          if (n.x < Math.min(a.x, b.x) - gap || n.x > Math.max(a.x, b.x) + gap) continue;
          if (n.y < Math.min(a.y, b.y) - gap || n.y > Math.max(a.y, b.y) + gap) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((n.x - a.x) * dx + (n.y - a.y) * dy) / len2));
          let vx = n.x - (a.x + t * dx);
          let vy = n.y - (a.y + t * dy);
          const dist = Math.hypot(vx, vy);
          if (dist >= gap) continue;
          if (dist < 1e-6) { vx = -dy; vy = dx; } else { vx /= dist; vy /= dist; }
          const norm = Math.hypot(vx, vy) || 1;
          const k = (push * (gap - dist)) / gap / norm;
          n.vx += vx * k;
          n.vy += vy * k;
        }
      }
    };
    edgeForce.initialize = () => {};

    return {
      pendants,
      // Сила для d3-симуляции: чужие рёбра отталкивают точки хвостов.
      edgeForce,
      // Узел входит в какой-нибудь висячий хвост (а не в ядро графа).
      isTail: (n) => tailSlugs.has(n.slug),
      // Первичная расстановка хвостов вокруг УЖЕ разложенного ядра (у узлов
      // ядра есть координаты): каждый хвост сразу ставится на свободное место
      // снаружи, а не выбирается физикой из случайного начального положения —
      // так в ловушки внутри циклов он не попадает вообще. Короткие хвосты
      // первыми: уже поставленные считаются препятствиями для следующих.
      attach() {
        [...roots].sort((x, y) => x.comp.size - y.comp.size).forEach((p) => {
          layTemplate(p);
          relocate(p, true);
        });
      },
      untangle() {
        let moved = 0;
        for (const p of pendants) {
          if (p.attempts >= RELOCATE_MAX_ATTEMPTS || p.failures >= RELOCATE_MAX_FAILURES) continue;
          if (p.anchor.x == null || p.head.x == null) continue;
          // закреплённые (в т.ч. перетаскиваемые) узлы не трогаем
          if (isPinned(p)) continue;
          if (!isTrapped(p)) continue;
          if (relocate(p)) moved += 1;
        }
        return moved;
      },
      reset() {
        pendants.forEach((p) => { p.attempts = 0; p.failures = 0; });
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Группы статей: поиск сообществ по ссылкам (Louvain)
  // ---------------------------------------------------------------------------
  // Группа — статьи, которые ссылаются друг на друга заметно чаще, чем на
  // остальные. Теги не используются: у статей часто есть общие для всего
  // проекта теги (название мира, раздел), и группировка по ним склеила бы
  // всё в одну кучу, а ссылки отражают реальную структуру текста.
  //
  // Louvain: каждый узел сначала сам себе группа; узлы по очереди переходят
  // в соседнюю группу, если это увеличивает модулярность (доля связей внутри
  // групп сверх ожидаемой случайно), пока переходы есть. Затем группы
  // схлопываются в узлы нового уровня, и всё повторяется, пока что-то
  // меняется. Порядок обхода фиксирован — на тех же данных те же группы
  // (раскладка не перетасовывается при каждом открытии).
  //
  // Вход: slug'и и уникальные неориентированные пары [slugA, slugB, вес?]
  // (вес по умолчанию 1, см. linkWeightByTitle).
  // Выход: Map slug → номер группы (номера 0..k−1; изолированный узел —
  // отдельная группа из одного узла).
  function detectCommunities(slugs, pairList) {
    const index = new Map(slugs.map((s, i) => [s, i]));
    // adj[i]: Map j → вес; петля adj[i].get(i) хранит удвоенный вес
    // внутренних связей — тогда степень узла = сумма по строке.
    let adj = slugs.map(() => new Map());
    pairList.forEach(([a, b, weight = 1]) => {
      const i = index.get(a);
      const j = index.get(b);
      if (i == null || j == null || i === j) return;
      adj[i].set(j, (adj[i].get(j) || 0) + weight);
      adj[j].set(i, (adj[j].get(i) || 0) + weight);
    });
    const membership = slugs.map((_, i) => i); // исходный узел → узел текущего уровня

    for (let level = 0; level < 10; level++) {
      const n = adj.length;
      const k = adj.map((row) => { let s = 0; row.forEach((w) => { s += w; }); return s; });
      const m2 = k.reduce((s, v) => s + v, 0);
      if (!m2) break;
      const comm = adj.map((_, i) => i);
      const tot = k.slice();
      let movedAny = false;

      for (let pass = 0; pass < 30; pass++) {
        let moved = false;
        for (let i = 0; i < n; i++) {
          if (!k[i]) continue;
          const ci = comm[i];
          tot[ci] -= k[i];
          const w = new Map();
          adj[i].forEach((weight, j) => {
            if (j === i) return;
            w.set(comm[j], (w.get(comm[j]) || 0) + weight);
          });
          let best = ci;
          let bestGain = (w.get(ci) || 0) - (tot[ci] * k[i]) / m2;
          w.forEach((weight, c) => {
            const gain = weight - (tot[c] * k[i]) / m2;
            if (gain > bestGain + 1e-9) { bestGain = gain; best = c; }
          });
          comm[i] = best;
          tot[best] += k[i];
          if (best !== ci) moved = true;
        }
        if (!moved) break;
        movedAny = true;
      }
      if (!movedAny) break;

      // Схлопываем группы в узлы следующего уровня.
      const renum = new Map();
      comm.forEach((c) => { if (!renum.has(c)) renum.set(c, renum.size); });
      const next = Array.from({ length: renum.size }, () => new Map());
      adj.forEach((row, i) => {
        const ci = renum.get(comm[i]);
        row.forEach((weight, j) => {
          const cj = renum.get(comm[j]);
          next[ci].set(cj, (next[ci].get(cj) || 0) + weight);
        });
      });
      for (let s = 0; s < membership.length; s++) membership[s] = renum.get(comm[membership[s]]);
      adj = next;
    }

    // Итоговые номера — плотные 0..k−1 в порядке первого появления.
    const dense = new Map();
    const result = new Map();
    slugs.forEach((s, i) => {
      const c = membership[i];
      if (!dense.has(c)) dense.set(c, dense.size);
      result.set(s, dense.get(c));
    });
    return result;
  }

  // Вес ссылки для группировки с учётом названий. Статьи одной темы обычно
  // и называются похоже: "Пространство" и "Пространство (фундаменталь)",
  // "Реальность" и "Красная реальность". Если такие статьи УЖЕ связаны
  // ссылкой, связь весит больше (до 1 + TITLE_WEIGHT при одинаковых словах),
  // и они охотнее попадают в одну группу. Новых связей название не создаёт:
  // тёзки из далёких, не связанных ссылками частей графа не склеиваются.
  // Уточнение в скобках не учитывается, слова короче 3 букв — тоже.
  const TITLE_WEIGHT = 2;
  function titleWords(n) {
    if (n.locked || !n.title) return new Set();
    return new Set(n.title.toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(/ё/g, 'е')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2));
  }
  function linkWeightByTitle(wordsA, wordsB) {
    let common = 0;
    wordsA.forEach((w) => { if (wordsB.has(w)) common += 1; });
    const union = wordsA.size + wordsB.size - common;
    return 1 + (union ? TITLE_WEIGHT * (common / union) : 0);
  }

  // Выпуклая оболочка точек {x, y} (монотонная цепь Эндрю). Для 1–2 точек
  // возвращает их же — подложка тогда рисуется кругом/капсулой за счёт
  // толстой скруглённой обводки.
  function convexHull(points) {
    if (points.length < 3) return points.slice();
    const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
  }

  // Цвета подложек групп — только чтобы соседние "острова" различались на
  // глаз; рисуются почти прозрачными, цвет узлов (по тегу) от них не зависит.
  const CLUSTER_COLORS = ['#5865f2', '#3ba55c', '#faa61a', '#eb459e', '#00b0f4', '#ed4245', '#9b59b6', '#1abc9c', '#e67e22', '#95a5a6'];

  // Счётчик экземпляров графа — для уникальных id градиентов свечения
  // (на странице одновременно может быть несколько графов).
  let graphInstanceCounter = 0;

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
   *   cosmos — true/false включает "космос" (мерцающие звёзды на фоне с
   *   параллаксом + свечение точек, растущее с их размером) и его
   *   переключение через setCosmos; не передан — космоса нет вовсе (локальная
   *   панель редактора). Только для полной карты на дашборде.
   *   clusters — искать группы связанных статей (detectCommunities): статьи
   *   группы собираются "островом" с полупрозрачной подложкой и названием.
   *   collapse — (при clusters) при сильном отдалении большого графа
   *   сворачивать группы в кружки; по умолчанию включено, переключается
   *   через setCollapse.
   *   onNodeFocus — ПКМ по статье: (slug) => void (окрестность статьи).
   * @returns {Promise<{destroy: () => void, setSearchHighlight: (query: string) => void, setUniformSize: (flag: boolean) => void, setCosmos: (flag: boolean) => void, setCollapse: (flag: boolean) => void, firstSearchMatch: () => string|null}>}
   */
  async function renderGraph(container, data, options = {}) {
    const d3 = await loadD3();
    const { onNodeClick, centerSlug, compact, colorByTag, tagColors } = options;
    let uniformSize = !!options.uniformSize;
    const cosmosSupported = typeof options.cosmos === 'boolean';

    container.innerHTML = '';
    const width = container.clientWidth || 400;
    const height = container.clientHeight || 400;

    if (!data.nodes.length) {
      const empty = document.createElement('div');
      empty.className = 'graph-empty';
      empty.textContent = 'Пока нет статей для отображения графа.';
      container.appendChild(empty);
      return { destroy() {}, setSearchHighlight() {}, setUniformSize() {}, setCosmos() {}, setCollapse() {}, firstSearchMatch() { return null; } };
    }

    // Цвет узла — цвет ПЕРВОГО тега статьи (порядок тегов задаёт сервер: сперва
    // поле "Теги", затем #хэштеги из текста). У одного названия тега один цвет
    // во всей системе (см. src/services/tag-colors.js), поэтому статьи с одним
    // тегом окрашены одинаково.
    const colorFor = (n) => tagNodeColor(n, tagColors);

    const nodes = data.nodes.map(n => ({ ...n, degree: 0 }));
    const nodeBySlug = new Map(nodes.map(n => [n.slug, n]));
    // source/target связи — slug (до инициализации forceLink) или узел (после)
    const nodeOfEnd = (e) => (typeof e === 'object' ? e : nodeBySlug.get(e));
    const slugOfEnd = (e) => (typeof e === 'object' ? e.slug : e);

    // Одна линия на пару статей. Раньше взаимные ссылки (A→B и B→A) давали
    // две линии друг поверх друга, а в физике пара тянулась вдвое сильнее
    // остальных; повторная ссылка той же статьи — ещё одну. Взаимность не
    // теряется: такая связь помечена mutual и рисуется чуть заметнее.
    // Ссылка статьи на саму себя линии не даёт.
    const links = [];
    {
      const byPair = new Map();
      data.edges.forEach((e) => {
        if (e.from === e.to || !nodeBySlug.has(e.from) || !nodeBySlug.has(e.to)) return;
        const key = e.from < e.to ? `${e.from}\u0000${e.to}` : `${e.to}\u0000${e.from}`;
        const existing = byPair.get(key);
        if (existing) {
          if (existing.source !== e.from) existing.mutual = true;
          return;
        }
        const l = { source: e.from, target: e.to, mutual: false };
        byPair.set(key, l);
        links.push(l);
      });
    }

    // Соседи каждого узла — для подсветки при наведении/поиске
    const neighbors = new Map(nodes.map(n => [n.slug, new Set([n.slug])]));
    links.forEach(l => {
      neighbors.get(l.source)?.add(l.target);
      neighbors.get(l.target)?.add(l.source);
    });

    // Степень узла — число РАЗНЫХ соседей; влияет на радиус точки. Считается по
    // соседям, а не по рёбрам: статьи часто ссылаются друг на друга взаимно
    // (A→B и B→A), и по рёбрам такой лист получал бы "две связи" и рос, хотя
    // на графе у него одна линия. Ссылка на себя (соседями узел уже включён
    // сам) и связи с отсутствующими узлами не в счёт.
    nodes.forEach(n => { n.degree = neighbors.get(n.slug).size - 1; });

    // Связи как пары узлов — для поиска пересечений ниже (links уже без дублей).
    const pairs = links.map((l) => ({ a: nodeBySlug.get(l.source), b: nodeBySlug.get(l.target) }));

    // Группы (см. detectCommunities). Группой считается сообщество минимум из
    // двух статей; одиночки ни в какую группу не входят. Если группа вышла
    // одна на весь граф — толку от неё нет, группировку не показываем.
    const clusters = [];
    const clusterOf = new Map(); // slug → группа
    if (options.clusters && links.length) {
      const words = new Map(nodes.map((n) => [n.slug, titleWords(n)]));
      const comm = detectCommunities(
        nodes.map((n) => n.slug),
        links.map((l) => [l.source, l.target, linkWeightByTitle(words.get(l.source), words.get(l.target))])
      );
      const bucket = new Map();
      nodes.forEach((n) => {
        const c = comm.get(n.slug);
        if (!bucket.has(c)) bucket.set(c, []);
        bucket.get(c).push(n);
      });
      bucket.forEach((members) => {
        if (members.length < 2) return;
        clusters.push({ members, x: 0, y: 0, r: 0, minY: 0, pad: 0, placed: 0 });
      });
      if (clusters.length < 2) clusters.length = 0;
      // Крупные группы — первыми: им достаются первые цвета палитры.
      clusters.sort((a, b) => b.members.length - a.members.length);
      clusters.forEach((c, i) => {
        c.id = i;
        c.color = CLUSTER_COLORS[i % CLUSTER_COLORS.length];
        c.members.forEach((n) => clusterOf.set(n.slug, c));
      });
      // Название группы — самая связанная ВНУТРИ группы статья (при равенстве —
      // самая связанная вообще). Недоступные (locked) статьи не называют группу.
      const intra = new Map();
      links.forEach((l) => {
        const c = clusterOf.get(l.source);
        if (c && c === clusterOf.get(l.target)) {
          intra.set(l.source, (intra.get(l.source) || 0) + 1);
          intra.set(l.target, (intra.get(l.target) || 0) + 1);
        }
      });
      clusters.forEach((c) => {
        const named = c.members.filter((n) => !n.locked)
          .sort((a, b) => (intra.get(b.slug) || 0) - (intra.get(a.slug) || 0) || b.degree - a.degree)[0];
        c.name = named ? nodeDisplayTitle(named) : '???';
      });
    }
    // Связь между разными группами (или группой и одиночкой).
    const isInterLink = (l) => clusters.length > 0
      && clusterOf.get(slugOfEnd(l.source)) !== clusterOf.get(slugOfEnd(l.target));

    // Размеры точек и подписей. Рост логарифмический: каждая следующая связь
    // прибавляет всё меньше (вторая связь — заметный шаг, сотая — почти
    // незаметный), плюс жёсткий потолок max. Так хаб с десятками связей
    // остаётся "солнцем" среди "звёзд" (~4× крупнее листа), а не раздувается
    // до гигантского пятна при сотнях связей. Точка без связей и крайняя
    // точка (одна связь) одного размера — base; рост идёт от него и начинается
    // со второй связи. Ориентиры для полной карты:
    //   связей 0–1 → 5px, 2 → 8px, 5 → 12px, 10 → 15px, 30 → 20px, 100 → 26px, потолок 30px.
    const SIZE = compact
      ? { base: 4, k: 1.8, max: 12, uniform: 5, center: 3, labelBase: 8, labelK: 1, labelMax: 11, labelHover: 15 }
      : { base: 5, k: 4.5, max: 30, uniform: 7, center: 5, labelBase: 9, labelK: 2.2, labelMax: 17, labelHover: 17 };

    // Рост размера по числу связей: 0 при 0 и 1 связи, дальше логарифмически.
    const growthOf = (n) => Math.log(Math.max(1, n.degree));

    const radiusFor = (n) => {
      const grown = uniformSize
        ? SIZE.uniform
        : Math.min(SIZE.base + SIZE.k * growthOf(n), SIZE.max);
      return grown + (n.slug === centerSlug ? SIZE.center : 0);
    };

    // Размер подписи растёт со степенью узла так же плавно, как и точка.
    const labelSizeFor = (n) => (uniformSize
      ? SIZE.labelBase
      : Math.min(SIZE.labelBase + SIZE.labelK * growthOf(n), SIZE.labelMax));

    // При наведении/поиске подпись увеличивается "лупой" примерно до одного
    // и того же размера (labelHover), а не в фиксированное число раз — иначе
    // уже крупная подпись хаба раздувалась бы до гигантской.
    const labelHoverScaleFor = (n) => Math.max(1.2, SIZE.labelHover / labelSizeFor(n));

    // Звёздный canvas создаётся ДО svg — чтобы лежать под графом.
    const starfield = cosmosSupported ? createStarfield(container) : null;
    let cosmosOn = cosmosSupported && options.cosmos;

    const svg = d3.select(container)
      .append('svg')
      .attr('class', 'graph-svg')
      .attr('viewBox', [0, 0, width, height]);

    const root = svg.append('g');

    // Масштаб. Нижний предел маленький: при сотнях статей весь граф должен
    // помещаться на экран (тогда группы сворачиваются — см. syncCollapsed).
    // userZoomed — пользователь сам крутил/двигал граф: после этого
    // автоподгонка вида (fitToContent) его вид не перебивает.
    const MIN_ZOOM = 0.05;
    const MAX_ZOOM = 4;
    let zoomK = 1;
    let userZoomed = false;
    const zoomBehavior = d3.zoom()
      .scaleExtent([MIN_ZOOM, MAX_ZOOM])
      .on('zoom', (event) => {
        if (event.sourceEvent) { userZoomed = true; stopZoomAnimation(); }
        root.attr('transform', event.transform);
        starfield?.setTransform(event.transform);
        zoomK = event.transform.k;
        applyZoomStyles();
        syncCollapsed();
      });
    svg.call(zoomBehavior);

    // Плавный переход к виду {x, y, k} (без d3-transition — он не подключён).
    let zoomAnimId = 0;
    function stopZoomAnimation() {
      if (zoomAnimId) cancelAnimationFrame(zoomAnimId);
      zoomAnimId = 0;
    }
    function animateZoomTo(target, duration = 500) {
      stopZoomAnimation();
      const from = d3.zoomTransform(svg.node());
      const start = performance.now();
      const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
      const step = (now) => {
        const t = Math.min(1, (now - start) / duration);
        const e = ease(t);
        // масштаб — геометрически, иначе переход между 0.1 и 1 "проскакивает"
        const k = from.k * Math.pow(target.k / from.k, e);
        const x = from.x + (target.x - from.x) * e;
        const y = from.y + (target.y - from.y) * e;
        svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(x, y).scale(k));
        zoomAnimId = t < 1 ? requestAnimationFrame(step) : 0;
      };
      zoomAnimId = requestAnimationFrame(step);
    }
    // Вид, в который помещается прямоугольник графа (в координатах графа).
    function transformForBounds(x0, y0, x1, y1, minK, maxK) {
      const margin = 30;
      const w = Math.max(x1 - x0, 1);
      const h = Math.max(y1 - y0, 1);
      const fit = Math.min((width - margin * 2) / w, (height - margin * 2) / h);
      const k = Math.max(MIN_ZOOM, Math.min(maxK, Math.max(minK, fit)));
      return { k, x: width / 2 - k * (x0 + x1) / 2, y: height / 2 - k * (y0 + y1) / 2 };
    }

    // Подложки групп — самый нижний слой, под свечением и связями.
    const hull = root.append('g')
      .attr('class', 'graph-hulls')
      .style('pointer-events', 'none')
      .selectAll('g')
      .data(clusters)
      .join('g')
      .attr('class', 'graph-hull');
    const hullPath = hull.append('path')
      .attr('fill', (c) => c.color)
      .attr('stroke', (c) => c.color)
      .attr('stroke-linejoin', 'round')
      .attr('stroke-linecap', 'round');

    // Текущий поисковый запрос (в нижнем регистре) и цвет заливки точки нужны
    // уже при первой отрисовке (кружки и свечение), поэтому объявлены здесь.
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

    // Свечение точек ("космос"): мягкий радиальный градиент цвета точки под
    // связями и узлами. Сила плавно растёт с размером точки (а не для
    // "избранных" узлов): лист светится едва заметно, чем больше связей — тем
    // шире и ярче гало, у самых крупных — заметное "солнце". Градиентом, а не
    // SVG-фильтром blur — фильтр на сотнях узлов заметно просаживает FPS.
    // Один градиент на цвет (а не на узел), т.к. цветов = числу тегов.
    const glowUid = `graph-glow-${++graphInstanceCounter}`;
    const defs = svg.append('defs');
    const glowGradients = new Map();
    const glowFillFor = (n) => {
      const color = fillFor(n) || NO_TAG_COLOR;
      let id = glowGradients.get(color);
      if (!id) {
        id = `${glowUid}-${color.replace(/[^0-9a-z]/gi, '')}`;
        glowGradients.set(color, id);
        const grad = defs.append('radialGradient').attr('id', id);
        grad.append('stop').attr('offset', '0%').attr('stop-color', color).attr('stop-opacity', 0.85);
        grad.append('stop').attr('offset', '30%').attr('stop-color', color).attr('stop-opacity', 0.45);
        grad.append('stop').attr('offset', '65%').attr('stop-color', color).attr('stop-opacity', 0.14);
        grad.append('stop').attr('offset', '100%').attr('stop-color', color).attr('stop-opacity', 0);
      }
      return `url(#${id})`;
    };
    // 0 (самая мелкая точка) … 1 (потолок размера)
    const glowStrength = (n) => Math.min(1, Math.max(0, (radiusFor(n) - SIZE.base) / (SIZE.max - SIZE.base)));
    const glowRadiusFor = (n) => radiusFor(n) * (1.7 + 1.5 * glowStrength(n));
    const glowOpacityFor = (n) => 0.3 + 0.7 * glowStrength(n);

    const glow = cosmosSupported
      ? root.append('g')
        .attr('class', 'graph-glows')
        .style('pointer-events', 'none')
        .selectAll('circle')
        .data(nodes)
        .join('circle')
        .attr('class', (n) => 'graph-node-glow' + (clusterOf.has(n.slug) ? ' graph-in-cluster' : ''))
        .attr('r', glowRadiusFor)
        .attr('fill', glowFillFor)
        .attr('fill-opacity', glowOpacityFor)
      : d3.selectAll([]);

    container.classList.toggle('graph-cosmos', cosmosOn);
    starfield?.setEnabled(cosmosOn);

    const link = root.append('g')
      .attr('class', 'graph-links')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('class', (l) => 'graph-link' + (l.mutual ? ' graph-link-mutual' : '') + (isInterLink(l) ? ' graph-link-inter' : ''));

    const node = root.append('g')
      .attr('class', 'graph-nodes')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .attr('class', (n) => 'graph-node' + (n.slug === centerSlug ? ' graph-node-center' : '') + (n.locked ? ' graph-node-locked' : '') + (clusterOf.has(n.slug) ? ' graph-in-cluster' : ''))
      .call(d3.drag()
        .on('start', (event, n) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          n.fx = n.x; n.fy = n.y;
          untangleBudget = UNTANGLE_BUDGET; // после ручного движения снова можно распутывать
          pendantLayout.reset();
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

    const circle = node.append('circle')
      .attr('r', radiusFor)
      .attr('class', 'graph-node-circle')
      .style('fill', fillFor);

    node.append('title').text(nodeDisplayTitle);

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
      .attr('class', (n) => 'graph-label' + (n.slug === centerSlug ? ' graph-node-center' : '') + (n.locked ? ' graph-node-locked' : '') + (clusterOf.has(n.slug) ? ' graph-in-cluster' : ''));

    const labelText = label.append('text')
      .attr('class', 'graph-node-label')
      .attr('text-anchor', 'middle')
      .attr('dy', (n) => -(radiusFor(n) + 4))
      .style('font-size', (n) => `${labelSizeFor(n)}px`)
      .style('--label-hover-scale', labelHoverScaleFor)
      .text(nodeDisplayTitle);

    // Названия групп — над подложкой. Размер шрифта компенсирует масштаб
    // (на обзоре название читается), при приближении название бледнеет,
    // чтобы не мешать подписям статей — см. applyZoomStyles.
    const clusterLabel = root.append('g')
      .attr('class', 'graph-cluster-labels')
      .style('pointer-events', 'none')
      .selectAll('text')
      .data(clusters)
      .join('text')
      .attr('class', 'graph-cluster-label')
      .attr('text-anchor', 'middle')
      .style('fill', (c) => c.color)
      .text((c) => c.name);

    // Свёрнутые группы (обзор при сильном отдалении): каждая группа — один
    // кружок "Название · N" в центре группы, связи между группами — линии,
    // толщина которых растёт с числом ссылок между ними. Статьи вне групп
    // (одиночки) остаются видны как есть. Слой построен всегда, а показывается
    // классом .graph-collapsed на контейнере (syncCollapsed).
    const COLLAPSE_MIN_NODES = 60; // меньше — граф и так читается, не прячем
    const COLLAPSE_ZOOM = 0.5;     // масштаб, ниже которого группы сворачиваются
    const collapseAvailable = clusters.length >= 2 && nodes.length >= COLLAPSE_MIN_NODES;
    let collapseEnabled = options.collapse !== false;
    let isCollapsed = false;

    // Узел мета-графа для статьи: её группа или (для одиночки) она сама.
    // У группы и у статьи одинаковые поля x/y — линия мета-графа рисуется
    // между ними без различия.
    const metaOf = (slug) => clusterOf.get(slug) || nodeBySlug.get(slug);
    const metaKey = (g) => (g.members ? `c:${g.id}` : `s:${g.slug}`);
    const metaLinks = [];
    if (collapseAvailable) {
      const byPair = new Map();
      links.forEach((l) => {
        const a = metaOf(l.source);
        const b = metaOf(l.target);
        if (a === b) return;
        const ka = metaKey(a);
        const kb = metaKey(b);
        const key = ka < kb ? `${ka}\u0000${kb}` : `${kb}\u0000${ka}`;
        const existing = byPair.get(key);
        if (existing) existing.count += 1;
        else {
          const ml = { a, b, count: 1 };
          byPair.set(key, ml);
          metaLinks.push(ml);
        }
      });
    }
    const metaLayer = root.append('g').attr('class', 'graph-meta');
    const metaLink = metaLayer.append('g')
      .selectAll('line')
      .data(metaLinks)
      .join('line')
      .attr('class', 'graph-meta-link')
      // толщина — в пикселях экрана (vector-effect в CSS), от масштаба не зависит
      .style('stroke-width', (ml) => `${1 + 1.6 * Math.log2(ml.count)}px`);
    const superNode = metaLayer.append('g')
      .selectAll('g')
      .data(collapseAvailable ? clusters : [])
      .join('g')
      .attr('class', 'graph-supernode')
      .on('click', (event, c) => expandCluster(c));
    // Непрозрачная подкладка цвета фона: линии между группами не
    // просвечивают сквозь полупрозрачный кружок.
    const superBacking = superNode.append('circle')
      .attr('class', 'graph-supernode-backing');
    const superCircle = superNode.append('circle')
      .attr('class', 'graph-supernode-circle')
      .style('fill', (c) => c.color)
      .style('stroke', (c) => c.color);
    const superText = superNode.append('text')
      .attr('class', 'graph-supernode-label')
      .attr('text-anchor', 'middle')
      .text((c) => `${c.name} · ${c.members.length}`);
    superNode.append('title').text((c) => {
      const names = c.members.slice(0, 12).map(nodeDisplayTitle).join('\n');
      const more = c.members.length > 12 ? `\n… ещё ${c.members.length - 12}` : '';
      return `${c.name}: ${c.members.length} статей (клик — раскрыть)\n\n${names}${more}`;
    });

    // Центр, радиус и верх каждой группы по текущим координатам её статей.
    // Статьи без координат (хвосты до их расстановки) не учитываются.
    function updateClusterGeometry() {
      clusters.forEach((c) => {
        let sx = 0;
        let sy = 0;
        let placed = 0;
        let pad = 0;
        c.members.forEach((m) => {
          if (m.x == null) return;
          sx += m.x; sy += m.y; placed += 1;
          pad = Math.max(pad, radiusFor(m));
        });
        c.placed = placed;
        if (!placed) return;
        c.x = sx / placed;
        c.y = sy / placed;
        let r = 0;
        let minY = Infinity;
        c.members.forEach((m) => {
          if (m.x == null) return;
          r = Math.max(r, Math.hypot(m.x - c.x, m.y - c.y));
          minY = Math.min(minY, m.y);
        });
        c.pad = pad + 16;
        c.r = r + c.pad;
        c.minY = minY;
      });
    }

    function renderClusters() {
      if (!clusters.length) return;
      updateClusterGeometry();
      hullPath
        .attr('stroke-width', (c) => c.pad * 2)
        .attr('d', (c) => {
          const pts = convexHull(c.members.filter((m) => m.x != null));
          if (!pts.length) return null;
          return `M${pts.map((p) => `${p.x},${p.y}`).join('L')}Z`;
        });
      clusterLabel
        .attr('x', (c) => c.x)
        .attr('y', (c) => c.minY - c.pad - 6);
      if (collapseAvailable) {
        metaLink
          .attr('x1', (ml) => ml.a.x).attr('y1', (ml) => ml.a.y)
          .attr('x2', (ml) => ml.b.x).attr('y2', (ml) => ml.b.y);
        superNode.attr('transform', (c) => `translate(${c.x},${c.y})`);
      }
    }

    // Всё, что должно выглядеть одинаково на экране при любом масштабе:
    // названия групп и кружки свёрнутых групп (размер делится на масштаб).
    function applyZoomStyles() {
      const k = zoomK;
      if (clusters.length) {
        clusterLabel
          .style('font-size', `${Math.min(15 / k, 120)}px`)
          .style('stroke-width', `${Math.min(4 / k, 32)}px`)
          .style('opacity', k <= 0.7 ? 1 : Math.max(0.2, 1 - (k - 0.7) / 0.8));
      }
      if (collapseAvailable) {
        const superR = (c) => (14 + 5 * Math.sqrt(c.members.length)) / k;
        superBacking.attr('r', superR);
        superCircle.attr('r', superR);
        superText
          .style('font-size', `${12 / k}px`)
          .style('stroke-width', `${3 / k}px`)
          .attr('dy', (c) => -((14 + 5 * Math.sqrt(c.members.length)) / k + 6 / k));
      }
    }

    // Свёрнуто: включено, граф достаточно большой, масштаб мелкий и не идёт
    // поиск (найденная статья должна быть видна, а не спрятана в группе).
    function syncCollapsed() {
      const on = collapseAvailable && collapseEnabled && zoomK < COLLAPSE_ZOOM && !activeSearchQuery;
      if (on === isCollapsed) return;
      isCollapsed = on;
      container.classList.toggle('graph-collapsed', on);
    }

    // Клик по свёрнутой группе — приблизиться к ней настолько, чтобы она
    // раскрылась (и поместилась в экран, если это возможно).
    function expandCluster(c) {
      const placed = c.members.filter((m) => m.x != null);
      if (!placed.length) return;
      const xs = placed.map((m) => m.x);
      const ys = placed.map((m) => m.y);
      userZoomed = true;
      animateZoomTo(transformForBounds(
        Math.min(...xs) - c.pad, Math.min(...ys) - c.pad,
        Math.max(...xs) + c.pad, Math.max(...ys) + c.pad,
        COLLAPSE_ZOOM * 1.2, 1
      ));
    }

    // Первичная подгонка вида: когда раскладка почти улеглась, а граф не
    // помещается в карточку, — плавно отдаляемся, чтобы был виден целиком
    // (большой граф при этом сразу открывается обзором групп). Маленький
    // граф, уже помещающийся на экран, не трогаем; если пользователь успел
    // сам покрутить масштаб — тоже.
    let didFit = false;
    function fitToContent() {
      didFit = true;
      if (userZoomed) return;
      const placed = nodes.filter((n) => n.x != null);
      if (!placed.length) return;
      let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
      placed.forEach((n) => {
        const r = radiusFor(n) + 20;
        x0 = Math.min(x0, n.x - r); y0 = Math.min(y0, n.y - r);
        x1 = Math.max(x1, n.x + r); y1 = Math.max(y1, n.y + r);
      });
      // Подложки групп и названия над ними тоже должны попасть в кадр.
      updateClusterGeometry();
      clusters.forEach((c) => {
        if (!c.placed) return;
        x0 = Math.min(x0, c.x - c.r); x1 = Math.max(x1, c.x + c.r);
        y0 = Math.min(y0, c.minY - c.pad - 30); y1 = Math.max(y1, c.y + c.r);
      });
      if (x0 >= 0 && y0 >= 0 && x1 <= width && y1 <= height) return;
      animateZoomTo(transformForBounds(x0, y0, x1, y1, MIN_ZOOM, 1), 700);
    }

    // Состояние подсветки живёт и на точке, и на её подписи.
    const setNodeClass = (name, predicate) => {
      node.classed(name, predicate);
      label.classed(name, predicate);
      glow.classed(name, predicate);
    };

    node.style('cursor', (n) => n.locked ? 'not-allowed' : (onNodeClick ? 'pointer' : 'default'));
    if (onNodeClick) {
      // Узел-заглушка (locked) — недоступная статья; клик по нему ничего не
      // открывает (сервер бы всё равно ответил 403), только тултип "???".
      node.on('click', (event, n) => { if (!n.locked) onNodeClick(n.slug); });
    }
    // ПКМ (на телефоне — долгое нажатие) — показать окрестность статьи.
    if (options.onNodeFocus) {
      node.on('contextmenu', (event, n) => {
        event.preventDefault();
        options.onNodeFocus(n.slug);
      });
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
      // Узел-заглушка (locked) без названия — по тексту не ищем, нечего искать.
      return !n.locked && !activeSearchQuery.startsWith('#') && n.title.toLowerCase().includes(term);
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
    //
    // Хабы (статьи, на которые ссылаются почти все, — обзорные) иначе стягивают
    // весь граф в "звезду" вокруг себя: у каждой их связи та же сила, что у
    // обычной, а связей десятки. Поэтому связи хаба длиннее и слабее — он
    // оказывается между своими группами, а не в центре общего кома. Порог —
    // HUB_DEGREE соседей; у обычных статей ничего не меняется.
    //
    // Связи между разными группами (isInterLink) длиннее и заметно слабее
    // внутренних: группы расходятся "островами", а не слипаются.
    const HUB_DEGREE = 6;
    const INTER_LINK_DISTANCE = 1.8;
    const INTER_LINK_STRENGTH = 0.25;
    const hubnessOf = (l) => Math.max(1, Math.max(nodeOfEnd(l.source).degree, nodeOfEnd(l.target).degree) / HUB_DEGREE);
    const linkDistanceFor = (l) => {
      const d = (compact ? 40 : 60)
        + Math.max(0, radiusFor(nodeOfEnd(l.source)) - SIZE.uniform)
        + Math.max(0, radiusFor(nodeOfEnd(l.target)) - SIZE.uniform)
        + (compact ? 10 : 22) * Math.log(hubnessOf(l));
      return isInterLink(l) ? d * INTER_LINK_DISTANCE : d;
    };
    const linkStrengthFor = (l) => (0.7 / Math.sqrt(hubnessOf(l))) * (isInterLink(l) ? INTER_LINK_STRENGTH : 1);
    const chargeFor = (n) => -((compact ? 60 : 110) + Math.max(0, radiusFor(n) - SIZE.uniform) * (compact ? 3 : 8));
    // Статьи в группах тянутся к центру графа слабее: их держит вместе
    // своя группа, а общая гравитация сминала бы острова в один диск.
    const CLUSTERED_GRAVITY = 0.3;
    const gravityFor = (n) => (uniformSize ? 0.03 : 0.025 + 0.012 * Math.log(1 + n.degree))
      * (clusterOf.has(n.slug) ? CLUSTERED_GRAVITY : 1);
    const collideFor = (n) => radiusFor(n) + 12;

    // Висячие хвосты (см. createPendantLayout) расставляются отдельно, ПОСЛЕ
    // ядра графа. Силовая раскладка из случайного начального положения даёт
    // локальные минимумы: точка на конце хвоста запирается внутри чужого
    // цикла (типично — внутри треугольника), и чем больше таких циклов, тем
    // хуже. Поэтому сначала симуляция идёт только по ядру, хвосты пока скрыты;
    // когда ядро в основном улеглось (alpha упала до TAILS_ATTACH_ALPHA),
    // каждый хвост ставится на свободное место снаружи, а физика доводит всё
    // вместе. Так хвосты в ловушки не попадают вовсе, а не выпутываются потом.
    const pendantLayout = createPendantLayout({
      nodeBySlug,
      neighbors,
      pairs,
      linkLength: (a, b) => linkDistanceFor({ source: a, target: b }),
      radiusFor,
      pinnedSlug: centerSlug && nodeBySlug.has(centerSlug) ? centerSlug : null
    });
    const TAILS_ATTACH_ALPHA = 0.35;
    const TAILS_ATTACH_KICK = 0.3;
    let tailsPending = pendantLayout.pendants.length > 0;
    const linkHasTail = (l) => pendantLayout.isTail(nodeOfEnd(l.source)) || pendantLayout.isTail(nodeOfEnd(l.target));

    const coreNodes = tailsPending ? nodes.filter((n) => !pendantLayout.isTail(n)) : nodes;
    const coreLinks = tailsPending ? links.filter((l) => !linkHasTail(l)) : links;

    // Сила групп: (1) каждая статья тянется к центру своей группы — группа
    // собирается в компактный "остров"; (2) группы, чьи круги перекрываются,
    // расталкиваются целиком (сдвигаются все статьи обеих групп, крупная
    // группа — меньше мелкой) — острова не наползают друг на друга.
    const CLUSTER_PULL = 0.08;
    const CLUSTER_SEPARATION = 0.8;
    const CLUSTER_GAP = 30;
    const clusterForce = (alpha) => {
      if (!clusters.length) return;
      updateClusterGeometry();
      clusters.forEach((c) => {
        if (!c.placed) return;
        c.members.forEach((m) => {
          if (m.x == null || m.fx != null) return;
          m.vx += (c.x - m.x) * CLUSTER_PULL * alpha;
          m.vy += (c.y - m.y) * CLUSTER_PULL * alpha;
        });
      });
      for (let i = 0; i < clusters.length; i++) {
        const a = clusters[i];
        if (!a.placed) continue;
        for (let j = i + 1; j < clusters.length; j++) {
          const b = clusters[j];
          if (!b.placed) continue;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist = Math.hypot(dx, dy);
          const min = a.r + b.r + CLUSTER_GAP;
          if (dist >= min) continue;
          if (dist < 1e-6) { dx = 1; dy = 0; dist = 1; }
          const push = ((min - dist) / dist) * CLUSTER_SEPARATION * alpha;
          const total = a.members.length + b.members.length;
          const pa = push * (b.members.length / total);
          const pb = push * (a.members.length / total);
          a.members.forEach((m) => { if (m.x != null && m.fx == null) { m.vx -= dx * pa; m.vy -= dy * pa; } });
          b.members.forEach((m) => { if (m.x != null && m.fx == null) { m.vx += dx * pb; m.vy += dy * pb; } });
        }
      }
    };

    const linkForce = d3.forceLink(coreLinks).id((n) => n.slug).distance(linkDistanceFor).strength(linkStrengthFor);
    const chargeForce = d3.forceManyBody().strength(chargeFor).distanceMax(compact ? 220 : 380);
    const xForce = d3.forceX(width / 2).strength(gravityFor);
    const yForce = d3.forceY(height / 2).strength(gravityFor);
    const collideForce = d3.forceCollide(collideFor);

    const simulation = d3.forceSimulation(coreNodes)
      .force('link', linkForce)
      .force('charge', chargeForce)
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('x', xForce)
      .force('y', yForce)
      .force('collide', collideForce)
      .force('tailEdges', pendantLayout.edgeForce)
      .force('clusters', clusterForce);

    if (centerSlug && nodeBySlug.has(centerSlug)) {
      const c = nodeBySlug.get(centerSlug);
      c.fx = width / 2;
      c.fy = height / 2;
    }

    // Что рисовать на тике: пока хвосты не расставлены — только ядро (у хвостов
    // ещё нет координат), потом всё.
    const allView = { link, node, label, glow };
    const coreView = tailsPending
      ? {
        link: link.filter((l) => !linkHasTail(l)),
        node: node.filter((n) => !pendantLayout.isTail(n)),
        label: label.filter((n) => !pendantLayout.isTail(n)),
        glow: glow.filter((n) => !pendantLayout.isTail(n))
      }
      : allView;
    let view = coreView;
    if (tailsPending) {
      const hide = (sel, pred) => sel.filter(pred).style('display', 'none');
      hide(link, linkHasTail);
      hide(node, pendantLayout.isTail);
      hide(label, pendantLayout.isTail);
      hide(glow, pendantLayout.isTail);
    }

    function attachTails() {
      tailsPending = false;
      pendantLayout.attach();
      simulation.nodes(nodes);
      linkForce.links(links);
      view = allView;
      // появляются плавно, а не "выскакивают"
      const reveal = (sel, pred) => sel.filter(pred).style('display', null).classed('graph-tail-in', true);
      reveal(link, linkHasTail);
      reveal(node, pendantLayout.isTail);
      reveal(label, pendantLayout.isTail);
      reveal(glow, pendantLayout.isTail);
      simulation.alpha(Math.max(simulation.alpha(), TAILS_ATTACH_KICK)).restart();
    }

    // Распутывание запертых хвостов — страховка на случай, когда хвост всё же
    // оказался по ту сторону чужого ребра (ядро под ним сдвинулось). Проверка
    // идёт периодически, пока раскладка остывает, и в конце. Все запертые
    // хвосты переносятся за один проход и сразу на свободные места, поэтому
    // проходов нужно немного; лимит — защита от бесконечных перезапусков
    // (обновляется, когда пользователь двигает узлы).
    const UNTANGLE_BUDGET = 30;
    const UNTANGLE_KICK = 0.1;
    let untangleBudget = UNTANGLE_BUDGET;
    let untangleTicks = 0;

    function runUntangle() {
      if (untangleBudget <= 0 || tailsPending) return;
      if (pendantLayout.untangle()) {
        untangleBudget -= 1;
        // слегка подбодрить симуляцию, чтобы перенесённые узлы осели; сильный
        // нагрев перетряхивал бы весь граф ради нескольких точек
        simulation.alpha(Math.max(simulation.alpha(), UNTANGLE_KICK)).restart();
      }
    }

    simulation.on('tick', () => {
      if (tailsPending && simulation.alpha() < TAILS_ATTACH_ALPHA) attachTails();
      view.link
        .attr('x1', (l) => l.source.x)
        .attr('y1', (l) => l.source.y)
        .attr('x2', (l) => l.target.x)
        .attr('y2', (l) => l.target.y);
      view.node.attr('transform', (n) => `translate(${n.x},${n.y})`);
      view.label.attr('transform', (n) => `translate(${n.x},${n.y})`);
      view.glow.attr('cx', (n) => n.x).attr('cy', (n) => n.y);
      renderClusters();
      if (!didFit && !tailsPending && simulation.alpha() < 0.12) fitToContent();
      // раз в ~0.5 с, пока раскладка уже подостыла (в начале узлы ещё летят)
      if (pendantLayout.pendants.length && ++untangleTicks % 30 === 0 && simulation.alpha() < 0.35) runUntangle();
    });
    simulation.on('end', () => {
      runUntangle();
      if (!didFit) fitToContent();
    });
    applyZoomStyles();

    return {
      destroy() {
        simulation.stop();
        stopZoomAnimation();
        starfield?.destroy();
        container.classList.remove('graph-cosmos', 'graph-collapsed');
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
        glow.attr('fill', glowFillFor);
        applyHighlight(searchMatches());
        syncCollapsed();
      },
      // Лучшая найденная статья — для перехода к её окрестности по Enter в
      // поиске: точное совпадение названия, затем название, начинающееся с
      // запроса, затем содержащее его, затем совпадение по тегу.
      firstSearchMatch() {
        const term = searchTerm();
        if (!term) return null;
        const candidates = nodes.filter((n) => !n.locked && nodeMatchesQuery(n));
        const rank = (n) => {
          const t = n.title.toLowerCase();
          if (t === term) return 0;
          if (t.startsWith(term)) return 1;
          return t.includes(term) ? 2 : 3;
        };
        candidates.sort((a, b) => rank(a) - rank(b) || b.degree - a.degree);
        return candidates[0]?.slug ?? null;
      },
      // Сворачивание групп при отдалении вкл/выкл на лету.
      setCollapse(flag) {
        collapseEnabled = !!flag;
        syncCollapsed();
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
        glow.attr('r', glowRadiusFor).attr('fill-opacity', glowOpacityFor);
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
      },
      // Космос (звёзды + свечение) вкл/выкл на лету; физика графа не трогается.
      setCosmos(flag) {
        if (!cosmosSupported) return;
        cosmosOn = !!flag;
        container.classList.toggle('graph-cosmos', cosmosOn);
        starfield.setEnabled(cosmosOn);
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
    const STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linejoin', 'stroke-linecap', 'paint-order', 'opacity', 'font-size', 'font-weight', 'font-family', 'text-anchor'];
    // Скрытое в живом графе (свечение без "космоса", свёрнутые/развёрнутые
    // слои групп) в картинку не берём: display в клон не переносится, а
    // нулевая прозрачность лишь раздувала бы файл.
    const hiddenClones = [];
    originals.forEach((origEl, i) => {
      const cs = getComputedStyle(origEl);
      if (cs.display === 'none' || cs.opacity === '0') hiddenClones.push(clones[i]);
      let styleStr = '';
      STYLE_PROPS.forEach((p) => {
        let v = cs.getPropertyValue(p);
        // fill:url(#градиент-свечения) браузер отдаёт абсолютным адресом страницы —
        // внутри отдельного SVG-файла такая ссылка не сработает, возвращаем локальную.
        if (v.startsWith('url(')) v = v.replace(/url\(["']?[^"')#]*#([^"')]+)["']?\)/, 'url(#$1)');
        styleStr += `${p}:${v};`;
      });
      clones[i].setAttribute('style', styleStr);
    });
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));

    hiddenClones.forEach((el) => el.remove());
    const cosmosOn = container.classList.contains('graph-cosmos');

    // Фон (и звёзды под графом) рисуются на самом canvas, а не rect-ом внутри SVG.
    const bg = getComputedStyle(container).backgroundColor || '#202225';

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
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
      const starsCanvas = container.querySelector('canvas.graph-starfield');
      if (cosmosOn && starsCanvas && starsCanvas.width) ctx.drawImage(starsCanvas, 0, 0, width, height);
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
      <span>Цвет узла — цвет его первого тега (меняется во вкладке «Теги»), при поиске — цвет найденного тега · Размер — число связей · Подложки — группы статей, связанных ссылками · Наведите/ищите (# — только по тегам) — подсветка связей · Клик — открыть · ПКМ или Enter в поиске — окрестность статьи · Колесо — масштаб (при сильном отдалении группы сворачиваются) · Перетаскивание — сдвинуть</span>
    `;
    container.appendChild(legend);
  }

  // Инициализация графовой карточки на дашборде (public/views/dashboard.html):
  // ищет #graphContainer/#graphNodeCount и панель фильтров (#graphServerFilter,
  // #graphSearchInput/#graphSearchClear, #graphHideIsolated,
  // #graphHideLabels, #graphUniformSize, #graphCosmos, #graphExportPng) в уже вставленной разметке страницы.
  // Вызывается из spa-router.js (loadDashboard).
  async function initGraphPage() {
    const container = document.getElementById('graphContainer');
    if (!container) return;

    // Свежий заход на дашборд (в т.ч. повторный через SPA-роутер) — сбрасываем
    // ссылку на fullscreen-выход от предыдущего визита: разметка dashboard.html
    // перезагружена целиком, старая карточка отсоединена от DOM.
    exitActiveGraphFullscreen = null;

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
    const cosmosEl = document.getElementById('graphCosmos');
    const countEl = document.getElementById('graphNodeCount');
    const searchInput = document.getElementById('graphSearchInput');
    const searchClearBtn = document.getElementById('graphSearchClear');
    const clustersEl = document.getElementById('graphClusters');
    const collapseEl = document.getElementById('graphCollapse');
    const focusBar = document.getElementById('graphFocusBar');

    // Окрестность статьи ("локальный граф"): только выбранная статья и её
    // соседи на focusDepth шагов по ссылкам. Включается ПКМ по статье или
    // Enter в поиске, выключается кнопкой "Весь граф" в полосе над графом.
    let focusSlug = null;
    let focusDepth = 1;

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

    // Космос по умолчанию включён; выбор пользователя помним между визитами.
    const COSMOS_STORAGE_KEY = 'beginfind.graphCosmos';
    if (cosmosEl) {
      try { cosmosEl.checked = localStorage.getItem(COSMOS_STORAGE_KEY) !== '0'; } catch (_) { /* storage недоступен — остаётся значение из разметки */ }
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

      // Статья фокуса пропала из показанных (сменили сервер) — фокус снимаем.
      if (focusSlug && !slugSet.has(focusSlug)) focusSlug = null;
      if (focusSlug) {
        const adjacency = new Map();
        edges.forEach((e) => {
          if (!adjacency.has(e.from)) adjacency.set(e.from, new Set());
          if (!adjacency.has(e.to)) adjacency.set(e.to, new Set());
          adjacency.get(e.from).add(e.to);
          adjacency.get(e.to).add(e.from);
        });
        const near = new Set([focusSlug]);
        let frontier = [focusSlug];
        for (let step = 0; step < focusDepth; step++) {
          const next = [];
          frontier.forEach((s) => adjacency.get(s)?.forEach((t) => {
            if (!near.has(t)) { near.add(t); next.push(t); }
          }));
          frontier = next;
        }
        nodes = nodes.filter((n) => near.has(n.slug));
        slugSet = near;
        edges = edges.filter((e) => slugSet.has(e.from) && slugSet.has(e.to));
      }

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
      // Связи считаются так же, как рисуются: одна на пару статей, взаимные
      // ссылки (A→B и B→A) — одна связь.
      const pairKeys = new Set();
      data.edges.forEach((e) => {
        if (e.from !== e.to) pairKeys.add(e.from < e.to ? `${e.from}\u0000${e.to}` : `${e.to}\u0000${e.from}`);
      });
      if (countEl) countEl.textContent = `Статей: ${data.nodes.length} · Связей: ${pairKeys.size}`;
      renderFocusBar();
      instance = await renderGraph(container, data, {
        onNodeClick: navigateToArticle,
        onNodeFocus: setFocus,
        centerSlug: focusSlug || undefined,
        colorByTag: true,
        tagColors: fullData.tagColors,
        uniformSize: !!uniformSizeEl?.checked,
        cosmos: !!cosmosEl?.checked,
        clusters: clustersEl ? clustersEl.checked : true,
        collapse: collapseEl ? collapseEl.checked : true
      });
      if (searchInput?.value.trim()) instance.setSearchHighlight(searchInput.value);
      if (data.nodes.length) renderGraphLegend(container, data.nodes, fullData.tagColors);
    }

    function setFocus(slug, depth) {
      focusSlug = slug || null;
      if (depth) focusDepth = depth;
      rerender();
    }

    // Полоса над графом, пока показана окрестность статьи.
    function renderFocusBar() {
      if (!focusBar) return;
      focusBar.hidden = !focusSlug;
      if (!focusSlug) { focusBar.innerHTML = ''; return; }
      const n = fullData.nodes.find((x) => x.slug === focusSlug);
      const title = n ? nodeDisplayTitle(n) : focusSlug;
      const depthBtn = (d, text) => `<button type="button" class="btn btn-sm ${focusDepth === d ? 'btn-primary' : 'btn-secondary'}" data-depth="${d}">${text}</button>`;
      focusBar.innerHTML = `
        <span class="graph-focus-title"><i class="fas fa-crosshairs"></i> Окрестность статьи «${escapeHtml(title)}»</span>
        ${depthBtn(1, '1 шаг')}${depthBtn(2, '2 шага')}
        <button type="button" class="btn btn-sm btn-secondary" data-focus-reset><i class="fas fa-times"></i> Весь граф</button>
      `;
      focusBar.querySelectorAll('[data-depth]').forEach((b) => {
        b.addEventListener('click', () => setFocus(focusSlug, Number(b.dataset.depth)));
      });
      focusBar.querySelector('[data-focus-reset]').addEventListener('click', () => setFocus(null));
    }

    serverSelect?.addEventListener('change', rerender);
    hideIsolatedEl?.addEventListener('change', rerender);
    clustersEl?.addEventListener('change', () => {
      if (collapseEl) collapseEl.disabled = !clustersEl.checked;
      rerender();
    });
    collapseEl?.addEventListener('change', () => instance?.setCollapse(collapseEl.checked));
    uniformSizeEl?.addEventListener('change', () => instance?.setUniformSize(uniformSizeEl.checked));
    cosmosEl?.addEventListener('change', () => {
      try { localStorage.setItem(COSMOS_STORAGE_KEY, cosmosEl.checked ? '1' : '0'); } catch (_) { /* не критично */ }
      instance?.setCosmos(cosmosEl.checked);
    });

    searchInput?.addEventListener('input', () => {
      const q = searchInput.value.trim();
      if (searchClearBtn) searchClearBtn.hidden = !q;
      instance?.setSearchHighlight(q);
    });
    // Enter в поиске — показать окрестность первой найденной статьи.
    searchInput?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const slug = instance?.firstSearchMatch();
      if (!slug) return;
      e.preventDefault();
      setFocus(slug);
    });
    searchClearBtn?.addEventListener('click', () => {
      if (!searchInput) return;
      searchInput.value = '';
      searchClearBtn.hidden = true;
      instance?.setSearchHighlight('');
      searchInput.focus();
    });

    document.getElementById('graphExportPng')?.addEventListener('click', () => exportGraphPng(container));

    // Полноэкранный режим: разворачиваем ВСЮ карточку (.graph-card-top —
    // заголовок + панель фильтров/поиска + сам граф), а не только
    // #graphContainer, — поиск и остальные controls остаются на прежнем
    // месте на панели, просто она растягивается на весь экран. Раскладка
    // графа (силы, viewBox) посчитана под размер контейнера на момент
    // renderGraph, поэтому при входе/выходе пересчитываем её через rerender().
    const fullscreenBtn = document.getElementById('graphFullscreenToggle');
    const cardEl = container.closest('.graph-card-top');
    function setGraphFullscreen(on) {
      if (!cardEl) return;
      cardEl.classList.toggle('graph-fullscreen', on);
      cardEl.classList.remove('graph-controls-open');
      if (fullscreenBtn) {
        fullscreenBtn.innerHTML = on
          ? '<i class="fas fa-compress"></i> Свернуть'
          : '<i class="fas fa-expand"></i> Во весь экран';
        fullscreenBtn.title = on ? 'Свернуть граф' : 'Открыть граф на весь экран';
      }
      exitActiveGraphFullscreen = on ? () => setGraphFullscreen(false) : null;
      rerender();
    }
    fullscreenBtn?.addEventListener('click', () => {
      setGraphFullscreen(!cardEl?.classList.contains('graph-fullscreen'));
    });
    // "Фильтры" — видна только в полноэкранном режиме на телефоне (CSS):
    // раскрывает спрятанные там переключатели. Граф не пересчитываем — SVG
    // занимает контейнер по CSS и просто становится ниже/выше.
    document.getElementById('graphControlsToggle')?.addEventListener('click', () => {
      cardEl?.classList.toggle('graph-controls-open');
    });

    await rerender();
  }

  window.GraphView = {
    renderGraph, loadD3, navigateToArticle, initGraphPage, exportGraphPng, createPendantLayout
  };
})();
