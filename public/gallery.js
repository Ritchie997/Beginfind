// gallery.js — Галерея (аналог Pinterest), см. src/routes/gallery.routes.js.
//
//   window.galleryManager — страница /gallery: поиск, сортировка, теги и
//     сетка-кладка превью (много работ сразу) с подгрузкой при прокрутке;
//   window.galleryViewer  — просмотр работы поверх любой страницы (из
//     сетки, из полосы «Из галереи» под статьёй, по клику на арт в статье,
//     по ссылке /gallery/:id). Страницы листаются слайдером (стрелки при
//     наведении на ПК, свайп справа налево на телефоне) или лентой сверху
//     вниз (вертикальная лента) — режим выбирает автор при выкладывании.
//     Переключатель вариаций — по введённым автором именам. Лайки/реакции/
//     комментарии — тот же UI, что у статей (класс наследуется от
//     AntropediaManager, см. engagementApi в public/antropedia.js);
//   window.galleryEditor  — окно выкладывания/правки работы (массовая
//     загрузка страниц, вариации, доступ по ролям, привязка к статьям,
//     ассоциированные работы);
//   window.galleryPicker  — выбор арта для пересылки в статью (редактор,
//     image-блок с data.gallery — см. editor-manager.js).

(function () {
  'use strict';

  const PAGE_SIZE = 30;
  const UPLOAD_CHUNK = 8;

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(String(iso).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? '' : 'Z'));
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function errorText(result, fallback) {
    return (result && ((result.data && result.data.error) || result.error)) || fallback;
  }

  function isTypingTarget(el) {
    return !!(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
  }

  function isAnimatedUrl(url) {
    return /\.gif(\?|$)/i.test(String(url || ''));
  }

  // Разметка пикера стикеров — та же, что STICKER_PICKER_MARKUP в
  // antropedia.js (wireComposer ищет его по классам внутри формы).
  const STICKER_PICKER_MARKUP = `
    <div class="antropedia-sticker-picker" hidden>
      <div class="antropedia-sticker-picker-header">
        Стикеры
        <span class="antropedia-sticker-picker-links">
          <a href="#" data-nav="/stickers">управлять наборами</a> ·
          <a href="#" data-role="open-store">магазин наборов</a>
        </span>
      </div>
      <div class="antropedia-sticker-picker-tabs"></div>
      <div class="antropedia-sticker-picker-subtitle"></div>
      <div class="antropedia-sticker-picker-body"></div>
    </div>`;

  // Эндпоинты лайков/реакций/комментариев работы — тот же формат ответов,
  // что у статей (см. ARTICLE_ENGAGEMENT_API в antropedia.js).
  const api = (path, method, body) => window.apiClient.makeAuthenticatedRequest(path, method, body);
  const GALLERY_ENGAGEMENT_API = {
    getLikes: (id) => api(`/api/gallery/works/${id}/likes`),
    toggleLike: (id) => api(`/api/gallery/works/${id}/likes/toggle`, 'POST'),
    getReactions: (id) => api(`/api/gallery/works/${id}/reactions`),
    toggleReaction: (id, shortcode) => api(`/api/gallery/works/${id}/reactions/toggle`, 'POST', { shortcode }),
    getComments: (id) => api(`/api/gallery/works/${id}/comments`),
    addComment: (id, content, parentId) => api(`/api/gallery/works/${id}/comments`, 'POST', { content, parentId: parentId || null }),
    deleteComment: (id, commentId) => api(`/api/gallery/works/${id}/comments/${commentId}`, 'DELETE'),
    toggleCommentReaction: (id, commentId, shortcode) => api(`/api/gallery/works/${id}/comments/${commentId}/reactions/toggle`, 'POST', { shortcode })
  };

  // Карточка работы — общая для сетки галереи, полосы под статьёй,
  // ассоциированных работ и пикера в редакторе.
  function cardHtml(work, { compact = false, selectable = false, inFolder = false } = {}) {
    const cover = work.cover;
    const ratio = cover && cover.width && cover.height ? `${cover.width} / ${cover.height}` : '4 / 5';
    const badges = [];
    if (work.restricted) badges.push('<span class="gallery-badge" title="Видна не всем — доступ по ролям"><i class="fas fa-lock"></i></span>');
    if (cover && (cover.animated || isAnimatedUrl(cover.url))) badges.push('<span class="gallery-badge">GIF</span>');
    if (work.pagesCount > 1) badges.push(`<span class="gallery-badge" title="Страниц"><i class="far fa-images"></i> ${work.pagesCount}</span>`);
    if (work.hasVariations) badges.push('<span class="gallery-badge" title="У страниц есть вариации"><i class="fas fa-layer-group"></i></span>');
    const media = cover
      ? `<img src="${escapeHtml(cover.thumb || cover.url)}" alt="${escapeHtml(work.title)}" loading="lazy" decoding="async">`
      : '<div class="gallery-card-empty"><i class="far fa-image"></i><span>Нет страниц</span></div>';
    return `
      <article class="gallery-card${compact ? ' gallery-card-compact' : ''}" data-work-id="${work.id}" tabindex="0" title="${escapeHtml(work.title)}">
        <div class="gallery-card-media" style="aspect-ratio:${ratio}">
          ${media}
          ${badges.length ? `<div class="gallery-card-badges">${badges.join('')}</div>` : ''}
          ${selectable ? `<button type="button" class="gallery-card-select" data-select-work="${work.id}" aria-label="Выбрать работу «${escapeHtml(work.title)}»"><i class="fas fa-check"></i></button>` : ''}
          ${compact ? '' : `<div class="gallery-card-foot">
            <span class="${work.liked ? 'is-liked' : ''}"><i class="${work.liked ? 'fas' : 'far'} fa-heart"></i> ${work.likes || 0}</span>
            <span><i class="far fa-comment"></i> ${work.comments || 0}</span>
            <span><i class="far fa-eye"></i> ${work.views || 0}</span>
          </div>`}
        </div>
        ${selectable && !compact ? `
          <button type="button" class="gallery-card-menu-trigger" data-work-menu-trigger aria-label="Действия с работой «${escapeHtml(work.title)}»" aria-haspopup="menu" aria-expanded="false"><i class="fas fa-ellipsis"></i></button>
          <div class="gallery-card-actions-menu" role="menu" hidden>
            ${inFolder ? '' : '<button type="button" role="menuitem" data-work-menu-action="edit"><i class="fas fa-pen"></i> Изменить</button>'}
            <button type="button" role="menuitem" data-work-menu-action="move"><i class="fas fa-folder"></i> Переместить</button>
            <button type="button" role="menuitem" data-work-menu-action="delete" class="is-danger"><i class="fas fa-trash"></i> Удалить</button>
          </div>` : ''}
        <div class="gallery-card-caption">
          <div class="gallery-card-title">${escapeHtml(work.title)}</div>
          ${compact || !work.author ? '' : `<div class="gallery-card-author">${window.avatarHtml({ name: work.author.display_name, avatar: work.author.avatar }, 18)} ${escapeHtml(work.author.display_name)}</div>`}
        </div>
      </article>`;
  }

  // Индекс статей (заголовки под читателя + недоступные ему slug'и) — для
  // wiki-ссылок в описании работы: и для отрисовки (есть / нет / недоступно),
  // и для автодополнения в окне выкладывания. Кэш на минуту.
  let articlesIndexCache = null;
  function loadArticlesIndex() {
    const isPublicGuest = window.PublicSite && !window.authManager?.isAuthenticated?.();
    const cacheScope = isPublicGuest ? 'public' : 'authenticated';
    if (articlesIndexCache && articlesIndexCache.scope === cacheScope && Date.now() - articlesIndexCache.at < 60 * 1000) {
      return articlesIndexCache.promise;
    }
    const endpoint = isPublicGuest ? '/api/public/articles-index' : '/api/articles-index';
    const promise = window.apiClient.makeAuthenticatedRequest(endpoint).then((r) => {
      const data = (r.success && r.data) || {};
      const list = Array.isArray(data)
        ? data
        : (Array.isArray(data.data) ? data.data : (Array.isArray(data.accessible) ? data.accessible : []));
      const restricted = Array.isArray(data.restrictedSlugs) ? data.restrictedSlugs : [];
      return { list, bySlug: new Map(list.map((a) => [a.slug, a])), restricted: new Set(restricted) };
    }).catch(() => ({ list: [], bySlug: new Map(), restricted: new Set() }));
    articlesIndexCache = { at: Date.now(), promise, scope: cacheScope };
    return promise;
  }

  // Описание работы — тем же рендерером, что и статьи: markdown, wiki-ссылки
  // [подпись]((статья)), #теги, ||спойлеры||. Пустая строка — новый абзац.
  async function renderDescriptionHtml(text) {
    const paragraphs = String(text || '').split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
    if (!paragraphs.length || !window.renderArticleBlocks) return '';
    const index = await loadArticlesIndex();
    const doc = { version: 1, blocks: paragraphs.map((markdown, i) => ({ id: `d${i}`, type: 'paragraph', data: { markdown } })) };
    return window.renderArticleBlocks(doc, index.bySlug, index.restricted);
  }

  function openArticle(slug) {
    if (window.PublicSite && typeof window.PublicSite.navigateTo === 'function') {
      window.PublicSite.navigateTo(`/antropedia/${encodeURIComponent(slug)}`);
      return;
    }
    if (window.spaRouter && typeof window.spaRouter.openAntropediaArticle === 'function') {
      window.spaRouter.openAntropediaArticle(slug);
    }
  }

  // ========================================================================
  // Просмотр работы
  // ========================================================================

  const BaseManager = window.AntropediaManager;

  class GalleryViewer extends BaseManager {
    constructor() {
      super();
      this.engagementApi = GALLERY_ENGAGEMENT_API;
      this.work = null;
      this.pageIndex = 0;
      // Выбранная вариация каждой страницы (pageId -> индекс) и имя последней
      // выбранной: на следующих страницах сразу показывается вариация с тем
      // же именем, если она там есть ("Ч/Б" — так всю работу в ч/б).
      this.variantChoice = new Map();
      this.preferredVariantName = null;
      this.folderNavigation = false;
      this.el = null;
      this._histId = null;
      this._openSeq = 0;
    }

    // Жалобы на работы пока нет — у статьи кнопка жалобы ищется по id
    // (antropediaReportBtn), и на странице Antropedia её нашёл бы и этот класс.
    initReportModal() {}

    ensureDom() {
      if (this.el) return;
      const el = document.createElement('div');
      el.className = 'gallery-viewer';
      el.hidden = true;
      el.innerHTML = `
        <div class="gv-shell">
          <div class="gv-stage">
            <div class="gv-topbar">
              <button type="button" class="gv-icon-btn" data-gv="close" title="Закрыть (Esc)"><i class="fas fa-xmark"></i></button>
              <div class="gv-variants" data-gv="variants"></div>
              <span class="gv-counter" data-gv="counter"></span>
            </div>
            <div class="gv-frame" data-gv="frame">
              <div class="gv-track" data-gv="track"><img class="gv-image" data-gv="image" alt=""></div>
              <button type="button" class="gv-arrow gv-arrow-prev" data-gv="prev" title="Назад (←)"><i class="fas fa-chevron-left"></i></button>
              <button type="button" class="gv-arrow gv-arrow-next" data-gv="next" title="Вперёд (→)"><i class="fas fa-chevron-right"></i></button>
            </div>
            <div class="gv-strip" data-gv="strip"></div>
            <div class="gv-pages" data-gv="pages"></div>
          </div>
          <aside class="gv-panel">
            <h2 class="gv-title" data-gv="title"></h2>
            <div class="gv-badges" data-gv="badges"></div>
            <div class="gv-author" data-gv="author"></div>
            <div class="gv-meta" data-gv="meta"></div>
            <div class="gv-desc preview-pane" data-gv="desc"></div>
            <div class="gv-tags" data-gv="tags"></div>
            <div class="gv-actions">
              <button type="button" class="btn btn-secondary btn-sm" data-gv="share"><i class="fas fa-link"></i> Поделиться</button>
              <button type="button" class="btn btn-secondary btn-sm" data-gv="open-full" title="Открыть страницу в полном размере"><i class="fas fa-up-right-from-square"></i></button>
              <button type="button" class="btn btn-primary btn-sm" data-gv="edit" hidden><i class="fas fa-pen"></i> Изменить</button>
              <button type="button" class="btn btn-danger btn-sm" data-gv="delete" hidden><i class="fas fa-trash"></i></button>
            </div>
            <div class="antropedia-view-engagement gv-engagement">
              <button type="button" class="antropedia-engagement-btn" data-gv="like" title="Нравится"><i class="far fa-heart"></i> <span data-gv="like-count">0</span></button>
              <div class="antropedia-reactions" data-gv="reactions" data-target-type="gallery" data-target-id=""></div>
              <button type="button" class="antropedia-engagement-btn" data-gv="comments-btn" title="К комментариям"><i class="far fa-comment"></i> <span data-gv="comments-count">0</span></button>
            </div>
            <div class="gv-section" data-gv="articles-wrap" hidden>
              <h4><i class="fas fa-book-open"></i> В энциклопедии</h4>
              <div class="gv-articles" data-gv="articles"></div>
            </div>
            <div class="gv-section" data-gv="associated-wrap" hidden>
              <h4><i class="fas fa-link"></i> Связанные работы</h4>
              <div class="gv-associated" data-gv="associated"></div>
            </div>
            <section class="antropedia-comments gv-comments" data-gv="comments-section">
              <h3><i class="far fa-comment"></i> Комментарии <span data-gv="comments-header-count"></span></h3>
              <form class="antropedia-comment-form" data-gv="comment-form">
                <div class="antropedia-comment-input" contenteditable="true" data-placeholder="Написать комментарий…"></div>
                <div class="antropedia-comment-form-actions">
                  <button type="button" class="antropedia-sticker-picker-btn" data-sticker-picker-trigger title="Стикеры"><i class="far fa-face-smile"></i></button>
                  <button type="submit" data-role="submit" class="btn btn-primary btn-sm">Отправить</button>
                </div>
                ${STICKER_PICKER_MARKUP}
              </form>
              <div class="antropedia-comments-list" data-gv="comments-list"></div>
              <div class="antropedia-comments-empty" data-gv="comments-empty" hidden>Комментариев пока нет — будьте первым.</div>
            </section>
          </aside>
        </div>`;
      document.body.appendChild(el);
      this.el = el;
      const q = (name) => el.querySelector(`[data-gv="${name}"]`);
      this.$ = q;

      // Поля, которые использует унаследованный UI лайков/комментариев.
      this.likeBtn = q('like');
      this.likeCountEl = q('like-count');
      this.commentsBtn = q('comments-btn');
      this.commentsCountEl = q('comments-count');
      this.commentsSectionEl = q('comments-section');
      this.commentsHeaderCountEl = q('comments-header-count');
      this.commentsListEl = q('comments-list');
      this.commentsEmptyEl = q('comments-empty');
      this.commentFormEl = q('comment-form');
      this.commentInputEl = this.commentFormEl.querySelector('.antropedia-comment-input');
      this.reactionsBarEl = q('reactions');
      this.initEngagement();

      q('close').addEventListener('click', () => this.close());
      q('prev').addEventListener('click', (e) => { e.stopPropagation(); this.step(-1); });
      q('next').addEventListener('click', (e) => { e.stopPropagation(); this.step(1); });
      q('image').addEventListener('click', () => this.step(1, { wrap: false }));
      q('share').addEventListener('click', () => this.share());
      q('open-full').addEventListener('click', () => {
        const img = this.currentImage();
        if (img) window.open(img.url, '_blank', 'noopener');
      });
      q('edit').addEventListener('click', () => this.edit());
      q('delete').addEventListener('click', () => this.remove());
      q('variants').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-variant-index]');
        if (btn) this.selectVariant(this.pageIndex, parseInt(btn.dataset.variantIndex, 10));
      });
      q('pages').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-variant-index]');
        const block = btn && btn.closest('[data-page-index]');
        if (block) this.selectVariant(parseInt(block.dataset.pageIndex, 10), parseInt(btn.dataset.variantIndex, 10));
      });
      q('strip').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-page-index]');
        if (btn) this.showPage(parseInt(btn.dataset.pageIndex, 10));
      });
      q('articles').addEventListener('click', (e) => {
        const a = e.target.closest('[data-slug]');
        if (!a) return;
        e.preventDefault();
        this.close().then(() => openArticle(a.dataset.slug));
      });
      q('associated').addEventListener('click', (e) => {
        const card = e.target.closest('[data-work-id]');
        if (card) this.openWork(card.dataset.workId);
      });
      q('author').addEventListener('click', (e) => {
        const p = e.target.closest('[data-action="open-profile"]');
        if (p) this.close().then(() => window.spaRouter?.navigateTo(`/profile/${p.dataset.value}`));
      });
      // Описание: wiki-ссылка — статья в Antropedia (как ссылка в статье),
      // #тег — фильтр галереи по нему.
      q('desc').addEventListener('click', (e) => {
        const link = e.target.closest('.wiki-link, .wiki-link-missing, .wiki-link-restricted');
        if (link) {
          e.preventDefault();
          if (link.classList.contains('wiki-link')) this.close().then(() => openArticle(link.dataset.slug));
          else if (link.classList.contains('wiki-link-restricted')) showMessage('Эта статья недоступна вашей роли', 'info');
          else showMessage('Такой статьи пока нет', 'info');
          return;
        }
        const tag = e.target.closest('.hashtag');
        if (tag && tag.dataset.tag) {
          e.preventDefault();
          this.close().then(async () => {
            if (location.pathname !== '/gallery') await window.spaRouter?.navigateTo('/gallery');
            window.galleryManager?.filterByTag(tag.dataset.tag);
          });
        }
      });
      q('tags').addEventListener('click', (e) => {
        const t = e.target.closest('[data-tag]');
        if (!t) return;
        const tag = t.dataset.tag;
        this.close().then(async () => {
          if (location.pathname !== '/gallery') await window.spaRouter?.navigateTo('/gallery');
          window.galleryManager?.filterByTag(tag);
        });
      });

      this.bindSwipe(q('frame'));

      document.addEventListener('keydown', (e) => {
        if (!this.isOpen() || isTypingTarget(document.activeElement)) return;
        if (document.querySelector('.modal-overlay:not([hidden])')) return;
        if (e.key === 'Escape') { e.preventDefault(); this.close(); }
        else if (e.key === 'ArrowRight' && this.isHorizontal()) { e.preventDefault(); this.step(1); }
        else if (e.key === 'ArrowLeft' && this.isHorizontal()) { e.preventDefault(); this.step(-1); }
      });

      // Закрытие пикеров стикеров кликом мимо — как _docClickHandler в
      // antropedia.js (там он вешается только на странице Antropedia).
      document.addEventListener('click', (e) => {
        if (!this.isOpen() || e.target.closest('.antropedia-sticker-preview-overlay')) return;
        el.querySelectorAll('.antropedia-sticker-picker').forEach((picker) => this.closePickerIfOutside(picker, e));
        document.querySelectorAll('body > .antropedia-sticker-picker').forEach((picker) => this.closePickerIfOutside(picker, e));
      });
    }

    closePickerIfOutside(picker, e) {
      if (picker.hidden) return;
      const trigger = picker._triggerEl || picker.parentElement?.querySelector('[data-sticker-picker-trigger]');
      const path = e.composedPath ? e.composedPath() : [];
      const inside = path.includes(picker) || picker.contains(e.target);
      const onTrigger = trigger && (e.target === trigger || trigger.contains(e.target) || path.includes(trigger));
      if (!inside && !onTrigger) {
        if (picker.dataset.detached) picker.remove(); else picker.hidden = true;
        trigger?.classList.remove('active');
      }
    }

    // Переход в профиль из комментария — сначала закрыть просмотр.
    handleCommentsListClick(e) {
      const personEl = e.target.closest('[data-action="open-profile"]');
      if (personEl && personEl.getAttribute('data-value')) {
        const id = personEl.getAttribute('data-value');
        this.close().then(() => {
          if (window.PublicSite && typeof window.PublicSite.navigateTo === 'function') {
            window.PublicSite.navigateTo(`/profile/${id}`);
          } else {
            window.spaRouter?.navigateTo(`/profile/${id}`);
          }
        });
        return;
      }
      super.handleCommentsListClick(e);
    }

    // Свайп в слайдере: палец справа налево — следующая страница. Пока палец
    // ведёт, кадр едет за ним; вертикальное движение отдаём прокрутке.
    bindSwipe(frame) {
      const track = this.$('track');
      let x0 = 0, y0 = 0, dx = 0, mode = null;
      frame.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1 || !this.isHorizontal()) { mode = 'ignore'; return; }
        x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; mode = null;
        track.style.transition = 'none';
      }, { passive: true });
      frame.addEventListener('touchmove', (e) => {
        if (mode === 'ignore' || e.touches.length !== 1) return;
        const mx = e.touches[0].clientX - x0;
        const my = e.touches[0].clientY - y0;
        if (!mode) {
          if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
          mode = Math.abs(mx) > Math.abs(my) ? 'swipe' : 'ignore';
        }
        if (mode !== 'swipe') return;
        e.preventDefault();
        const pages = this.currentPages().length;
        // На краях — с "резиной", чтобы было видно, что дальше страниц нет.
        const atEdge = (mx > 0 && this.pageIndex === 0) || (mx < 0 && this.pageIndex >= pages - 1);
        dx = atEdge ? mx / 3 : mx;
        track.style.transform = `translateX(${dx}px)`;
      }, { passive: false });
      const end = () => {
        if (mode !== 'swipe') { mode = null; return; }
        mode = null;
        track.style.transition = '';
        track.style.transform = '';
        const threshold = Math.min(80, frame.clientWidth * 0.18);
        if (dx < -threshold) this.step(1, { wrap: false, animate: 'next' });
        else if (dx > threshold) this.step(-1, { wrap: false, animate: 'prev' });
      };
      frame.addEventListener('touchend', end);
      frame.addEventListener('touchcancel', end);
    }

    isOpen() {
      return !!(this.el && !this.el.hidden);
    }

    isHorizontal() {
      return this.folderNavigation || !this.work || this.work.scrollMode !== 'vertical';
    }

    currentPages() {
      return this.work ? this.work.pages : [];
    }

    variantIndexFor(page) {
      if (this.variantChoice.has(page.id)) return this.variantChoice.get(page.id);
      if (this.preferredVariantName) {
        const i = page.variants.findIndex((v) => v.name === this.preferredVariantName);
        if (i >= 0) return i;
      }
      return 0;
    }

    variantOf(page) {
      return page ? page.variants[Math.min(this.variantIndexFor(page), page.variants.length - 1)] : null;
    }

    // Показанная сейчас картинка — выбранная вариация текущей страницы.
    currentImage() {
      return this.variantOf(this.currentPages()[this.pageIndex]);
    }

    /**
     * Открывает работу. opts.imageId — id вариации: сразу на её странице и
     * с ней выбранной (пересланный в статью арт, возврат после правки).
     */
    async openWork(id, opts = {}) {
      this.ensureDom();
      const seq = ++this._openSeq;
      const result = await window.apiClient.getGalleryWork(id);
      if (seq !== this._openSeq) return false;
      if (!result.success) {
        showMessage(errorText(result, 'Не удалось открыть работу'), 'error');
        return false;
      }
      const work = result.data;
      this.folderNavigation = !!opts.folderNavigation;
      this.work = work;
      this.currentSlug = work.id;

      this.pageIndex = 0;
      this.variantChoice = new Map();
      this.preferredVariantName = null;
      if (opts.imageId) {
        work.pages.some((page, p) => {
          const v = page.variants.findIndex((img) => String(img.id) === String(opts.imageId));
          if (v < 0) return false;
          this.pageIndex = p;
          this.variantChoice.set(page.id, v);
          return true;
        });
      }

      // Адрес работы — /gallery/:id (его можно скопировать из строки браузера).
      const workPath = window.PublicSite ? null : `/gallery/${work.id}`;
      if (this.el.hidden) {
        this.el.hidden = false;
        document.body.classList.add('gallery-viewer-open');
        this._histId = window.modalHistory ? window.modalHistory.open(() => this.close({ fromHistory: true }), workPath) : null;
      } else if (workPath && window.location.pathname !== workPath) {
        history.replaceState(history.state || {}, '', workPath);
      }
      this.el.scrollTop = 0;
      this.el.querySelector('.gv-panel').scrollTop = 0;

      this.renderInfo();
      this.renderPages();
      this.resetEngagementUI();
      this.loadEngagement();
      window.apiClient.recordGalleryView(work.id).then((r) => {
        if (r.success && this.work && this.work.id === work.id) {
          this.work.views = r.data.viewsCount;
          const viewsEl = this.$('views');
          if (viewsEl) viewsEl.textContent = String(r.data.viewsCount);
        }
      }).catch(() => {});
      return true;
    }

    async close({ fromHistory = false } = {}) {
      if (!this.el || this.el.hidden) return;
      this.closeAllStickerPickers();
      this.el.hidden = true;
      document.body.classList.remove('gallery-viewer-open');
      this.work = null;
      this.currentSlug = null;
      this.folderNavigation = false;
      this.$('pages').innerHTML = '';
      const hist = this._histId;
      this._histId = null;
      if (hist && !fromHistory && window.modalHistory) await window.modalHistory.close(hist);
    }

    renderInfo() {
      const w = this.work;
      this.$('title').textContent = w.title;
      const badges = [];
      if (w.restricted) badges.push('<span class="gallery-badge gallery-badge-inline"><i class="fas fa-lock"></i> Доступ по ролям</span>');
      if (w.scrollMode === 'vertical' && !this.folderNavigation) badges.push('<span class="gallery-badge gallery-badge-inline"><i class="fas fa-scroll"></i> Вертикальная лента</span>');
      this.$('badges').innerHTML = badges.join('');
      this.$('author').innerHTML = `<span class="antropedia-person" data-action="open-profile" data-value="${w.author.id}" title="Открыть профиль">${window.avatarHtml({ name: w.author.display_name, avatar: w.author.avatar }, 28)} <b>${escapeHtml(w.author.display_name)}</b></span>`;
      const meta = [
        `<span><i class="fas fa-calendar"></i> ${formatDate(w.created_at)}</span>`,
        `<span><i class="fas fa-eye"></i> <span data-gv="views">${w.views || 0}</span></span>`
      ];
      if (w.serverName) meta.push(`<span><i class="fas fa-server"></i> ${escapeHtml(w.serverName)}</span>`);
      this.$('meta').innerHTML = meta.join('');
      const descEl = this.$('desc');
      descEl.innerHTML = '';
      descEl.hidden = !w.description;
      if (w.description) {
        const workId = w.id;
        renderDescriptionHtml(w.description).then((html) => {
          if (!this.work || this.work.id !== workId) return; // успели открыть другую
          descEl.innerHTML = html;
          window.attachBlocksInteractions?.(descEl);
        }).catch(() => { descEl.textContent = w.description; });
      }
      this.$('tags').innerHTML = (w.tags || []).map((t) => `<span class="antropedia-tag-pill" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`).join('');
      this.$('edit').hidden = !w.can_edit || !!w.inFolder || this.folderNavigation;
      this.$('delete').hidden = !w.can_delete;

      this.$('articles-wrap').hidden = !(w.articles && w.articles.length);
      this.$('articles').innerHTML = (w.articles || []).map((a) =>
        `<a href="#" class="gv-article-link" data-slug="${escapeHtml(a.slug)}"><i class="far fa-file-lines"></i> ${escapeHtml(a.title)}</a>`).join('');
      this.$('associated-wrap').hidden = !(w.associated && w.associated.length);
      this.$('associated').innerHTML = (w.associated || []).map((a) => cardHtml(a, { compact: true })).join('');
    }

    // Чипы вариаций одной страницы — имена, введённые автором; 🔒 — у
    // вариации свои роли на просмотр (видна не всем).
    variantChipsHtml(page) {
      if (!page || page.variants.length < 2) return '';
      const active = Math.min(this.variantIndexFor(page), page.variants.length - 1);
      return page.variants.map((v, i) =>
        `<button type="button" class="gv-variant${i === active ? ' active' : ''}" data-variant-index="${i}" title="${escapeHtml(v.name)}">${v.restricted ? '<i class="fas fa-lock"></i> ' : ''}${escapeHtml(v.name)}</button>`
      ).join('');
    }

    selectVariant(pageIndex, variantIndex) {
      const page = this.currentPages()[pageIndex];
      if (!page || !page.variants[variantIndex]) return;
      this.variantChoice.set(page.id, variantIndex);
      this.preferredVariantName = page.variants[variantIndex].name;
      if (this.isHorizontal()) {
        this.showPage(this.pageIndex);
        // Миниатюра в полосе — тоже выбранной вариации.
        const thumb = this.$('strip').querySelector(`[data-page-index="${pageIndex}"] img`);
        if (thumb) thumb.src = page.variants[variantIndex].thumb;
      } else {
        const block = this.$('pages').querySelector(`[data-page-index="${pageIndex}"]`);
        if (block) block.outerHTML = this.pageBlockHtml(page, pageIndex);
      }
    }

    pageBlockHtml(page, i) {
      const img = this.variantOf(page);
      // Мелкие картинки не растягиваем шире их собственного размера.
      const style = img.width && img.height ? ` style="aspect-ratio:${img.width} / ${img.height};max-width:min(100%, 900px, ${img.width}px)"` : '';
      const chips = this.variantChipsHtml(page);
      return `<div class="gv-page-block" data-page-index="${i}">`
        + (chips ? `<div class="gv-variants gv-page-variants">${chips}</div>` : '')
        + `<img class="gv-page" src="${escapeHtml(img.url)}" alt="Страница ${i + 1}" loading="${i < 2 ? 'eager' : 'lazy'}" decoding="async"${style}>`
        + '</div>';
    }

    renderPages() {
      const pages = this.currentPages();
      const horizontal = this.isHorizontal();
      this.el.classList.toggle('gv-mode-vertical', !horizontal);
      this.el.classList.toggle('gv-single', pages.length < 2);
      this.$('frame').hidden = !horizontal;
      this.$('strip').hidden = !horizontal || pages.length < 2;
      this.$('pages').hidden = horizontal;
      this.$('variants').innerHTML = '';

      if (!pages.length) {
        this.$('counter').textContent = '';
        this.$('image').removeAttribute('src');
        this.$('pages').innerHTML = '<div class="gv-no-pages">Вам пока не доступна ни одна страница этой работы</div>';
        this.$('frame').hidden = true;
        this.$('pages').hidden = false;
        return;
      }

      if (horizontal) {
        this.$('pages').innerHTML = '';
        this.$('strip').innerHTML = pages.map((page, i) => {
          const img = this.variantOf(page);
          return `<button type="button" class="gv-thumb" data-page-index="${i}"><img src="${escapeHtml(img.thumb)}" alt="" loading="lazy">${page.variants.length > 1 ? '<i class="fas fa-layer-group gv-thumb-layers"></i>' : ''}</button>`;
        }).join('');
        this.showPage(this.pageIndex);
      } else {
        this.$('counter').textContent = `${pages.length} ${plural(pages.length, 'страница', 'страницы', 'страниц')}`;
        this.$('pages').innerHTML = pages.map((page, i) => this.pageBlockHtml(page, i)).join('');
        // Пересланная в статью страница — сразу к ней.
        if (this.pageIndex > 0) {
          const target = this.$('pages').children[this.pageIndex];
          requestAnimationFrame(() => target?.scrollIntoView({ block: 'start' }));
        }
      }
    }

    showPage(index, { animate } = {}) {
      const pages = this.currentPages();
      if (!pages.length) return;
      this.pageIndex = Math.max(0, Math.min(index, pages.length - 1));
      const img = this.variantOf(pages[this.pageIndex]);
      this.$('variants').innerHTML = this.variantChipsHtml(pages[this.pageIndex]);
      const imageEl = this.$('image');
      imageEl.src = img.url;
      imageEl.alt = `${this.work.title} — ${this.pageIndex + 1}`;
      if (animate) {
        imageEl.classList.remove('gv-in-next', 'gv-in-prev');
        void imageEl.offsetWidth;
        imageEl.classList.add(animate === 'next' ? 'gv-in-next' : 'gv-in-prev');
      }
      this.$('counter').textContent = pages.length > 1 ? `${this.pageIndex + 1} / ${pages.length}` : '';
      this.$('prev').hidden = this.pageIndex === 0;
      this.$('next').hidden = this.pageIndex >= pages.length - 1;
      this.syncFolderNavigation();
      this.$('strip').querySelectorAll('.gv-thumb').forEach((t, i) => t.classList.toggle('active', i === this.pageIndex));
      this.$('strip').querySelector('.gv-thumb.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
      // Соседние страницы — заранее, чтобы листание было мгновенным.
      [pages[this.pageIndex + 1], pages[this.pageIndex - 1]].forEach((p) => {
        if (p) { const pre = new Image(); pre.src = this.variantOf(p).url; }
      });
    }

    step(delta, { wrap = false, animate } = {}) {
      if (!this.isHorizontal()) return;
      if (this.folderNavigation) {
        window.galleryManager?.navigateFolderWork(this.work?.id, delta);
        return;
      }
      const pages = this.currentPages();
      if (pages.length < 2) return;
      let next = this.pageIndex + delta;
      if (next < 0 || next >= pages.length) {
        if (!wrap) return;
        next = (next + pages.length) % pages.length;
      }
      this.showPage(next, { animate: animate || (delta > 0 ? 'next' : 'prev') });
    }

    syncFolderNavigation() {
      if (!this.folderNavigation || !this.work) return;
      const position = window.galleryManager?.getFolderWorkPosition(this.work.id);
      if (!position) {
        this.$('prev').hidden = true;
        this.$('next').hidden = true;
        this.$('counter').textContent = '';
        return;
      }
      this.$('counter').textContent = `${position.index + 1} / ${position.total}`;
      this.$('prev').hidden = position.index === 0;
      this.$('next').hidden = !position.hasNext;
    }

    async share() {
      if (!this.work) return;
      const url = `${location.origin}/gallery/${this.work.id}`;
      try {
        if (navigator.share && window.matchMedia('(hover: none)').matches) {
          await navigator.share({ title: this.work.title, url });
          return;
        }
        await navigator.clipboard.writeText(url);
        showMessage('Ссылка на работу скопирована', 'success');
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        window.prompt('Ссылка на работу:', url);
      }
    }

    async edit() {
      if (!this.work) return;
      const saved = await window.galleryEditor.open(this.work);
      if (saved) {
        window.galleryManager?.refreshCard(saved);
        this.openWork(saved.id, { imageId: this.currentImage()?.id });
      }
    }

    async remove() {
      if (!this.work) return;
      const work = this.work;
      const ok = await window.confirmDialog.open({
        title: 'Удалить работу?',
        message: `«${work.title}» удалится вместе со всеми страницами, вариациями, лайками и комментариями. Это действие необратимо.`,
        confirmLabel: 'Удалить'
      });
      if (!ok) return;
      const result = await window.apiClient.deleteGalleryWork(work.id);
      if (!result.success) {
        showMessage(errorText(result, 'Не удалось удалить работу'), 'error');
        return;
      }
      await this.close();
      window.galleryManager?.removeCard(work.id);
      await window.galleryManager?.loadFolders();
      // Карточки вне страницы галереи (вкладка «Арты» в профиле, полоса под
      // статьёй) — тоже убираем.
      document.querySelectorAll(`.gallery-card[data-work-id="${work.id}"]`).forEach((el) => el.remove());
      showMessage('Работа удалена', 'success');
    }
  }

  // ========================================================================
  // Страница /gallery — сетка-кладка превью
  // ========================================================================

  class GalleryManager {
    constructor() {
      this.offset = 0;
      this.total = 0;
      this.loading = false;
      this.hasMore = true;
      this.items = [];
      this._observer = null;
      this._resizeHandler = null;
      this._searchDebounce = null;
      this._loadSeq = 0;
      this._loadPromise = null;
      this.columnCount = 0;
      this.folderTree = [];
      this.visibleFolders = [];
      this.activeFolderId = null;
      this.selectMode = false;
      this.selectedWorkIds = new Set();
      this.dragging = null;
      this.folderNameDialogResolve = null;
    }

    async init() {
      this.cleanup();
      this.rootEl = document.getElementById('galleryPage');
      if (!this.rootEl) return;
      this.gridEl = document.getElementById('galleryGrid');
      this.searchEl = document.getElementById('gallerySearch');
      this.sortEl = document.getElementById('gallerySort');
      this.mineBtn = document.getElementById('galleryMineBtn');
      this.tagsEl = document.getElementById('galleryTags');
      this.countEl = document.getElementById('galleryCount');
      this.emptyEl = document.getElementById('galleryEmpty');
      this.loadingEl = document.getElementById('galleryLoadingMore');
      this.sentinelEl = document.getElementById('gallerySentinel');
      this.folderSectionEl = document.getElementById('galleryFolderSection');
      this.folderBreadcrumbEl = document.getElementById('galleryFolderBreadcrumb');
      this.folderMoveMenuEl = document.getElementById('galleryFolderMoveMenu');
      this.folderToolsMenuEl = document.getElementById('galleryFolderToolsMenu');
      this.folderToolsToggleEl = document.getElementById('galleryFolderToolsToggle');
      this.folderCreateButtonEl = document.getElementById('galleryFolderCreate');
      this.toggleSelectButtonEl = document.getElementById('galleryToggleSelect');
      this.selectionActionsEl = document.getElementById('gallerySelectionActions');
      this.folderNameModalEl = document.getElementById('galleryFolderNameModal');
      this.folderNameFormEl = this.folderNameModalEl?.querySelector('form');
      this.folderNameInputEl = document.getElementById('galleryFolderNameInput');
      this.folderNameTitleEl = document.getElementById('galleryFolderNameTitle');
      this.folderNameSubmitEl = this.folderNameFormEl?.querySelector('[data-folder-name-submit]');
      this.activeFolderId = null;
      this.isPublicGallery = this.rootEl.dataset.gallerySurface === 'public';
      this.canManageFolders = !this.isPublicGallery || !!window.authManager?.isAuthenticated?.();
      if (this.isPublicGallery && !this.canManageFolders && this.folderToolsToggleEl) {
        const tools = this.folderToolsToggleEl.closest('.gallery-folder-tools');
        if (tools) tools.hidden = true;
      }
      this.folderUploadInput = document.getElementById('galleryFolderUploadInput');
      this.folderUploading = false;
      this.activeTag = '';
      this.mine = false;

      document.getElementById('galleryUploadBtn')?.addEventListener('click', async () => {
        const activeFolder = this.activeFolderId ? this.findFolder(this.activeFolderId) : null;
        const currentUserId = window.authManager?.getCurrentUser?.()?.id;
        if (activeFolder && Number(activeFolder.ownerId) === Number(currentUserId)) {
          if (!this.folderUploading) this.folderUploadInput?.click();
          return;
        }
        const saved = await window.galleryEditor.open(null);
        if (saved) {
          await this.resetAndLoad();
          window.galleryViewer.openWork(saved.id);
        }
      });
      this.folderUploadInput?.addEventListener('change', async () => {
        const files = Array.from(this.folderUploadInput.files || []);
        this.folderUploadInput.value = '';
        if (files.length) await this.uploadFolderImages(files);
      });
      this.searchEl?.addEventListener('input', () => {
        clearTimeout(this._searchDebounce);
        this._searchDebounce = setTimeout(() => this.resetAndLoad(), 300);
      });
      this.sortEl?.addEventListener('change', () => this.resetAndLoad());
      this.mineBtn?.addEventListener('click', () => {
        this.mine = !this.mine;
        this.mineBtn.classList.toggle('active', this.mine);
        this.resetAndLoad();
      });
      this.tagsEl?.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-tag]');
        if (!chip) return;
        this.activeTag = this.activeTag === chip.dataset.tag ? '' : chip.dataset.tag;
        this.renderTags();
        this.resetAndLoad();
      });
      document.getElementById('galleryFolderCreate')?.addEventListener('click', () => this.createFolder());
      document.getElementById('galleryFolderToolsToggle')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleFolderToolsMenu();
      });
      this.folderToolsMenuEl?.addEventListener('click', (e) => {
        if (e.target.closest('#galleryFolderCreate, #galleryToggleSelect')) this.closeFolderToolsMenu();
      });
      this.folderNameFormEl?.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = this.folderNameInputEl?.value.trim() || '';
        if (!name) {
          this.folderNameInputEl?.focus();
          return;
        }
        this.finishFolderNameDialog(name);
      });
      this.folderNameModalEl?.addEventListener('click', (e) => {
        if (e.target === this.folderNameModalEl || e.target.closest('[data-folder-name-cancel]')) {
          this.finishFolderNameDialog(null);
        }
      });
      this.folderNameModalEl?.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.finishFolderNameDialog(null);
        }
      });
      document.getElementById('galleryToggleSelect')?.addEventListener('click', () => this.setSelectMode(!this.selectMode));
      document.getElementById('galleryCancelSelect')?.addEventListener('click', () => this.setSelectMode(false));
      document.getElementById('gallerySelectAll')?.addEventListener('click', () => this.selectAllVisibleWorks());
      document.getElementById('galleryMoveSelected')?.addEventListener('click', (e) => {
        if (this.selectedWorkIds.size) this.openFolderMoveMenu(e.currentTarget, { workIds: [...this.selectedWorkIds] });
      });
      this.folderBreadcrumbEl?.addEventListener('click', (e) => {
        if (e.target.closest('[data-folder-exit]')) { this.openFolder(null); return; }
        if (e.target.closest('#galleryFolderRename')) { this.renameCurrentFolder(); return; }
        if (e.target.closest('#galleryFolderMove')) {
          if (this.activeFolderId) this.openFolderMoveMenu(e.target.closest('#galleryFolderMove'), { folderId: this.activeFolderId });
          return;
        }
        if (e.target.closest('#galleryFolderDelete')) { this.deleteCurrentFolder(); return; }
        const button = e.target.closest('[data-folder-parent]');
        if (button) this.openFolder(button.dataset.folderParent || null);
      });
      this.folderMoveMenuEl?.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="create-folder-for-selection"]')) {
          const workIds = this.folderMoveState?.workIds || null;
          this.closeFolderMoveMenu();
          this.createFolder(workIds);
          return;
        }
        const item = e.target.closest('[data-action="move-to"]');
        if (!item) return;
        const folderId = item.dataset.folderId || null;
        const moveState = this.folderMoveState;
        this.closeFolderMoveMenu();
        if (moveState?.folderId) this.moveFolderToParent(moveState.folderId, folderId);
        else if (moveState?.workIds?.length) this.moveWorksToFolder(moveState.workIds, folderId);
      });
      this.gridEl.addEventListener('click', (e) => {
        const folderCard = e.target.closest('.gallery-folder-card[data-folder-id]');
        if (folderCard) {
          const folderTrigger = e.target.closest('[data-folder-menu-trigger]');
          if (folderTrigger) {
            e.stopPropagation();
            this.toggleCardActionsMenu(folderCard, folderTrigger);
            return;
          }
          const folderAction = e.target.closest('[data-folder-menu-action]');
          if (folderAction) {
            e.stopPropagation();
            this.handleFolderMenuAction(folderCard.dataset.folderId, folderAction.dataset.folderMenuAction, folderAction);
            return;
          }
          if (e.target.closest('.gallery-folder-open')) this.openFolder(folderCard.dataset.folderId);
          return;
        }
        const menuTrigger = e.target.closest('[data-work-menu-trigger]');
        if (menuTrigger) {
          e.stopPropagation();
          this.toggleCardActionsMenu(menuTrigger.closest('.gallery-card'), menuTrigger);
          return;
        }
        const menuAction = e.target.closest('[data-work-menu-action]');
        if (menuAction) {
          e.stopPropagation();
          this.handleWorkMenuAction(menuAction.closest('.gallery-card')?.dataset.workId, menuAction.dataset.workMenuAction, menuAction);
          return;
        }
        const selectButton = e.target.closest('[data-select-work]');
        if (selectButton) {
          e.stopPropagation();
          this.toggleWorkSelected(selectButton.dataset.selectWork);
          return;
        }
        const card = e.target.closest('[data-work-id]');
        if (!card) return;
        if (this.selectMode) {
          this.toggleWorkSelected(card.dataset.workId);
          return;
        }
        window.galleryViewer.openWork(card.dataset.workId, { folderNavigation: !!this.activeFolderId });
      });
      this.gridEl.addEventListener('keydown', (e) => {
        const folderButton = e.target.closest('.gallery-folder-open');
        if (folderButton && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          this.openFolder(folderButton.closest('.gallery-folder-card')?.dataset.folderId);
          return;
        }
        const card = e.target.closest('[data-work-id]');
        if (!card || e.target.closest('[data-select-work]')) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (this.selectMode) this.toggleWorkSelected(card.dataset.workId);
          else window.galleryViewer.openWork(card.dataset.workId, { folderNavigation: !!this.activeFolderId });
        }
      });
      this.gridEl.addEventListener('dragstart', (e) => {
        const folder = e.target.closest('.gallery-folder-card[data-folder-id]');
        if (folder) {
          const folderData = this.findFolder(folder.dataset.folderId);
          const currentUserId = window.authManager?.getCurrentUser?.()?.id;
          if (!this.canManageFolders || Number(folderData?.ownerId) !== Number(currentUserId) ||
              e.target.closest('[data-folder-menu-trigger], [data-folder-menu-action]')) {
            e.preventDefault();
            return;
          }
          this.dragging = { folderId: folder.dataset.folderId };
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', folder.dataset.folderId);
          folder.classList.add('is-dragging');
          return;
        }
        const card = e.target.closest('.gallery-card[data-work-id]');
        if (!card || e.target.closest('[data-work-menu-trigger], [data-work-menu-action], [data-select-work]') ||
            this.selectMode || card.dataset.draggable !== 'true') {
          e.preventDefault();
          return;
        }
        this.dragging = { workId: card.dataset.workId };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.dataset.workId);
        card.classList.add('is-dragging');
      });
      this.rootEl.addEventListener('dragend', () => {
        this.rootEl.querySelectorAll('.is-dragging, .is-drop-target').forEach((el) => el.classList.remove('is-dragging', 'is-drop-target'));
        this.dragging = null;
      });
      const findDropTarget = (event) => {
        if (!this.dragging) return null;
        const target = event.target.closest('.gallery-folder-card[data-folder-id], [data-folder-parent]');
        if (!target) return null;
        const targetFolderId = target.dataset.folderId || target.dataset.folderParent;
        if (this.isPublicGallery && targetFolderId) {
          const currentUserId = window.authManager?.getCurrentUser?.()?.id;
          const folder = this.findFolder(targetFolderId);
          if (!folder || Number(folder.ownerId) !== Number(currentUserId)) return null;
        }
        if (this.dragging.folderId && String(target.dataset.folderId || '') === String(this.dragging.folderId)) return null;
        return target;
      };
      this.rootEl.addEventListener('dragover', (e) => {
        const target = findDropTarget(e);
        if (!target) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        target.classList.add('is-drop-target');
      });
      this.rootEl.addEventListener('dragleave', (e) => {
        const target = findDropTarget(e);
        if (target && !target.contains(e.relatedTarget)) target.classList.remove('is-drop-target');
      });
      this.rootEl.addEventListener('drop', (e) => {
        const target = findDropTarget(e);
        if (!target) return;
        e.preventDefault();
        target.classList.remove('is-drop-target');
        const drag = this.dragging;
        this.dragging = null;
        const folderId = target.dataset.folderId || target.dataset.folderParent || null;
        if (drag.folderId) this.moveFolderToParent(drag.folderId, folderId);
        else if (drag.workId) this.moveWorksToFolder([drag.workId], folderId);
      });
      this.rootEl.addEventListener('click', (e) => {
        if (!e.target.closest('#galleryFolderToolsMenu, #galleryFolderToolsToggle')) this.closeFolderToolsMenu();
        if (!e.target.closest('.gallery-card-actions-menu, [data-work-menu-trigger], [data-folder-menu-trigger]')) {
          this.closeCardActionsMenus();
        }
        if (!this.folderMoveMenuEl || this.folderMoveMenuEl.hidden || e.target.closest('#galleryFolderMoveMenu')) return;
        if (e.target.closest('#galleryMoveSelected, #galleryFolderMove, [data-work-menu-action="move"], [data-folder-menu-action="move"]')) return;
        this.closeFolderMoveMenu();
      });
      this.rootEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (this.folderToolsMenuEl && !this.folderToolsMenuEl.hidden) {
          e.preventDefault();
          this.closeFolderToolsMenu();
          document.getElementById('galleryFolderToolsToggle')?.focus();
          return;
        }
        const openMenu = this.rootEl.querySelector('.gallery-card-actions-menu:not([hidden])');
        if (!openMenu) return;
        e.preventDefault();
        const trigger = openMenu.closest('.gallery-card, .gallery-folder-card')
          ?.querySelector('[data-work-menu-trigger], [data-folder-menu-trigger]');
        this.closeCardActionsMenus();
        trigger?.focus();
      });

      this._resizeHandler = () => {
        if (this.computeColumnCount() !== this.columnCount) this.layout();
      };
      window.addEventListener('resize', this._resizeHandler);
      this._observer = new IntersectionObserver((entries) => {
        if (entries.some((en) => en.isIntersecting)) this.loadMore();
      }, { rootMargin: '600px 0px' });
      if (this.sentinelEl) this._observer.observe(this.sentinelEl);

      this.loadTags();
      if (this.isPublicGallery || this.canManageFolders) await this.loadFolders();
      else if (this.folderSectionEl) this.folderSectionEl.hidden = true;
      await this.resetAndLoad();
    }

    cleanup() {
      if (this._observer) { this._observer.disconnect(); this._observer = null; }
      if (this._resizeHandler) { window.removeEventListener('resize', this._resizeHandler); this._resizeHandler = null; }
      clearTimeout(this._searchDebounce);
      this.closeFolderMoveMenu();
      this.closeFolderToolsMenu();
      this.setSelectMode(false);
      this.finishFolderNameDialog(null);
      this._loadSeq++;
      this.loading = false;
      this._loadPromise = null;
    }

    async loadTags() {
      try {
        const result = await window.apiClient.getGalleryTags();
        this.tags = result.success && Array.isArray(result.data) ? result.data : [];
      } catch (e) {
        this.tags = [];
      }
      this.renderTags();
    }

    renderTags() {
      if (!this.tagsEl) return;
      const tags = (this.tags || []).slice(0, 30);
      if (this.activeTag && !tags.some((t) => t.name.toLowerCase() === this.activeTag.toLowerCase())) {
        tags.unshift({ name: this.activeTag, count: 0 });
      }
      this.tagsEl.innerHTML = tags.length
        ? `<button type="button" class="filter-chip${this.activeTag ? '' : ' active'}" data-tag="">Всё</button>` +
          tags.map((t) => `<button type="button" class="filter-chip${t.name.toLowerCase() === this.activeTag.toLowerCase() && this.activeTag ? ' active' : ''}" data-tag="${escapeHtml(t.name)}">#${escapeHtml(t.name)}</button>`).join('')
        : '';
    }

    filterByTag(tag) {
      this.activeTag = tag || '';
      this.renderTags();
      this.resetAndLoad();
    }

    async loadFolders() {
      if (!this.isPublicGallery && !this.canManageFolders) {
        if (this.folderSectionEl) this.folderSectionEl.hidden = true;
        return false;
      }
      try {
        const result = this.isPublicGallery
          ? await window.apiClient.getPublicGalleryFolders()
          : await window.apiClient.getGalleryFolders();
        if (!result.success || !Array.isArray(result.data)) {
          showMessage(errorText(result, 'Не удалось загрузить папки галереи'), 'error');
          return false;
        }
        this.folderTree = result.data;
        this.renderFolders();
        return true;
      } catch (e) {
        showMessage('Не удалось загрузить папки галереи', 'error');
        return false;
      }
    }

    findFolder(id, folders = this.folderTree) {
      for (const folder of folders) {
        if (String(folder.id) === String(id)) return folder;
        const child = this.findFolder(id, folder.children || []);
        if (child) return child;
      }
      return null;
    }

    buildFolderIndex() {
      const byId = new Map();
      const children = new Map();
      const flat = [];
      const walk = (folders, parentId = null, depth = 0) => folders.forEach((folder) => {
        const id = String(folder.id);
        byId.set(id, folder);
        if (!children.has(parentId || '')) children.set(parentId || '', []);
        children.get(parentId || '').push(folder);
        flat.push({ folder, depth });
        walk(folder.children || [], id, depth + 1);
      });
      walk(this.folderTree);
      const descendants = (folderId) => {
        const result = new Set([String(folderId)]);
        const addChildren = (id) => (children.get(String(id)) || []).forEach((folder) => {
          if (result.has(String(folder.id))) return;
          result.add(String(folder.id));
          addChildren(folder.id);
        });
        addChildren(folderId);
        return result;
      };
      return { byId, children, flat, descendants };
    }

    renderFolders() {
      if (!this.folderSectionEl) return;
      const current = this.activeFolderId ? this.findFolder(this.activeFolderId) : null;
      if (this.activeFolderId && !current) this.activeFolderId = null;
      const active = this.activeFolderId ? this.findFolder(this.activeFolderId) : null;
      const breadcrumb = [];
      let parent = active;
      while (parent) {
        breadcrumb.unshift(parent);
        parent = parent.parentId ? this.findFolder(parent.parentId) : null;
      }
      const currentUserId = window.authManager?.getCurrentUser?.()?.id;
      const isForeignFolder = !!(active && Number(active.ownerId) !== Number(currentUserId));
      const activeAuthor = active?.author?.display_name || '';
      this.folderBreadcrumbEl.innerHTML = [
        '<button type="button" class="gallery-folder-crumb-root" data-folder-parent="">Галерея</button>',
        ...breadcrumb.slice(0, -1).map((folder) => `<span aria-hidden="true">/</span><button type="button" data-folder-parent="${folder.id}">${escapeHtml(folder.name)}</button>`),
        ...(active ? [
          '<span aria-hidden="true">/</span>',
          `<span class="gallery-folder-crumb-current">${escapeHtml(active.name)}</span>`,
          ...(activeAuthor ? [`<span class="gallery-folder-crumb-author">Автор: ${escapeHtml(activeAuthor)}</span>`] : []),
          ...(isForeignFolder ? ['<button type="button" class="gallery-folder-exit" data-folder-exit><i class="fas fa-arrow-left"></i> Выйти из папки</button>'] : []),
          ...(!isForeignFolder && this.canManageFolders ? [
            '<button type="button" class="gallery-folder-crumb-action" id="galleryFolderRename" title="Переименовать папку" aria-label="Переименовать папку"><i class="fas fa-pen"></i></button>',
            '<button type="button" class="gallery-folder-crumb-action" id="galleryFolderMove" title="Переместить папку" aria-label="Переместить папку"><i class="fas fa-share"></i></button>',
            '<button type="button" class="gallery-folder-crumb-action is-danger" id="galleryFolderDelete" title="Удалить папку" aria-label="Удалить папку"><i class="fas fa-trash"></i></button>'
          ] : [])
        ] : [])
      ].join('');
      const children = active
        ? (active.children || [])
        : this.folderTree;
      this.visibleFolders = children;
      const canManageActive = !active || (this.canManageFolders && Number(active.ownerId) === Number(currentUserId));
      if (this.folderCreateButtonEl) this.folderCreateButtonEl.hidden = !canManageActive;
      if (this.toggleSelectButtonEl) this.toggleSelectButtonEl.hidden = !canManageActive;
      if (this.mineBtn) {
        this.mineBtn.disabled = !!active;
        this.mineBtn.classList.toggle('active', !!active || this.mine);
      }
      const uploadLabel = document.querySelector('#galleryUploadBtn .antropedia-btn-label');
      const canUploadToActive = active && this.canManageFolders && Number(active.ownerId) === Number(currentUserId);
      if (uploadLabel && !this.folderUploading) {
        uploadLabel.textContent = canUploadToActive ? 'Добавить изображения' : 'Выложить работу';
      }
      const tools = this.folderToolsToggleEl?.closest('.gallery-folder-tools');
      if (tools && this.isPublicGallery) tools.hidden = !this.canManageFolders || !canManageActive;
      this.folderSectionEl.hidden = false;
      this.updateSelectionUi();
      if (this.items.length) this.layout();
    }

    folderCardHtml(folder) {
      const previewImages = Array.isArray(folder.preview)
        ? folder.preview.filter((image) => typeof image?.url === 'string' && image.url.trim())
        : [];
      const previewMarkup = previewImages.length
        ? previewImages.slice(0, 3).map((image, index) => `<img class="gallery-folder-preview-image gallery-folder-preview-image-${index + 1}" src="${escapeHtml(image.url)}" alt="" loading="lazy" decoding="async">`).join('')
        : '<i class="fas fa-folder"></i>';
      const currentUser = window.authManager?.getCurrentUser?.();
      const currentUserId = currentUser?.id;
      const isOwner = this.canManageFolders && Number(folder.ownerId) === Number(currentUserId);
      const author = folder.author || (isOwner ? {
        display_name: currentUser.display_name || currentUser.username,
        avatar: currentUser.avatar
      } : null);
      return `
        <div class="gallery-folder-card" data-folder-id="${folder.id}" draggable="${isOwner ? 'true' : 'false'}">
          <button type="button" class="gallery-folder-open" aria-label="Открыть папку «${escapeHtml(folder.name)}»">
            <span class="gallery-folder-preview" aria-hidden="true">${previewMarkup}</span>
            <span class="gallery-folder-card-info">
              <span class="gallery-card-title gallery-folder-name">${escapeHtml(folder.name)}</span>
              ${author ? `<span class="gallery-card-author">${window.avatarHtml({ name: author.display_name, avatar: author.avatar }, 18)} ${escapeHtml(author.display_name)}</span>` : ''}
              <span class="gallery-folder-count">${folder.imageCount} ${plural(folder.imageCount, 'изображение', 'изображения', 'изображений')}</span>
            </span>
          </button>
          ${isOwner ? `<button type="button" class="gallery-folder-menu-trigger" data-folder-menu-trigger aria-label="Действия с папкой «${escapeHtml(folder.name)}»" aria-haspopup="menu" aria-expanded="false"><i class="fas fa-ellipsis"></i></button>
          <div class="gallery-card-actions-menu" role="menu" hidden>
            <button type="button" role="menuitem" data-folder-menu-action="rename"><i class="fas fa-pen"></i> Переименовать</button>
            <button type="button" role="menuitem" data-folder-menu-action="move"><i class="fas fa-folder"></i> Переместить</button>
            <button type="button" role="menuitem" data-folder-menu-action="delete" class="is-danger"><i class="fas fa-trash"></i> Удалить</button>
          </div>` : ''}
        </div>`;
    }

    async openFolder(id) {
      this.activeFolderId = id ? String(id) : null;
      this.setSelectMode(false);
      this.renderFolders();
      await this.resetAndLoad();
    }

    async createFolder(workIds = null) {
      if (!this.canManageFolders) return;
      const name = await this.openFolderNameDialog({
        title: this.activeFolderId ? 'Новая подпапка' : 'Новая папка',
        submitLabel: 'Создать'
      });
      if (name == null) return;
      try {
        const result = await window.apiClient.createGalleryFolder(name, this.activeFolderId);
        if (!result.success) {
          showMessage(errorText(result, 'Не удалось создать папку'), 'error');
          return;
        }
        await this.loadFolders();
        if (workIds && workIds.length) {
          this.activeFolderId = String(result.data.id);
          this.renderFolders();
          await this.moveWorksToFolder(workIds, result.data.id);
          return;
        }
        await this.openFolder(result.data.id);
        showMessage('Папка создана', 'success');
      } catch (e) {
        showMessage('Не удалось создать папку', 'error');
      }
    }

    openFolderNameDialog({ title, submitLabel, value = '' }) {
      if (!this.folderNameModalEl || !this.folderNameFormEl || !this.folderNameInputEl) return Promise.resolve(null);
      this.finishFolderNameDialog(null);
      this.folderNameTitleEl.textContent = title;
      this.folderNameSubmitEl.textContent = submitLabel;
      this.folderNameInputEl.value = value;
      this.folderNameModalEl.hidden = false;
      this.folderNameInputEl.focus();
      this.folderNameInputEl.select();
      return new Promise((resolve) => {
        this.folderNameDialogResolve = resolve;
      });
    }

    finishFolderNameDialog(value) {
      if (!this.folderNameModalEl || this.folderNameModalEl.hidden) return;
      this.folderNameModalEl.hidden = true;
      const resolve = this.folderNameDialogResolve;
      this.folderNameDialogResolve = null;
      resolve?.(value);
    }

    toggleFolderToolsMenu() {
      const menu = this.folderToolsMenuEl;
      const trigger = document.getElementById('galleryFolderToolsToggle');
      if (!menu || !trigger) return;
      const open = menu.hidden;
      this.closeFolderToolsMenu();
      menu.hidden = !open;
      trigger.setAttribute('aria-expanded', String(open));
      if (open) menu.querySelector('button:not([hidden])')?.focus();
    }

    closeFolderToolsMenu() {
      if (this.folderToolsMenuEl) this.folderToolsMenuEl.hidden = true;
      document.getElementById('galleryFolderToolsToggle')?.setAttribute('aria-expanded', 'false');
    }

    toggleCardActionsMenu(card, trigger) {
      if (!card || !trigger) return;
      const menu = card.querySelector('.gallery-card-actions-menu');
      if (!menu) return;
      const shouldOpen = menu.hidden;
      this.closeCardActionsMenus();
      menu.hidden = !shouldOpen;
      trigger.setAttribute('aria-expanded', String(shouldOpen));
      if (shouldOpen) menu.querySelector('button')?.focus();
    }

    closeCardActionsMenus() {
      this.rootEl?.querySelectorAll('.gallery-card-actions-menu:not([hidden])').forEach((menu) => {
        menu.hidden = true;
        menu.closest('.gallery-card, .gallery-folder-card')
          ?.querySelector('[data-work-menu-trigger], [data-folder-menu-trigger]')
          ?.setAttribute('aria-expanded', 'false');
      });
    }

    async handleWorkMenuAction(workId, action, menuItem) {
      const work = this.items.find((item) => String(item.id) === String(workId));
      if (!work) return;
      this.closeCardActionsMenus();
      if (action === 'move') {
        this.openFolderMoveMenu(menuItem, { workIds: [String(workId)] });
        return;
      }
      const opened = await window.galleryViewer.openWork(workId);
      if (!opened) return;
      if (action === 'edit') await window.galleryViewer.edit();
      else if (action === 'delete') await window.galleryViewer.remove();
    }

    handleFolderMenuAction(folderId, action, menuItem) {
      this.closeCardActionsMenus();
      if (action === 'rename') this.renameFolder(folderId);
      else if (action === 'move') this.openFolderMoveMenu(menuItem, { folderId });
      else if (action === 'delete') this.deleteFolder(folderId);
    }

    async renameCurrentFolder() {
      return this.renameFolder(this.activeFolderId);
    }

    async renameFolder(folderId) {
      const folder = this.findFolder(folderId);
      if (!folder) return;
      const name = await this.openFolderNameDialog({
        title: 'Переименовать папку',
        submitLabel: 'Сохранить',
        value: folder.name
      });
      if (name == null) return;
      try {
        const result = await window.apiClient.renameGalleryFolder(folder.id, name);
        if (!result.success) {
          showMessage(errorText(result, 'Не удалось переименовать папку'), 'error');
          return;
        }
        await this.loadFolders();
        await this.resetAndLoad();
        showMessage('Папка переименована', 'success');
      } catch (e) {
        showMessage('Не удалось переименовать папку', 'error');
      }
    }

    async deleteCurrentFolder() {
      return this.deleteFolder(this.activeFolderId);
    }

    async deleteFolder(folderId) {
      const folder = this.findFolder(folderId);
      if (!folder) return;
      const ok = await window.confirmDialog.open({
        title: 'Удалить папку?',
        message: 'Подпапки и работы будут перемещены на уровень выше. Изображения не удалятся.',
        confirmLabel: 'Удалить'
      });
      if (!ok) return;
      try {
        const result = await window.apiClient.deleteGalleryFolder(folder.id);
        if (!result.success) {
          showMessage(errorText(result, 'Не удалось удалить папку'), 'error');
          return;
        }
        if (String(this.activeFolderId || '') === String(folder.id)) {
          this.activeFolderId = folder.parentId ? String(folder.parentId) : null;
        }
        await this.loadFolders();
        await this.resetAndLoad();
        showMessage('Папка удалена', 'success');
      } catch (e) {
        showMessage('Не удалось удалить папку', 'error');
      }
    }

    openFolderMoveMenu(anchor, { workIds = null, folderId = null } = {}) {
      const menu = this.folderMoveMenuEl;
      if (!menu || (!folderId && !workIds?.length)) return;
      const tree = this.buildFolderIndex();
      const excluded = folderId ? tree.descendants(folderId) : new Set();
      let currentFolderId;
      if (folderId) {
        currentFolderId = tree.byId.get(String(folderId))?.parentId || '';
      } else {
        const current = new Set((workIds || []).map((id) => {
          const work = this.items.find((item) => String(item.id) === String(id));
          return work?.folder_id ? String(work.folder_id) : '';
        }));
        if (current.size === 1) currentFolderId = [...current][0];
      }
      const itemHtml = (id, label, depth = 0) => `
        <button type="button" class="gallery-folder-move-item${String(currentFolderId) === String(id) ? ' is-current' : ''}" role="menuitem" data-action="move-to" data-folder-id="${escapeHtml(id)}" style="padding-left:${10 + depth * 16}px">
          <i class="${id ? 'fas fa-folder' : 'fas fa-home'}"></i><span>${escapeHtml(label)}</span>${String(currentFolderId) === String(id) ? '<i class="fas fa-check gallery-folder-move-check"></i>' : ''}
        </button>`;
      const currentUserId = window.authManager?.getCurrentUser?.()?.id;
      const destinationFolders = this.isPublicGallery
        ? tree.flat.filter(({ folder }) => Number(folder.ownerId) === Number(currentUserId))
        : tree.flat;
      menu.innerHTML = `
        <div class="gallery-folder-move-title">${folderId ? 'Переместить папку в' : 'Перенести в папку'}</div>
        ${itemHtml('', folderId ? 'Верхний уровень' : 'Без папки')}
        ${destinationFolders.filter(({ folder }) => !excluded.has(String(folder.id))).map(({ folder, depth }) => itemHtml(folder.id, folder.name, depth + 1)).join('')}
        ${folderId ? '' : '<button type="button" class="gallery-folder-move-item is-new" data-action="create-folder-for-selection"><i class="fas fa-folder-plus"></i><span>Новая папка...</span></button>'}`;
      this.folderMoveState = folderId
        ? { folderId: String(folderId) }
        : { workIds: workIds.map(String) };
      const sectionRect = this.folderSectionEl.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      menu.hidden = false;
      menu.style.top = `${anchorRect.bottom - sectionRect.top + this.folderSectionEl.scrollTop + 4}px`;
      menu.style.left = `${Math.max(8, Math.min(anchorRect.left - sectionRect.left, this.folderSectionEl.clientWidth - menu.offsetWidth - 8))}px`;
      menu.querySelector('[data-action="move-to"]')?.focus();
    }

    closeFolderMoveMenu() {
      if (this.folderMoveMenuEl) this.folderMoveMenuEl.hidden = true;
      this.folderMoveState = null;
    }

    async moveWorksToFolder(workIds, folderId) {
      try {
        const result = await window.apiClient.setGalleryWorksFolder(workIds, folderId);
        if (!result.success) {
          showMessage(errorText(result, 'Не удалось переместить работы'), 'error');
          await this.resetAndLoad();
          return;
        }
        this.setSelectMode(false);
        await this.loadFolders();
        await this.resetAndLoad();
        showMessage(`Перемещено работ: ${result.data.moved ?? workIds.length}`, 'success');
      } catch (e) {
        showMessage('Не удалось переместить работы', 'error');
        await this.resetAndLoad();
      }
    }

    async moveFolderToParent(folderId, parentId) {
      const tree = this.buildFolderIndex();
      const folder = tree.byId.get(String(folderId));
      if (!folder) return;
      const target = parentId ? tree.byId.get(String(parentId)) : null;
      if (parentId && !target) {
        showMessage('Папка назначения не найдена', 'error');
        return;
      }
      if (String(folder.parentId || '') === String(parentId || '')) return;
      if (parentId && tree.descendants(folderId).has(String(parentId))) {
        showMessage('Нельзя переместить папку в неё саму или во вложенную в неё папку', 'warning');
        return;
      }
      try {
        const result = await window.apiClient.moveGalleryFolder(folderId, parentId);
        if (!result.success) {
          showMessage(errorText(result, 'Не удалось переместить папку'), 'error');
          return;
        }
        await this.loadFolders();
        this.renderFolders();
        showMessage(`Папка «${folder.name}» перемещена`, 'success');
      } catch (e) {
        showMessage('Не удалось переместить папку', 'error');
      }
    }

    setSelectMode(on) {
      this.selectMode = !!on;
      this.selectedWorkIds = new Set();
      this.updateSelectionUi();
      if (this.gridEl) {
        this.gridEl.classList.toggle('is-selecting', this.selectMode);
        this.gridEl.querySelectorAll('.gallery-card[data-work-id]').forEach((card) => {
          card.classList.remove('is-selected');
          card.draggable = !this.selectMode && card.dataset.draggable === 'true';
        });
      }
    }

    toggleWorkSelected(workId) {
      const work = this.items.find((item) => String(item.id) === String(workId));
      const userId = window.authManager?.getCurrentUser?.()?.id;
      if (!work || String(work.author_id) !== String(userId)) return;
      if (this.selectedWorkIds.has(String(workId))) this.selectedWorkIds.delete(String(workId));
      else if (this.selectedWorkIds.size < 100) this.selectedWorkIds.add(String(workId));
      else {
        showMessage('За один раз можно выбрать не больше 100 работ', 'warning');
        return;
      }
      this.updateSelectionUi();
    }

    selectAllVisibleWorks() {
      const userId = window.authManager?.getCurrentUser?.()?.id;
      let omitted = 0;
      this.items.forEach((work) => {
        if (String(work.author_id) !== String(userId) || this.selectedWorkIds.has(String(work.id))) return;
        if (this.selectedWorkIds.size < 100) this.selectedWorkIds.add(String(work.id));
        else omitted++;
      });
      this.updateSelectionUi();
      if (omitted) showMessage('Выбраны первые 100 загруженных работ', 'warning');
    }

    updateSelectionUi() {
      const toggle = document.getElementById('galleryToggleSelect');
      if (toggle) {
        toggle.classList.toggle('active', this.selectMode);
        toggle.innerHTML = this.selectMode
          ? '<i class="fas fa-times"></i> Отменить выбор'
          : '<i class="far fa-check-square"></i> Выбрать работы';
      }
      if (this.selectionActionsEl) this.selectionActionsEl.hidden = !this.selectMode;
      const count = document.getElementById('gallerySelectionCount');
      if (count) count.textContent = this.selectedWorkIds.size
        ? `Выбрано: ${this.selectedWorkIds.size}`
        : 'Нажмите на свои работы для выбора';
      const move = document.getElementById('galleryMoveSelected');
      if (move) move.disabled = this.selectedWorkIds.size === 0;
      if (this.gridEl) {
        this.gridEl.classList.toggle('is-selecting', this.selectMode);
        this.gridEl.querySelectorAll('.gallery-card[data-work-id]').forEach((card) => {
          const selected = this.selectedWorkIds.has(String(card.dataset.workId));
          card.classList.toggle('is-selected', selected);
          const icon = card.querySelector('.gallery-card-select i');
          if (icon) icon.className = selected ? 'fas fa-check' : 'fas fa-plus';
        });
      }
    }

    async uploadFolderImages(files) {
      const folderId = this.activeFolderId;
      if (!folderId || this.folderUploading) return;
      const uploadButton = document.getElementById('galleryUploadBtn');
      const uploadLabel = uploadButton?.querySelector('.antropedia-btn-label');
      const folderButtons = this.folderSectionEl?.querySelectorAll('button') || [];
      this.folderUploading = true;
      if (uploadButton) uploadButton.disabled = true;
      folderButtons.forEach((button) => { button.disabled = true; });
      this.folderSectionEl?.setAttribute('aria-busy', 'true');
      if (uploadLabel) uploadLabel.textContent = `Загрузка 0/${files.length}`;

      let uploaded = 0;
      const failures = [];
      try {
        for (const [index, file] of files.entries()) {
          if (uploadLabel) uploadLabel.textContent = `Загрузка ${index + 1}/${files.length}`;
          const title = String(file.name || 'Изображение')
            .replace(/\.[^.]+$/, '')
            .trim()
            .slice(0, 200) || 'Изображение';
          let workId = null;
          let imageUploaded = false;
          try {
            const created = await window.apiClient.createGalleryWork({
              title,
              description: '',
              tags: [],
              scrollMode: 'horizontal',
              serverId: null,
              roles: [],
              articleSlugs: [],
              associatedIds: []
            });
            if (!created.success || !created.data?.id) {
              throw new Error(errorText(created, 'Не удалось создать работу'));
            }
            workId = created.data.id;
            const result = await window.apiClient.uploadGalleryImages(workId, null, [file]);
            if (!result.success) {
              throw new Error(errorText(result, 'Не удалось загрузить изображение'));
            }
            imageUploaded = true;
            const moved = await window.apiClient.setGalleryWorkFolder(workId, folderId);
            if (!moved.success) {
              throw new Error(`Изображение загружено, но не удалось добавить его в папку: ${errorText(moved, 'ошибка перемещения')}`);
            }
            uploaded++;
          } catch (error) {
            if (workId && !imageUploaded) {
              try {
                const cleanup = await window.apiClient.deleteGalleryWork(workId);
                if (!cleanup.success) {
                  failures.push(`${file.name}: ${error.message}; не удалось удалить незавершённую работу`);
                  continue;
                }
              } catch (cleanupError) {
                failures.push(`${file.name}: ${error.message}; не удалось удалить незавершённую работу: ${cleanupError.message}`);
                continue;
              }
            }
            failures.push(`${file.name}: ${error.message || 'ошибка загрузки'}`);
          }
        }
      } finally {
        this.folderUploading = false;
        if (uploadButton) uploadButton.disabled = false;
        folderButtons.forEach((button) => { button.disabled = false; });
        this.folderSectionEl?.removeAttribute('aria-busy');
        if (uploadLabel) uploadLabel.textContent = this.activeFolderId ? 'Добавить изображения' : 'Выложить работу';
      }

      await this.loadFolders();
      if (this.activeFolderId === folderId) await this.resetAndLoad();
      if (failures.length) {
        const details = failures.slice(0, 3).join('\n');
        const remainder = failures.length > 3 ? `\nИ ещё ошибок: ${failures.length - 3}` : '';
        showMessage(`Добавлено в папку ${uploaded} из ${files.length}. Ошибки:\n${details}${remainder}`, 'warning');
      } else {
        showMessage(`Добавлено в папку изображений: ${uploaded}`, 'success');
      }
    }

    getFilters() {
      const me = window.authManager?.getCurrentUser?.();
      return {
        q: this.searchEl ? this.searchEl.value.trim() : '',
        sort: this.sortEl ? this.sortEl.value : 'newest',
        tag: this.activeTag,
        author: this.activeFolderId
          ? (!this.isPublicGallery && me ? me.id : '')
          : (this.mine && me ? me.id : ''),
        ...((this.isPublicGallery && !this.activeFolderId)
          ? { excludeFolderedWorks: '1' }
          : {}),
        ...((this.activeFolderId || !this.isPublicGallery)
          ? { folder: this.activeFolderId || 'root' }
          : {})
      };
    }

    async resetAndLoad() {
      this._loadSeq++;
      this._loadPromise = null;
      if (this.selectMode || this.selectedWorkIds.size) this.setSelectMode(false);
      this.offset = 0;
      this.total = 0;
      this.hasMore = true;
      this.loading = false;
      this.items = [];
      this.layout(false);
      await this.loadMore();
    }

    loadMore() {
      if (this._loadPromise) return this._loadPromise;
      if (!this.hasMore || !this.gridEl) return Promise.resolve();
      const pending = this.loadMorePage().finally(() => {
        if (this._loadPromise === pending) this._loadPromise = null;
      });
      this._loadPromise = pending;
      return pending;
    }

    async loadMorePage() {
      if (this.loading || !this.hasMore || !this.gridEl) return;
      this.loading = true;
      const seq = this._loadSeq;
      if (this.loadingEl) this.loadingEl.hidden = false;
      try {
        const result = await window.apiClient.getGalleryWorks(this.getFilters(), PAGE_SIZE, this.offset);
        if (seq !== this._loadSeq) return;
        if (!result.success) {
          showMessage(errorText(result, 'Не удалось загрузить галерею'), 'error');
          this.hasMore = false;
          this.layout();
          return;
        }
        const data = result.data.data || [];
        this.total = result.data.total || 0;
        this.offset += data.length;
        this.hasMore = this.offset < this.total && data.length > 0;
        this.items.push(...data);
        this.layout();
        this.renderCount();
      } catch (e) {
        if (seq === this._loadSeq) {
          showMessage('Не удалось загрузить галерею', 'error');
          this.layout();
        }
      } finally {
        if (seq === this._loadSeq) {
          this.loading = false;
          if (this.loadingEl) this.loadingEl.hidden = true;
          this.renderCount();
          // Экран ещё не заполнен — догружаем, не дожидаясь прокрутки.
          if (this.hasMore && this.sentinelEl && this.sentinelEl.getBoundingClientRect().top < window.innerHeight + 600) {
            setTimeout(() => this.loadMore(), 0);
          }
        }
      }
    }

    getFolderWorkPosition(workId) {
      if (!this.activeFolderId) return null;
      const index = this.items.findIndex((item) => String(item.id) === String(workId));
      if (index < 0) return null;
      return {
        index,
        total: this.total,
        hasNext: index < this.items.length - 1 || this.hasMore
      };
    }

    async navigateFolderWork(workId, delta) {
      if (!this.activeFolderId) return false;
      const index = this.items.findIndex((item) => String(item.id) === String(workId));
      if (index < 0) return false;
      let nextIndex = index + delta;
      while (nextIndex >= this.items.length && this.hasMore) {
        const before = this.items.length;
        await this.loadMore();
        if (this.items.length === before) break;
      }
      if (nextIndex < 0 || nextIndex >= this.items.length) return false;
      return window.galleryViewer.openWork(this.items[nextIndex].id, { folderNavigation: true });
    }

    renderCount() {
      if (this.countEl) this.countEl.textContent = this.total ? `${this.total} ${plural(this.total, 'работа', 'работы', 'работ')}` : '';
      if (this.emptyEl) {
        const hasFolders = this.visibleFolders.length > 0;
        const filtered = !!(this.searchEl?.value.trim() || this.activeTag || this.mine);
        this.emptyEl.hidden = this.items.length > 0 || this.loading || (hasFolders && !filtered);
        const text = this.emptyEl.querySelector('p');
        if (text) {
          text.textContent = this.activeFolderId
            ? 'В этой папке пока нет работ.'
            : (filtered ? 'Работы не найдены.' : 'Здесь пока пусто — выложите первую работу.');
        }
      }
    }

    // Кладка как в Pinterest: колонки фиксированной ширины, каждая новая
    // карточка — в самую короткую (высоты считаем по пропорциям обложки,
    // не дожидаясь загрузки картинок) — порядок остаётся "по строкам".
    computeColumnCount() {
      const width = this.gridEl ? this.gridEl.clientWidth : 0;
      if (width < 520) return 2;
      return Math.max(2, Math.min(7, Math.floor(width / 250)));
    }

    layout(includeFolders = true) {
      if (!this.gridEl) return;
      this.columnCount = this.computeColumnCount();
      this.gridEl.innerHTML = '';
      this.columns = [];
      this.columnHeights = [];
      for (let i = 0; i < this.columnCount; i++) {
        const col = document.createElement('div');
        col.className = 'gallery-column';
        this.gridEl.appendChild(col);
        this.columns.push(col);
        this.columnHeights.push(0);
      }
      this.appendCards(this.items, includeFolders ? this.visibleFolders : []);
      this.renderCount();
    }

    appendCards(items, folders = []) {
      if (!this.columns || !this.columns.length) return;
      const entries = this.buildFeedEntries(items, folders);

      const shortestColumn = () => {
        let target = 0;
        for (let i = 1; i < this.columnHeights.length; i++) {
          if (this.columnHeights[i] < this.columnHeights[target] - 0.01) target = i;
        }
        return target;
      };
      entries.forEach((entry) => {
        if (entry.type === 'folder') {
          const wrap = document.createElement('div');
          wrap.innerHTML = this.folderCardHtml(entry.folder);
          const card = wrap.firstElementChild;
          const target = shortestColumn();
          this.columns[target].appendChild(card);
          this.columnHeights[target] += 1.05;
          return;
        }
        const work = entry.work;
        const c = work.cover;
        const ratio = c && c.width && c.height ? c.height / c.width : 1.25;
        const userId = window.authManager?.getCurrentUser?.()?.id;
        const isOwned = String(work.author_id) === String(userId);
        const target = shortestColumn();
        const wrap = document.createElement('div');
        wrap.innerHTML = cardHtml(work, { selectable: isOwned, inFolder: !!this.activeFolderId });
        const card = wrap.firstElementChild;
        card.dataset.draggable = isOwned ? 'true' : 'false';
        card.draggable = isOwned && !this.selectMode;
        card.classList.toggle('is-selected', this.selectedWorkIds.has(String(work.id)));
        this.columns[target].appendChild(card);
        this.columnHeights[target] += ratio + 0.28;
      });
      this.updateSelectionUi();
    }

    buildFeedEntries(items, folders) {
      const works = items.map((work) => ({ type: 'work', work }));
      const orderedFolders = folders.map((folder) => ({ type: 'folder', folder }));
      if (this.sortEl?.value !== 'newest') return [...orderedFolders, ...works];

      const entries = [];
      let workIndex = 0;
      let folderIndex = 0;
      const getTime = (value) => {
        if (!value) return 0;
        const normalized = String(value).includes('T') ? String(value) : `${String(value).replace(' ', 'T')}Z`;
        const time = Date.parse(normalized);
        return Number.isNaN(time) ? 0 : time;
      };
      while (workIndex < works.length && folderIndex < orderedFolders.length) {
        const workTime = getTime(works[workIndex].work.created_at);
        const folderTime = getTime(orderedFolders[folderIndex].folder.createdAt);
        if (folderTime >= workTime) entries.push(orderedFolders[folderIndex++]);
        else entries.push(works[workIndex++]);
      }
      return entries.concat(works.slice(workIndex), orderedFolders.slice(folderIndex));
    }

    refreshCard(work) {
      const idx = this.items.findIndex((w) => String(w.id) === String(work.id));
      if (idx < 0) return;
      this.items[idx] = {
        ...this.items[idx],
        title: work.title,
        restricted: work.restricted,
        tags: work.tags,
        pagesCount: work.pages.length,
        hasVariations: work.pages.some((p) => p.variants.length > 1),
        cover: work.pages.length ? work.pages[0].variants[0] : null
      };
      this.layout();
    }

    removeCard(id) {
      const before = this.items.length;
      this.items = this.items.filter((w) => String(w.id) !== String(id));
      if (this.items.length !== before) {
        this.total = Math.max(0, this.total - 1);
        this.offset = Math.max(0, this.offset - 1);
        this.layout();
      }
    }
  }

  // ========================================================================
  // Окно выкладывания / правки работы
  // ========================================================================

  // Страница и вариация — разные инструменты: страницы листаются читателем
  // (их порядок — перетаскиванием плиток), а у каждой страницы — свои
  // вариации (другие версии ТОЙ ЖЕ страницы: цветная, ч/б, эскиз…) с
  // собственными именами и ролями на просмотр (панель под плитками).
  const CHIP_FIELD_MARKUP = `
    <div class="chip-field-box"><div class="chip-field-chips"></div><input type="text" class="chip-field-input"></div>
    <div class="chip-field-dropdown" hidden></div><input type="hidden" class="chip-field-hidden">`;

  function decodeRole(value) {
    const m = /^(system|server):(\d+)$/.exec(String(value || ''));
    return m ? { scope: m[1], id: parseInt(m[2], 10) } : null;
  }

  class GalleryEditor {
    constructor() {
      this.el = null;
      this.work = null;
      // [{id?, variants:[{id?, name, roles:['system:1', …], url, thumb, file?, preview?}]}]
      this.pages = [];
      this.selectedPage = -1;
      this.roleOptions = [];
      this._resolve = null;
      this._histId = null;
      this.saving = false;
      this._upload = null; // AbortController идущего сохранения
      // Закрытие вкладки/перезагрузка посреди загрузки — системное окно
      // «Покинуть сайт?» (свой текст браузеры в нём не показывают).
      window.addEventListener('beforeunload', (e) => {
        if (!this.saving) return;
        e.preventDefault();
        e.returnValue = '';
      });
    }

    // Уход из редактора (крестик, «Отмена», «Назад», другая страница), пока
    // картинки ещё грузятся. true — уходим (загрузка прервана), false —
    // остаёмся ждать.
    async confirmLeave() {
      if (!this.saving) return true;
      if (this._leaveAsk) return this._leaveAsk;
      this._leaveAsk = window.confirmDialog.open({
        title: 'Загрузка не завершена',
        message: 'Вы точно хотите выйти? Загрузка ещё не завершена.',
        confirmLabel: 'Выйти',
        cancelLabel: 'Вернуться, дождаться загрузки'
      });
      const leave = await this._leaveAsk;
      this._leaveAsk = null;
      if (leave && this.saving) {
        this._upload.abort();
        this._upload = null;
        this.saving = false;
      }
      return leave;
    }

    ensureDom() {
      if (this.el) return;
      const el = document.createElement('div');
      el.className = 'modal-overlay gallery-editor-modal';
      el.hidden = true;
      el.innerHTML = `
        <div class="modal-box gallery-editor-box">
          <div class="modal-header">
            <h3 data-ge="heading">Новая работа</h3>
            <button type="button" class="modal-close" data-ge="close">&times;</button>
          </div>
          <div class="modal-body gallery-editor-body">
            <div class="form-group">
              <label class="form-label">Название *</label>
              <input type="text" class="form-input" data-ge="title" maxlength="200" placeholder="Например: Портрет героини">
            </div>
            <div class="form-group">
              <div class="ge-desc-head">
                <label class="form-label">Описание</label>
                <button type="button" class="btn btn-secondary btn-sm" data-ge="insert-wikilink" title="Ссылка на статью Antropedia — как в редакторе: [подпись]((статья))"><i class="fas fa-book-open"></i> Ссылка на статью</button>
              </div>
              <textarea class="form-textarea" data-ge="description" maxlength="5000" rows="3" placeholder="О работе, история создания… Ссылка на статью: [подпись]((Название статьи)) — начните с (( и выберите из списка."></textarea>
            </div>
            <div class="form-group" data-ge="author-group" hidden>
              <label class="form-label">Автор</label>
              <div class="ge-author">
                <span class="ge-author-current" data-ge="author-current"></span>
                <div class="ge-author-search">
                  <input type="text" class="form-input" data-ge="author-search" placeholder="Найти пользователя, чтобы назначить автором…" autocomplete="off">
                  <div class="chip-field-dropdown" data-ge="author-dropdown" hidden></div>
                </div>
              </div>
              <p class="form-label-hint">Назначать автором другого человека могут только владелец и доверенный админ.</p>
            </div>
            <div class="form-group">
              <label class="form-label">Теги</label>
              <div class="chip-field" data-ge="tags">${CHIP_FIELD_MARKUP}</div>
            </div>

            <div class="form-group">
              <label class="form-label">Как листать страницы</label>
              <div class="ge-modes">
                <label class="ge-mode"><input type="radio" name="geScrollMode" value="horizontal" checked>
                  <span><i class="fas fa-arrows-left-right"></i> <b>Слайдер</b><small>по одной странице, стрелками и свайпом</small></span></label>
                <label class="ge-mode"><input type="radio" name="geScrollMode" value="vertical">
                  <span><i class="fas fa-arrows-up-down"></i> <b>Вертикальная лента</b><small>все страницы подряд сверху вниз</small></span></label>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Страницы *</label>
              <p class="form-label-hint">Страницы листает читатель — перетаскивайте их, чтобы поменять порядок (можно сразу много файлов: JPG, PNG, WEBP, GIF). Нажмите на страницу, чтобы добавить ей вариации — другие версии этой же страницы — и задать каждой своё имя и роли.</p>
              <div class="ge-pages" data-ge="pages"></div>
              <div class="ge-detail" data-ge="detail"></div>
            </div>

            <details class="ge-more">
              <summary>Доступ, энциклопедия и связи</summary>
              <div class="form-group">
                <label class="form-label">Сервер</label>
                <select class="form-select" data-ge="server"><option value="">— без сервера —</option></select>
              </div>
              <div class="form-group">
                <label class="form-label">Доступ ко всей работе</label>
                <div class="chip-field" data-ge="roles">${CHIP_FIELD_MARKUP}</div>
                <p class="form-label-hint">Пусто — работу видят все. 🌐 — роли платформы, 🏠 — роли выбранного сервера. Можно выбрать только роли, которые есть у вас самих. Роли отдельных вариаций — у самих вариаций.</p>
              </div>
              <div class="form-group">
                <label class="form-label">Привязать</label>
                <div class="chip-field" data-ge="articles">${CHIP_FIELD_MARKUP}</div>
              </div>
              <div class="form-group">
                <label class="form-label">Ассоциированные работы</label>
                <div class="chip-field" data-ge="associated">${CHIP_FIELD_MARKUP}</div>
              </div>
            </details>
          </div>
          <div class="modal-footer gallery-editor-footer">
            <span class="ge-progress" data-ge="progress"></span>
            <button type="button" class="btn btn-secondary" data-ge="cancel">Отмена</button>
            <button type="button" class="btn btn-primary" data-ge="save">Опубликовать</button>
          </div>
        </div>`;
      document.body.appendChild(el);
      this.el = el;
      const q = (name) => el.querySelector(`[data-ge="${name}"]`);
      this.$ = q;

      this.tagsField = new ChipField(q('tags'), { freeText: true, placeholder: 'Тег и Enter…' });
      this.rolesField = new ChipField(q('roles'), { freeText: false, placeholder: 'Роли, которым видна работа…', emptyText: 'Ролей нет' });
      this.articlesField = new ChipField(q('articles'), { freeText: false, placeholder: 'Название статьи…', emptyText: 'Статья не найдена' });
      this.associatedField = new ChipField(q('associated'), { freeText: false, placeholder: 'Название работы…', emptyText: 'Работа не найдена' });

      q('close').addEventListener('click', () => this.finish(null));
      q('cancel').addEventListener('click', () => this.finish(null));
      q('save').addEventListener('click', () => this.save());
      q('server').addEventListener('change', () => this.loadRoleOptions());
      this.bindPagesEvents(q('pages'));
      this.bindDetailEvents(q('detail'));
      this.bindAuthorEvents();
      this.bindDescriptionLinks();
    }

    // ----- Wiki-ссылки в описании: [подпись]((статья)) с автодополнением,
    // как в редакторе статей (см. updateWikilinkSuggest в editor-manager.js) -----

    bindDescriptionLinks() {
      const ta = this.$('description');
      const suggest = document.createElement('div');
      suggest.className = 'eb-wikilink-suggest ge-wikilink-suggest';
      suggest.hidden = true;
      document.body.appendChild(suggest);
      this.descSuggestEl = suggest;

      // "((начало названия" перед курсором — с подписью "[…]((" или без неё:
      // список статей открывается уже на "((" (подпись, если её не было,
      // вставляется пустой — тогда ссылка показывает название статьи).
      const OPEN_RE = /(\])?\(\(([^()#\n]*)$/;
      const close = () => { suggest.hidden = true; };
      const update = async () => {
        const m = OPEN_RE.exec(ta.value.slice(0, ta.selectionStart));
        if (!m) { close(); return; }
        const index = await loadArticlesIndex();
        const query = m[2].toLowerCase();
        const options = index.list.filter((a) => (a.title || a.slug).toLowerCase().includes(query)).slice(0, 20);
        if (!options.length || document.activeElement !== ta) { close(); return; }
        suggest.innerHTML = options.map((a, i) => `<button type="button" data-slug="${escapeHtml(a.slug)}" class="${i === 0 ? 'eb-suggest-active' : ''}">${escapeHtml(a.title || a.slug)}</button>`).join('');
        const rect = ta.getBoundingClientRect();
        suggest.style.left = `${Math.max(8, rect.left)}px`;
        suggest.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 220)}px`;
        suggest.style.minWidth = `${Math.min(rect.width, 360)}px`;
        suggest.hidden = false;
        suggest.scrollTop = 0;
      };
      const apply = (btn) => {
        const m = OPEN_RE.exec(ta.value.slice(0, ta.selectionStart));
        if (!btn || !m) { close(); return; }
        const slug = btn.dataset.slug;
        const title = btn.textContent;
        // Как в редакторе: название, если оно само даёт тот же slug и не
        // содержит ( ) # (ими ссылка разбирается), иначе — slug.
        const roundTrips = window.wikiSlugify && window.wikiSlugify(title) === slug;
        const target = roundTrips && !/[()#]/.test(title) ? title : slug;
        let openStart = ta.selectionStart - m[2].length;
        let head = ta.value.slice(0, openStart);
        if (!m[1]) {
          // Без подписи: "((" -> "[]((" (wiki-ссылке нужны квадратные скобки).
          head = head.slice(0, -2) + '[]((';
          openStart += 2;
        }
        const after = ta.value.slice(ta.selectionStart);
        const insert = target + (after.startsWith('))') ? '' : '))');
        ta.value = head + insert + after;
        ta.selectionStart = ta.selectionEnd = openStart + insert.length + (after.startsWith('))') ? 2 : 0);
        close();
        ta.focus();
      };

      ta.addEventListener('input', update);
      ta.addEventListener('click', update);
      ta.addEventListener('blur', () => setTimeout(close, 150));
      ta.addEventListener('keydown', (e) => {
        if (suggest.hidden) return;
        const buttons = Array.from(suggest.querySelectorAll('button'));
        let i = buttons.findIndex((b) => b.classList.contains('eb-suggest-active'));
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          buttons[i]?.classList.remove('eb-suggest-active');
          i = (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[i].classList.add('eb-suggest-active');
          buttons[i].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          apply(buttons[i]);
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      });
      suggest.addEventListener('mousedown', (e) => {
        const btn = e.target.closest('button[data-slug]');
        if (!btn) return;
        e.preventDefault();
        apply(btn);
      });

      // Кнопка: выделенный текст становится подписью — [выделение]((|)),
      // курсор внутри (( )), и сразу открывается список статей.
      this.$('insert-wikilink').addEventListener('click', () => {
        const start = ta.selectionStart, end = ta.selectionEnd;
        const label = ta.value.slice(start, end);
        const insert = `[${label}]((`;
        ta.value = ta.value.slice(0, start) + insert + '))' + ta.value.slice(end);
        ta.focus();
        ta.selectionStart = ta.selectionEnd = start + insert.length;
        update();
      });
    }

    // ----- Автор (только владелец и доверенный админ) -----

    renderAuthor() {
      const a = this.author;
      this.$('author-current').innerHTML = a
        ? `${window.avatarHtml({ name: a.display_name, avatar: a.avatar }, 22)} <b>${escapeHtml(a.display_name)}</b>`
        : '';
    }

    hideAuthorDropdown() {
      const dd = this.$('author-dropdown');
      dd.hidden = true;
      dd.innerHTML = '';
    }

    bindAuthorEvents() {
      const input = this.$('author-search');
      const dropdown = this.$('author-dropdown');
      let debounce = null;
      let seq = 0;
      input.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
          const query = input.value.trim();
          const mySeq = ++seq;
          if (!query) { this.hideAuthorDropdown(); return; }
          const res = await window.apiClient.searchUsers(query).catch(() => null);
          if (mySeq !== seq) return;
          const users = res && res.success && Array.isArray(res.data) ? res.data : [];
          dropdown.innerHTML = users.length
            ? users.map((u) => `<div class="chip-field-dropdown-item" data-user-id="${u.id}" data-name="${escapeHtml(u.display_name || u.username)}">${escapeHtml(u.display_name || u.username)} <span style="color: var(--text-muted);">(ID ${u.id})</span></div>`).join('')
            : '<div class="chip-field-dropdown-empty">Никого не найдено</div>';
          dropdown.hidden = false;
        }, 200);
      });
      dropdown.addEventListener('click', (e) => {
        const item = e.target.closest('[data-user-id]');
        if (!item) return;
        const id = parseInt(item.dataset.userId, 10);
        // Поиск отдаёт только id и имя — аватар (буква) до сохранения.
        this.author = { id, display_name: item.dataset.name, avatar: null };
        input.value = '';
        this.hideAuthorDropdown();
        this.renderAuthor();
      });
      input.addEventListener('blur', () => setTimeout(() => this.hideAuthorDropdown(), 150));
    }

    /** @returns {Promise<object|null>} сохранённая работа (полная) или null */
    open(work) {
      this.ensureDom();
      if (this._resolve) this.finish(null);
      this.work = work || null;
      this.$('heading').textContent = work ? 'Изменить работу' : 'Новая работа';
      this.$('save').textContent = work ? 'Сохранить' : 'Опубликовать';
      this.$('title').value = work ? work.title : '';
      this.$('description').value = work ? (work.description || '') : '';
      this.tagsField.setValues(work ? work.tags || [] : []);
      const me = window.authManager?.getCurrentUser?.();
      this.canChangeAuthor = !!(me && (me.is_root || me.is_role_manager));
      this.author = work ? work.author : (me ? { id: me.id, display_name: me.display_name || me.username, avatar: me.avatar } : null);
      this.$('author-group').hidden = !this.canChangeAuthor;
      this.$('author-search').value = '';
      this.hideAuthorDropdown();
      this.renderAuthor();
      this.el.querySelector(`input[name="geScrollMode"][value="${work && work.scrollMode === 'vertical' ? 'vertical' : 'horizontal'}"]`).checked = true;
      this.pages = work
        ? work.pages.map((p) => ({
          id: p.id,
          variants: p.variants.map((v) => ({
            id: v.id, name: v.name, url: v.url, thumb: v.thumb,
            roles: (v.roles || []).map((r) => `${r.scope}:${r.id}`)
          }))
        }))
        : [];
      this.selectedPage = this.pages.length ? 0 : -1;
      this.roleOptions = [];
      this.renderPages();
      this.$('progress').textContent = '';
      this.el.querySelector('.ge-more').open = !!(work && ((work.roles && work.roles.length) || (work.articleSlugs && work.articleSlugs.length) || (work.associated && work.associated.length) || work.serverId));

      this.el.hidden = false;
      this._histId = window.modalHistory ? window.modalHistory.open(() => this.finish(null, { fromHistory: true })) : null;
      setTimeout(() => this.$('title').focus(), 50);
      this.loadOptions(work);
      return new Promise((resolve) => { this._resolve = resolve; });
    }

    async finish(result, { fromHistory = false } = {}) {
      if (this.saving && result === null) {
        // «Назад» запись окна уже сняла — если остаёмся, заводим её заново.
        if (fromHistory) this._histId = null;
        if (!(await this.confirmLeave())) {
          if (!this._histId && !this.el.hidden && window.modalHistory) {
            this._histId = window.modalHistory.open(() => this.finish(null, { fromHistory: true }));
          }
          return;
        }
      }
      if (this.el && this.el.hidden && !this._resolve) return; // уже закрыто
      this.pages.forEach((p) => p.variants.forEach((v) => { if (v.preview) URL.revokeObjectURL(v.preview); }));
      if (this.descSuggestEl) this.descSuggestEl.hidden = true;
      if (this.el) this.el.hidden = true;
      const hist = this._histId;
      this._histId = null;
      if (hist && !fromHistory && window.modalHistory) await window.modalHistory.close(hist);
      const resolve = this._resolve;
      this._resolve = null;
      if (resolve) resolve(result);
    }

    async loadOptions(work) {
      // Сервера, статьи, работы для ассоциаций — независимо друг от друга.
      const serverSel = this.$('server');
      serverSel.innerHTML = '<option value="">— без сервера —</option>';
      const serversTask = window.apiClient.getServers().then((r) => {
        (r.success && Array.isArray(r.data) ? r.data : []).forEach((s) => {
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = s.name;
          serverSel.appendChild(opt);
        });
        serverSel.value = work && work.serverId ? String(work.serverId) : '';
      }).catch(() => {});

      const articlesTask = window.apiClient.makeAuthenticatedRequest('/api/articles-index').then((r) => {
        const list = r.success && r.data && Array.isArray(r.data.accessible) ? r.data.accessible : [];
        this.articlesField.setOptions(list.map((a) => ({ value: a.slug, label: a.title || a.slug })));
        this.articlesField.setValues(work && work.articleSlugs ? work.articleSlugs.filter((s) => list.some((a) => a.slug === s)) : []);
      }).catch(() => {});

      const worksTask = window.apiClient.getGalleryWorks({ sort: 'newest' }, 100, 0).then((r) => {
        const list = (r.success && r.data && r.data.data) || [];
        const known = new Map(list.map((w) => [String(w.id), w.title]));
        (work && work.associated || []).forEach((w) => known.set(String(w.id), w.title));
        if (work) known.delete(String(work.id));
        this.associatedField.setOptions([...known].map(([value, label]) => ({ value, label })));
        this.associatedField.setValues(work ? (work.associated || []).map((w) => String(w.id)) : []);
      }).catch(() => {});

      await serversTask;
      await Promise.all([this.loadRoleOptions(work ? work.roles : null), articlesTask, worksTask]);
    }

    // Те же два каталога ролей, что у слоёв статьи (loadRoleCatalogForLayers
    // в spa-router.js): 🌐 роли платформы и 🏠 роли выбранного сервера. Один
    // список вариантов — и для всей работы, и для каждой вариации.
    async loadRoleOptions(initialRoles) {
      const keepWork = initialRoles
        ? initialRoles.map((r) => `${r.scope}:${r.id}`)
        : this.rolesField.getValues();
      const options = [];
      try {
        const adminRes = await api('/api/admin-roles');
        if (adminRes.success && Array.isArray(adminRes.data?.roles)) {
          adminRes.data.roles.forEach((r) => options.push({ value: `system:${r.id}`, label: `🌐 ${r.name}` }));
        }
      } catch (e) { /* каталог платформы просто не подгрузится */ }
      const serverId = this.$('server').value;
      if (serverId) {
        try {
          const res = await api(`/api/servers/${serverId}/roles`);
          if (res.success && Array.isArray(res.data)) res.data.forEach((r) => options.push({ value: `server:${r.id}`, label: `🏠 ${r.name}` }));
        } catch (e) { /* роли сервера не подгрузятся */ }
      }
      // Уже выбранные роли другого сервера не теряем молча — остаются чипами.
      const used = new Set(keepWork);
      this.pages.forEach((p) => p.variants.forEach((v) => v.roles.forEach((r) => used.add(r))));
      used.forEach((v) => {
        if (!options.some((o) => o.value === v)) options.push({ value: v, label: v.startsWith('system:') ? `🌐 роль #${v.slice(7)}` : `🏠 роль #${v.slice(7)}` });
      });
      this.roleOptions = options;
      this.rolesField.setOptions(options);
      this.rolesField.setValues(keepWork);
      this.renderDetail();
    }

    // ----- Плитки страниц -----

    renderPages() {
      const box = this.$('pages');
      box.innerHTML = this.pages.map((p, i) => {
        const first = p.variants[0];
        const pending = p.variants.some((v) => v.file);
        const restricted = p.variants.some((v) => v.roles.length);
        return `
          <div class="ge-page${i === this.selectedPage ? ' is-selected' : ''}" draggable="true" data-page="${i}" title="Страница ${i + 1} — нажмите, чтобы настроить вариации">
            <img src="${escapeHtml(first.preview || first.thumb || first.url)}" alt="">
            <span class="ge-page-num">${i + 1}</span>
            ${p.variants.length > 1 ? `<span class="ge-page-layers" title="Вариаций"><i class="fas fa-layer-group"></i> ${p.variants.length}</span>` : ''}
            ${restricted ? '<span class="ge-page-lock" title="У вариаций есть роли"><i class="fas fa-lock"></i></span>' : ''}
            ${pending ? '<span class="ge-page-new" title="Ещё не загружено">new</span>' : ''}
            <button type="button" class="ge-page-remove" data-act="page-remove" title="Убрать страницу со всеми вариациями">&times;</button>
          </div>`;
      }).join('') + `
        <label class="ge-add-pages" title="Добавить страницы (можно выбрать много файлов или перетащить их сюда)">
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple data-add-pages hidden>
          <i class="fas fa-plus"></i><span>Страницы</span>
        </label>`;
      this.renderDetail();
    }

    filterImageFiles(fileList) {
      const files = Array.from(fileList || []).filter((f) => /^image\/(jpeg|png|webp|gif)$/.test(f.type));
      if (!files.length) showMessage('Подходят только изображения JPG, PNG, WEBP или GIF', 'error');
      // Имена вида "001.png, 002.png" — по порядку, как страницы манги.
      return files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }

    newVariant(file) {
      return { name: '', roles: [], file, preview: URL.createObjectURL(file) };
    }

    addPages(fileList) {
      const files = this.filterImageFiles(fileList);
      if (!files.length) return;
      files.forEach((file) => this.pages.push({ variants: [this.newVariant(file)] }));
      if (this.selectedPage < 0) this.selectedPage = 0;
      this.renderPages();
    }

    bindPagesEvents(box) {
      box.addEventListener('change', (e) => {
        const input = e.target.closest('[data-add-pages]');
        if (input) {
          this.addPages(input.files);
          input.value = '';
        }
      });
      box.addEventListener('click', (e) => {
        const tile = e.target.closest('[data-page]');
        if (!tile) return;
        const i = parseInt(tile.dataset.page, 10);
        if (e.target.closest('[data-act="page-remove"]')) {
          const [removed] = this.pages.splice(i, 1);
          (removed ? removed.variants : []).forEach((v) => { if (v.preview) URL.revokeObjectURL(v.preview); });
          if (this.selectedPage >= this.pages.length) this.selectedPage = this.pages.length - 1;
          else if (this.selectedPage > i) this.selectedPage--;
        } else {
          this.selectedPage = i;
        }
        this.renderPages();
      });

      // Перетаскивание плиток (порядок страниц) и файлов с диска (новые страницы).
      let dragFrom = null;
      box.addEventListener('dragstart', (e) => {
        const tile = e.target.closest('[data-page]');
        if (!tile) return;
        dragFrom = parseInt(tile.dataset.page, 10);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'gallery-page');
        tile.classList.add('is-dragging');
      });
      box.addEventListener('dragend', () => {
        dragFrom = null;
        box.querySelectorAll('.is-dragging, .is-drop-target').forEach((n) => n.classList.remove('is-dragging', 'is-drop-target'));
      });
      box.addEventListener('dragover', (e) => {
        e.preventDefault();
        box.querySelectorAll('.is-drop-target').forEach((n) => n.classList.remove('is-drop-target'));
        (e.target.closest('[data-page]') || box).classList.add('is-drop-target');
      });
      box.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragFrom === null) {
          if (e.dataTransfer.files && e.dataTransfer.files.length) this.addPages(e.dataTransfer.files);
          return;
        }
        const target = e.target.closest('[data-page]');
        const selected = this.pages[this.selectedPage];
        const [moved] = this.pages.splice(dragFrom, 1);
        // На место цели (после удаления перетаскиваемой индексы сдвинулись —
        // тот же индекс и есть "место цели" при переносе в обе стороны).
        const to = target ? parseInt(target.dataset.page, 10) : this.pages.length;
        this.pages.splice(Math.min(to, this.pages.length), 0, moved);
        this.selectedPage = this.pages.indexOf(selected);
        dragFrom = null;
        this.renderPages();
      });
    }

    // ----- Вариации выбранной страницы -----

    renderDetail() {
      const box = this.$('detail');
      const page = this.pages[this.selectedPage];
      if (!page) { box.innerHTML = ''; return; }
      box.innerHTML = `
        <div class="ge-detail-head">
          <b>Страница ${this.selectedPage + 1} — вариации</b>
          <label class="btn btn-secondary btn-sm ge-add-variant" title="Другая версия этой же страницы (можно несколько файлов)">
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple data-add-variants hidden>
            <i class="fas fa-plus"></i> Вариация
          </label>
        </div>
        <p class="form-label-hint">Имя вариации читатель видит в переключателе. Роли — кому эта вариация видна (пусто — всем, кому видна работа); страницу без единой доступной вариации читатель не увидит.</p>
        ${page.variants.map((v, vi) => `
          <div class="ge-variant-row" data-variant="${vi}">
            <img src="${escapeHtml(v.preview || v.thumb || v.url)}" alt="">
            <div class="ge-variant-fields">
              <input type="text" class="form-input" data-variant-name="${vi}" maxlength="80" value="${escapeHtml(v.name)}" placeholder="${vi === 0 ? 'Основная' : `Вариация ${vi + 1}`}">
              <div class="chip-field" data-variant-roles="${vi}">${CHIP_FIELD_MARKUP}</div>
            </div>
            <div class="ge-variant-actions">
              <button type="button" class="gv-icon-btn" data-act="variant-up" title="Выше" ${vi === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
              <button type="button" class="gv-icon-btn" data-act="variant-down" title="Ниже" ${vi === page.variants.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>
              <button type="button" class="gv-icon-btn" data-act="variant-remove" title="Удалить вариацию" ${page.variants.length < 2 ? 'disabled' : ''}><i class="fas fa-trash"></i></button>
            </div>
          </div>`).join('')}`;

      box.querySelectorAll('[data-variant-roles]').forEach((root) => {
        const variant = page.variants[parseInt(root.dataset.variantRoles, 10)];
        const field = new ChipField(root, {
          freeText: false,
          placeholder: 'Роли, которым видна вариация…',
          emptyText: 'Ролей нет',
          onChange: () => { variant.roles = field.getValues(); this.markPageLock(); }
        });
        field.setOptions(this.roleOptions);
        field.setValues(variant.roles);
        root._field = field;
      });
    }

    markPageLock() {
      const tile = this.$('pages').querySelector(`[data-page="${this.selectedPage}"]`);
      const page = this.pages[this.selectedPage];
      if (!tile || !page) return;
      const restricted = page.variants.some((v) => v.roles.length);
      const lock = tile.querySelector('.ge-page-lock');
      if (restricted && !lock) tile.insertAdjacentHTML('beforeend', '<span class="ge-page-lock" title="У вариаций есть роли"><i class="fas fa-lock"></i></span>');
      if (!restricted && lock) lock.remove();
    }

    // Набранное, но не превращённое в чип в полях ролей — тоже в состояние.
    syncDetail() {
      const page = this.pages[this.selectedPage];
      if (!page) return;
      this.$('detail').querySelectorAll('[data-variant-roles]').forEach((root) => {
        const v = page.variants[parseInt(root.dataset.variantRoles, 10)];
        if (v && root._field) v.roles = root._field.getValues();
      });
    }

    bindDetailEvents(box) {
      box.addEventListener('input', (e) => {
        const input = e.target.closest('[data-variant-name]');
        const page = this.pages[this.selectedPage];
        if (input && page) page.variants[parseInt(input.dataset.variantName, 10)].name = input.value;
      });
      box.addEventListener('change', (e) => {
        const input = e.target.closest('[data-add-variants]');
        if (!input) return;
        const files = this.filterImageFiles(input.files);
        input.value = '';
        const page = this.pages[this.selectedPage];
        if (!files.length || !page) return;
        this.syncDetail();
        files.forEach((file) => page.variants.push(this.newVariant(file)));
        this.renderPages();
      });
      box.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        const page = this.pages[this.selectedPage];
        if (!btn || !page) return;
        this.syncDetail();
        const vi = parseInt(btn.closest('[data-variant]').dataset.variant, 10);
        const list = page.variants;
        if (btn.dataset.act === 'variant-up' && vi > 0) [list[vi - 1], list[vi]] = [list[vi], list[vi - 1]];
        else if (btn.dataset.act === 'variant-down' && vi < list.length - 1) [list[vi + 1], list[vi]] = [list[vi], list[vi + 1]];
        else if (btn.dataset.act === 'variant-remove' && list.length > 1) {
          const [removed] = list.splice(vi, 1);
          if (removed && removed.preview) URL.revokeObjectURL(removed.preview);
        }
        this.renderPages();
      });
      // Файлы, брошенные на панель вариаций, — новые вариации этой страницы.
      box.addEventListener('dragover', (e) => { if (this.pages[this.selectedPage]) e.preventDefault(); });
      box.addEventListener('drop', (e) => {
        const page = this.pages[this.selectedPage];
        if (!page || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
        e.preventDefault();
        const files = this.filterImageFiles(e.dataTransfer.files);
        if (!files.length) return;
        this.syncDetail();
        files.forEach((file) => page.variants.push(this.newVariant(file)));
        this.renderPages();
      });
    }

    // ----- Сохранение -----

    collectMeta() {
      return {
        title: this.$('title').value.trim(),
        description: this.$('description').value.trim(),
        tags: this.tagsField.getValues(),
        scrollMode: this.el.querySelector('input[name="geScrollMode"]:checked').value,
        serverId: this.$('server').value || null,
        roles: this.rolesField.getValues().map(decodeRole).filter(Boolean),
        articleSlugs: this.articlesField.getValues(),
        associatedIds: this.associatedField.getValues().map((v) => parseInt(v, 10)).filter(Boolean),
        ...(this.canChangeAuthor && this.author ? { authorId: this.author.id } : {})
      };
    }

    // Состав страниц для PUT: только уже загруженное (с id).
    pagesPayload() {
      return this.pages.filter((p) => p.id).map((p) => ({
        id: p.id,
        variants: p.variants.filter((v) => v.id).map((v) => ({ id: v.id, name: v.name, roles: v.roles.map(decodeRole).filter(Boolean) }))
      }));
    }

    applyUploaded(variant, uploaded) {
      if (variant.preview) URL.revokeObjectURL(variant.preview);
      Object.assign(variant, { id: uploaded.id, url: uploaded.url, thumb: uploaded.thumb, file: null, preview: null });
    }

    async save() {
      if (this.saving) return;
      this.syncDetail();
      this.tagsField.commitTyped?.();
      const meta = this.collectMeta();
      if (!meta.title) {
        showMessage('Укажите название работы', 'error');
        this.$('title').focus();
        return;
      }
      if (!this.pages.length) {
        showMessage('Добавьте хотя бы одну страницу', 'error');
        return;
      }

      const isNew = !this.work;
      const run = new AbortController();
      const checkAborted = () => { if (run.signal.aborted) throw new Error('aborted'); };
      this._upload = run;
      this.saving = true;
      const saveBtn = this.$('save');
      saveBtn.disabled = true;
      const progress = this.$('progress');
      try {
        // Страница, у которой остались только новые (незагруженные)
        // вариации, на сервере пересоздаётся — первый PUT её бы удалил.
        this.pages.forEach((p) => { if (p.id && !p.variants.some((v) => v.id)) p.id = null; });

        // 1) Метаданные + состав уже загруженного.
        progress.textContent = 'Сохранение…';
        const first = isNew
          ? await window.apiClient.createGalleryWork(meta)
          : await window.apiClient.updateGalleryWork(this.work.id, { ...meta, pages: this.pagesPayload() });
        checkAborted();
        if (!first.success) throw new Error(errorText(first, 'Не удалось сохранить работу'));
        let saved = first.data;
        this.work = saved;

        const total = this.pages.reduce((n, p) => n + p.variants.filter((v) => v.file).length, 0);
        let done = 0;
        const upload = async (pageId, variants) => {
          for (let i = 0; i < variants.length; i += UPLOAD_CHUNK) {
            const chunk = variants.slice(i, i + UPLOAD_CHUNK);
            progress.textContent = `Загрузка: ${done} / ${total}`;
            const res = await window.apiClient.uploadGalleryImages(saved.id, pageId, chunk.map((v) => v.file), run.signal);
            checkAborted();
            if (!res.success) throw new Error(errorText(res, 'Не удалось загрузить картинки'));
            res.data.variants.forEach((uploaded, k) => {
              this.applyUploaded(chunk[k], uploaded);
              if (!pageId) chunk[k]._newPageId = uploaded.pageId;
            });
            done += chunk.length;
          }
        };

        // 2а) Новые страницы — первой вариацией каждая (одной пачкой).
        const newPages = this.pages.filter((p) => !p.id);
        const firsts = newPages.map((p) => p.variants.find((v) => v.file));
        await upload(null, firsts);
        newPages.forEach((p, k) => { p.id = firsts[k]._newPageId; delete firsts[k]._newPageId; });
        // 2б) Остальные новые вариации — в свои страницы.
        for (const p of this.pages) {
          const pendingVariants = p.variants.filter((v) => v.file);
          if (pendingVariants.length) await upload(p.id, pendingVariants);
        }

        // 3) Итоговый порядок, имена и роли (новое могло стоять между старым).
        if (isNew || total > 0) {
          progress.textContent = 'Сохранение порядка…';
          checkAborted();
          const final = await window.apiClient.updateGalleryWork(saved.id, { ...meta, pages: this.pagesPayload() });
          if (!final.success) throw new Error(errorText(final, 'Не удалось сохранить порядок страниц'));
          saved = final.data;
        }
        showMessage(isNew ? 'Работа опубликована' : 'Работа сохранена', 'success');
        // «Выйти» нажали, когда всё уже ушло на сервер, — редактор закрыт.
        if (run.signal.aborted) return;
        progress.textContent = '';
        this.saving = false;
        // Загрузка кончилась, пока открыт вопрос «Точно выйти?» — ждём ответа:
        // «Выйти» закроет редактор сам, «Вернуться» — закрываем как сохранённое.
        if (this._leaveAsk && await this._leaveAsk) return;
        await this.finish(saved);
      } catch (e) {
        progress.textContent = '';
        if (run.signal.aborted) {
          // Редактор уже закрыт; загруженное до прерывания остаётся в работе.
          showMessage('Загрузка прервана', 'warning');
          return;
        }
        showMessage(e.message || 'Не удалось сохранить работу', 'error');
        // Работа уже создана — дальнейшие попытки должны её править, а не
        // плодить копии (this.work и id загруженного выставлены выше).
        if (this.work) {
          this.$('heading').textContent = 'Изменить работу';
          this.$('save').textContent = 'Сохранить';
        }
        this.renderPages();
      } finally {
        // Редактор за это время могли закрыть и открыть заново с новым сохранением.
        if (this._upload === run) {
          this._upload = null;
          this.saving = false;
        }
        saveBtn.disabled = false;
      }
    }
  }

  // ========================================================================
  // Выбор арта для статьи (редактор)
  // ========================================================================

  class GalleryPicker {
    constructor() {
      this.el = null;
      this._resolve = null;
      this._histId = null;
      this._seq = 0;
    }

    ensureDom() {
      if (this.el) return;
      const el = document.createElement('div');
      el.className = 'modal-overlay gallery-picker-modal';
      el.hidden = true;
      el.innerHTML = `
        <div class="modal-box gallery-picker-box">
          <div class="modal-header">
            <h3 data-gp="heading"><i class="fas fa-images"></i> Арт из галереи</h3>
            <button type="button" class="modal-close" data-gp="close">&times;</button>
          </div>
          <div class="modal-body">
            <div class="gallery-picker-search" data-gp="search-wrap">
              <i class="fas fa-search"></i>
              <input type="text" class="form-input" data-gp="search" placeholder="Поиск по названию, тегам, автору…">
            </div>
            <button type="button" class="btn btn-secondary btn-sm" data-gp="back" hidden><i class="fas fa-arrow-left"></i> К работам</button>
            <div class="gallery-picker-grid" data-gp="grid"></div>
            <div class="gallery-picker-empty" data-gp="empty" hidden>Ничего не найдено</div>
          </div>
        </div>`;
      document.body.appendChild(el);
      this.el = el;
      const q = (n) => el.querySelector(`[data-gp="${n}"]`);
      this.$ = q;
      q('close').addEventListener('click', () => this.finish(null));
      q('back').addEventListener('click', () => this.showWorks());
      let t = null;
      q('search').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => this.loadWorks(), 250); });
      q('grid').addEventListener('click', (e) => {
        const card = e.target.closest('[data-work-id]');
        if (card) { this.pickWork(card.dataset.workId); return; }
        const page = e.target.closest('[data-image-id]');
        if (page && this.currentWork) {
          this.finish({ workId: this.currentWork.id, imageId: parseInt(page.dataset.imageId, 10), src: page.dataset.src, title: this.currentWork.title });
        }
      });
    }

    /** @returns {Promise<{workId, imageId, src, title}|null>} */
    open() {
      this.ensureDom();
      if (this._resolve) this.finish(null);
      this.el.hidden = false;
      this._histId = window.modalHistory ? window.modalHistory.open(() => this.finish(null, { fromHistory: true })) : null;
      this.$('search').value = '';
      this.showWorks();
      setTimeout(() => this.$('search').focus(), 50);
      return new Promise((resolve) => { this._resolve = resolve; });
    }

    async finish(result, { fromHistory = false } = {}) {
      if (this.el) this.el.hidden = true;
      const hist = this._histId;
      this._histId = null;
      if (hist && !fromHistory && window.modalHistory) await window.modalHistory.close(hist);
      const resolve = this._resolve;
      this._resolve = null;
      if (resolve) resolve(result);
    }

    showWorks() {
      this.currentWork = null;
      this.$('back').hidden = true;
      this.$('search-wrap').hidden = false;
      this.$('heading').innerHTML = '<i class="fas fa-images"></i> Арт из галереи';
      this.loadWorks();
    }

    async loadWorks() {
      const seq = ++this._seq;
      const grid = this.$('grid');
      grid.innerHTML = '<div class="gallery-picker-loading"><i class="fas fa-spinner fa-spin"></i></div>';
      const res = await window.apiClient.getGalleryWorks({ q: this.$('search').value.trim() }, 60, 0);
      if (seq !== this._seq || this.currentWork) return;
      const list = ((res.success && res.data && res.data.data) || []).filter((w) => w.cover);
      grid.innerHTML = list.map((w) => cardHtml(w, { compact: true })).join('');
      this.$('empty').hidden = list.length > 0;
    }

    async pickWork(id) {
      const seq = ++this._seq;
      const res = await window.apiClient.getGalleryWork(id);
      if (seq !== this._seq) return;
      if (!res.success) { showMessage(errorText(res, 'Не удалось открыть работу'), 'error'); return; }
      const work = res.data;
      const all = work.pages.flatMap((p) => p.variants);
      if (all.length === 1) {
        this.finish({ workId: work.id, imageId: all[0].id, src: all[0].url, title: work.title });
        return;
      }
      // Несколько страниц или вариаций — выбрать, что именно переслать.
      this.currentWork = work;
      this.$('back').hidden = false;
      this.$('search-wrap').hidden = true;
      this.$('empty').hidden = true;
      this.$('heading').innerHTML = `<i class="fas fa-images"></i> ${escapeHtml(work.title)} — выберите страницу`;
      this.$('grid').innerHTML = work.pages.map((page, i) => `
        <div class="gallery-picker-variant">
          ${work.pages.length > 1 ? `<div class="gallery-picker-variant-name">Страница ${i + 1}</div>` : ''}
          <div class="gallery-picker-pages">
            ${page.variants.map((v) => `<button type="button" class="gallery-picker-page" data-image-id="${v.id}" data-src="${escapeHtml(v.url)}" title="${escapeHtml(v.name)}"><img src="${escapeHtml(v.thumb)}" alt="" loading="lazy"><span>${escapeHtml(page.variants.length > 1 ? v.name : String(i + 1))}</span></button>`).join('')}
          </div>
        </div>`).join('');
    }
  }

  // ========================================================================
  // Полоса «Из галереи» под статьёй Antropedia
  // ========================================================================

  async function renderArticleStrip(container, slug) {
    if (!container) return;
    if (!container._galleryBound) {
      container._galleryBound = true;
      container.addEventListener('click', (e) => {
        const card = e.target.closest('[data-work-id]');
        if (card) window.galleryViewer.openWork(card.dataset.workId);
      });
    }
    container.hidden = true;
    container.innerHTML = '';
    try {
      const res = await window.apiClient.getGalleryWorksForArticle(slug);
      const list = res.success && Array.isArray(res.data) ? res.data.filter((w) => w.cover) : [];
      if (!list.length || container.dataset.slug !== String(slug)) return;
      container.innerHTML = `<h3><i class="fas fa-images"></i> Из галереи</h3><div class="gallery-strip">${list.map((w) => cardHtml(w, { compact: true })).join('')}</div>`;
      container.hidden = false;
    } catch (e) {
      // Не критично для чтения статьи.
    }
  }

  window.galleryViewer = new GalleryViewer();
  window.galleryManager = new GalleryManager();
  window.galleryEditor = new GalleryEditor();
  window.galleryPicker = new GalleryPicker();
  window.galleryRenderArticleStrip = renderArticleStrip;
  // Карточка работы — и для вкладки «Арты» в профиле (spa-router.js).
  window.galleryCardHtml = cardHtml;
})();
