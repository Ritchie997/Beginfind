// stickers-manager.js — вкладка "Стикеры" в админ-панели: создание своих
// наборов, каталог одобренных наборов (+ подписка "добавить себе"),
// модерация (approve/reject) для тех, у кого есть право moderate_stickers.
//
// Один и тот же шорткод ":slug:alias:" используется в двух режимах —
// маленькая инлайн-картинка внутри текста комментария, или отдельный
// крупный "стикер", если это весь текст целиком (см. рендер в ibripedia.js
// и validateContentForPosting/attachStickersToItems в
// src/services/stickers-store.js). Эта страница только управляет наборами;
// вставка шорткода в комментарий — отдельный пикер там же, в ibripedia.js.

(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  const STATUS_LABELS = { pending: 'На модерации', approved: 'Подтверждён', rejected: 'Отклонён' };

  class StickersManager {
    constructor() {
      this.currentTab = 'catalog';
      this.canModerate = false;
      this.selectedFile = null;
      this.currentPack = null;
      this.currentPackMode = null; // 'own' | 'catalog' | 'review'
      this._searchDebounce = null;
      // Модалка "причина" (stickersRejectModal) обслуживает и отклонение
      // заявки из очереди на модерации, и отзыв уже одобренного чужого
      // набора (см. openRejectModal/openRevokeModal/submitReasonModal) —
      // одна и та же форма "заголовок + необязательная причина", разное
      // действие на confirm.
      this._reasonModalAction = null; // 'reject' | 'revoke'
    }

    async init() {
      this.tabsEl = document.getElementById('stickersTabs');
      this.pendingTabBtn = document.getElementById('stickersPendingTabBtn');
      this.pendingBadge = document.getElementById('stickersPendingBadge');
      if (!this.tabsEl) return; // партиал ещё не в DOM

      const user = (window.authManager && authManager.getUser()) || {};
      this.canModerate = !!(user.is_root || (user.permissions && user.permissions.moderate_stickers));
      if (this.pendingTabBtn) this.pendingTabBtn.hidden = !this.canModerate;

      this.bindEvents();
      this.currentTab = 'catalog';
      await this.loadCatalog();
      if (this.canModerate) this.refreshPendingBadge();
    }

    bindEvents() {
      this.tabsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-stickers-tab]');
        if (btn) this.switchTab(btn.dataset.stickersTab);
      });

      document.getElementById('stickersCreateBtn')?.addEventListener('click', () => this.openCreateModal());
      document.getElementById('stickersMineEmptyCreateBtn')?.addEventListener('click', () => this.openCreateModal());
      document.getElementById('stickersCreateCloseBtn')?.addEventListener('click', () => this.closeCreateModal());
      document.getElementById('stickersCreateCancelBtn')?.addEventListener('click', () => this.closeCreateModal());
      document.getElementById('stickersCreateConfirmBtn')?.addEventListener('click', () => this.submitCreate());
      document.getElementById('stickersCreateModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'stickersCreateModal') this.closeCreateModal();
      });
      document.getElementById('stickersCreateTitle')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.submitCreate();
      });

      let searchInput = document.getElementById('stickersCatalogSearch');
      searchInput?.addEventListener('input', () => {
        clearTimeout(this._searchDebounce);
        this._searchDebounce = setTimeout(() => this.loadCatalog(searchInput.value), 250);
      });

      document.getElementById('stickersPackModalCloseBtn')?.addEventListener('click', () => this.closePackModal());
      document.getElementById('stickersPackModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'stickersPackModal') this.closePackModal();
      });

      document.getElementById('stickersUploadPickBtn')?.addEventListener('click', () => {
        document.getElementById('stickersUploadFileInput')?.click();
      });
      document.getElementById('stickersUploadFileInput')?.addEventListener('change', (e) => {
        this.selectedFile = e.target.files?.[0] || null;
        const label = document.getElementById('stickersUploadFileName');
        if (label) label.textContent = this.selectedFile ? this.selectedFile.name : 'Выбрать файл';
      });
      document.getElementById('stickersUploadConfirmBtn')?.addEventListener('click', () => this.submitUpload());

      document.getElementById('stickersRejectCloseBtn')?.addEventListener('click', () => this.closeRejectModal());
      document.getElementById('stickersRejectCancelBtn')?.addEventListener('click', () => this.closeRejectModal());
      document.getElementById('stickersRejectModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'stickersRejectModal') this.closeRejectModal();
      });
      document.getElementById('stickersRejectConfirmBtn')?.addEventListener('click', () => this.submitReasonModal());
    }

    switchTab(tab) {
      if (tab === 'pending' && !this.canModerate) return;
      this.currentTab = tab;
      this.tabsEl.querySelectorAll('[data-stickers-tab]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.stickersTab === tab);
      });
      document.getElementById('stickersPanelCatalog').hidden = tab !== 'catalog';
      document.getElementById('stickersPanelMine').hidden = tab !== 'mine';
      document.getElementById('stickersPanelPending').hidden = tab !== 'pending';

      if (tab === 'catalog') this.loadCatalog(document.getElementById('stickersCatalogSearch')?.value);
      else if (tab === 'mine') this.loadMine();
      else if (tab === 'pending') this.loadPending();
    }

    // Перегрузить ту вкладку-список, что сейчас открыта — после действия над
    // набором, автор которого необязательно текущий пользователь (модерация
    // чужого набора из каталога), обновлять нужно именно её, а не всегда
    // "Мои наборы", как раньше подразумевали renamePack()/deletePack().
    async refreshCurrentList() {
      if (this.currentTab === 'catalog') await this.loadCatalog(document.getElementById('stickersCatalogSearch')?.value);
      else if (this.currentTab === 'mine') await this.loadMine();
      else if (this.currentTab === 'pending') await this.loadPending();
    }

    // ---------- Каталог ----------

    async loadCatalog(search) {
      const loadingEl = document.getElementById('stickersCatalogLoading');
      const emptyEl = document.getElementById('stickersCatalogEmpty');
      const gridEl = document.getElementById('stickersCatalogGrid');
      loadingEl.style.display = 'block';
      emptyEl.hidden = true;
      gridEl.hidden = true;

      try {
        const result = await window.apiClient.getStickerCatalog(search || '');
        const packs = result.success ? (result.data || []) : [];
        loadingEl.style.display = 'none';
        if (!packs.length) {
          emptyEl.hidden = false;
          // Раньше здесь grid.innerHTML не трогали — если список опустел
          // именно этим действием (например, отписались от последнего
          // набора), старая карточка так и оставалась в разметке.
          gridEl.innerHTML = '';
          return;
        }
        gridEl.hidden = false;
        gridEl.innerHTML = packs.map((p) => this.renderPackCard(p, 'catalog')).join('');
        gridEl.querySelectorAll('[data-open-pack]').forEach((card) => {
          card.addEventListener('click', () => this.openPackModal(card.dataset.openPack, card.dataset.openMode));
        });
        gridEl.querySelectorAll('[data-toggle-sub]').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleSubscribe(btn.dataset.toggleSub, btn.dataset.subscribed === '1');
          });
        });
      } catch (e) {
        loadingEl.style.display = 'none';
        showMessage('Не удалось загрузить каталог наборов', 'error');
      }
    }

    async toggleSubscribe(packId, isSubscribed) {
      try {
        if (isSubscribed) await window.apiClient.unsubscribeStickerPack(packId);
        else await window.apiClient.subscribeStickerPack(packId);
        await this.loadCatalog(document.getElementById('stickersCatalogSearch')?.value);
      } catch (e) {
        showMessage('Не удалось изменить подписку на набор', 'error');
      }
    }

    // ---------- Мои наборы ----------

    async loadMine() {
      const loadingEl = document.getElementById('stickersMineLoading');
      const emptyEl = document.getElementById('stickersMineEmpty');
      const gridEl = document.getElementById('stickersMineGrid');
      loadingEl.style.display = 'block';
      emptyEl.hidden = true;
      gridEl.hidden = true;

      try {
        const result = await window.apiClient.getMyStickerPacks();
        const packs = result.success ? (result.data || []) : [];
        loadingEl.style.display = 'none';
        if (!packs.length) {
          emptyEl.hidden = false;
          // См. тот же комментарий в loadCatalog: набор удалили/он остался
          // последним — очищаем сетку явно, а не полагаемся на то, что
          // gridEl.hidden спрячет уже отрисованную карточку.
          gridEl.innerHTML = '';
          return;
        }
        gridEl.hidden = false;
        gridEl.innerHTML = packs.map((p) => this.renderPackCard(p, 'mine')).join('');
        gridEl.querySelectorAll('[data-open-pack]').forEach((card) => {
          card.addEventListener('click', () => this.openPackModal(card.dataset.openPack, card.dataset.openMode));
        });
      } catch (e) {
        loadingEl.style.display = 'none';
        showMessage('Не удалось загрузить ваши наборы', 'error');
      }
    }

    // ---------- На модерации ----------

    async loadPending() {
      const loadingEl = document.getElementById('stickersPendingLoading');
      const emptyEl = document.getElementById('stickersPendingEmpty');
      const gridEl = document.getElementById('stickersPendingGrid');
      loadingEl.style.display = 'block';
      emptyEl.hidden = true;
      gridEl.hidden = true;

      try {
        const result = await window.apiClient.getPendingStickerPacks();
        const packs = result.success ? (result.data || []) : [];
        loadingEl.style.display = 'none';
        this.updatePendingBadge(packs.length);
        if (!packs.length) {
          emptyEl.hidden = false;
          // См. тот же комментарий в loadCatalog: заявку только что
          // подтвердили/отклонили — она перестала быть последней pending,
          // очищаем сетку явно, а не полагаемся на gridEl.hidden.
          gridEl.innerHTML = '';
          return;
        }
        gridEl.hidden = false;
        gridEl.innerHTML = packs.map((p) => this.renderPackCard(p, 'pending')).join('');
        gridEl.querySelectorAll('[data-open-pack]').forEach((card) => {
          card.addEventListener('click', () => this.openPackModal(card.dataset.openPack, card.dataset.openMode));
        });
      } catch (e) {
        loadingEl.style.display = 'none';
        showMessage('Не удалось загрузить заявки на модерацию', 'error');
      }
    }

    async refreshPendingBadge() {
      try {
        const result = await window.apiClient.getPendingStickerPacks();
        this.updatePendingBadge(result.success ? (result.data || []).length : 0);
      } catch (e) { /* тихо — это просто бейдж */ }
    }

    updatePendingBadge(count) {
      if (!this.pendingBadge) return;
      this.pendingBadge.hidden = !count;
      this.pendingBadge.textContent = String(count);
    }

    // ---------- Карточка набора ----------

    renderPackCard(pack, context) {
      const stickers = pack.stickers || [];
      const previewSrc = stickers.slice(0, 3);
      const count = pack.stickersCount ?? stickers.length;

      const preview = previewSrc.length
        ? previewSrc.map((s) => `<img src="${escapeHtml(s.fileUrl)}" alt="">`).join('') +
          (count > previewSrc.length ? `<span class="stickers-pack-preview-more">+${count - previewSrc.length}</span>` : '')
        : `<span class="stickers-pack-preview-empty">Пусто</span>`;

      let metaRight = '';
      let actions = '';
      let openMode = context === 'mine' ? 'own' : context === 'pending' ? 'review' : 'catalog';

      if (context === 'catalog') {
        metaRight = `<span class="stickers-status-badge approved">${count} шт.</span>`;
        actions = pack.isOwn
          ? `<div class="stickers-pack-card-actions"><span class="stickers-status-badge approved" style="flex:1;text-align:center;">Ваш набор</span></div>`
          : `<div class="stickers-pack-card-actions">
               <button type="button" class="btn ${pack.subscribed ? 'btn-secondary' : 'btn-primary'} btn-sm" data-toggle-sub="${pack.id}" data-subscribed="${pack.subscribed ? '1' : '0'}">
                 ${pack.subscribed ? '<i class="fas fa-check"></i> Добавлено' : '<i class="fas fa-plus"></i> Добавить'}
               </button>
             </div>`;
      } else if (context === 'mine') {
        metaRight = `<span class="stickers-status-badge ${pack.status}">${STATUS_LABELS[pack.status] || pack.status}</span>`;
        actions = `<div class="stickers-pack-card-actions"><button type="button" class="btn btn-secondary btn-sm">Открыть · ${count} шт.</button></div>`;
      } else {
        metaRight = `<span class="stickers-status-badge pending">${count} шт.</span>`;
        actions = `<div class="stickers-pack-card-actions"><button type="button" class="btn btn-secondary btn-sm">Проверить набор</button></div>`;
      }

      const authorLine = context === 'catalog'
        ? `от ${escapeHtml(pack.authorName)}`
        : context === 'pending'
          ? `${escapeHtml(pack.authorName)} · ${formatDate(pack.createdAt)}`
          : formatDate(pack.createdAt);

      const description = pack.description
        ? `<div class="stickers-pack-card-description" title="${escapeHtml(pack.description)}">${escapeHtml(pack.description)}</div>`
        : '';

      return `
        <div class="stickers-pack-card" data-open-pack="${pack.id}" data-open-mode="${openMode}">
          <div class="stickers-pack-preview">${preview}</div>
          <div class="stickers-pack-card-title" title="${escapeHtml(pack.title)}">${escapeHtml(pack.title)}</div>
          ${description}
          <div class="stickers-pack-card-meta"><span>${authorLine}</span>${metaRight}</div>
          ${actions}
        </div>`;
    }

    // ---------- Модалка "Создать набор" ----------

    openCreateModal() {
      document.getElementById('stickersCreateTitle').value = '';
      document.getElementById('stickersCreateDescription').value = '';
      document.getElementById('stickersCreateModal').hidden = false;
      document.getElementById('stickersCreateTitle').focus();
    }

    closeCreateModal() {
      document.getElementById('stickersCreateModal').hidden = true;
    }

    async submitCreate() {
      const title = document.getElementById('stickersCreateTitle').value.trim();
      const description = document.getElementById('stickersCreateDescription').value.trim();
      if (!title) { showMessage('Введите название набора', 'warning'); return; }

      try {
        const result = await window.apiClient.createStickerPack(title, description);
        if (!result.success) {
          showMessage(`Не удалось создать набор: ${result.data?.error || result.error || ''}`, 'error');
          return;
        }
        this.closeCreateModal();
        showMessage('Набор создан — теперь добавьте в него стикеры', 'success');
        await this.loadMine();
        this.switchTab('mine');
        this.openPackModal(result.data.id, 'own');
      } catch (e) {
        showMessage('Неожиданная ошибка при создании набора', 'error');
      }
    }

    // ---------- Модалка набора (просмотр/загрузка/модерация) ----------

    async openPackModal(packId, mode) {
      try {
        const result = await window.apiClient.getStickerPack(packId);
        if (!result.success) {
          showMessage(`Не удалось открыть набор: ${result.data?.error || result.error || ''}`, 'error');
          return;
        }
        this.currentPack = result.data;
        this.currentPackMode = mode;
        this.selectedFile = null;
        this.renderPackModal();
        document.getElementById('stickersPackModal').hidden = false;
      } catch (e) {
        showMessage('Неожиданная ошибка при открытии набора', 'error');
      }
    }

    closePackModal() {
      document.getElementById('stickersPackModal').hidden = true;
      this.currentPack = null;
      this.currentPackMode = null;
    }

    renderPackModal() {
      const pack = this.currentPack;
      const mode = this.currentPackMode;
      if (!pack) return;

      document.getElementById('stickersPackModalTitle').textContent = pack.title;

      const metaEl = document.getElementById('stickersPackModalMeta');
      metaEl.innerHTML = `
        <span class="stickers-status-badge ${pack.status}">${STATUS_LABELS[pack.status] || pack.status}</span>
        <span>Автор: ${escapeHtml(pack.authorName)}</span>
        <span>Создан: ${formatDate(pack.createdAt)}</span>
        <span>Стикеров: ${pack.stickers.length}</span>
      `;

      // Всегда убираем прошлый блок причины перед тем, как решать, нужен ли
      // новый — иначе при повторном renderPackModal() на всё ещё отклонённом
      // наборе (например, сразу после добавления стикера, до resubmit)
      // блок причины дублировался бы на каждый re-render.
      document.getElementById('stickersPackRejectBox')?.remove();
      if (pack.status === 'rejected' && pack.rejectReason) {
        metaEl.insertAdjacentHTML('afterend',
          `<div class="stickers-reject-reason-box" id="stickersPackRejectBox"><i class="fas fa-triangle-exclamation"></i> Причина отклонения: ${escapeHtml(pack.rejectReason)}</div>`);
      }

      const gridEl = document.getElementById('stickersPackModalGrid');
      // Удалять отдельные стикеры может и модератор из чужого набора (см.
      // pack.canModerate — тот же canModerateOtherUsersPack, что и на
      // сервере), а вот ЗАГРУЖАТЬ новые в чужой набор — нет: это было бы
      // выдачей себя за автора, upload-строка ниже остаётся own-only.
      const canRemoveStickers = mode === 'own' || !!pack.canModerate;
      const canUpload = mode === 'own';
      gridEl.innerHTML = pack.stickers.length
        ? pack.stickers.map((s) => `
            <div class="stickers-tile" data-shortcode=":${pack.slug}:${s.alias}:" title="Шорткод: :${escapeHtml(pack.slug)}:${escapeHtml(s.alias)}:">
              <img src="${escapeHtml(s.fileUrl)}" alt="${escapeHtml(s.alias)}">
              <div class="stickers-tile-alias">${escapeHtml(s.alias)}</div>
              ${canRemoveStickers ? `<button type="button" class="stickers-tile-remove" data-remove-sticker="${s.id}" title="Удалить стикер">&times;</button>` : ''}
            </div>`).join('')
        : `<div class="stickers-grid-empty">В наборе пока нет стикеров</div>`;

      gridEl.querySelectorAll('[data-shortcode]').forEach((tile) => {
        tile.addEventListener('click', (e) => {
          if (e.target.closest('[data-remove-sticker]')) return;
          this.copyShortcode(tile.dataset.shortcode);
        });
      });
      gridEl.querySelectorAll('[data-remove-sticker]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.removeSticker(btn.dataset.removeSticker);
        });
      });

      document.getElementById('stickersPackModalUploadRow').hidden = !canUpload;
      if (canUpload) {
        document.getElementById('stickersUploadFileInput').value = '';
        document.getElementById('stickersUploadAliasInput').value = '';
        document.getElementById('stickersUploadFileName').textContent = 'Выбрать файл';
      }

      document.getElementById('stickersPackModalFooter').innerHTML = this.renderPackModalFooter(pack, mode);
      this.bindPackModalFooter(pack, mode);
    }

    renderPackModalFooter(pack, mode) {
      if (mode === 'own') {
        const resubmit = pack.status === 'rejected'
          ? `<button type="button" class="btn btn-primary" id="stickersResubmitBtn"><i class="fas fa-rotate-right"></i> Отправить повторно</button>`
          : '';
        return `
          <button type="button" class="btn btn-secondary" id="stickersRenameBtn"><i class="fas fa-pen"></i> Переименовать</button>
          ${resubmit}
          <button type="button" class="btn btn-danger" id="stickersDeletePackBtn"><i class="fas fa-trash"></i> Удалить набор</button>
        `;
      }
      if (mode === 'review') {
        return `
          <button type="button" class="btn btn-danger" id="stickersRejectBtn"><i class="fas fa-xmark"></i> Отклонить</button>
          <button type="button" class="btn btn-success" id="stickersApproveBtn"><i class="fas fa-check"></i> Подтвердить</button>
        `;
      }
      // catalog: чужой набор — переключатель подписки всем, плюс модерация
      // (изменить/отозвать/удалить) для тех, у кого canModerate (см.
      // canModerateOtherUsersPack в src/routes/stickers.routes.js — право
      // moderate_stickers И автор набора строго ниже по иерархии).
      const subscribed = !!pack.subscribed;
      const subBtn = `
        <button type="button" class="btn ${subscribed ? 'btn-secondary' : 'btn-primary'}" id="stickersCatalogSubBtn">
          ${subscribed ? '<i class="fas fa-xmark"></i> Убрать' : '<i class="fas fa-plus"></i> Добавить себе'}
        </button>
      `;
      if (!pack.canModerate) return subBtn;

      const revokeBtn = pack.status === 'approved'
        ? `<button type="button" class="btn btn-warning" id="stickersRevokePackBtn"><i class="fas fa-rotate-left"></i> Отозвать</button>`
        : '';
      return `
        ${subBtn}
        <button type="button" class="btn btn-secondary" id="stickersModRenameBtn"><i class="fas fa-pen"></i> Изменить</button>
        ${revokeBtn}
        <button type="button" class="btn btn-danger" id="stickersModDeletePackBtn"><i class="fas fa-trash"></i> Удалить</button>
      `;
    }

    bindPackModalFooter(pack, mode) {
      if (mode === 'own') {
        document.getElementById('stickersRenameBtn')?.addEventListener('click', () => this.renamePack());
        document.getElementById('stickersResubmitBtn')?.addEventListener('click', () => this.resubmitPack());
        document.getElementById('stickersDeletePackBtn')?.addEventListener('click', () => this.deletePack(true));
      } else if (mode === 'review') {
        document.getElementById('stickersApproveBtn')?.addEventListener('click', () => this.approvePending());
        document.getElementById('stickersRejectBtn')?.addEventListener('click', () => this.openRejectModal());
      } else {
        document.getElementById('stickersCatalogSubBtn')?.addEventListener('click', async () => {
          await this.toggleSubscribe(pack.id, !!pack.subscribed);
          await this.openPackModal(pack.id, 'catalog');
        });
        document.getElementById('stickersModRenameBtn')?.addEventListener('click', () => this.renamePack());
        document.getElementById('stickersRevokePackBtn')?.addEventListener('click', () => this.openRevokeModal());
        document.getElementById('stickersModDeletePackBtn')?.addEventListener('click', () => this.deletePack());
      }
    }

    copyShortcode(code) {
      const done = () => showMessage(`Шорткод ${code} скопирован`, 'success');
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(code).then(done).catch(() => showMessage(code, 'info'));
      } else {
        showMessage(code, 'info');
      }
    }

    async submitUpload() {
      if (!this.currentPack) return;
      const alias = document.getElementById('stickersUploadAliasInput').value.trim();
      if (!this.selectedFile) { showMessage('Выберите файл стикера', 'warning'); return; }
      if (!alias) { showMessage('Укажите имя стикера (латиницей)', 'warning'); return; }

      const btn = document.getElementById('stickersUploadConfirmBtn');
      if (btn) btn.disabled = true;
      try {
        const result = await window.apiClient.uploadSticker(this.currentPack.id, this.selectedFile, alias);
        if (!result.success) {
          showMessage(`Не удалось загрузить стикер: ${result.data?.error || result.error || ''}`, 'error');
          return;
        }
        this.selectedFile = null;
        await this.openPackModal(this.currentPack.id, 'own');
      } catch (e) {
        showMessage('Неожиданная ошибка при загрузке стикера', 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    async removeSticker(stickerId) {
      if (!confirm('Удалить этот стикер из набора?')) return;
      try {
        const result = await window.apiClient.deleteSticker(stickerId);
        if (!result.success) {
          showMessage(`Не удалось удалить стикер: ${result.data?.error || result.error || ''}`, 'error');
          return;
        }
        await this.openPackModal(this.currentPack.id, this.currentPackMode);
      } catch (e) {
        showMessage('Неожиданная ошибка при удалении стикера', 'error');
      }
    }

    async renamePack() {
      const newTitle = prompt('Новое название набора:', this.currentPack.title);
      if (newTitle == null) return;
      const trimmed = newTitle.trim();
      if (!trimmed) return;

      // Тем же прямым prompt()-подходом, что и название — описание короткое
      // (до 200 символов), полноценная форма ради одного текстового поля
      // была бы избыточна. Пустая строка — осознанно очистить описание,
      // Cancel (null) — не менять его вовсе.
      const newDescription = prompt('Описание набора (необязательно, до 200 символов):', this.currentPack.description || '');
      const description = newDescription == null ? undefined : newDescription.trim().slice(0, 200);

      try {
        const result = await window.apiClient.renameStickerPack(this.currentPack.id, trimmed, description);
        if (!result.success) {
          showMessage(`Не удалось переименовать набор: ${result.data?.error || result.error || ''}`, 'error');
          return;
        }
        await this.openPackModal(this.currentPack.id, this.currentPackMode);
        // Не обязательно "Мои наборы" — тем же путём переименовывает и
        // модератор чужой набор из каталога (см. renderPackModalFooter),
        // тогда актуальную карточку нужно обновить в открытой сейчас вкладке.
        await this.refreshCurrentList();
      } catch (e) {
        showMessage('Неожиданная ошибка при переименовании набора', 'error');
      }
    }

    async resubmitPack() {
      try {
        const result = await window.apiClient.resubmitStickerPack(this.currentPack.id);
        if (!result.success) {
          showMessage(`Не удалось отправить набор на модерацию: ${result.data?.error || result.error || ''}`, 'error');
          return;
        }
        showMessage('Набор отправлен на повторную модерацию', 'success');
        await this.openPackModal(this.currentPack.id, this.currentPackMode);
        await this.loadMine();
      } catch (e) {
        showMessage('Неожиданная ошибка', 'error');
      }
    }

    async deletePack() {
      if (!confirm(`Удалить набор «${this.currentPack.title}» вместе со всеми стикерами? Это необратимо.`)) return;
      try {
        const result = await window.apiClient.deleteStickerPack(this.currentPack.id);
        if (!result.success) {
          showMessage(`Не удалось удалить набор: ${result.data?.error || result.error || ''}`, 'error');
          return;
        }
        this.closePackModal();
        showMessage('Набор удалён', 'success');
        // Аналогично renamePack() — набор необязательно свой (модератор
        // мог удалить чужой прямо из каталога), обновляем ту вкладку,
        // которая сейчас реально открыта.
        await this.refreshCurrentList();
        if (this.canModerate) await this.refreshPendingBadge();
      } catch (e) {
        showMessage('Неожиданная ошибка при удалении набора', 'error');
      }
    }

    async approvePending() {
      try {
        const result = await window.apiClient.approveStickerPack(this.currentPack.id);
        if (!result.success) {
          showMessage(`Не удалось подтвердить набор: ${result.data?.error || result.error || ''}`, 'error');
          return;
        }
        showMessage('Набор подтверждён', 'success');
        this.closePackModal();
        await this.loadPending();
      } catch (e) {
        showMessage('Неожиданная ошибка при подтверждении набора', 'error');
      }
    }

    // Модалка "причина" общая для двух разных действий — отклонения заявки
    // из очереди (mode 'review') и отзыва уже одобренного чужого набора
    // (mode 'catalog', см. renderPackModalFooter) — заголовок и текст кнопки
    // подстраиваются под this._reasonModalAction, submitReasonModal() внизу
    // решает, какой эндпоинт дёрнуть.
    openReasonModal(action, title, confirmLabel, confirmClass) {
      this._reasonModalAction = action;
      document.querySelector('#stickersRejectModal .modal-header h3').textContent = title;
      const confirmBtn = document.getElementById('stickersRejectConfirmBtn');
      confirmBtn.textContent = confirmLabel;
      confirmBtn.className = `btn ${confirmClass}`;
      document.getElementById('stickersRejectReason').value = '';
      document.getElementById('stickersRejectModal').hidden = false;
    }

    openRejectModal() {
      this.openReasonModal('reject', 'Отклонить набор', 'Отклонить', 'btn-danger');
    }

    openRevokeModal() {
      this.openReasonModal('revoke', 'Отозвать набор', 'Отозвать', 'btn-warning');
    }

    closeRejectModal() {
      document.getElementById('stickersRejectModal').hidden = true;
    }

    async submitReasonModal() {
      const reason = document.getElementById('stickersRejectReason').value.trim();
      const action = this._reasonModalAction;
      try {
        const result = action === 'revoke'
          ? await window.apiClient.revokeStickerPack(this.currentPack.id, reason)
          : await window.apiClient.rejectStickerPack(this.currentPack.id, reason);
        if (!result.success) {
          showMessage(`Не удалось ${action === 'revoke' ? 'отозвать' : 'отклонить'} набор: ${result.data?.error || result.error || ''}`, 'error');
          return;
        }
        this.closeRejectModal();
        this.closePackModal();
        showMessage(action === 'revoke' ? 'Набор отозван' : 'Набор отклонён', 'success');
        if (action === 'revoke') await this.refreshCurrentList();
        else await this.loadPending();
      } catch (e) {
        showMessage('Неожиданная ошибка', 'error');
      }
    }
  }

  window.stickersManager = new StickersManager();
})();
