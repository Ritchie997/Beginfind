// sticker-store.js — "Магазин наборов": модалка со СПИСКОМ ВСЕХ одобренных
// наборов стикеров (каталог), где можно свободно добавлять/убирать наборы
// себе одним кликом, без ухода на отдельную страницу — открывается из
// ссылки "магазин наборов" в пикере стикеров (см. wireComposer() в
// ibripedia.js) рядом со ссылкой "управлять наборами" (та ведёт в раздел
// "Стикеры" — создание/загрузка собственных наборов, это НЕ здесь).
// Добавленные наборы всегда показываются первыми.

(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  const STYLES = `
    .sst-search-wrap { position: relative; margin-bottom: 12px; }
    .sst-search-wrap i { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--text-muted); }
    .sst-search-wrap input { width: 100%; box-sizing: border-box; padding: 9px 12px 9px 34px; background: var(--background-tertiary); border: 1px solid var(--background-accent); border-radius: 6px; color: var(--text-normal); font-size: 14px; }
    .sst-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; max-height: 420px; overflow-y: auto; padding: 2px; }
    .sst-card { background: var(--background-tertiary); border: 1px solid var(--background-accent); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .sst-card.subscribed { border-color: var(--blurple); }
    .sst-preview { display: flex; gap: 6px; height: 40px; align-items: center; }
    .sst-preview img { width: 36px; height: 36px; object-fit: contain; background: var(--background-secondary); border-radius: 6px; }
    .sst-preview-empty { color: var(--text-muted); font-size: 12px; font-style: italic; }
    .sst-title { color: var(--text-normal); font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sst-description { color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sst-meta { color: var(--text-muted); font-size: 12px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .sst-own-badge { flex-shrink: 0; padding: 2px 9px; border-radius: 12px; font-size: 11px; font-weight: 600; background: rgba(59,165,93,0.18); color: var(--green); }
    .sst-empty { grid-column: 1 / -1; color: var(--text-muted); font-size: 13px; text-align: center; padding: 30px 0; }
  `;

  class StickerStore {
    constructor() {
      this._els = null;
      this._onChange = null;
      this._searchDebounce = null;
    }

    ensureModal() {
      if (this._els) return this._els;

      const style = document.createElement('style');
      style.id = 'stickerStoreStyles';
      style.textContent = STYLES;
      document.head.appendChild(style);

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.id = 'stickerStoreModal';
      overlay.hidden = true;
      overlay.innerHTML = `
        <div class="modal-box modal-box-wide">
          <div class="modal-header">
            <h3><i class="fas fa-store"></i> Магазин наборов</h3>
            <button class="modal-close" id="stickerStoreCloseBtn">&times;</button>
          </div>
          <div class="modal-body">
            <div class="sst-search-wrap">
              <i class="fas fa-search"></i>
              <input type="text" id="stickerStoreSearch" placeholder="Поиск наборов по названию…">
            </div>
            <div class="sst-grid" id="stickerStoreGrid"></div>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      overlay.addEventListener('click', (e) => { if (e.target === overlay) this.close(); });
      overlay.querySelector('#stickerStoreCloseBtn').addEventListener('click', () => this.close());
      const searchEl = overlay.querySelector('#stickerStoreSearch');
      searchEl.addEventListener('input', () => {
        clearTimeout(this._searchDebounce);
        this._searchDebounce = setTimeout(() => this.load(searchEl.value), 250);
      });

      this._els = { overlay, grid: overlay.querySelector('#stickerStoreGrid'), searchEl };
      return this._els;
    }

    // onChange — колбэк "что-то поменялось" (см. refreshOpenStickerPickers в
    // ibripedia.js) — вызывается после каждого добавить/убрать, чтобы уже
    // открытый пикер стикеров сразу отразил новый набор в списке.
    async open(onChange) {
      this._onChange = onChange || null;
      const els = this.ensureModal();
      els.overlay.hidden = false;
      els.searchEl.value = '';
      await this.load();
    }

    close() {
      if (this._els) this._els.overlay.hidden = true;
    }

    async load(search) {
      const els = this._els;
      if (!els) return;
      els.grid.innerHTML = `<div class="sst-empty">Загрузка…</div>`;
      try {
        const result = await window.apiClient.getStickerCatalog(search || '');
        const packs = result.success ? (result.data || []) : [];
        // Добавленные — всегда первыми (сортировка стабильна: порядок
        // среди одинаковых по этому признаку не меняем — так, как их
        // отдаёт listCatalog, т.е. новые сверху).
        packs.sort((a, b) => (b.subscribed ? 1 : 0) - (a.subscribed ? 1 : 0));
        this.render(packs);
      } catch (e) {
        els.grid.innerHTML = `<div class="sst-empty">Не удалось загрузить каталог наборов</div>`;
      }
    }

    render(packs) {
      const els = this._els;
      if (!packs.length) {
        els.grid.innerHTML = `<div class="sst-empty">Наборы не найдены</div>`;
        return;
      }

      els.grid.innerHTML = packs.map((p) => {
        const preview = (p.stickers || []).slice(0, 3);
        const count = p.stickersCount ?? preview.length;
        const previewHtml = preview.length
          ? preview.map((s) => `<img src="${escapeHtml(s.fileUrl)}" alt="">`).join('')
          : `<span class="sst-preview-empty">Пусто</span>`;
        // Свой набор — тоже можно убрать из использованных (subscribe —
        // это "вижу его стикеры в пикере", а не "владею им"): автор просто
        // сразу подписан на собственный набор при создании (см. createPack
        // в stickers-store.js), но это такая же обычная подписка, которую
        // можно снять и добавить обратно — набор при этом никуда не девается.
        const ownBadge = p.isOwn
          ? `<span class="sst-own-badge">Ваш набор</span>`
          : '';
        const actionBtn = `
          <button type="button" class="btn ${p.subscribed ? 'btn-secondary' : 'btn-primary'} btn-sm" data-pack-id="${p.id}" data-subscribed="${p.subscribed ? '1' : '0'}">
            ${p.subscribed ? '<i class="fas fa-xmark"></i> Убрать' : '<i class="fas fa-plus"></i> Добавить'}
          </button>`;
        const descriptionHtml = p.description
          ? `<div class="sst-description" title="${escapeHtml(p.description)}">${escapeHtml(p.description)}</div>`
          : '';
        return `
          <div class="sst-card${p.subscribed ? ' subscribed' : ''}">
            <div class="sst-preview">${previewHtml}</div>
            <div class="sst-title" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</div>
            ${descriptionHtml}
            <div class="sst-meta"><span>от ${escapeHtml(p.authorName)} · ${count} шт.</span>${ownBadge}</div>
            ${actionBtn}
          </div>`;
      }).join('');

      els.grid.querySelectorAll('[data-pack-id]').forEach((btn) => {
        btn.addEventListener('click', () => this.toggle(btn.dataset.packId, btn.dataset.subscribed === '1'));
      });
    }

    async toggle(packId, isSubscribed) {
      try {
        if (isSubscribed) await window.apiClient.unsubscribeStickerPack(packId);
        else await window.apiClient.subscribeStickerPack(packId);
        await this.load(this._els.searchEl.value);
        this._onChange?.();
      } catch (e) {
        showMessage('Не удалось изменить подписку на набор', 'error');
      }
    }
  }

  window.stickerStore = new StickerStore();
})();
