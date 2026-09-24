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

  const STATUS_LABELS = { draft: 'Черновик', pending: 'На модерации', approved: 'Подтверждён', rejected: 'Отклонён' };

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
      // Коллаборация в окне чужого набора: файл, выбранный для загрузки, и
      // черновик сопроводительного сообщения (переживает перерисовку окна
      // после загрузки/удаления стикера).
      this.collabFile = null;
      this._collabMessage = '';
    }

    async init() {
      this.tabsEl = document.getElementById('stickersTabs');
      this.pendingTabBtn = document.getElementById('stickersPendingTabBtn');
      this.pendingBadge = document.getElementById('stickersPendingBadge');
      this.collabBadge = document.getElementById('stickersCollabBadge');
      if (!this.tabsEl) return; // партиал ещё не в DOM

      const user = (window.authManager && authManager.getUser()) || {};
      this.canModerate = !!(user.is_root || (user.permissions && user.permissions.moderate_stickers));
      if (this.pendingTabBtn) this.pendingTabBtn.hidden = !this.canModerate;

      this.bindEvents();
      this.currentTab = 'catalog';
      await this.loadCatalog();
      if (this.canModerate) this.refreshPendingBadge();
      // Предложения коллабораций приходят любому автору, не только модератору —
      // при заходе в раздел сразу показываем уведомление, если они есть.
      this.refreshCollabBadge();
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
      document.getElementById('stickersCreateConfirmBtn')?.addEventListener('click', (e) => runExclusive(e.currentTarget, () => this.submitCreate()));
      document.getElementById('stickersCreateModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'stickersCreateModal') this.closeCreateModal();
      });
      document.getElementById('stickersCreateTitle')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') runExclusive(document.getElementById('stickersCreateConfirmBtn'), () => this.submitCreate());
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

      document.getElementById('stickersCollabBannerBtn')?.addEventListener('click', () => this.switchTab('collab'));
      document.getElementById('stickersPanelCollab')?.addEventListener('click', (e) => {
        const accept = e.target.closest('[data-collab-accept]');
        const decline = e.target.closest('[data-collab-decline]');
        const cancel = e.target.closest('[data-collab-cancel]');
        const open = e.target.closest('[data-open-pack]');
        if (accept) this.acceptCollab(accept.dataset.collabAccept, accept.dataset.name);
        else if (decline) this.declineCollab(decline.dataset.collabDecline, decline.dataset.name);
        else if (cancel) this.cancelCollabRequest(cancel.dataset.collabCancel);
        else if (open) this.openPackModal(open.dataset.openPack, open.dataset.openMode);
      });

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
      document.getElementById('stickersPanelCollab').hidden = tab !== 'collab';
      document.getElementById('stickersPanelPending').hidden = tab !== 'pending';

      if (tab === 'catalog') this.loadCatalog(document.getElementById('stickersCatalogSearch')?.value);
      else if (tab === 'mine') this.loadMine();
      else if (tab === 'collab') this.loadCollab();
      else if (tab === 'pending') this.loadPending();
    }

    // Перегрузить ту вкладку-список, что сейчас открыта — после действия над
    // набором, автор которого необязательно текущий пользователь (модерация
    // чужого набора из каталога), обновлять нужно именно её, а не всегда
    // "Мои наборы", как раньше подразумевали renamePack()/deletePack().
    async refreshCurrentList() {
      if (this.currentTab === 'catalog') await this.loadCatalog(document.getElementById('stickersCatalogSearch')?.value);
      else if (this.currentTab === 'mine') await this.loadMine();
      else if (this.currentTab === 'collab') await this.loadCollab();
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
        // Быстрая публикация прямо с карточки черновика — не открывая набор.
        gridEl.querySelectorAll('[data-publish-pack]').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.publishPack(btn.dataset.publishPack);
          });
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

    // ---------- Коллаборации ----------

    stickerWord(n) {
      const m10 = n % 10;
      const m100 = n % 100;
      if (m10 === 1 && m100 !== 11) return 'стикер';
      if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'стикера';
      return 'стикеров';
    }

    // Бейдж на вкладке + уведомление-баннер вверху раздела: автор видит, что
    // ему предложили коллаборацию, ещё не заходя во вкладку.
    updateCollabBadge(count) {
      if (this.collabBadge) {
        this.collabBadge.hidden = !count;
        this.collabBadge.textContent = String(count);
      }
      const banner = document.getElementById('stickersCollabBanner');
      if (banner) {
        banner.hidden = !count;
        const text = document.getElementById('stickersCollabBannerText');
        if (text) {
          text.textContent = count === 1
            ? 'Вам предложили коллаборацию в одном из ваших наборов'
            : `Вам предложили коллаборацию в ваших наборах — предложений: ${count}`;
        }
      }
    }

    async refreshCollabBadge() {
      try {
        const result = await window.apiClient.getIncomingStickerCollabs();
        this.updateCollabBadge(result.success ? (result.data || []).length : 0);
      } catch (e) { /* тихо — это просто уведомление */ }
    }

    renderCollabThumbs(stickers, limit, total) {
      const list = stickers || [];
      if (!list.length) return '';
      const shown = list.slice(0, limit);
      const more = (total ?? list.length) - shown.length;
      return `<div class="stickers-collab-thumbs">${
        shown.map((s) => `<img src="${escapeHtml(s.fileUrl)}" alt="${escapeHtml(s.alias)}" title="${escapeHtml(s.alias)}">`).join('')
      }${more > 0 ? `<span class="stickers-collab-thumbs-more">+${more}</span>` : ''}</div>`;
    }

    renderCollabIncomingCard(r) {
      const n = r.stickersCount;
      return `
        <div class="stickers-collab-card">
          <div class="stickers-collab-head">
            <div class="stickers-collab-title"><i class="fas fa-handshake"></i> <strong>${escapeHtml(r.proposerName)}</strong> предлагает добавить ${n} ${this.stickerWord(n)} в набор «${escapeHtml(r.packTitle)}»</div>
            <span class="stickers-collab-date">${formatDate(r.submittedAt)}</span>
          </div>
          ${r.message ? `<div class="stickers-collab-message">${escapeHtml(r.message)}</div>` : ''}
          ${this.renderCollabThumbs(r.stickers, 10, n)}
          <div class="stickers-collab-hint">Если принять, стикеры добавятся в набор, а ${escapeHtml(r.proposerName)} станет соавтором. Если отклонить — они будут удалены, набор не изменится.</div>
          <div class="stickers-collab-actions btns-compact">
            <button type="button" class="btn btn-success btn-sm" data-collab-accept="${r.id}" data-name="${escapeHtml(r.proposerName)}"><i class="fas fa-check"></i> Принять</button>
            <button type="button" class="btn btn-danger btn-sm" data-collab-decline="${r.id}" data-name="${escapeHtml(r.proposerName)}"><i class="fas fa-xmark"></i> Отклонить</button>
            <button type="button" class="btn btn-secondary btn-sm" data-open-pack="${r.packId}" data-open-mode="own"><i class="fas fa-eye"></i> Набор</button>
          </div>
        </div>`;
    }

    renderCollabOutgoingCard(r) {
      // Статус заявки -> тот же бейдж, что и у наборов (цвета уже есть):
      // принято = зелёный, отклонено = красный, ждёт = жёлтый, черновик = серый.
      const statusMap = {
        draft: ['draft', 'Черновик'],
        pending: ['pending', 'Ждёт решения автора'],
        accepted: ['approved', 'Принято — вы соавтор'],
        declined: ['rejected', 'Отклонено']
      };
      const [badgeClass, badgeLabel] = statusMap[r.status] || ['draft', r.status];
      const n = r.stickersCount;
      const active = r.status === 'draft' || r.status === 'pending';
      const actions = active
        ? `<div class="stickers-collab-actions btns-compact">
             <button type="button" class="btn btn-secondary btn-sm" data-open-pack="${r.packId}" data-open-mode="catalog"><i class="fas fa-eye"></i> Открыть набор</button>
             <button type="button" class="btn btn-danger btn-sm" data-collab-cancel="${r.id}"><i class="fas fa-rotate-left"></i> ${r.status === 'draft' ? 'Отменить' : 'Отозвать'}</button>
           </div>`
        : '';
      const when = r.resolvedAt || r.submittedAt || r.createdAt;
      return `
        <div class="stickers-collab-card">
          <div class="stickers-collab-head">
            <div class="stickers-collab-title">Набор «${escapeHtml(r.packTitle)}»${r.packAuthorName ? ` <span style="color:var(--text-muted)">· автор ${escapeHtml(r.packAuthorName)}</span>` : ''}</div>
            <span class="stickers-status-badge ${badgeClass}">${badgeLabel}</span>
          </div>
          <div class="stickers-collab-hint">${n} ${this.stickerWord(n)} · ${formatDate(when)}</div>
          ${active ? this.renderCollabThumbs(r.stickers, 8, n) : ''}
          ${actions}
        </div>`;
    }

    async loadCollab() {
      const loadingEl = document.getElementById('stickersCollabLoading');
      const contentEl = document.getElementById('stickersCollabContent');
      loadingEl.style.display = 'block';
      contentEl.hidden = true;

      try {
        const [incomingRes, outgoingRes] = await Promise.all([
          window.apiClient.getIncomingStickerCollabs(),
          window.apiClient.getMyStickerCollabs()
        ]);
        const incoming = incomingRes.success ? (incomingRes.data || []) : [];
        const outgoing = outgoingRes.success ? (outgoingRes.data || []) : [];
        this.updateCollabBadge(incoming.length);

        const incomingList = document.getElementById('stickersCollabIncomingList');
        incomingList.innerHTML = incoming.map((r) => this.renderCollabIncomingCard(r)).join('');
        document.getElementById('stickersCollabIncomingEmpty').hidden = incoming.length > 0;

        const outgoingList = document.getElementById('stickersCollabOutgoingList');
        outgoingList.innerHTML = outgoing.map((r) => this.renderCollabOutgoingCard(r)).join('');
        document.getElementById('stickersCollabOutgoingEmpty').hidden = outgoing.length > 0;

        loadingEl.style.display = 'none';
        contentEl.hidden = false;
      } catch (e) {
        loadingEl.style.display = 'none';
        showMessage('Не удалось загрузить предложения коллабораций', 'error');
      }
    }

    async acceptCollab(requestId, proposerName) {
      if (!confirm(`Принять предложение? Стикеры пользователя ${proposerName} добавятся в ваш набор, а он станет соавтором.`)) return;
      try {
        const result = await window.apiClient.acceptStickerCollab(requestId);
        if (!result.success) {
          showMessage(`Не удалось принять предложение: ${result.data?.error || result.error || ''}`, 'error');
          return;
        }
        showMessage(`Коллаборация принята — стикеры добавлены в набор, ${proposerName} теперь соавтор`, 'success');
        await this.loadCollab();
      } catch (e) {
        showMessage('Неожиданная ошибка при принятии предложения', 'error');
      }
    }

    async declineCollab(requestId, proposerName) {
      if (!confirm(`Отклонить предложение? Стикеры пользователя ${proposerName} будут удалены, набор не изменится.`)) return;
      try {
        const result = await window.apiClient.declineStickerCollab(requestId);
        if (!result.success) {
          showMessage(`Не удалось отклонить предложение: ${result.data?.error || result.error || ''}`, 'error');
          return;
        }
        showMessage('Предложение отклонено', 'success');
        await this.loadCollab();
      } catch (e) {
        showMessage('Неожиданная ошибка при отклонении предложения', 'error');
      }
    }

    async cancelCollabRequest(requestId) {
      if (!confirm('Отозвать предложение? Добавленные вами стикеры будут удалены.')) return;
      try {
        const result = await window.apiClient.cancelStickerCollab(requestId);
        if (!result.success) {
          showMessage(`Не удалось отозвать предложение: ${result.data?.error || result.error || ''}`, 'error');
          return;
        }
        showMessage('Предложение отозвано', 'success');
        await this.loadCollab();
      } catch (e) {
        showMessage('Неожиданная ошибка', 'error');
      }
    }

    // Блок "Коллаборация" в окне ЧУЖОГО опубликованного набора: собрать свои
    // стикеры -> предложить автору. Для собственного набора, наборов не в
    // статусе approved и режимов модерации/очереди его нет.
    renderCollabSection(pack, mode) {
      const box = document.getElementById('stickersPackModalCollab');
      if (!box) return;
      const eligible = mode === 'catalog' && !pack.isOwn && pack.status === 'approved';
      if (!eligible) {
        box.hidden = true;
        box.innerHTML = '';
        return;
      }

      const collab = pack.myCollab || null;
      const pending = collab && collab.status === 'pending';
      const staged = (collab && collab.stickers) || [];

      const tiles = staged.length
        ? `<div class="stickers-grid">${staged.map((s) => `
            <div class="stickers-tile" title="${escapeHtml(s.alias)}">
              <img src="${escapeHtml(s.fileUrl)}" alt="${escapeHtml(s.alias)}">
              <div class="stickers-tile-alias">${escapeHtml(s.alias)}</div>
              ${pending ? '' : `<button type="button" class="stickers-tile-remove" data-collab-remove="${s.id}" title="Убрать стикер">&times;</button>`}
            </div>`).join('')}</div>`
        : '<div class="stickers-collab-staged-empty">Вы пока не добавили ни одного своего стикера.</div>';

      let body;
      if (pending) {
        body = `
          <div class="stickers-collab-sent"><i class="fas fa-paper-plane"></i> Предложение отправлено автору — ждём его решения.${collab.message ? ` Ваше сообщение: «${escapeHtml(collab.message)}»` : ''}</div>
          ${tiles}
          <div class="stickers-collab-row">
            <button type="button" class="btn btn-danger" id="stickersCollabCancelBtn"><i class="fas fa-rotate-left"></i> Отозвать предложение</button>
          </div>`;
      } else {
        body = `
          ${tiles}
          <div class="stickers-collab-row">
            <input type="file" id="stickersCollabFileInput" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
            <button type="button" class="btn btn-secondary" id="stickersCollabPickBtn"><i class="fas fa-image"></i> <span id="stickersCollabFileName">Выбрать файл</span></button>
            <input type="text" id="stickersCollabAliasInput" class="form-input" placeholder="Имя стикера латиницей, напр. wave" maxlength="60">
            <button type="button" class="btn btn-primary" id="stickersCollabAddBtn"><i class="fas fa-upload"></i> Добавить</button>
          </div>
          <div class="stickers-collab-row">
            <input type="text" id="stickersCollabMessage" class="form-input" placeholder="Сообщение автору (необязательно)" maxlength="300" value="${escapeHtml(this._collabMessage)}">
          </div>
          <div class="stickers-collab-row">
            <button type="button" class="btn btn-primary" id="stickersCollabSubmitBtn" ${staged.length ? '' : 'disabled title="Сначала добавьте хотя бы один стикер"'}><i class="fas fa-handshake"></i> Предложить коллаборацию</button>
            ${collab ? '<button type="button" class="btn btn-secondary" id="stickersCollabCancelBtn"><i class="fas fa-rotate-left"></i> Отменить</button>' : ''}
          </div>`;
      }

      box.innerHTML = `
        <div class="stickers-collab-box-title"><i class="fas fa-handshake"></i> Коллаборация</div>
        <p class="stickers-collab-explain">Добавьте свои стикеры и предложите автору объединить их с этим набором. Если автор согласится, стикеры попадут в набор, а вы станете соавтором. Если нет — всё отменится.</p>
        ${body}`;
      box.hidden = false;
      this.bindCollabSection(pack, collab);
    }

    bindCollabSection(pack, collab) {
      const box = document.getElementById('stickersPackModalCollab');
      const reopen = () => this.openPackModal(pack.id, 'catalog');

      box.querySelectorAll('[data-collab-remove]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const result = await window.apiClient.deleteCollabSticker(btn.dataset.collabRemove);
            if (!result.success) {
              showMessage(`Не удалось убрать стикер: ${result.data?.error || result.error || ''}`, 'error');
              return;
            }
            await reopen();
          } catch (err) {
            showMessage('Неожиданная ошибка', 'error');
          }
        });
      });

      box.querySelector('#stickersCollabCancelBtn')?.addEventListener('click', async () => {
        if (!collab) return;
        if (!confirm('Отозвать предложение? Добавленные вами стикеры будут удалены.')) return;
        try {
          const result = await window.apiClient.cancelStickerCollab(collab.id);
          if (!result.success) {
            showMessage(`Не удалось отозвать предложение: ${result.data?.error || result.error || ''}`, 'error');
            return;
          }
          this._collabMessage = '';
          showMessage('Предложение отозвано', 'success');
          await reopen();
        } catch (err) {
          showMessage('Неожиданная ошибка', 'error');
        }
      });

      const messageInput = box.querySelector('#stickersCollabMessage');
      messageInput?.addEventListener('input', () => { this._collabMessage = messageInput.value; });

      const fileInput = box.querySelector('#stickersCollabFileInput');
      box.querySelector('#stickersCollabPickBtn')?.addEventListener('click', () => fileInput?.click());
      fileInput?.addEventListener('change', () => {
        this.collabFile = fileInput.files?.[0] || null;
        const label = box.querySelector('#stickersCollabFileName');
        if (label) label.textContent = this.collabFile ? this.collabFile.name : 'Выбрать файл';
      });

      box.querySelector('#stickersCollabAddBtn')?.addEventListener('click', async (e) => {
        const alias = box.querySelector('#stickersCollabAliasInput').value.trim();
        if (!this.collabFile) { showMessage('Выберите файл стикера', 'warning'); return; }
        if (!alias) { showMessage('Укажите имя стикера (латиницей)', 'warning'); return; }
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const result = await window.apiClient.uploadCollabSticker(pack.id, this.collabFile, alias);
          if (!result.success) {
            showMessage(`Не удалось добавить стикер: ${result.data?.error || result.error || ''}`, 'error');
            btn.disabled = false;
            return;
          }
          this.collabFile = null;
          await reopen();
        } catch (err) {
          showMessage('Неожиданная ошибка при загрузке стикера', 'error');
          btn.disabled = false;
        }
      });

      box.querySelector('#stickersCollabSubmitBtn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const result = await window.apiClient.submitStickerCollab(pack.id, (messageInput?.value || '').trim());
          if (!result.success) {
            showMessage(`Не удалось отправить предложение: ${result.data?.error || result.error || ''}`, 'error');
            btn.disabled = false;
            return;
          }
          this._collabMessage = '';
          showMessage('Предложение отправлено автору набора', 'success');
          await reopen();
        } catch (err) {
          showMessage('Неожиданная ошибка при отправке предложения', 'error');
          btn.disabled = false;
        }
      });
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
          ? `<div class="stickers-pack-card-actions btns-compact"><span class="stickers-status-badge approved" style="flex:1;text-align:center;">Ваш набор</span></div>`
          : `<div class="stickers-pack-card-actions btns-compact">
               <button type="button" class="btn ${pack.subscribed ? 'btn-secondary' : 'btn-primary'} btn-sm" data-toggle-sub="${pack.id}" data-subscribed="${pack.subscribed ? '1' : '0'}">
                 ${pack.subscribed ? '<i class="fas fa-check"></i> Добавлено' : '<i class="fas fa-plus"></i> Добавить'}
               </button>
             </div>`;
      } else if (context === 'mine') {
        metaRight = `<span class="stickers-status-badge ${pack.status}">${STATUS_LABELS[pack.status] || pack.status}</span>`;
        // У черновика с хотя бы одним стикером — кнопка "Опубликовать" рядом
        // с "Открыть" (пустой набор публиковать нельзя, см. publishPack в
        // src/services/stickers-store.js).
        const publishBtn = pack.status === 'draft' && count > 0
          ? `<button type="button" class="btn btn-primary btn-sm" data-publish-pack="${pack.id}"><i class="fas fa-paper-plane"></i> Опубликовать</button>`
          : '';
        actions = `<div class="stickers-pack-card-actions btns-compact"><button type="button" class="btn btn-secondary btn-sm">Открыть · ${count} шт.</button>${publishBtn}</div>`;
      } else {
        metaRight = `<span class="stickers-status-badge pending">${count} шт.</span>`;
        actions = `<div class="stickers-pack-card-actions btns-compact"><button type="button" class="btn btn-secondary btn-sm">Проверить набор</button></div>`;
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
        <div class="stickers-pack-card${pack.status === 'draft' ? ' is-draft' : ''}" data-open-pack="${pack.id}" data-open-mode="${openMode}">
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
        showMessage('Черновик создан — добавьте стикеры и опубликуйте набор, когда он будет готов', 'success');
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
        if (!this.currentPack || String(this.currentPack.id) !== String(packId)) this._collabMessage = '';
        this.currentPack = result.data;
        this.currentPackMode = mode;
        this.selectedFile = null;
        this.collabFile = null;
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
      this.collabFile = null;
      this._collabMessage = '';
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
        ${(pack.coAuthors && pack.coAuthors.length) ? `<span>Соавторы: ${pack.coAuthors.map((c) => escapeHtml(c.name)).join(', ')}</span>` : ''}
        <span>Создан: ${formatDate(pack.createdAt)}</span>
        <span>Стикеров: ${pack.stickers.length}</span>
      `;

      // Всегда убираем прошлый блок причины перед тем, как решать, нужен ли
      // новый — иначе при повторном renderPackModal() на всё ещё отклонённом
      // наборе (например, сразу после добавления стикера, до resubmit)
      // блок причины дублировался бы на каждый re-render.
      document.getElementById('stickersPackRejectBox')?.remove();
      document.getElementById('stickersPackHintBox')?.remove();
      if (pack.status === 'rejected' && pack.rejectReason) {
        metaEl.insertAdjacentHTML('afterend',
          `<div class="stickers-reject-reason-box" id="stickersPackRejectBox"><i class="fas fa-triangle-exclamation"></i> Причина отклонения: ${escapeHtml(pack.rejectReason)}</div>`);
      }
      // Подсказка о том, что сейчас с набором и что можно сделать — только
      // для автора (mode 'own'): модератору/посетителю она ни к чему.
      if (mode === 'own' && (pack.status === 'draft' || pack.status === 'pending')) {
        const hint = pack.status === 'draft'
          ? 'Это черновик — его видите только вы. Добавьте стикеры и нажмите «Опубликовать», когда набор будет готов: он уйдёт на проверку администратору.'
          : 'Набор отправлен на проверку администратору. Пока он не подтверждён, его можно вернуть в черновики и доделать.';
        metaEl.insertAdjacentHTML('afterend',
          `<div class="stickers-draft-box" id="stickersPackHintBox"><i class="fas fa-circle-info"></i> ${hint}</div>`);
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

      this.renderCollabSection(pack, mode);

      document.getElementById('stickersPackModalFooter').innerHTML = this.renderPackModalFooter(pack, mode);
      this.bindPackModalFooter(pack, mode);
    }

    renderPackModalFooter(pack, mode) {
      if (mode === 'own') {
        // Главное действие по статусу — первой кнопкой: черновик публикуем,
        // ожидающий модерации возвращаем в черновики, отклонённый шлём
        // повторно.
        let statusAction = '';
        if (pack.status === 'draft') {
          statusAction = pack.stickers.length
            ? `<button type="button" class="btn btn-primary" id="stickersPublishBtn"><i class="fas fa-paper-plane"></i> Опубликовать</button>`
            : `<button type="button" class="btn btn-primary" id="stickersPublishBtn" disabled title="Добавьте хотя бы один стикер"><i class="fas fa-paper-plane"></i> Опубликовать</button>`;
        } else if (pack.status === 'pending') {
          statusAction = `<button type="button" class="btn btn-secondary" id="stickersUnpublishBtn"><i class="fas fa-file-pen"></i> Вернуть в черновики</button>`;
        } else if (pack.status === 'rejected') {
          statusAction = `<button type="button" class="btn btn-primary" id="stickersResubmitBtn"><i class="fas fa-rotate-right"></i> Отправить повторно</button>`;
        }
        return `
          ${statusAction}
          <button type="button" class="btn btn-secondary" id="stickersRenameBtn"><i class="fas fa-pen"></i> Переименовать</button>
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
        document.getElementById('stickersPublishBtn')?.addEventListener('click', () => this.publishPack(pack.id));
        document.getElementById('stickersUnpublishBtn')?.addEventListener('click', () => this.unpublishPack());
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

    // Публикация — отдельный шаг после создания: черновик уходит на модерацию.
    // packId передаётся явно, потому что вызывается и с карточки в списке (там
    // модалка набора не открыта и this.currentPack нет).
    async publishPack(packId) {
      try {
        const result = await window.apiClient.publishStickerPack(packId);
        if (!result.success) {
          showMessage(`Не удалось опубликовать набор: ${result.data?.error || result.error || ''}`, 'error');
          return;
        }
        showMessage('Набор отправлен на модерацию', 'success');
        if (this.currentPack && String(this.currentPack.id) === String(packId)) {
          await this.openPackModal(packId, this.currentPackMode);
        }
        await this.loadMine();
      } catch (e) {
        showMessage('Неожиданная ошибка при публикации набора', 'error');
      }
    }

    async unpublishPack() {
      try {
        const result = await window.apiClient.unpublishStickerPack(this.currentPack.id);
        if (!result.success) {
          showMessage(`Не удалось вернуть набор в черновики: ${result.data?.error || result.error || ''}`, 'error');
          return;
        }
        showMessage('Набор возвращён в черновики', 'success');
        await this.openPackModal(this.currentPack.id, this.currentPackMode);
        await this.loadMine();
      } catch (e) {
        showMessage('Неожиданная ошибка', 'error');
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
