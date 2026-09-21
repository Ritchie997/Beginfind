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
   * @returns {Promise<{destroy: () => void, setSearchHighlight: (query: string) => void, setUniformSize: (flag: boolean) => void, setCosmos: (flag: boolean) => void}>}
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
      return { destroy() {}, setSearchHighlight() {}, setUniformSize() {}, setCosmos() {} };
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

    // Уникальные связи (без дублей A→B и B→A) — для поиска пересечений ниже.
    const pairs = [];
    {
      const seen = new Set();
      links.forEach((l) => {
        const key = l.source < l.target ? `${l.source}\u0000${l.target}` : `${l.target}\u0000${l.source}`;
        if (seen.has(key)) return;
        seen.add(key);
        pairs.push({ a: nodeBySlug.get(l.source), b: nodeBySlug.get(l.target) });
      });
    }

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

    svg.call(d3.zoom()
      .scaleExtent([0.2, 4])
      .on('zoom', (event) => {
        root.attr('transform', event.transform);
        starfield?.setTransform(event.transform);
      }));

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
        .attr('class', 'graph-node-glow')
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
      glow.classed(name, predicate);
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
    // source/target связи — slug (до инициализации forceLink) или узел (после)
    const endOf = (e) => (typeof e === 'object' ? e : nodeBySlug.get(e));
    const linkHasTail = (l) => pendantLayout.isTail(endOf(l.source)) || pendantLayout.isTail(endOf(l.target));

    const coreNodes = tailsPending ? nodes.filter((n) => !pendantLayout.isTail(n)) : nodes;
    const coreLinks = tailsPending ? links.filter((l) => !linkHasTail(l)) : links;

    const linkForce = d3.forceLink(coreLinks).id((n) => n.slug).distance(linkDistanceFor).strength(0.7);
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
      .force('tailEdges', pendantLayout.edgeForce);

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
      // раз в ~0.5 с, пока раскладка уже подостыла (в начале узлы ещё летят)
      if (pendantLayout.pendants.length && ++untangleTicks % 30 === 0 && simulation.alpha() < 0.35) runUntangle();
    });
    simulation.on('end', runUntangle);

    return {
      destroy() {
        simulation.stop();
        starfield?.destroy();
        container.classList.remove('graph-cosmos');
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
    const STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linejoin', 'paint-order', 'opacity', 'font-size', 'font-weight', 'font-family', 'text-anchor'];
    originals.forEach((origEl, i) => {
      const cs = getComputedStyle(origEl);
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

    // Космос выключен — свечение в клон не берём (в живом SVG оно скрыто CSS-ом,
    // а стили display в клон не копируются).
    const cosmosOn = container.classList.contains('graph-cosmos');
    if (!cosmosOn) clone.querySelectorAll('.graph-glows').forEach((el) => el.remove());

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
      <span>Цвет узла — цвет его первого тега (меняется во вкладке «Теги»), при поиске — цвет найденного тега · Размер — число связей · Наведите/ищите (# — только по тегам) — подсветка связей · Клик — открыть · Колесо — масштаб · Перетаскивание — сдвинуть</span>
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
        uniformSize: !!uniformSizeEl?.checked,
        cosmos: !!cosmosEl?.checked
      });
      if (searchInput?.value.trim()) instance.setSearchHighlight(searchInput.value);
      if (data.nodes.length) renderGraphLegend(container, data.nodes, fullData.tagColors);
    }

    serverSelect?.addEventListener('change', rerender);
    hideIsolatedEl?.addEventListener('change', rerender);
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
    renderGraph, loadD3, navigateToArticle, initGraphPage, exportGraphPng, createPendantLayout
  };
})();
