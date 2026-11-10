// graph-view.js — Высокопроизводительный Canvas 2D рендер графа связей статей.
// Ремастер-версия: Canvas вместо сотен SVG-DOM-узлов для плавной работы на смартфонах (60/120 FPS),
// органичный бесшумный прогрев (warm-up) без взрывов и скачков, отзывчивый мобильный тач
// (pinch-to-zoom, панорамирование, адаптивная зона клика) и полное сохранение визуального стиля
// (космос, мерцающие звёзды, ореолы хабов, острова Louvain, обводка подписей, поиск и окрестности).

(function () {
  'use strict';

  // Выход из полноэкранного режима графа по Escape
  let exitActiveGraphFullscreen = null;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && exitActiveGraphFullscreen) exitActiveGraphFullscreen();
  });

  // Загрузка D3 (d3-force для физической симуляции):
  // 1. Если window.d3 уже подключён через <script> в index.html — используется сразу (0 мс).
  // 2. Иначе динамически подключается скрипт d3.min.js с jsDelivr.
  // 3. При сбое сети — запасной ESM import с esm.sh.
  let d3Promise = null;
  function loadD3() {
    if (window.d3 && typeof window.d3.forceSimulation === 'function') {
      return Promise.resolve(window.d3);
    }
    if (!d3Promise) {
      d3Promise = new Promise((resolve) => {
        if (window.d3 && typeof window.d3.forceSimulation === 'function') {
          return resolve(window.d3);
        }
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js';
        s.onload = () => {
          if (window.d3 && typeof window.d3.forceSimulation === 'function') {
            resolve(window.d3);
          } else {
            fallbackEsm().then(resolve);
          }
        };
        s.onerror = () => {
          fallbackEsm().then(resolve);
        };
        document.head.appendChild(s);
      });
    }
    return d3Promise;
  }

  function fallbackEsm() {
    return Promise.all([
      import('https://esm.sh/d3-force@3.0.0'),
      import('https://esm.sh/d3-quadtree@3.0.0'),
      import('https://esm.sh/d3-dispatch@3.0.0'),
      import('https://esm.sh/d3-timer@3.0.0')
    ]).then(([force, quadtree, dispatch, timer]) => {
      const merged = { ...force, ...quadtree, ...dispatch, ...timer };
      if (!window.d3) window.d3 = merged;
      return merged;
    }).catch((err) => {
      console.error('Не удалось загрузить d3-force:', err);
      return window.d3 || {};
    });
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  const NO_TAG_COLOR = '#8e9297';
  const MAP_NODE_COLOR = '#1abc9c';
  const TAU = Math.PI * 2;

  function primaryTagOf(node, tagColors) {
    const map = tagColors || {};
    const key = (node.tags || []).find((t) => map[t]);
    return key ? { key, name: map[key].name || key, color: map[key].color } : null;
  }

  function tagNodeColor(node, tagColors) {
    const primary = primaryTagOf(node, tagColors);
    return primary ? primary.color : NO_TAG_COLOR;
  }

  function nodeDisplayTitle(n) {
    if (n.kind === 'map') return `🗺 ${n.title || 'Карта'}`;
    return n.locked ? '???' : (n.title || n.slug);
  }

  // Цвета подложек групп (островов)
  const CLUSTER_COLORS = ['#5865f2', '#3ba55c', '#faa61a', '#eb459e', '#00b0f4', '#ed4245', '#9b59b6', '#1abc9c', '#e67e22', '#95a5a6'];

  // ---------------------------------------------------------------------------
  // Космический фон графа: мерцающие звёзды на <canvas> с параллаксом
  // Оптимизация: умный спящий режим в покое (20 FPS вместо 60 FPS для экономии батареи),
  // остановка при скрытой вкладке или свернутом блоке.
  // ---------------------------------------------------------------------------
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
    const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    let W = 0;
    let H = 0;
    let FW = 0;
    let FH = 0;
    let dpr = 1;
    let stars = [];
    let transform = { x: 0, y: 0, k: 1 };
    let enabled = false;
    let inView = true;
    let rafId = 0;
    let lastTs = 0;
    let isIdle = false;
    let idleTimer = null;

    const rand = (a, b) => a + Math.random() * (b - a);
    const wrap = (v, m) => ((v % m) + m) % m;

    function spawn(s, initial) {
      const roll = Math.random();
      const layer = roll < 0.6 ? 0 : (roll < 0.9 ? 1 : 2);
      s.big = layer === 2 && Math.random() < 0.18;
      s.depth = [0.1, 0.22, 0.38][layer];
      s.r = s.big ? rand(1.5, 2.1) : [rand(0.35, 0.7), rand(0.6, 1.0), rand(0.9, 1.4)][layer];
      s.x = Math.random() * FW;
      s.y = Math.random() * FH;
      s.rgb = pickStarColor();
      s.maxA = s.big ? rand(0.85, 1) : rand(0.35, 0.85);
      s.dur = rand(6, 16);
      s.age = initial ? Math.random() * s.dur : 0;
      s.tw = Math.random() < 0.55 ? rand(0.25, 0.7) : 0;
      s.period = rand(0.9, 3.2);
      s.phase = Math.random() * TAU;
      return s;
    }

    function draw(dt) {
      if (!W || !H) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2;
      const cy = H / 2;
      const ox = (FW - W) / 2;
      const oy = (FH - H) / 2;

      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
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
      // На мобильных устройствах умеренное число звёзд для экономии ресурсов
      const count = Math.max(70, Math.min(500, Math.round((FW * FH) / 3200)));
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

      // В состоянии покоя частота отрисовки звёзд снижается до ~22 FPS
      if (isIdle) {
        setTimeout(() => {
          if (shouldRun() && !rafId) rafId = requestAnimationFrame(frame);
        }, 40);
      } else {
        rafId = requestAnimationFrame(frame);
      }
    }

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
      setTransform(t) {
        transform = { x: t.x, y: t.y, k: t.k };
        this.wake();
        if (enabled && !rafId && stars.length) draw(0);
      },
      wake() {
        isIdle = false;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { isIdle = true; }, 1800);
        sync();
      },
      destroy() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        enabled = false;
        if (idleTimer) clearTimeout(idleTimer);
        document.removeEventListener('visibilitychange', onVisibility);
        intersectionObserver?.disconnect();
        resizeObserver?.disconnect();
        canvas.remove();
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Группы статей: Louvain Community Detection
  // ---------------------------------------------------------------------------
  function detectCommunities(slugs, pairList) {
    const index = new Map(slugs.map((s, i) => [s, i]));
    let adj = slugs.map(() => new Map());
    pairList.forEach(([a, b, weight = 1]) => {
      const i = index.get(a);
      const j = index.get(b);
      if (i == null || j == null || i === j) return;
      adj[i].set(j, (adj[i].get(j) || 0) + weight);
      adj[j].set(i, (adj[j].get(i) || 0) + weight);
    });
    const membership = slugs.map((_, i) => i);

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

    const dense = new Map();
    const result = new Map();
    slugs.forEach((s, i) => {
      const c = membership[i];
      if (!dense.has(c)) dense.set(c, dense.size);
      result.set(s, dense.get(c));
    });
    return result;
  }

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

  // Заглушка для обратной совместимости, если внешние модули вызывают createPendantLayout
  function createPendantLayout() {
    return {
      pendants: [],
      edgeForce: () => {},
      isTail: () => false,
      attach: () => {},
      untangle: () => 0,
      reset: () => {}
    };
  }

  // ---------------------------------------------------------------------------
  // Основной Canvas 2D рендер графа
  // ---------------------------------------------------------------------------
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
      return { destroy() {}, setSearchHighlight() {}, setUniformSize() {}, setCosmos() {}, firstSearchMatch() { return null; } };
    }

    const starfield = cosmosSupported ? createStarfield(container) : null;
    let cosmosOn = cosmosSupported && options.cosmos;
    container.classList.toggle('graph-cosmos', cosmosOn);
    starfield?.setEnabled(cosmosOn);

    const canvas = document.createElement('canvas');
    canvas.className = 'graph-canvas';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const tooltip = document.createElement('div');
    tooltip.className = 'graph-tooltip';
    tooltip.hidden = true;
    container.appendChild(tooltip);

    // Цветовая палитра темы
    function getThemeColors() {
      const cs = getComputedStyle(container);
      return {
        bg: cosmosOn ? '#0a0c16' : (cs.getPropertyValue('--graph-bg').trim() || '#202225'),
        accent: cs.getPropertyValue('--background-accent').trim() || '#4f545c',
        blurple: cs.getPropertyValue('--blurple').trim() || '#5865f2',
        green: cs.getPropertyValue('--green').trim() || '#3ba55c',
        yellow: cs.getPropertyValue('--yellow').trim() || '#faa61a',
        textNormal: cs.getPropertyValue('--text-normal').trim() || '#dcddde',
        textMuted: cs.getPropertyValue('--text-muted').trim() || '#8e9297'
      };
    }
    let colors = getThemeColors();

    const nodes = data.nodes.map(n => ({ ...n, degree: 0 }));
    const nodeBySlug = new Map(nodes.map(n => [n.slug, n]));
    const nodeOfEnd = (e) => (typeof e === 'object' ? e : nodeBySlug.get(e));
    const slugOfEnd = (e) => (typeof e === 'object' ? e.slug : e);

    // Связи (одна связь на пару статей)
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

    const neighbors = new Map(nodes.map(n => [n.slug, new Set([n.slug])]));
    links.forEach(l => {
      neighbors.get(l.source)?.add(l.target);
      neighbors.get(l.target)?.add(l.source);
    });
    nodes.forEach(n => { n.degree = neighbors.get(n.slug).size - 1; });

    // Поиск сообществ (острова Louvain)
    const clusters = [];
    const clusterOf = new Map();
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
      clusters.sort((a, b) => b.members.length - a.members.length);
      clusters.forEach((c, i) => {
        c.id = i;
        c.color = CLUSTER_COLORS[i % CLUSTER_COLORS.length];
        c.members.forEach((n) => clusterOf.set(n.slug, c));
      });
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

    const isInterLink = (l) => clusters.length > 0
      && clusterOf.get(slugOfEnd(l.source)) !== clusterOf.get(slugOfEnd(l.target));

    // Размеры точек и подписей
    const SIZE = compact
      ? { base: 4, k: 1.8, max: 12, uniform: 5, center: 3, labelBase: 8, labelK: 1, labelMax: 11, labelHover: 15 }
      : { base: 5, k: 4.5, max: 30, uniform: 7, center: 5, labelBase: 9, labelK: 2.2, labelMax: 17, labelHover: 17 };

    const growthOf = (n) => Math.log(Math.max(1, n.degree));
    const radiusFor = (n) => {
      const grown = uniformSize
        ? SIZE.uniform
        : Math.min(SIZE.base + SIZE.k * growthOf(n), SIZE.max);
      return grown + (n.slug === centerSlug ? SIZE.center : 0);
    };
    const labelSizeFor = (n) => (uniformSize
      ? SIZE.labelBase
      : Math.min(SIZE.labelBase + SIZE.labelK * growthOf(n), SIZE.labelMax));
    const labelHoverScaleFor = (n) => Math.max(1.2, SIZE.labelHover / labelSizeFor(n));

    // Параметры свечения ("Космос")
    const glowStrength = (n) => Math.min(1, Math.max(0, (radiusFor(n) - SIZE.base) / (SIZE.max - SIZE.base)));
    const glowRadiusFor = (n) => radiusFor(n) * (1.7 + 1.5 * glowStrength(n));
    const glowOpacityFor = (n) => 0.3 + 0.7 * glowStrength(n);

    // Поиск
    let activeSearchQuery = '';
    function searchTerm() {
      return (activeSearchQuery.startsWith('#') ? activeSearchQuery.slice(1) : activeSearchQuery).trim();
    }
    function tagMatchesTerm(key, term) {
      if (String(key).toLowerCase().includes(term)) return true;
      const name = tagColors?.[key]?.name;
      return !!name && name.toLowerCase().includes(term);
    }
    function matchingTagOf(n) {
      const term = searchTerm();
      if (!term) return null;
      return (n.tags || []).find((t) => tagColors?.[t] && tagMatchesTerm(t, term)) ?? null;
    }
    function nodeMatchesQuery(n) {
      const term = searchTerm();
      if (!term) return false;
      if ((n.tags || []).some((t) => tagMatchesTerm(t, term))) return true;
      return !n.locked && !activeSearchQuery.startsWith('#') && (n.title || '').toLowerCase().includes(term);
    }
    function searchMatches() {
      if (!activeSearchQuery) return null;
      return new Set(nodes.filter(nodeMatchesQuery).map((n) => n.slug));
    }

    const colorFor = (n) => tagNodeColor(n, tagColors);
    const fillFor = (n) => {
      if (n.kind === 'map') return MAP_NODE_COLOR;
      if (n.slug === centerSlug) return colors.green;
      if (!colorByTag) return colors.blurple;
      const matched = matchingTagOf(n);
      return matched ? tagColors[matched].color : colorFor(n);
    };

    // Обновление геометрии кластеров
    function updateClusterGeometry() {
      clusters.forEach((c) => {
        let sx = 0; let sy = 0; let placed = 0; let pad = 0;
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

    // Физические силы
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
    const CLUSTERED_GRAVITY = 0.3;
    const gravityFor = (n) => (uniformSize ? 0.03 : 0.025 + 0.012 * Math.log(1 + n.degree))
      * (clusterOf.has(n.slug) ? CLUSTERED_GRAVITY : 1);
    const collideFor = (n) => radiusFor(n) + 12;

    const clusterForce = (alpha) => {
      if (!clusters.length) return;
      updateClusterGeometry();
      clusters.forEach((c) => {
        if (!c.placed) return;
        c.members.forEach((m) => {
          if (m.x == null || m.fx != null) return;
          m.vx += (c.x - m.x) * 0.08 * alpha;
          m.vy += (c.y - m.y) * 0.08 * alpha;
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
          const min = a.r + b.r + 30;
          if (dist >= min) continue;
          if (dist < 1e-6) { dx = 1; dy = 0; dist = 1; }
          const push = ((min - dist) / dist) * 0.8 * alpha;
          const total = a.members.length + b.members.length;
          const pa = push * (b.members.length / total);
          const pb = push * (a.members.length / total);
          a.members.forEach((m) => { if (m.x != null && m.fx == null) { m.vx -= dx * pa; m.vy -= dy * pa; } });
          b.members.forEach((m) => { if (m.x != null && m.fx == null) { m.vx += dx * pb; m.vy += dy * pb; } });
        }
      }
    };

    // ---------------------------------------------------------------------------
    // Органичный старт: начальная расстановка кластеров по спирали
    // ---------------------------------------------------------------------------
    if (clusters.length > 0) {
      const stepAngle = TAU / clusters.length;
      const ringRadius = Math.min(width, height) * 0.28;
      clusters.forEach((c, idx) => {
        const ca = idx * stepAngle;
        const cx = width / 2 + Math.cos(ca) * ringRadius;
        const cy = height / 2 + Math.sin(ca) * ringRadius;
        c.members.forEach((m, mIdx) => {
          if (m.x == null) {
            const ma = mIdx * 2.399963;
            const mr = 16 * Math.sqrt(mIdx + 1);
            m.x = cx + Math.cos(ma) * mr;
            m.y = cy + Math.sin(ma) * mr;
          }
        });
      });
    }
    let unplacedIdx = 0;
    nodes.forEach((n) => {
      if (n.x == null) {
        const a = unplacedIdx * 2.399963;
        const r = Math.min(width, height) * 0.32 + 14 * Math.sqrt(unplacedIdx + 1);
        n.x = width / 2 + Math.cos(a) * r;
        n.y = height / 2 + Math.sin(a) * r;
        unplacedIdx++;
      }
    });

    const linkForce = d3.forceLink(links).id((n) => n.slug).distance(linkDistanceFor).strength(linkStrengthFor);
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
      .force('collide', collideForce)
      .force('clusters', clusterForce);

    if (centerSlug && nodeBySlug.has(centerSlug)) {
      const c = nodeBySlug.get(centerSlug);
      c.fx = width / 2;
      c.fy = height / 2;
    }

    // ---------------------------------------------------------------------------
    // Бесшумный предварительный прогрев (Silent Warm-up):
    // 35–45 тиков симуляции в памяти за ~10 мс. Граф появляется на экране
    // СРАЗУ устойчивым и структурированным, без хаотичного взрыва и разлёта.
    // ---------------------------------------------------------------------------
    const warmupTicks = compact ? 22 : 40;
    for (let w = 0; w < warmupTicks; w++) {
      simulation.tick();
    }

    // ---------------------------------------------------------------------------
    // Вид (камера), масштабирование и панорамирование
    // ---------------------------------------------------------------------------
    const MIN_ZOOM = 0.05;
    const MAX_ZOOM = 4.0;
    let transform = { x: 0, y: 0, k: 1 };
    let zoomK = 1;
    let userZoomed = false;

    function computeContentBounds() {
      let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
      nodes.forEach((n) => {
        if (n.x == null) return;
        const r = radiusFor(n) + 20;
        x0 = Math.min(x0, n.x - r); y0 = Math.min(y0, n.y - r);
        x1 = Math.max(x1, n.x + r); y1 = Math.max(y1, n.y + r);
      });
      updateClusterGeometry();
      clusters.forEach((c) => {
        if (!c.placed) return;
        x0 = Math.min(x0, c.x - c.r); x1 = Math.max(x1, c.x + c.r);
        y0 = Math.min(y0, c.minY - c.pad - 30); y1 = Math.max(y1, c.y + c.r);
      });
      if (!isFinite(x0)) return { x0: 0, y0: 0, x1: width, y1: height };
      return { x0, y0, x1, y1 };
    }

    function transformForBounds(x0, y0, x1, y1, minK, maxK) {
      const margin = 32;
      const w = Math.max(x1 - x0, 1);
      const h = Math.max(y1 - y0, 1);
      const fit = Math.min((width - margin * 2) / w, (height - margin * 2) / h);
      const k = Math.max(MIN_ZOOM, Math.min(maxK, Math.max(minK, fit)));
      return { k, x: width / 2 - k * (x0 + x1) / 2, y: height / 2 - k * (y0 + y1) / 2 };
    }

    // Первоначальный кадр ставится сразу после прогрева — до первого рендера
    const b0 = computeContentBounds();
    const initT = transformForBounds(b0.x0, b0.y0, b0.x1, b0.y1, MIN_ZOOM, 1.0);
    transform = initT;
    zoomK = transform.k;
    starfield?.setTransform(transform);

    let zoomAnimId = 0;
    function stopZoomAnimation() {
      if (zoomAnimId) cancelAnimationFrame(zoomAnimId);
      zoomAnimId = 0;
    }
    function animateZoomTo(target, duration = 450) {
      stopZoomAnimation();
      const from = { ...transform };
      const start = performance.now();
      const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
      const step = (now) => {
        const t = Math.min(1, (now - start) / duration);
        const e = ease(t);
        const k = from.k * Math.pow(target.k / from.k, e);
        const x = from.x + (target.x - from.x) * e;
        const y = from.y + (target.y - from.y) * e;
        transform = { x, y, k };
        zoomK = k;
        starfield?.setTransform(transform);
        scheduleRender();
        zoomAnimId = t < 1 ? requestAnimationFrame(step) : 0;
      };
      zoomAnimId = requestAnimationFrame(step);
    }

    // ---------------------------------------------------------------------------
    // Интерактивное состояние (наведение, подсветка)
    // ---------------------------------------------------------------------------
    let hoveredNode = null;
    let draggedNode = null;

    function getActivePrimarySlugs() {
      if (hoveredNode) return new Set([hoveredNode.slug]);
      return searchMatches();
    }

    function isDimmed(n, primarySlugs) {
      if (!primarySlugs || !primarySlugs.size) return false;
      if (primarySlugs.has(n.slug)) return false;
      const nbs = neighbors.get(n.slug);
      for (const s of primarySlugs) {
        if (nbs?.has(s)) return false;
      }
      return true;
    }

    // ---------------------------------------------------------------------------
    // Canvas Отрисовка
    // ---------------------------------------------------------------------------
    let renderRequested = false;
    let canvasW = 0;
    let canvasH = 0;
    let dpr = 1;

    function resizeCanvas() {
      const w = container.clientWidth || 400;
      const h = container.clientHeight || 400;
      if (w === canvasW && h === canvasH) return;
      canvasW = w;
      canvasH = h;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(canvasW * dpr);
      canvas.height = Math.round(canvasH * dpr);
      colors = getThemeColors();
      scheduleRender();
    }

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => resizeCanvas())
      : null;
    resizeObserver?.observe(container);
    resizeCanvas();

    function scheduleRender() {
      if (!renderRequested) {
        renderRequested = true;
        requestAnimationFrame(renderFrame);
      }
    }

    function hexToRgba(hex, alpha) {
      if (!hex || hex[0] !== '#') return hex;
      let r = 0; let g = 0; let b = 0;
      if (hex.length === 4) {
        r = parseInt(hex[1] + hex[1], 16);
        g = parseInt(hex[2] + hex[2], 16);
        b = parseInt(hex[3] + hex[3], 16);
      } else if (hex.length === 7) {
        r = parseInt(hex.slice(1, 3), 16);
        g = parseInt(hex.slice(3, 5), 16);
        b = parseInt(hex.slice(5, 7), 16);
      }
      return `rgba(${r},${g},${b},${alpha})`;
    }

    function renderFrame() {
      renderRequested = false;
      if (!canvasW || !canvasH) return;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      ctx.setTransform(dpr * transform.k, 0, 0, dpr * transform.k, dpr * transform.x, dpr * transform.y);

      const primarySlugs = getActivePrimarySlugs();
      const hasSearch = !!activeSearchQuery;
      const hideLabelsMode = container.classList.contains('graph-hide-labels');

      // 1. Острова (кластеры)
      if (clusters.length > 0) {
        updateClusterGeometry();
        clusters.forEach((c) => {
          if (!c.placed) return;
          const pts = convexHull(c.members.filter((m) => m.x != null));
          if (!pts.length) return;

          ctx.save();
          ctx.beginPath();
          if (pts.length === 1) {
            ctx.arc(pts[0].x, pts[0].y, c.pad, 0, TAU);
          } else {
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.closePath();
          }
          ctx.fillStyle = c.color;
          ctx.globalAlpha = cosmosOn ? 0.11 : 0.08;
          ctx.lineWidth = c.pad * 2;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.strokeStyle = c.color;
          ctx.stroke();
          ctx.fill();
          ctx.restore();

          // Название группы (с плавным исчезновением при близком приближении)
          if (c.name && zoomK <= 1.4) {
            const labelOpacity = zoomK <= 0.7 ? 1 : Math.max(0.1, 1 - (zoomK - 0.7) / 0.7);
            const fontSize = Math.min(15 / zoomK, 90);
            ctx.save();
            ctx.globalAlpha = labelOpacity;
            ctx.font = `700 ${fontSize}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.lineWidth = Math.min(4 / zoomK, 24);
            ctx.strokeStyle = colors.bg;
            ctx.lineJoin = 'round';
            ctx.strokeText(c.name, c.x, c.minY - c.pad - 6);
            ctx.fillStyle = c.color;
            ctx.fillText(c.name, c.x, c.minY - c.pad - 6);
            ctx.restore();
          }
        });
      }

      // 2. Свечение точек ("Космос")
      if (cosmosOn) {
        nodes.forEach((n) => {
          if (n.x == null) return;
          const dimmed = isDimmed(n, primarySlugs);
          const r = glowRadiusFor(n);
          const color = fillFor(n) || NO_TAG_COLOR;
          const opacity = glowOpacityFor(n) * (dimmed ? 0.12 : 1);

          const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r);
          grad.addColorStop(0, hexToRgba(color, 0.85 * opacity));
          grad.addColorStop(0.3, hexToRgba(color, 0.45 * opacity));
          grad.addColorStop(0.65, hexToRgba(color, 0.14 * opacity));
          grad.addColorStop(1, hexToRgba(color, 0));

          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r, 0, TAU);
          ctx.fill();
        });
      }

      // 3. Линии связей (пакетная отрисовка по типам)
      // Обычные, неактивные связи
      ctx.save();
      links.forEach((l) => {
        const u = l.source;
        const v = l.target;
        if (u.x == null || v.x == null) return;
        const uSlug = u.slug;
        const vSlug = v.slug;
        const isActive = primarySlugs && (primarySlugs.has(uSlug) || primarySlugs.has(vSlug));
        const isDim = primarySlugs && !isActive;

        ctx.beginPath();
        ctx.moveTo(u.x, u.y);
        ctx.lineTo(v.x, v.y);

        if (isActive) {
          ctx.strokeStyle = colors.blurple;
          ctx.lineWidth = 2;
          ctx.globalAlpha = 1.0;
        } else if (isDim) {
          ctx.strokeStyle = colors.accent;
          ctx.lineWidth = l.mutual ? 1.4 : 1;
          ctx.globalAlpha = 0.12;
        } else {
          ctx.strokeStyle = colors.accent;
          ctx.lineWidth = l.mutual ? 1.6 : 1;
          ctx.globalAlpha = isInterLink(l) ? 0.3 : (l.mutual ? 0.75 : 0.6);
        }
        ctx.stroke();
      });
      ctx.restore();

      // 4. Узлы (кружки)
      nodes.forEach((n) => {
        if (n.x == null) return;
        const r = radiusFor(n);
        const dimmed = isDimmed(n, primarySlugs);
        const isHover = hoveredNode && hoveredNode.slug === n.slug;
        const isSearchMatch = hasSearch && nodeMatchesQuery(n);
        const fill = fillFor(n) || colors.blurple;

        ctx.save();
        ctx.globalAlpha = dimmed ? 0.15 : 1.0;

        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, TAU);
        ctx.fillStyle = fill;
        ctx.fill();

        // Обводка узла
        if (isHover || isSearchMatch) {
          ctx.strokeStyle = colors.yellow;
          ctx.lineWidth = 3;
          ctx.stroke();
        } else if (n.locked) {
          ctx.strokeStyle = colors.textMuted;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([2.5, 2]);
          ctx.stroke();
        } else {
          ctx.strokeStyle = colors.bg;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.restore();
      });

      // 5. Подписи статей
      // Сортировка: более крупные узлы рисуют подписи поверх мелких
      const sortedNodes = [...nodes].sort((a, b) => a.degree - b.degree);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineJoin = 'round';

      sortedNodes.forEach((n) => {
        if (n.x == null) return;
        const isHover = hoveredNode && hoveredNode.slug === n.slug;
        const isSearchMatch = hasSearch && nodeMatchesQuery(n);
        const isCenter = n.slug === centerSlug;

        if (hideLabelsMode && !isHover && !isSearchMatch && !isCenter) {
          return;
        }

        const dimmed = isDimmed(n, primarySlugs);
        let baseSize = labelSizeFor(n);
        if (isHover) baseSize *= labelHoverScaleFor(n);

        const title = nodeDisplayTitle(n);
        const y = n.y - (radiusFor(n) + 4);

        ctx.save();
        ctx.globalAlpha = dimmed ? 0.15 : 1.0;
        ctx.font = `${isHover || isCenter ? '600 ' : ''}${n.locked ? 'italic ' : ''}${baseSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

        // Ореол подписи под цвет фона (paint-order: stroke)
        ctx.lineWidth = 3;
        ctx.strokeStyle = colors.bg;
        ctx.strokeText(title, n.x, y);

        // Текст
        if (isHover || isCenter) {
          ctx.fillStyle = colors.textNormal;
        } else if (n.locked) {
          ctx.fillStyle = colors.textMuted;
        } else {
          ctx.fillStyle = colors.textMuted;
        }
        ctx.fillText(title, n.x, y);
        ctx.restore();
      });
    }

    // Симуляция физики
    simulation.on('tick', () => {
      scheduleRender();
    });

    // ---------------------------------------------------------------------------
    // Интерактивное управление (мышь, тач-жесты, пинч-зум)
    // ---------------------------------------------------------------------------
    function findNodeAt(px, py, isTouch = false) {
      const gx = (px - transform.x) / transform.k;
      const gy = (py - transform.y) / transform.k;
      // На сенсорном экране зона нажатия расширена для комфортного попадания пальцем
      const touchPadding = isTouch ? Math.max(14 / transform.k, 22 / transform.k) : 4 / transform.k;

      let best = null;
      let bestDist = Infinity;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n.x == null) continue;
        const dist = Math.hypot(n.x - gx, n.y - gy);
        const r = radiusFor(n) + touchPadding;
        if (dist <= r && dist < bestDist) {
          best = n;
          bestDist = dist;
        }
      }
      return best;
    }

    function showTooltip(n, screenX, screenY) {
      if (!n || n.locked) {
        tooltip.hidden = true;
        return;
      }
      const title = nodeDisplayTitle(n);
      const tags = (n.tags || []).slice(0, 4).map((t) => `#${escapeHtml(t)}`).join(' ');
      tooltip.innerHTML = `
        <div class="graph-tooltip-title">${escapeHtml(title)}</div>
        ${tags ? `<div class="graph-tooltip-tags">${tags}</div>` : ''}
        <div class="graph-tooltip-hint">Связей: ${n.degree} · Нажмите, чтобы открыть</div>
      `;
      tooltip.hidden = false;
      tooltip.style.left = `${screenX}px`;
      tooltip.style.top = `${screenY}px`;
    }

    function hideTooltip() {
      tooltip.hidden = true;
    }

    // Обработка колеса мыши (зум к курсору)
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      userZoomed = true;
      stopZoomAnimation();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const zoomFactor = e.deltaY < 0 ? 1.15 : (1 / 1.15);
      const nextK = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, transform.k * zoomFactor));
      const factor = nextK / transform.k;

      transform.x = mx - (mx - transform.x) * factor;
      transform.y = my - (my - transform.y) * factor;
      transform.k = nextK;
      zoomK = nextK;
      starfield?.setTransform(transform);
      scheduleRender();
    }, { passive: false });

    // Обработка мыши (Desktop)
    let isMouseDown = false;
    let mouseStartPos = { x: 0, y: 0 };
    let hasDragged = false;

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 2) return; // ПКМ обрабатывается через contextmenu
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      isMouseDown = true;
      hasDragged = false;
      mouseStartPos = { x: mx, y: my };

      const hit = findNodeAt(mx, my, false);
      if (hit) {
        draggedNode = hit;
        draggedNode.fx = hit.x;
        draggedNode.fy = hit.y;
        simulation.alphaTarget(0.2).restart();
      }
    });

    window.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (isMouseDown) {
        const dx = mx - mouseStartPos.x;
        const dy = my - mouseStartPos.y;
        if (Math.hypot(dx, dy) > 4) hasDragged = true;

        if (draggedNode) {
          draggedNode.fx = (mx - transform.x) / transform.k;
          draggedNode.fy = (my - transform.y) / transform.k;
          scheduleRender();
        } else {
          userZoomed = true;
          stopZoomAnimation();
          transform.x += dx;
          transform.y += dy;
          mouseStartPos = { x: mx, y: my };
          starfield?.setTransform(transform);
          scheduleRender();
        }
        return;
      }

      // Ховер
      if (mx >= 0 && mx <= canvasW && my >= 0 && my <= canvasH) {
        const hit = findNodeAt(mx, my, false);
        if (hit !== hoveredNode) {
          hoveredNode = hit;
          canvas.style.cursor = hit ? (hit.locked ? 'not-allowed' : 'pointer') : 'grab';
          if (hit) showTooltip(hit, mx, my); else hideTooltip();
          scheduleRender();
        } else if (hit) {
          showTooltip(hit, mx, my);
        }
      } else if (hoveredNode) {
        hoveredNode = null;
        hideTooltip();
        canvas.style.cursor = 'grab';
        scheduleRender();
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (!isMouseDown) return;
      isMouseDown = false;

      if (draggedNode) {
        draggedNode.fx = null;
        draggedNode.fy = null;
        simulation.alphaTarget(0);
      }

      if (!hasDragged && draggedNode) {
        const n = draggedNode;
        if (n.kind === 'map') {
          window.MapsUI?.openMapPage(n.mapId);
        } else if (onNodeClick && !n.locked) {
          onNodeClick(n.slug);
        }
      }
      draggedNode = null;
    });

    // Контекстное меню (ПКМ) — окрестность статьи
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const hit = findNodeAt(mx, my, false);
      if (hit && options.onNodeFocus && hit.kind !== 'map') {
        options.onNodeFocus(hit.slug);
      }
    });

    // ---------------------------------------------------------------------------
    // Сенсорное управление для мобильных (Touch Gestures: Pinch-Zoom, Pan, Tap)
    // ---------------------------------------------------------------------------
    let touches = [];
    let touchStartDist = 0;
    let touchStartK = 1;
    let touchStartTime = 0;
    let touchStartPos = { x: 0, y: 0 };
    let longPressTimer = null;
    let touchDragged = false;

    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      userZoomed = true;
      stopZoomAnimation();
      const rect = canvas.getBoundingClientRect();
      touches = Array.from(e.touches).map((t) => ({ x: t.clientX - rect.left, y: t.clientY - rect.top }));
      touchDragged = false;
      touchStartTime = performance.now();

      if (touches.length === 1) {
        touchStartPos = { ...touches[0] };
        const hit = findNodeAt(touches[0].x, touches[0].y, true);
        if (hit) {
          draggedNode = hit;
          draggedNode.fx = hit.x;
          draggedNode.fy = hit.y;
          simulation.alphaTarget(0.2).restart();
        }

        // Долгое нажатие на телефоне (ПКМ-эквивалент) для окрестности статьи
        if (hit && options.onNodeFocus && hit.kind !== 'map') {
          if (longPressTimer) clearTimeout(longPressTimer);
          longPressTimer = setTimeout(() => {
            if (!touchDragged && draggedNode === hit) {
              if (navigator.vibrate) navigator.vibrate(35);
              options.onNodeFocus(hit.slug);
            }
          }, 450);
        }
      } else if (touches.length === 2) {
        if (longPressTimer) clearTimeout(longPressTimer);
        if (draggedNode) { draggedNode.fx = null; draggedNode.fy = null; draggedNode = null; }
        touchStartDist = Math.hypot(touches[1].x - touches[0].x, touches[1].y - touches[0].y);
        touchStartK = transform.k;
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const curTouches = Array.from(e.touches).map((t) => ({ x: t.clientX - rect.left, y: t.clientY - rect.top }));

      if (curTouches.length === 1 && touches.length >= 1) {
        const dx = curTouches[0].x - touches[0].x;
        const dy = curTouches[0].y - touches[0].y;
        if (Math.hypot(curTouches[0].x - touchStartPos.x, curTouches[0].y - touchStartPos.y) > 7) {
          touchDragged = true;
          if (longPressTimer) clearTimeout(longPressTimer);
        }

        if (draggedNode) {
          draggedNode.fx = (curTouches[0].x - transform.x) / transform.k;
          draggedNode.fy = (curTouches[0].y - transform.y) / transform.k;
        } else {
          transform.x += dx;
          transform.y += dy;
          starfield?.setTransform(transform);
        }
        touches = curTouches;
        scheduleRender();
      } else if (curTouches.length === 2) {
        touchDragged = true;
        if (longPressTimer) clearTimeout(longPressTimer);
        const curDist = Math.hypot(curTouches[1].x - curTouches[0].x, curTouches[1].y - curTouches[0].y);
        if (touchStartDist > 0) {
          const factor = curDist / touchStartDist;
          const nextK = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, touchStartK * factor));
          const midX = (curTouches[0].x + curTouches[1].x) / 2;
          const midY = (curTouches[0].y + curTouches[1].y) / 2;
          const scaleChange = nextK / transform.k;

          transform.x = midX - (midX - transform.x) * scaleChange;
          transform.y = midY - (midY - transform.y) * scaleChange;
          transform.k = nextK;
          zoomK = nextK;
          starfield?.setTransform(transform);
          scheduleRender();
        }
      }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      if (longPressTimer) clearTimeout(longPressTimer);
      const touchDuration = performance.now() - touchStartTime;

      if (!touchDragged && draggedNode && touchDuration < 380) {
        const n = draggedNode;
        if (n.kind === 'map') {
          window.MapsUI?.openMapPage(n.mapId);
        } else if (onNodeClick && !n.locked) {
          onNodeClick(n.slug);
        }
      }

      if (draggedNode) {
        draggedNode.fx = null;
        draggedNode.fy = null;
        draggedNode = null;
        simulation.alphaTarget(0);
      }
      touches = [];
    }, { passive: false });

    canvas.addEventListener('touchcancel', () => {
      if (longPressTimer) clearTimeout(longPressTimer);
      if (draggedNode) {
        draggedNode.fx = null;
        draggedNode.fy = null;
        draggedNode = null;
        simulation.alphaTarget(0);
      }
      touches = [];
    }, { passive: false });

    // Завершение симуляции — аккуратная подгонка в покое
    simulation.on('end', () => {
      if (!userZoomed) {
        const b = computeContentBounds();
        animateZoomTo(transformForBounds(b.x0, b.y0, b.x1, b.y1, MIN_ZOOM, 1.0), 300);
      }
      scheduleRender();
    });

    scheduleRender();

    return {
      destroy() {
        simulation.stop();
        stopZoomAnimation();
        starfield?.destroy();
        resizeObserver?.disconnect();
        container.classList.remove('graph-cosmos');
        container.innerHTML = '';
      },
      setSearchHighlight(query) {
        activeSearchQuery = (query || '').trim().toLowerCase();
        scheduleRender();
      },
      firstSearchMatch() {
        const term = searchTerm();
        if (!term) return null;
        const candidates = nodes.filter((n) => !n.locked && nodeMatchesQuery(n));
        const rank = (n) => {
          const t = (n.title || '').toLowerCase();
          if (t === term) return 0;
          if (t.startsWith(term)) return 1;
          return t.includes(term) ? 2 : 3;
        };
        candidates.sort((a, b) => rank(a) - rank(b) || b.degree - a.degree);
        return candidates[0]?.slug ?? null;
      },
      setUniformSize(flag) {
        const next = !!flag;
        if (next === uniformSize) return;
        uniformSize = next;
        linkForce.distance(linkDistanceFor);
        chargeForce.strength(chargeFor);
        xForce.strength(gravityFor);
        yForce.strength(gravityFor);
        collideForce.radius(collideFor);
        simulation.alpha(0.35).restart();
        scheduleRender();
      },
      setCosmos(flag) {
        if (!cosmosSupported) return;
        cosmosOn = !!flag;
        container.classList.toggle('graph-cosmos', cosmosOn);
        starfield?.setEnabled(cosmosOn);
        colors = getThemeColors();
        scheduleRender();
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Навигация к статье в Antropedia
  // ---------------------------------------------------------------------------
  async function navigateToArticle(slug) {
    if (!slug || !window.spaRouter) return;
    await window.spaRouter.navigateTo('/admin-panel/antropedia');
    await window.antropediaManager?.openArticleView(slug);
  }

  // ---------------------------------------------------------------------------
  // Экспорт графа в PNG напрямую из Canvas
  // ---------------------------------------------------------------------------
  async function exportGraphPng(container) {
    const canvas = container.querySelector('canvas.graph-canvas');
    if (!canvas || !canvas.width) {
      window.showMessage?.('Граф ещё не отрисован — нечего экспортировать.', 'error');
      return;
    }
    const starfield = container.querySelector('canvas.graph-starfield');
    const cosmosOn = container.classList.contains('graph-cosmos');

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const ctx = exportCanvas.getContext('2d');

    const bg = cosmosOn ? '#0a0c16' : (getComputedStyle(container).backgroundColor || '#202225');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

    if (cosmosOn && starfield && starfield.width) {
      ctx.drawImage(starfield, 0, 0, exportCanvas.width, exportCanvas.height);
    }
    ctx.drawImage(canvas, 0, 0, exportCanvas.width, exportCanvas.height);

    exportCanvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = URL.createObjectURL(blob);
      a.download = `articles-graph-${stamp}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  }

  // ---------------------------------------------------------------------------
  // Легенда цветов тегов
  // ---------------------------------------------------------------------------
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
      <span>Цвет узла — цвет первого тега · Размер — число связей · Подложки — группы связанных статей · Клик — открыть · Долгое нажатие / ПКМ — окрестность · Пинч / Колесо — зум</span>
    `;
    container.appendChild(legend);
  }

  // ---------------------------------------------------------------------------
  // Инициализация страницы дашборда
  // ---------------------------------------------------------------------------
  async function initGraphPage() {
    const container = document.getElementById('graphContainer');
    if (!container) return;

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
    const focusBar = document.getElementById('graphFocusBar');

    let focusSlug = null;
    let focusDepth = 1;

    if (hideLabelsEl) {
      hideLabelsEl.checked = fullData.nodes.length > 50;
      container.classList.toggle('graph-hide-labels', hideLabelsEl.checked);
      hideLabelsEl.addEventListener('change', () => {
        container.classList.toggle('graph-hide-labels', hideLabelsEl.checked);
      });
    }

    const COSMOS_STORAGE_KEY = 'alltell.graphCosmos';
    if (cosmosEl) {
      try { cosmosEl.checked = localStorage.getItem(COSMOS_STORAGE_KEY) !== '0'; } catch (_) {}
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
      const pairKeys = new Set();
      data.edges.forEach((e) => {
        if (e.from !== e.to) pairKeys.add(e.from < e.to ? `${e.from}\u0000${e.to}` : `${e.to}\u0000${e.from}`);
      });
      const mapCount = data.nodes.filter((n) => n.kind === 'map').length;
      if (countEl) countEl.textContent = `Статей: ${data.nodes.length - mapCount}${mapCount ? ` · Карт: ${mapCount}` : ''} · Связей: ${pairKeys.size}`;
      renderFocusBar();
      instance = await renderGraph(container, data, {
        onNodeClick: navigateToArticle,
        onNodeFocus: setFocus,
        centerSlug: focusSlug || undefined,
        colorByTag: true,
        tagColors: fullData.tagColors,
        uniformSize: !!uniformSizeEl?.checked,
        cosmos: !!cosmosEl?.checked,
        clusters: clustersEl ? clustersEl.checked : true
      });
      if (searchInput?.value.trim()) instance.setSearchHighlight(searchInput.value);
      if (data.nodes.length) renderGraphLegend(container, data.nodes, fullData.tagColors);
    }

    function setFocus(slug, depth) {
      focusSlug = slug || null;
      if (depth) focusDepth = depth;
      rerender();
    }

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
    clustersEl?.addEventListener('change', rerender);
    uniformSizeEl?.addEventListener('change', () => instance?.setUniformSize(uniformSizeEl.checked));
    cosmosEl?.addEventListener('change', () => {
      try { localStorage.setItem(COSMOS_STORAGE_KEY, cosmosEl.checked ? '1' : '0'); } catch (_) {}
      instance?.setCosmos(cosmosEl.checked);
    });

    searchInput?.addEventListener('input', () => {
      const q = searchInput.value.trim();
      if (searchClearBtn) searchClearBtn.hidden = !q;
      instance?.setSearchHighlight(q);
    });
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
    document.getElementById('graphControlsToggle')?.addEventListener('click', () => {
      cardEl?.classList.toggle('graph-controls-open');
    });

    await rerender();
  }

  window.GraphView = {
    renderGraph, loadD3, navigateToArticle, initGraphPage, exportGraphPng, createPendantLayout, renderGraphLegend
  };
})();
