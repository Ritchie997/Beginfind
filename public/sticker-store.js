// sticker-store.js — Единая модалка "Магазин наборов": список всех одобренных
// наборов стикеров (каталог), где можно свободно добавлять/убирать наборы себе
// одним кликом. Работает на всех страницах (Admin SPA, Antropedia, AllTell, Галерея, Профиль).

(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function getToken() {
    try {
      return (window.authManager && typeof window.authManager.getToken === 'function')
        ? (window.authManager.getToken() || '')
        : (localStorage.getItem('alltell_auth_token') || '');
    } catch (_) {
      return '';
    }
  }

  function notify(message, type = 'error') {
    if (typeof window.showMessage === 'function') {
      window.showMessage(message, type);
      return;
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type === 'error' ? 'error' : 'success'}`;
    toast.setAttribute('role', 'alert');
    toast.textContent = message;
    toast.style.cssText = 'position:fixed;top:20px;right:20px;z-index:10002;max-width:min(420px,calc(100vw - 40px));';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  async function apiRequest(endpoint, method = 'GET', data = null) {
    if (window.apiClient && typeof window.apiClient.makeAuthenticatedRequest === 'function') {
      return window.apiClient.makeAuthenticatedRequest(endpoint, method, data);
    }
    const token = getToken();
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (data != null) headers['Content-Type'] = 'application/json';
    const response = await fetch(endpoint, {
      method,
      headers,
      body: data != null ? JSON.stringify(data) : undefined
    });
    let result = {};
    try { result = await response.json(); } catch (_) {}
    return {
      success: response.ok,
      data: result,
      status: response.status,
      error: (result && result.error) || ''
    };
  }

  const STYLES = `
    #stickerStoreModal { z-index: 2040; }
    .sst-search-wrap { position: relative; margin-bottom: 12px; }
    .sst-search-wrap i { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--text-muted); pointer-events: none; }
    .sst-search-wrap input { width: 100%; box-sizing: border-box; padding: 10px 14px 10px 36px; background: var(--background-tertiary); border: 1px solid var(--background-accent); border-radius: 8px; color: var(--text-normal); font-size: 14px; font-family: inherit; }
    .sst-search-wrap input:focus { outline: none; border-color: var(--blurple); }
    .sst-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; max-height: 460px; overflow-y: auto; padding: 2px; }
    .sst-card { background: var(--background-tertiary); border: 1px solid var(--background-accent); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; transition: border-color 0.15s, box-shadow 0.15s; }
    .sst-card:hover { border-color: rgba(255,255,255,0.18); box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
    .sst-card.subscribed { border-color: var(--blurple); }
    .sst-preview { display: flex; gap: 6px; height: 42px; align-items: center; cursor: pointer; }
    .sst-preview img { width: 38px; height: 38px; object-fit: contain; background: var(--background-secondary); border-radius: 6px; padding: 2px; }
    .sst-preview-empty { color: var(--text-muted); font-size: 12px; font-style: italic; }
    .sst-title { color: var(--text-normal); font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
    .sst-title:hover { color: var(--blurple); }
    .sst-description { color: var(--text-muted); font-size: 12px; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sst-meta { color: var(--text-muted); font-size: 12px; display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: auto; }
    .sst-own-badge { flex-shrink: 0; padding: 2px 9px; border-radius: 12px; font-size: 11px; font-weight: 600; background: rgba(59,165,93,0.18); color: var(--green); }
    .sst-empty { grid-column: 1 / -1; color: var(--text-muted); font-size: 13px; text-align: center; padding: 36px 12px; }
    @media (max-width: 540px) {
      .sst-grid { grid-template-columns: 1fr; max-height: 60vh; }
    }
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
            <button class="modal-close" id="stickerStoreCloseBtn" type="button" aria-label="Закрыть">&times;</button>
          </div>
          <div class="modal-body">
            <div class="sst-search-wrap">
              <i class="fas fa-search"></i>
              <input type="text" id="stickerStoreSearch" placeholder="Поиск наборов по названию…" aria-label="Поиск наборов по названию">
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

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.isOpen()) {
          this.close();
        }
      });

      this._els = { overlay, grid: overlay.querySelector('#stickerStoreGrid'), searchEl };
      return this._els;
    }

    isOpen() {
      return Boolean(this._els && !this._els.overlay.hidden);
    }

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

    async refresh() {
      if (this.isOpen()) {
        await this.load(this._els?.searchEl?.value || '');
      }
      this._onChange?.();
    }

    async load(search) {
      const els = this._els;
      if (!els) return;
      const query = (search || '').trim();
      const token = getToken();
      if (!token) {
        els.grid.innerHTML = `
          <div class="sst-empty">
            <div style="font-size:14px;margin-bottom:10px;">Для просмотра каталога стикеров необходимо войти в аккаунт.</div>
            <button type="button" class="btn btn-primary btn-sm" id="sstLoginBtn">
              <i class="fas fa-right-to-bracket"></i> Войти
            </button>
          </div>`;
        els.grid.querySelector('#sstLoginBtn')?.addEventListener('click', () => {
          if (typeof window.showModalLogin === 'function') window.showModalLogin('login');
          else window.location.href = '/admin-panel';
        });
        return;
      }

      els.grid.innerHTML = `<div class="sst-empty">Загрузка…</div>`;
      try {
        let packs = [];
        if (window.apiClient && typeof window.apiClient.getStickerCatalog === 'function') {
          const res = await window.apiClient.getStickerCatalog(query);
          packs = res.success ? (res.data || []) : (Array.isArray(res) ? res : []);
        } else {
          const res = await apiRequest(`/api/stickers/catalog${query ? '?q=' + encodeURIComponent(query) : ''}`, 'GET');
          packs = res.success ? (res.data || []) : [];
        }
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
            <div class="sst-preview" data-open-pack="${p.id}" title="Просмотреть все стикеры набора">${previewHtml}</div>
            <div class="sst-title" data-open-pack="${p.id}" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</div>
            ${descriptionHtml}
            <div class="sst-meta"><span>от ${escapeHtml(p.authorName || 'автора')} · ${count} шт.</span>${ownBadge}</div>
            ${actionBtn}
          </div>`;
      }).join('');

      els.grid.querySelectorAll('[data-open-pack]').forEach((node) => {
        node.addEventListener('click', () => {
          const packId = node.dataset.openPack;
          if (packId && window.stickerPackView && typeof window.stickerPackView.open === 'function') {
            window.stickerPackView.open(packId);
          }
        });
      });

      els.grid.querySelectorAll('[data-pack-id]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggle(btn.dataset.packId, btn.dataset.subscribed === '1', btn);
        });
      });
    }

    async toggle(packId, isSubscribed, btn) {
      if (btn) btn.disabled = true;
      try {
        if (window.apiClient && typeof window.apiClient.subscribeStickerPack === 'function') {
          if (isSubscribed) await window.apiClient.unsubscribeStickerPack(packId);
          else await window.apiClient.subscribeStickerPack(packId);
        } else {
          const method = isSubscribed ? 'DELETE' : 'POST';
          const res = await apiRequest(`/api/stickers/packs/${encodeURIComponent(packId)}/subscribe`, method);
          if (!res.success) throw new Error(res.error || 'Не удалось обновить подписку');
        }
        await this.load(this._els?.searchEl?.value || '');
        this._onChange?.();
      } catch (e) {
        notify(e.message || 'Не удалось изменить подписку на набор', 'error');
        if (btn) btn.disabled = false;
      }
    }
  }

  window.stickerStore = new StickerStore();
})();
