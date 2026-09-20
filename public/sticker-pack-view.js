// sticker-pack-view.js — общая модалка "просмотр набора стикеров", доступная
// с любой страницы: открывается по клику на стикер в комментарии (см.
// ibripedia.js) или по клику на карточку набора во вкладке "Наборы стикеров"
// профиля (см. renderProfileStickers в spa-router.js).
//
// В отличие от stickers-manager.js (вкладка "Стикеры" в шапке — там же
// создание/загрузка/переименование/модерация), эта модалка — только
// просмотр + переключатель подписки "добавить себе"/"убрать": чужой набор
// не редактируется отсюда, а собственный отправляет управлять в раздел
// "Стикеры" (там уже есть загрузка/переименование/удаление).
//
// Разметка и стили создаются лениво при первом open() и переиспользуются
// дальше — не привязаны к конкретному view.html, поэтому работают с любой
// страницы SPA.

(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  const STATUS_LABELS = { draft: 'Черновик', pending: 'На модерации', approved: 'Подтверждён', rejected: 'Отклонён' };

  const STYLES = `
    .spv-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; font-size: 13px; color: var(--text-muted); }
    .spv-description { color: var(--text-normal); font-size: 14px; line-height: 1.5; margin: -6px 0 14px; }
    .spv-description:empty { display: none; }
    .spv-badge { display: inline-block; padding: 2px 9px; border-radius: 12px; font-size: 11px; font-weight: 600; white-space: nowrap; }
    .spv-badge.draft { background: rgba(255, 255, 255, 0.08); color: var(--text-muted); }
    .spv-badge.pending { background: rgba(250, 168, 26, 0.18); color: var(--yellow); }
    .spv-badge.approved { background: rgba(59, 165, 93, 0.18); color: var(--green); }
    .spv-badge.rejected { background: rgba(237, 66, 69, 0.18); color: var(--red); }
    .spv-reject-box { background: rgba(237, 66, 69, 0.1); border: 1px solid rgba(237, 66, 69, 0.35); color: var(--text-normal); border-radius: 6px; padding: 10px 12px; font-size: 13px; margin-bottom: 14px; }
    .spv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 10px; max-height: 340px; overflow-y: auto; padding: 2px; }
    .spv-tile { background: var(--background-tertiary); border: 1px solid var(--background-accent); border-radius: 8px; padding: 6px; text-align: center; }
    .spv-tile img { width: 100%; height: 64px; object-fit: contain; }
    .spv-tile-alias { font-size: 10px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 3px; }
    .spv-empty { grid-column: 1 / -1; color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px 0; }
    .spv-own-hint { color: var(--text-muted); font-size: 13px; }
    .spv-own-hint a { color: var(--blurple); text-decoration: none; }
    .spv-own-hint a:hover { text-decoration: underline; }
  `;

  class StickerPackView {
    constructor() {
      this.currentPack = null;
      this._els = null;
    }

    ensureModal() {
      if (this._els) return this._els;

      const style = document.createElement('style');
      style.id = 'stickerPackViewStyles';
      style.textContent = STYLES;
      document.head.appendChild(style);

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.id = 'stickerPackViewModal';
      overlay.hidden = true;
      overlay.innerHTML = `
        <div class="modal-box modal-box-wide">
          <div class="modal-header">
            <h3 id="stickerPackViewTitle">Набор</h3>
            <button class="modal-close" id="stickerPackViewCloseBtn">&times;</button>
          </div>
          <div class="modal-body">
            <div class="spv-meta" id="stickerPackViewMeta"></div>
            <div class="spv-description" id="stickerPackViewDescription"></div>
            <div id="stickerPackViewRejectBox"></div>
            <div class="spv-grid" id="stickerPackViewGrid"></div>
          </div>
          <div class="modal-footer" id="stickerPackViewFooter"></div>
        </div>
      `;
      document.body.appendChild(overlay);

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) this.close();
      });
      overlay.querySelector('#stickerPackViewCloseBtn').addEventListener('click', () => this.close());

      this._els = {
        overlay,
        title: overlay.querySelector('#stickerPackViewTitle'),
        meta: overlay.querySelector('#stickerPackViewMeta'),
        description: overlay.querySelector('#stickerPackViewDescription'),
        rejectBox: overlay.querySelector('#stickerPackViewRejectBox'),
        grid: overlay.querySelector('#stickerPackViewGrid'),
        footer: overlay.querySelector('#stickerPackViewFooter')
      };
      return this._els;
    }

    async open(packId) {
      if (!packId) return;
      const els = this.ensureModal();
      els.overlay.hidden = false;
      els.grid.innerHTML = `<div class="spv-empty">Загрузка…</div>`;
      els.footer.innerHTML = '';

      try {
        const result = await window.apiClient.getStickerPack(packId);
        if (!result.success) {
          showMessage(`Не удалось открыть набор: ${result.data?.error || result.error || ''}`, 'error');
          this.close();
          return;
        }
        this.currentPack = result.data;
        this.render();
      } catch (e) {
        showMessage('Неожиданная ошибка при открытии набора', 'error');
        this.close();
      }
    }

    close() {
      if (this._els) this._els.overlay.hidden = true;
      this.currentPack = null;
    }

    render() {
      const pack = this.currentPack;
      const els = this._els;
      if (!pack || !els) return;

      els.title.textContent = pack.title;
      els.meta.innerHTML = `
        <span class="spv-badge ${pack.status}">${STATUS_LABELS[pack.status] || pack.status}</span>
        <span>Автор: ${escapeHtml(pack.authorName)}</span>
        ${(pack.coAuthors && pack.coAuthors.length) ? `<span>Соавторы: ${pack.coAuthors.map((c) => escapeHtml(c.name)).join(', ')}</span>` : ''}
        <span>Стикеров: ${pack.stickers.length}</span>
      `;
      els.description.textContent = pack.description || '';

      els.rejectBox.innerHTML = (pack.status === 'rejected' && pack.rejectReason)
        ? `<div class="spv-reject-box"><i class="fas fa-triangle-exclamation"></i> Причина отклонения: ${escapeHtml(pack.rejectReason)}</div>`
        : '';

      els.grid.innerHTML = pack.stickers.length
        ? pack.stickers.map((s) => `
            <div class="spv-tile" title="${escapeHtml(s.alias)}">
              <img src="${escapeHtml(s.fileUrl)}" alt="${escapeHtml(s.alias)}">
              <div class="spv-tile-alias">${escapeHtml(s.alias)}</div>
            </div>`).join('')
        : `<div class="spv-empty">В наборе пока нет стикеров</div>`;

      els.footer.innerHTML = this.renderFooter(pack);
      this.bindFooter(pack);
    }

    renderFooter(pack) {
      if (pack.isOwn) {
        return `<div class="spv-own-hint"><i class="fas fa-circle-info"></i> Это ваш набор — управлять им (загружать стикеры, переименовать, удалить) можно во вкладке <a href="#" data-nav="/stickers">«Стикеры»</a>.</div>`;
      }
      if (pack.status !== 'approved') {
        return `<div class="spv-own-hint">Набор ещё не подтверждён модератором — добавить его себе пока нельзя.</div>`;
      }
      const subscribed = !!pack.subscribed;
      return `
        <button type="button" class="btn ${subscribed ? 'btn-secondary' : 'btn-primary'}" id="stickerPackViewSubBtn">
          ${subscribed ? '<i class="fas fa-xmark"></i> Убрать' : '<i class="fas fa-plus"></i> Добавить себе'}
        </button>
      `;
    }

    bindFooter(pack) {
      // Ссылка "управлять во вкладке «Стикеры»" сама переключит маршрут
      // (см. глобальный обработчик [data-nav] в spa-router.js) — модалку
      // за собой не закрывает, закрываем явно, чтобы она не висела поверх
      // новой страницы.
      this._els.footer.querySelector('[data-nav]')?.addEventListener('click', () => this.close());
      this._els.footer.querySelector('#stickerPackViewSubBtn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          if (pack.subscribed) await window.apiClient.unsubscribeStickerPack(pack.id);
          else await window.apiClient.subscribeStickerPack(pack.id);
          await this.open(pack.id);
        } catch (err) {
          showMessage('Не удалось изменить подписку на набор', 'error');
          btn.disabled = false;
        }
      });
    }
  }

  window.stickerPackView = new StickerPackView();
})();
