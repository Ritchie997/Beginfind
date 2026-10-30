// antropedia-editor-client.js — Полнофункциональный клиент редактора статей Antropedia
// для витрины основы: блоки EditorManager, инлайн-форматирование, превью (split/preview/edit),
// черновики (localStorage + облако /api/drafts), папки черновиков, многослойность и публикация.

(function () {
  'use strict';

  function currentUser() {
    if (window.authManager && typeof window.authManager.getUser === 'function') {
      const u = window.authManager.getUser();
      if (u) return u;
    }
    try {
      const raw = localStorage.getItem('currentUser') || localStorage.getItem('user');
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
  }

  function token() {
    if (window.authManager && typeof window.authManager.getToken === 'function') {
      const t = window.authManager.getToken();
      if (t) return t;
    }
    return localStorage.getItem('token') || localStorage.getItem('authToken') || null;
  }

  function isAuthenticated() {
    if (window.authManager && typeof window.authManager.isAuthenticated === 'function') {
      if (window.authManager.isAuthenticated()) return true;
    }
    return !!token();
  }

  // Общий клиент для авторизованных запросов
  if (!window.apiClient) {
    window.apiClient = {
      async makeAuthenticatedRequest(endpoint, method = 'GET', data = null) {
        const accessToken = token();
        const headers = {};
        if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
        if (data != null && !(data instanceof FormData)) headers['Content-Type'] = 'application/json';
        const options = { method, headers };
        if (data instanceof FormData) options.body = data;
        else if (data != null) options.body = JSON.stringify(data);
        try {
          const response = await fetch(endpoint, options);
          const result = await response.json().catch(() => ({}));
          return {
            success: response.ok,
            data: result,
            status: response.status,
            error: result && result.error
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
      async uploadImage(file) {
        const formData = new FormData();
        formData.append('image', file);
        return this.makeAuthenticatedRequest('/api/upload-image', 'POST', formData);
      }
    };
  } else if (!window.apiClient.uploadImage) {
    window.apiClient.uploadImage = async function (file) {
      const formData = new FormData();
      formData.append('image', file);
      if (typeof window.apiClient.makeAuthenticatedRequest === 'function') {
        return window.apiClient.makeAuthenticatedRequest('/api/upload-image', 'POST', formData);
      }
      const accessToken = token();
      const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
      const res = await fetch('/api/upload-image', { method: 'POST', headers, body: formData });
      const result = await res.json().catch(() => ({}));
      return { success: res.ok, data: result, status: res.status, error: result && result.error };
    };
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[m]);
  }

  // Всплывающие уведомления (toast)
  function showMessage(text, type = 'info') {
    if (typeof window.showMessage === 'function') {
      window.showMessage(text, type);
      return;
    }
    const prev = document.getElementById('antropedia-toast-container');
    if (prev) prev.remove();
    const toast = document.createElement('div');
    toast.id = 'antropedia-toast-container';
    toast.className = 'toast toast-' + type;
    toast.style.cssText = 'position:fixed;top:24px;right:24px;z-index:99999;padding:12px 20px;border-radius:10px;font-size:13.5px;font-weight:600;color:#fff;background:' +
      (type === 'error' ? '#ef4444' : type === 'success' ? '#22c55e' : '#6366f1') +
      ';box-shadow:0 8px 24px rgba(0,0,0,0.4);display:flex;align-items:center;gap:10px;transition:opacity 0.2s ease;';
    const icon = document.createElement('i');
    icon.className = type === 'error' ? 'fas fa-circle-exclamation' : type === 'success' ? 'fas fa-circle-check' : 'fas fa-circle-info';
    toast.append(icon, document.createTextNode(text));
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 250);
    }, 4500);
  }

  class AntropediaEditorController {
    constructor() {
      this.editorManager = null;
      this.rolesField = null;
      this.tagsField = null;
      this.layerRolesField = null;
      this.articleLayersEnabled = false;
      this.articleLayers = [];
      this.activeLayerIndex = 0;
      this._layersStateKnown = true;
      this.currentDraftId = null;
      this.currentDraftRev = null;
      this._lastLoadedDraftData = null;
      this._draftAutosaveTimer = null;
      this._draftPushChain = Promise.resolve();
      this._draftsModalEls = null;
      this._draftsFolders = [];
      this._draftsModalItems = [];
      this._draftsFolderId = null;
      this._draftsSelected = new Set();
      this._draftsSelectMode = false;
      this._initialized = false;
    }

    init() {
      if (this._initialized) return;
      this._initialized = true;

      // Инициализация ChipField
      this.initChipFields();
      this.setupFormEvents();
      this.bindDraftSyncListeners();
      this.startDraftAutosave();
    }

    initChipFields() {
      const rolesRoot = document.getElementById('articleRolesField');
      if (rolesRoot && typeof ChipField !== 'undefined') {
        this.rolesField = new ChipField(rolesRoot, {
          freeText: false,
          placeholder: 'Сначала выберите франшизу...',
          emptyText: 'Нет ролей для этой франшизы'
        });
      }

      const tagsRoot = document.getElementById('articleTagsField');
      if (tagsRoot && typeof ChipField !== 'undefined') {
        this.tagsField = new ChipField(tagsRoot, {
          freeText: true,
          placeholder: 'Введите тег и нажмите Enter...'
        });
      }

      const layerRolesRoot = document.getElementById('articleLayerRolesField');
      if (layerRolesRoot && typeof ChipField !== 'undefined') {
        this.layerRolesField = new ChipField(layerRolesRoot, {
          freeText: false,
          placeholder: 'Роли, которым виден слой...',
          emptyText: 'Сначала выберите франшизу',
          onChange: () => this.updateLayerPublicRow()
        });
      }
    }

    async openEditor({ draftId = null, articleSlug = null } = {}) {
      this.init();
      const editorRoot = document.getElementById('publicArticleEditor');
      if (!editorRoot) return;

      // Отображаем автора
      this.updateAuthorChip();

      // Загружаем список доступных франшиз
      await this.loadServers();

      // Инициализируем EditorManager
      const editor = window.editorManager || (typeof EditorManager !== 'undefined' ? new EditorManager() : null);
      if (editor) {
        this.editorManager = editor;
        window.editorManager = editor;
        await editor.initializeEditor();
      }

      // Сбрасываем или загружаем черновик/статью
      if (draftId) {
        await this.loadDraft(draftId);
      } else if (articleSlug) {
        await this.loadArticleForEdit(articleSlug);
      } else {
        // Проверяем, есть ли незавершённый черновик
        await this.checkAndOfferDraft();
      }

      // Автофокус на заголовок, если он пуст
      const titleInput = document.getElementById('articleTitle');
      if (titleInput && !titleInput.value) {
        setTimeout(() => titleInput.focus(), 150);
      }
    }

    closeEditor() {
      this.stopDraftAutosave();
      if (this.editorManager && typeof this.editorManager.cleanup === 'function') {
        this.editorManager.cleanup();
      }
      this.closeDraftsModal();
    }

    updateAuthorChip() {
      const chip = document.getElementById('articleAuthorChip');
      if (!chip) return;
      const user = currentUser();
      if (user) {
        chip.textContent = user.display_name || user.username || 'Пользователь';
        chip.title = 'Вы публикуете статью как ' + (user.display_name || user.username);
      } else {
        chip.textContent = 'Гость (требуется вход для публикации)';
        chip.title = 'Войдите в аккаунт, чтобы опубликовать статью';
      }
    }

    setupFormEvents() {
      // Кнопка «К статьям» (назад)
      document.getElementById('editorBackBtn')?.addEventListener('click', async () => {
        if (this.hasUnsavedChanges()) {
          const ok = window.confirmDialog
            ? await window.confirmDialog.open({
                title: 'Несохранённые изменения',
                message: 'У вас есть несохранённые изменения. Вернуться к статьям? Черновик сохранён на этом устройстве.',
                confirmLabel: 'Вернуться',
                cancelLabel: 'Остаться',
                danger: false
              })
            : true;
          if (!ok) return;
        }
        if (window.PublicAntropedia && typeof window.PublicAntropedia.showListView === 'function') {
          window.PublicAntropedia.showListView();
        }
      });

      // Сохранить черновик вручную
      document.getElementById('saveDraftBtn')?.addEventListener('click', async () => {
        await this.saveDraft(true);
      });

      // Открыть окно черновиков
      document.getElementById('loadDraftBtn')?.addEventListener('click', () => {
        this.openDraftsModal();
      });

      // Сбросить форму
      document.getElementById('resetArticleBtn')?.addEventListener('click', async () => {
        const ok = window.confirmDialog
          ? await window.confirmDialog.open({
              title: 'Очистить форму статьи?',
              message: 'Очистить форму статьи? Все введённые данные будут сброшены.',
              confirmLabel: 'Сбросить',
              cancelLabel: 'Отмена',
              danger: true
            })
          : true;
        if (!ok) return;
        this.clearForm();
      });

      // Опубликовать
      document.getElementById('saveArticleBtn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          await this.saveArticle();
        } finally {
          btn.disabled = false;
        }
      });

      // Выбор франшизы
      document.getElementById('articleServer')?.addEventListener('change', (e) => {
        const serverId = e.target.value;
        if (this.rolesField) this.rolesField.setValues([]);
        this.loadRolesForFranchise(serverId);
        this.loadHubsForFranchise(serverId);
        if (this.articleLayersEnabled && this.layerRolesField) {
          this.layerRolesField.setValues([]);
          this.loadRolesForFranchise(serverId, true);
        }
      });

      document.getElementById('articleHub')?.addEventListener('change', () => this.updateFranchisePath());

      // Обложка: Выбрать файл
      const fileInput = document.getElementById('articleImageFileInput');
      document.getElementById('editorCoverFileBtn')?.addEventListener('click', () => {
        if (fileInput) fileInput.click();
      });

      fileInput?.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        await this.uploadCoverImage(file);
      });

      // Обложка: Вставить URL
      document.getElementById('editorCoverUrlBtn')?.addEventListener('click', async () => {
        const url = window.confirmDialog
          ? await window.confirmDialog.prompt({
              title: 'Обложка по ссылке',
              message: 'Введите прямую ссылку на изображение обложки (URL):',
              placeholder: 'https://example.com/cover.jpg',
              confirmLabel: 'Вставить'
            })
          : null;
        if (url && url.trim()) {
          this.setCoverImage(url.trim());
        }
      });

      // Обложка: Удалить
      document.getElementById('editorCoverRemoveBtn')?.addEventListener('click', () => {
        this.removeCoverImage();
      });

      // Многослойность
      document.getElementById('articleLayersToggle')?.addEventListener('change', (e) => {
        this.setLayersMode(e.target.checked);
      });

      document.getElementById('articleLayersAddBtn')?.addEventListener('click', () => {
        this.snapshotActiveLayer();
        this.articleLayers.push({ roles: [], public: false, title: '', tags: [], content: { version: 1, blocks: [] } });
        this.loadLayerIntoForm(this.articleLayers.length - 1);
      });

      document.getElementById('articleLayersDuplicateBtn')?.addEventListener('click', () => {
        this.snapshotActiveLayer();
        const source = this.articleLayers[this.activeLayerIndex];
        if (!source) return;
        this.articleLayers.push({
          roles: source.roles.map((r) => ({ ...r })),
          public: !!source.public,
          title: source.title ? `${source.title} (копия)` : '',
          tags: [...(source.tags || [])],
          content: JSON.parse(JSON.stringify(source.content))
        });
        this.loadLayerIntoForm(this.articleLayers.length - 1);
      });

      document.getElementById('articleLayersList')?.addEventListener('click', (e) => {
        const moveBtn = e.target.closest('.article-layer-pill-move');
        if (moveBtn) {
          this.moveArticleLayer(parseInt(moveBtn.dataset.index, 10), parseInt(moveBtn.dataset.move, 10));
          return;
        }
        const removeBtn = e.target.closest('.article-layer-pill-remove');
        if (removeBtn) {
          const idx = parseInt(removeBtn.dataset.index, 10);
          if (this.articleLayers.length <= 1) return;
          this.articleLayers.splice(idx, 1);
          const nextIndex = Math.min(this.activeLayerIndex >= idx ? Math.max(0, this.activeLayerIndex - 1) : this.activeLayerIndex, this.articleLayers.length - 1);
          this.loadLayerIntoForm(nextIndex);
          return;
        }
        const pill = e.target.closest('.article-layer-pill');
        if (pill) {
          const idx = parseInt(pill.dataset.index, 10);
          if (idx === this.activeLayerIndex) return;
          this.snapshotActiveLayer();
          this.loadLayerIntoForm(idx);
        }
      });

      // Динамическое обновление заголовка активного слоя при вводе
      document.getElementById('articleTitle')?.addEventListener('input', (e) => {
        if (this.articleLayersEnabled && this.articleLayers[this.activeLayerIndex]) {
          this.articleLayers[this.activeLayerIndex].title = e.target.value;
          const hint = document.getElementById('articleLayerEditingHint');
          if (hint) hint.textContent = `(Слой ${this.activeLayerIndex + 1}: ${e.target.value || 'без названия'})`;
          this.renderArticleLayersList();
        }
      });

      // Переключение публичности активного слоя
      document.getElementById('articleLayerPublicCheckbox')?.addEventListener('change', (e) => {
        if (this.articleLayersEnabled && this.articleLayers[this.activeLayerIndex]) {
          this.articleLayers[this.activeLayerIndex].public = e.target.checked;
          this.renderArticleLayersList();
        }
      });
    }

    // === Загрузка франшиз и хабов ===
    async loadServers() {
      const serverSelect = document.getElementById('articleServer');
      if (!serverSelect) return;
      try {
        const result = await window.apiClient.makeAuthenticatedRequest('/api/servers');
        if (result.success && Array.isArray(result.data)) {
          const current = serverSelect.value;
          serverSelect.innerHTML = '<option value="">Нет франшизы (публичный мир)</option>';
          result.data.forEach((s) => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.name;
            serverSelect.appendChild(opt);
          });
          serverSelect.value = current;
          await this.loadHubsForFranchise(current);
        }
      } catch (e) {
        console.warn('Не удалось загрузить франшизы:', e);
      }
    }

    async loadHubsForFranchise(franchiseId) {
      const hubSelect = document.getElementById('articleHub');
      if (!hubSelect) return;
      if (!franchiseId) {
        hubSelect.disabled = true;
        hubSelect.innerHTML = '<option value="">Сначала выберите франшизу</option>';
        this.updateFranchisePath();
        return;
      }
      hubSelect.disabled = true;
      hubSelect.innerHTML = '<option value="">Загрузка хабов…</option>';
      try {
        const res = await window.apiClient.makeAuthenticatedRequest(`/api/servers/${encodeURIComponent(franchiseId)}/hubs`);
        hubSelect.innerHTML = '<option value="">Без хаба</option>';
        if (res.success && Array.isArray(res.data)) {
          res.data.forEach((hub) => {
            const opt = document.createElement('option');
            opt.value = hub.id;
            opt.textContent = hub.title || hub.name || `Хаб #${hub.id}`;
            opt.dataset.hubName = hub.title || hub.name;
            hubSelect.appendChild(opt);
          });
        }
        hubSelect.disabled = false;
      } catch (e) {
        hubSelect.innerHTML = '<option value="">Не удалось загрузить хабы</option>';
      }
      this.updateFranchisePath();
    }

    async loadRolesForFranchise(franchiseId, forLayers = false) {
      const field = forLayers ? this.layerRolesField : this.rolesField;
      if (!field) return;
      if (!franchiseId) {
        field.setChoices([]);
        return;
      }
      try {
        const res = await window.apiClient.makeAuthenticatedRequest(`/api/servers/${encodeURIComponent(franchiseId)}/roles`);
        if (res.success && Array.isArray(res.data)) {
          const choices = res.data.map((r) => ({
            value: forLayers ? `server:${r.id}` : String(r.id),
            label: r.name
          }));
          field.setChoices(choices);
        }
      } catch (e) {
        field.setChoices([]);
      }
    }

    updateFranchisePath() {
      const pathEl = document.getElementById('articleFranchisePath');
      const sSelect = document.getElementById('articleServer');
      const hSelect = document.getElementById('articleHub');
      if (!pathEl || !sSelect) return;
      if (!sSelect.value) {
        pathEl.hidden = true;
        pathEl.textContent = '';
        return;
      }
      const sName = sSelect.selectedOptions[0]?.textContent || '';
      const hName = hSelect && hSelect.value ? (hSelect.selectedOptions[0]?.dataset.hubName || hSelect.selectedOptions[0]?.textContent) : '';
      pathEl.textContent = hName ? `${sName} → ${hName}` : sName;
      pathEl.hidden = false;
    }

    // === Обложка статьи ===
    async uploadCoverImage(file) {
      if (!file) return;

      if (!file.type.startsWith('image/')) {
        showMessage('Пожалуйста, выберите файл изображения', 'error');
        return;
      }

      const maxSize = 5 * 1024 * 1024; // 5MB
      if (file.size > maxSize) {
        showMessage('Размер файла превышает допустимый лимит (5MB)', 'error');
        return;
      }

      // Предпросмотр сразу
      const previewImg = document.getElementById('articleCoverImagePreview');
      const previewContainer = document.getElementById('articleCoverPreview');
      const fileNameElement = document.getElementById('coverFileName');
      if (previewImg) previewImg.src = URL.createObjectURL(file);
      if (fileNameElement) fileNameElement.textContent = file.name;
      if (previewContainer) previewContainer.style.display = 'flex';

      const formData = new FormData();
      formData.append('image', file);

      try {
        showMessage('Загрузка обложки…', 'info');
        const tokenVal = token();
        const headers = tokenVal ? { Authorization: `Bearer ${tokenVal}` } : {};
        const res = await fetch('/api/upload-image', {
          method: 'POST',
          headers,
          body: formData
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && (data.url || data.path)) {
          const finalUrl = data.url || data.path;
          this.setCoverImage(finalUrl, file.name);
          showMessage('Обложка загружена', 'success');
        } else {
          showMessage(data && data.error ? data.error : 'Ошибка загрузки обложки', 'error');
        }
      } catch (e) {
        showMessage('Не удалось загрузить обложку: ' + e.message, 'error');
      }
    }

    setCoverImage(url, fileName = '') {
      const fileInput = document.getElementById('articleImageFile');
      const previewWrap = document.getElementById('articleCoverPreview');
      const previewImg = document.getElementById('articleCoverImagePreview');
      const fileNameEl = document.getElementById('coverFileName');
      if (fileInput) fileInput.value = url;
      if (previewImg) previewImg.src = url;
      if (fileNameEl) fileNameEl.textContent = fileName || url;
      if (previewWrap) previewWrap.style.display = 'flex';
    }

    removeCoverImage() {
      const fileInput = document.getElementById('articleImageFile');
      const fileUploadInput = document.getElementById('articleImageFileInput');
      const previewWrap = document.getElementById('articleCoverPreview');
      const previewImg = document.getElementById('articleCoverImagePreview');
      const fileNameEl = document.getElementById('coverFileName');
      if (fileInput) fileInput.value = '';
      if (fileUploadInput) fileUploadInput.value = '';
      if (previewImg) previewImg.src = '';
      if (fileNameEl) fileNameEl.textContent = '';
      if (previewWrap) previewWrap.style.display = 'none';
    }

    // === Многослойность ===
    encodeRoleRef(ref) {
      return `${ref.scope}:${ref.id}`;
    }

    decodeRoleRef(val) {
      const m = /^(system|server):(\d+)$/.exec(val);
      return m ? { scope: m[1], id: parseInt(m[2], 10) } : null;
    }

    async loadRoleCatalogForLayers(serverId) {
      if (!this.layerRolesField) return;
      const options = [];
      try {
        const adminRes = await window.apiClient.makeAuthenticatedRequest('/api/admin-roles');
        if (adminRes.success && Array.isArray(adminRes.data?.roles)) {
          adminRes.data.roles.forEach((r) => options.push({ value: `system:${r.id}`, label: `🌐 ${r.name}` }));
        }
      } catch (e) {}

      if (serverId) {
        try {
          const serverRes = await window.apiClient.makeAuthenticatedRequest(`/api/servers/${serverId}/roles`);
          if (serverRes.success && Array.isArray(serverRes.data)) {
            serverRes.data.forEach((r) => options.push({ value: `server:${r.id}`, label: `🏠 ${r.name}` }));
          }
        } catch (e) {}
      }

      this.layerRolesField.setOptions(options);
      this.layerRolesField.setPlaceholder(options.length ? 'Роли, которым виден слой...' : 'Сначала выберите франшизу...');
    }

    setLayersMode(enabled) {
      this.articleLayersEnabled = !!enabled;
      const panel = document.getElementById('articleLayersPanel');
      const legacyAccess = document.getElementById('articleLegacyAccessRow');
      const legacyRoles = document.getElementById('articleLegacyRolesRow');
      const hint = document.getElementById('articleLayerEditingHint');
      const tagsHint = document.getElementById('articleTagsLayerHint');

      if (panel) panel.hidden = !enabled;
      if (legacyAccess) legacyAccess.hidden = enabled;
      if (legacyRoles) legacyRoles.hidden = enabled;
      if (hint) hint.hidden = !enabled;
      if (tagsHint) { tagsHint.hidden = !enabled; if (!enabled) tagsHint.textContent = ''; }

      if (enabled) {
        const editor = this.editorManager || window.editorManager;
        if (!this.articleLayers.length) {
          this.articleLayers = [{
            roles: [],
            public: false,
            title: document.getElementById('articleTitle')?.value || '',
            tags: this.tagsField ? this.tagsField.getValues() : [],
            content: editor && editor.doc ? JSON.parse(JSON.stringify(editor.doc)) : { version: 1, blocks: [] }
          }];
          this.activeLayerIndex = 0;
        }
        const serverId = document.getElementById('articleServer')?.value;
        this.loadRoleCatalogForLayers(serverId);
        this.loadLayerIntoForm(this.activeLayerIndex);
      }
    }

    renderArticleLayersList() {
      const listEl = document.getElementById('articleLayersList');
      if (!listEl) return;
      const lastIndex = this.articleLayers.length - 1;
      listEl.innerHTML = this.articleLayers.map((l, i) => `
        <span class="article-layer-pill${i === this.activeLayerIndex ? ' active' : ''}" data-index="${i}">
          <button type="button" class="article-layer-pill-move" data-move="-1" data-index="${i}" title="Сделать публичнее (на уровень ниже)"${i === 0 ? ' disabled' : ''}><i class="fas fa-chevron-left"></i></button>
          <span class="article-layer-pill-title">${escapeHtml(l.title || 'Без названия')}</span>
          <button type="button" class="article-layer-pill-move" data-move="1" data-index="${i}" title="Сделать закрытее (на уровень выше)"${i === lastIndex ? ' disabled' : ''}><i class="fas fa-chevron-right"></i></button>
          ${this.articleLayers.length > 1 ? `<button type="button" class="article-layer-pill-remove" data-index="${i}" title="Удалить слой">&times;</button>` : ''}
        </span>
      `).join('');
    }

    loadLayerIntoForm(index) {
      if (index < 0 || index >= this.articleLayers.length) return;
      this.activeLayerIndex = index;
      const layer = this.articleLayers[index];
      const titleInput = document.getElementById('articleTitle');
      const hint = document.getElementById('articleLayerEditingHint');
      const pubCheck = document.getElementById('articleLayerPublicCheckbox');
      const tagsHint = document.getElementById('articleTagsLayerHint');

      if (titleInput) titleInput.value = layer.title || '';
      if (this.tagsField) this.tagsField.setValues(Array.isArray(layer.tags) ? layer.tags : []);
      if (tagsHint) tagsHint.textContent = `— теги слоя «${layer.title || 'без названия'}»: их видят только те, кому доступен этот слой`;

      const editor = this.editorManager || window.editorManager;
      if (editor) {
        editor.doc = layer.content ? JSON.parse(JSON.stringify(layer.content)) : { version: 1, blocks: [] };
        if (editor.container) {
          editor.renderAll();
          editor.scheduleRenderPreview?.();
        }
      }

      if (this.layerRolesField) this.layerRolesField.setValues((layer.roles || []).map((r) => this.encodeRoleRef(r)));
      if (pubCheck) pubCheck.checked = !!layer.public;

      if (hint) {
        hint.hidden = false;
        hint.textContent = `(Слой ${index + 1}: ${layer.title || 'без названия'})`;
      }
      this.renderArticleLayersList();
      this.updateLayerPublicRow();
    }

    snapshotActiveLayer() {
      if (!this.articleLayersEnabled || !this.articleLayers[this.activeLayerIndex]) return;
      const editor = this.editorManager || window.editorManager;
      this.articleLayers[this.activeLayerIndex] = {
        roles: (this.layerRolesField ? this.layerRolesField.getValues() : []).map((v) => this.decodeRoleRef(v)).filter(Boolean),
        public: !!document.getElementById('articleLayerPublicCheckbox')?.checked,
        title: document.getElementById('articleTitle')?.value || '',
        tags: this.tagsField ? this.tagsField.getValues() : [],
        content: editor && editor.doc ? JSON.parse(JSON.stringify(editor.doc)) : { version: 1, blocks: [] }
      };
    }

    updateLayerPublicRow() {
      const row = document.getElementById('articleLayerPublicRow');
      if (!row) return;
      const hasRoles = (this.layerRolesField?.getValues() || []).length > 0;
      row.hidden = hasRoles;
      if (hasRoles) {
        const cb = document.getElementById('articleLayerPublicCheckbox');
        if (cb) cb.checked = false;
      }
    }

    moveArticleLayer(index, direction) {
      const swapWith = index + direction;
      if (swapWith < 0 || swapWith >= this.articleLayers.length) return;
      this.snapshotActiveLayer();
      [this.articleLayers[index], this.articleLayers[swapWith]] = [this.articleLayers[swapWith], this.articleLayers[index]];
      if (this.activeLayerIndex === index) this.activeLayerIndex = swapWith;
      else if (this.activeLayerIndex === swapWith) this.activeLayerIndex = index;
      this.renderArticleLayersList();
    }

    // === Сбор данных формы для публикации и черновиков ===
    collectFormData() {
      this.snapshotActiveLayer();
      const editor = this.editorManager || window.editorManager;
      const addAsCoauthor = document.getElementById('addAsCoauthorCheckbox');
      const data = {
        title: document.getElementById('articleTitle')?.value || '',
        server: document.getElementById('articleServer')?.value || '',
        hub_id: document.getElementById('articleHub')?.value || null,
        content: editor && editor.doc ? JSON.stringify(editor.doc) : (document.getElementById('articleContent')?.innerHTML || ''),
        image: document.getElementById('articleImageFile')?.value || '',
        locked: document.getElementById('articleLocked')?.value === 'true',
        roles: this.rolesField ? this.rolesField.getValues() : [],
        tags: this.tagsField ? this.tagsField.getValues() : [],
        add_as_coauthor: addAsCoauthor ? addAsCoauthor.checked : true
      };

      if (this.articleLayersEnabled) {
        data.layers = this.articleLayers.map((l) => ({
          roles: l.roles,
          public: !!l.public,
          title: l.title,
          tags: Array.isArray(l.tags) ? l.tags : [],
          content: l.content
        }));
        data.tags = [];
        data.layersEnabled = true;
        data.activeLayerIndex = this.activeLayerIndex;
      } else {
        data.layers = [];
        data.layersEnabled = false;
      }
      return data;
    }

    clearForm() {
      const titleInput = document.getElementById('articleTitle');
      if (titleInput) titleInput.value = '';
      const editor = this.editorManager || window.editorManager;
      if (editor) {
        editor.doc = { version: 1, blocks: [] };
        if (editor.container) {
          editor.renderAll();
          editor.scheduleRenderPreview?.();
        }
      }
      if (this.tagsField) this.tagsField.setValues([]);
      if (this.rolesField) this.rolesField.setValues([]);
      this.removeCoverImage();

      const serverSelect = document.getElementById('articleServer');
      if (serverSelect) serverSelect.value = '';
      const hubSelect = document.getElementById('articleHub');
      if (hubSelect) {
        hubSelect.value = '';
        hubSelect.disabled = true;
      }
      this.updateFranchisePath();

      const lockedSelect = document.getElementById('articleLocked');
      if (lockedSelect) lockedSelect.value = 'false';

      this.articleLayersEnabled = false;
      this.articleLayers = [];
      this.activeLayerIndex = 0;
      const layersToggle = document.getElementById('articleLayersToggle');
      if (layersToggle) layersToggle.checked = false;
      this.setLayersMode(false);

      this.currentDraftId = null;
      this.currentDraftRev = null;
      this._lastLoadedDraftData = null;
      this.updateDraftSaveStatus(null);

      const saveBtn = document.getElementById('saveArticleBtn');
      if (saveBtn) saveBtn.removeAttribute('data-article-id');
      const formTitle = document.getElementById('article-form-title');
      if (formTitle) formTitle.textContent = 'Создать новую статью';

      if (this.editorManager) {
        this.editorManager.renderAll();
        this.editorManager.scheduleRenderPreview(true);
      }
    }

    hasUnsavedChanges() {
      if (!this._lastLoadedDraftData) {
        const title = document.getElementById('articleTitle')?.value.trim();
        const content = document.getElementById('articleContent')?.innerHTML || '';
        let hasBlocks = false;
        try {
          const doc = JSON.parse(content);
          hasBlocks = Array.isArray(doc.blocks) && doc.blocks.length > 0;
        } catch (e) {}
        return !!(title || hasBlocks);
      }
      const current = this.collectFormData();
      return JSON.stringify(current) !== JSON.stringify(this._lastLoadedDraftData);
    }

    // === Публикация статьи ===
    async saveArticle() {
      if (!isAuthenticated()) {
        const ok = window.confirmDialog
          ? await window.confirmDialog.open({
              title: 'Требуется авторизация',
              message: 'Для публикации статьи необходимо войти в аккаунт AllTell. Открыть окно входа?',
              confirmLabel: 'Войти',
              cancelLabel: 'Отмена',
              danger: false
            })
          : true;
        if (ok) {
          if (typeof window.showModalLogin === 'function') {
            window.showModalLogin('login');
          } else {
            window.location.href = '/admin-panel';
          }
        }
        return;
      }

      const saveBtn = document.getElementById('saveArticleBtn');
      const articleId = saveBtn ? saveBtn.getAttribute('data-article-id') : null;
      const data = this.collectFormData();

      if (!data.title.trim()) {
        showMessage('Пожалуйста, укажите заголовок статьи', 'error');
        document.getElementById('articleTitle')?.focus();
        return;
      }

      const hasContent = !this.isDraftContentEmpty(data.content);

      if (!hasContent && !data.layersEnabled) {
        showMessage('Добавьте хотя бы один блок текста или контента', 'error');
        return;
      }

      const method = articleId ? 'PUT' : 'POST';
      const url = articleId ? `/api/articles/${encodeURIComponent(articleId)}` : '/api/articles';

      try {
        showMessage(articleId ? 'Обновляем статью…' : 'Публикуем статью…', 'info');
        const tokenVal = token();
        const response = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenVal}`
          },
          body: JSON.stringify(data)
        });

        const result = await response.json().catch(() => ({}));
        if (response.ok) {
          showMessage(articleId ? 'Статья успешно обновлена!' : 'Статья успешно опубликована!', 'success');
          // Удаляем использованный черновик
          if (this.currentDraftId) {
            this.removePendingDraft(this.currentDraftId);
            this.deleteDraftOnServer(this.currentDraftId).catch(() => {});
          }
          this.currentDraftId = null;
          this.currentDraftRev = null;
          this._lastLoadedDraftData = null;

          // Переходим к чтению опубликованной статьи
          const slug = result.slug || (result.data && result.data.slug);
          if (slug) {
            setTimeout(() => {
              window.location.href = '/antropedia/' + encodeURIComponent(slug);
            }, 800);
          } else if (window.PublicAntropedia && typeof window.PublicAntropedia.showListView === 'function') {
            window.PublicAntropedia.showListView();
          }
        } else {
          showMessage(result.error || 'Ошибка при сохранении статьи', 'error');
        }
      } catch (err) {
        showMessage('Не удалось опубликовать статью: ' + err.message, 'error');
      }
    }

    // === СИСТЕМА ЧЕРНОВИКОВ (Local + Cloud) ===
    draftsStorageKey() {
      const user = currentUser();
      return `articleDraftsPending:${user && user.id != null ? user.id : 'anon'}`;
    }

    getPendingDrafts() {
      try {
        const raw = localStorage.getItem(this.draftsStorageKey());
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter((d) => d && d.id && d.data) : [];
      } catch (e) {
        return [];
      }
    }

    setPendingDrafts(list) {
      try {
        localStorage.setItem(this.draftsStorageKey(), JSON.stringify(list));
      } catch (e) {}
    }

    putPendingDraft(entry) {
      const list = this.getPendingDrafts().filter((d) => d.id !== entry.id);
      list.unshift(entry);
      this.setPendingDrafts(list);
    }

    removePendingDraft(id) {
      const list = this.getPendingDrafts().filter((d) => d.id !== id);
      this.setPendingDrafts(list);
    }

    newDraftId() {
      return `draft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }

    async draftsFetch(method, path, body, base = '/api/drafts') {
      const tokenVal = token();
      if (!tokenVal) return { ok: false, status: 401, json: null };
      const headers = {
        Authorization: `Bearer ${tokenVal}`
      };
      if (body != null) {
        headers['Content-Type'] = 'application/json';
      }
      const response = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined
      });
      let json = null;
      try { json = await response.json(); } catch (e) {}
      return { ok: response.ok, status: response.status, json };
    }

    async saveDraft(manual = true) {
      const data = this.collectFormData();
      const title = data.title.trim();
      let hasContent = false;
      try {
        const doc = JSON.parse(data.content);
        hasContent = Array.isArray(doc.blocks) && doc.blocks.length > 0;
      } catch (e) {}

      if (!title && !hasContent && !data.layersEnabled) {
        if (manual) showMessage('Черновик пуст — нечего сохранять', 'info');
        return;
      }

      if (!this.currentDraftId) {
        this.currentDraftId = this.newDraftId();
        this.currentDraftRev = null;
      }

      const entry = {
        id: this.currentDraftId,
        baseRev: this.currentDraftRev,
        updatedAt: Date.now(),
        data,
        offline: false
      };

      // 1. Сохраняем немедленно в локальный кэш
      this.putPendingDraft(entry);
      this._lastLoadedDraftData = data;
      this.updateDraftSaveStatus(manual ? 'saved_local' : 'autosaved_local');

      // 2. Отправляем в облако, если авторизован
      if (isAuthenticated()) {
        const pushResult = await this.pushDraft(entry);
        if (pushResult.status === 'ok') {
          this.updateDraftSaveStatus(manual ? 'synced' : 'autosaved_synced');
          if (manual) showMessage('Черновик сохранён и синхронизирован', 'success');
        } else if (pushResult.status === 'offline') {
          if (manual) showMessage('Черновик сохранён на устройстве (нет сети)', 'info');
        }
      } else {
        if (manual) showMessage('Черновик сохранён на этом устройстве (войдите для синхронизации)', 'info');
      }
    }

    async pushDraft(entry) {
      try {
        const res = await this.draftsFetch('PUT', `/${encodeURIComponent(entry.id)}`, {
          data: entry.data,
          baseRev: entry.baseRev,
          updatedAt: entry.updatedAt
        });
        if (res.ok && res.json) {
          this.currentDraftRev = res.json.rev;
          this.removePendingDraft(entry.id);
          return { status: 'ok', rev: res.json.rev };
        }
        return { status: 'error' };
      } catch (e) {
        return { status: 'offline' };
      }
    }

    async deleteDraftOnServer(draftId) {
      if (!isAuthenticated()) return;
      await this.draftsFetch('DELETE', `/${encodeURIComponent(draftId)}`);
    }

    updateDraftSaveStatus(status) {
      const el = document.getElementById('draftSaveStatus');
      if (!el) return;
      if (!status) {
        el.hidden = true;
        el.textContent = '';
        return;
      }
      el.hidden = false;
      const now = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      if (status === 'synced' || status === 'autosaved_synced') {
        el.className = 'draft-save-status is-synced';
        el.innerHTML = `<i class="fas fa-cloud-check"></i> Сохранён в ${now}`;
      } else {
        el.className = 'draft-save-status is-local';
        el.innerHTML = `<i class="fas fa-floppy-disk"></i> Сохранён локально в ${now}`;
      }
    }

    startDraftAutosave() {
      this.stopDraftAutosave();
      this._draftAutosaveTimer = setInterval(() => {
        if (this.hasUnsavedChanges()) {
          this.saveDraft(false);
        }
      }, 60000); // каждую минуту
    }

    stopDraftAutosave() {
      if (this._draftAutosaveTimer) {
        clearInterval(this._draftAutosaveTimer);
        this._draftAutosaveTimer = null;
      }
    }

    bindDraftSyncListeners() {
      window.addEventListener('online', () => this.flushPendingDrafts());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.flushPendingDrafts();
      });
    }

    async flushPendingDrafts() {
      if (!isAuthenticated()) return;
      const pending = this.getPendingDrafts();
      for (const item of pending) {
        await this.pushDraft(item);
      }
    }

    async checkAndOfferDraft() {
      const pending = this.getPendingDrafts();
      if (!pending.length) return;
      const latest = pending[0];
      const title = latest.data && latest.data.title;
      const date = new Date(latest.updatedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const ok = window.confirmDialog
        ? await window.confirmDialog.open({
            title: 'Восстановить черновик?',
            message: `Восстановить сохранённый черновик «${title || 'Без названия'}» от ${date}?`,
            confirmLabel: 'Восстановить',
            cancelLabel: 'Начать новую',
            danger: false
          })
        : false;
      if (ok) {
        await this.loadDraftData(latest.id, latest.data);
      }
    }

    async loadDraft(draftId) {
      if (!draftId) return false;
      // Ищем сначала в локальных
      const pending = this.getPendingDrafts().find((d) => d.id === draftId);
      if (pending) {
        this.currentDraftRev = (this._draftRevs && this._draftRevs[draftId]) ?? pending.baseRev ?? null;
        await this.loadDraftData(pending.id, pending.data);
        return true;
      }
      // Иначе грузим с сервера
      if (isAuthenticated()) {
        try {
          const res = await this.draftsFetch('GET', `/${encodeURIComponent(draftId)}`);
          if (res.ok && res.json) {
            this.currentDraftRev = res.json.rev;
            await this.loadDraftData(draftId, res.json.data);
            return true;
          }
        } catch (e) {
          showMessage('Не удалось загрузить черновик', 'error');
          return false;
        }
      }
      return false;
    }

    async loadDraftData(draftId, data) {
      if (!data) return;
      this.clearForm();
      this.currentDraftId = draftId;
      this._lastLoadedDraftData = data;

      const titleInput = document.getElementById('articleTitle');
      if (titleInput) titleInput.value = data.title || '';

      const contentEl = document.getElementById('articleContent');
      if (contentEl) {
        contentEl.innerHTML = typeof data.content === 'object'
          ? JSON.stringify(data.content)
          : (data.content || JSON.stringify({ version: 1, blocks: [] }));
      }

      if (data.image) {
        this.setCoverImage(data.image);
      }

      const sSelect = document.getElementById('articleServer');
      if (sSelect && data.server) {
        sSelect.value = data.server;
        await this.loadHubsForFranchise(data.server);
        await this.loadRolesForFranchise(data.server);
      }

      const hSelect = document.getElementById('articleHub');
      if (hSelect && data.hub_id) {
        hSelect.value = data.hub_id;
      }
      this.updateFranchisePath();

      const lockedSelect = document.getElementById('articleLocked');
      if (lockedSelect) lockedSelect.value = data.locked ? 'true' : 'false';

      if (this.tagsField && Array.isArray(data.tags)) {
        this.tagsField.setValues(data.tags);
      }
      if (this.rolesField && Array.isArray(data.roles)) {
        this.rolesField.setValues(data.roles);
      }

      if (data.layersEnabled && Array.isArray(data.layers) && data.layers.length) {
        this.articleLayers = data.layers.map((l) => ({
          roles: Array.isArray(l.roles) ? l.roles : [],
          public: !!l.public,
          title: l.title || '',
          tags: Array.isArray(l.tags) ? l.tags : [],
          content: l.content || { version: 1, blocks: [] }
        }));
        const toggle = document.getElementById('articleLayersToggle');
        if (toggle) toggle.checked = true;
        this.setLayersMode(true);
        this.loadLayerIntoForm(data.activeLayerIndex || 0);
      }

      this.updateDraftSaveStatus('saved_local');
      const editor = this.editorManager || window.editorManager;
      if (editor) {
        if (contentEl && contentEl.innerHTML) {
          try {
            const parsed = JSON.parse(contentEl.innerHTML);
            if (parsed && Array.isArray(parsed.blocks)) {
              editor.doc = parsed;
            }
          } catch (e) {}
        }
        editor.renderAll();
        editor.scheduleRenderPreview?.(true);
      }
      showMessage('Черновик загружен', 'success');
    }

    async loadArticleForEdit(slug) {
      if (!slug) return;
      try {
        showMessage('Загрузка статьи для редактирования…', 'info');
        const tokenVal = token();
        const headers = tokenVal ? { Authorization: `Bearer ${tokenVal}` } : {};
        const res = await fetch(`/api/articles/${encodeURIComponent(slug)}`, { headers });
        const article = await res.json();
        if (!res.ok) throw new Error(article.error || 'Статья не найдена');

        this.clearForm();
        const saveBtn = document.getElementById('saveArticleBtn');
        if (saveBtn) saveBtn.setAttribute('data-article-id', article.id);
        const formTitle = document.getElementById('article-form-title');
        if (formTitle) formTitle.textContent = 'Редактирование: ' + (article.title || article.slug);

        const titleInput = document.getElementById('articleTitle');
        if (titleInput) titleInput.value = article.title || '';

        const contentEl = document.getElementById('articleContent');
        if (contentEl) {
          contentEl.innerHTML = typeof article.content === 'object'
            ? JSON.stringify(article.content)
            : (article.content || JSON.stringify({ version: 1, blocks: [] }));
        }

        if (article.image) {
          this.setCoverImage(article.image);
        }

        const sSelect = document.getElementById('articleServer');
        if (sSelect && article.server) {
          sSelect.value = article.server;
          await this.loadHubsForFranchise(article.server);
          await this.loadRolesForFranchise(article.server);
        }

        const hSelect = document.getElementById('articleHub');
        if (hSelect && article.hub_id) {
          hSelect.value = article.hub_id;
        }
        this.updateFranchisePath();

        const lockedSelect = document.getElementById('articleLocked');
        if (lockedSelect) lockedSelect.value = article.locked ? 'true' : 'false';

        if (this.tagsField && Array.isArray(article.tags)) {
          this.tagsField.setValues(article.tags);
        }

        // Проверяем слои статьи
        try {
          const layersRes = await fetch(`/api/articles/${encodeURIComponent(article.id)}/layers`, { headers });
          if (layersRes.ok) {
            const layersData = await layersRes.json();
            if (layersData.layersEnabled && Array.isArray(layersData.layers) && layersData.layers.length) {
              this.articleLayers = layersData.layers;
              const toggle = document.getElementById('articleLayersToggle');
              if (toggle) toggle.checked = true;
              this.setLayersMode(true);
              this.loadLayerIntoForm(0);
            }
          }
        } catch (e) {}

        if (this.editorManager) {
          this.editorManager.renderAll();
          this.editorManager.scheduleRenderPreview(true);
        }
      } catch (err) {
        showMessage('Не удалось загрузить статью: ' + err.message, 'error');
      }
    }

    // === ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ЧЕРНОВИКОВ ===
    parseDraftContent(content) {
      if (content && typeof content === 'object') return content;
      const str = String(content || '').trim();
      if (!str) return { version: 1, blocks: [] };
      if (str[0] === '{') {
        try {
          const doc = JSON.parse(str);
          if (doc && Array.isArray(doc.blocks)) return doc;
        } catch (e) {}
      }
      return { version: 1, blocks: [{ type: 'paragraph', data: { markdown: str } }] };
    }

    isDraftContentEmpty(content) {
      const doc = this.parseDraftContent(content);
      return doc.blocks.every((b) => b && b.type === 'paragraph' && !String((b.data && b.data.markdown) || '').trim());
    }

    draftContentToText(content) {
      const doc = this.parseDraftContent(content);
      try {
        if (window.blocksToExcerptText) return window.blocksToExcerptText(doc, 5000);
      } catch (e) {}
      return doc.blocks.map((b) => (b && b.data && b.data.markdown) || '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
    }

    draftTags(data) {
      const own = Array.isArray(data.tags) ? data.tags : [];
      const layerTags = Array.isArray(data.layers)
        ? data.layers.flatMap((l) => (l && Array.isArray(l.tags) ? l.tags : []))
        : [];
      return [...new Set([...own, ...layerTags].map(String))];
    }

    escapeDraftHtml(str) {
      return String(str || '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }

    highlightDraftText(text, terms) {
      const raw = String(text || '');
      if (!terms || !terms.length) return this.escapeDraftHtml(raw);
      const pattern = terms
        .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/е/g, '[её]'))
        .join('|');
      const re = new RegExp(`(${pattern})`, 'gi');
      return raw.split(re).map((part, i) => (i % 2 ? `<mark>${this.escapeDraftHtml(part)}</mark>` : this.escapeDraftHtml(part))).join('');
    }

    draftExcerpt(text, terms) {
      const raw = String(text || '');
      if (!raw) return '';
      if (terms && terms.length) {
        const norm = this.normalizeDraftSearch(raw);
        const idx = terms.map((t) => norm.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
        if (idx > 80) return '…' + raw.slice(idx - 60, idx + 220);
      }
      return raw.slice(0, 280);
    }

    formatDraftTime(ts) {
      if (!ts) return '';
      const date = new Date(ts);
      const now = new Date();
      const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      const diffMin = Math.floor((now - date) / 60000);
      if (diffMin < 1) return 'только что';
      if (diffMin < 60) return `${diffMin} мин назад`;
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      if (ts >= startOfToday) return `сегодня, ${time}`;
      if (ts >= startOfToday - 86400000) return `вчера, ${time}`;
      const sameYear = date.getFullYear() === now.getFullYear();
      return `${date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })}, ${time}`;
    }

    normalizeDraftSearch(str) {
      return String(str || '').toLowerCase().replace(/ё/g, 'е');
    }

    buildDraftFolderIndex(folders) {
      const byId = new Map(folders.map((f) => [f.id, f]));
      const parentOf = (id) => {
        const f = byId.get(id);
        return f && f.parentId && byId.has(f.parentId) ? f.parentId : null;
      };
      const kids = new Map();
      folders.forEach((f) => {
        const p = parentOf(f.id);
        if (!kids.has(p)) kids.set(p, []);
        kids.get(p).push(f);
      });
      const byName = (a, b) => a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' });
      kids.forEach((list) => list.sort(byName));
      const children = (id) => kids.get(id || null) || [];
      const path = (id) => {
        const out = [];
        for (let cur = id, guard = 0; cur && byId.has(cur) && guard < 50; cur = parentOf(cur), guard++) out.unshift(byId.get(cur));
        return out;
      };
      const descendants = (id) => {
        const out = new Set();
        const walk = (cur) => {
          if (out.has(cur)) return;
          out.add(cur);
          children(cur).forEach((c) => walk(c.id));
        };
        walk(id);
        return out;
      };
      const flat = () => {
        const out = [];
        const walk = (id, depth) => children(id).forEach((f) => {
          out.push({ folder: f, depth });
          walk(f.id, depth + 1);
        });
        walk(null, 0);
        return out;
      };
      return { byId, children, path, descendants, flat };
    }

    buildDraftCardHtml(d, terms, folderName = null) {
      const esc = (v) => this.escapeDraftHtml(v);
      const isCurrent = d.id === this.currentDraftId;
      const tags = Array.isArray(d.tags) ? d.tags : [];
      const shownTags = tags.slice(0, 4);
      const fullDate = (ts) => (ts ? new Date(ts).toLocaleString('ru-RU') : '');
      const excerpt = this.draftExcerpt(d.text, terms);

      let syncBadge = '';
      if (d.pending && !d.onServer) {
        syncBadge = '<span class="drafts-card-badge is-local" title="Сохранён только на этом устройстве — загрузится на сервер, когда будет связь"><i class="fas fa-mobile-alt"></i> Только здесь</span>';
      } else if (d.pending) {
        syncBadge = '<span class="drafts-card-badge is-pending" title="Есть правки, которые ещё не загружены на сервер"><i class="fas fa-cloud-upload-alt"></i> Не синхронизирован</span>';
      }

      return `
        <article class="antropedia-card drafts-card${isCurrent ? ' is-current' : ''}" data-id="${esc(d.id)}" tabindex="0" draggable="true" title="Открыть черновик">
          ${d.image
            ? `<div class="antropedia-card-cover"><img src="${esc(d.image)}" alt="" loading="lazy" onerror="this.parentElement.classList.add('antropedia-card-cover-empty');this.parentElement.innerHTML='<i class=&quot;fas fa-file-alt&quot;></i>'"></div>`
            : '<div class="antropedia-card-cover antropedia-card-cover-empty"><i class="fas fa-file-alt"></i></div>'}
          <div class="drafts-card-check" aria-hidden="true"><i class="fas fa-check"></i></div>
          <div class="drafts-card-badges">
            ${isCurrent ? '<span class="drafts-card-badge is-current"><i class="fas fa-pen"></i> Открыт</span>' : ''}
            ${d.locked ? '<span class="drafts-card-badge is-locked" title="Закрытая статья"><i class="fas fa-lock"></i></span>' : ''}
            ${syncBadge}
          </div>
          <button type="button" class="drafts-card-move" data-action="move-draft" data-id="${esc(d.id)}" title="Перенести в папку" aria-label="Перенести в папку">
            <i class="fas fa-folder"></i>
          </button>
          <button type="button" class="drafts-card-delete" data-action="delete-draft" data-id="${esc(d.id)}" title="Удалить черновик" aria-label="Удалить черновик">
            <i class="fas fa-trash"></i>
          </button>
          <div class="antropedia-card-body">
            <h3 class="antropedia-card-title">${d.title ? this.highlightDraftText(d.title, terms) : '<span class="drafts-card-untitled">Без названия</span>'}</h3>
            ${excerpt ? `<p class="antropedia-card-excerpt">${this.highlightDraftText(excerpt, terms)}</p>` : '<p class="antropedia-card-excerpt drafts-card-no-text">Текста пока нет</p>'}
            ${shownTags.length ? `<div class="antropedia-card-tags">${shownTags.map((t) =>
              `<span class="antropedia-tag-pill" data-action="filter-tag" data-value="${esc(t)}" title="Искать по тегу">#${this.highlightDraftText(t, terms)}</span>`
            ).join('')}${tags.length > shownTags.length ? `<span class="antropedia-tag-pill drafts-card-more-tags">+${tags.length - shownTags.length}</span>` : ''}</div>` : ''}
            <div class="antropedia-card-meta">
              <span title="Изменён ${esc(fullDate(d.updatedAt))}${d.createdAt ? ` · создан ${esc(fullDate(d.createdAt))}` : ''}"><i class="fas fa-clock"></i> ${esc(this.formatDraftTime(d.updatedAt))}</span>
              ${folderName ? `<span class="drafts-card-folder" title="Папка"><i class="fas fa-folder"></i> ${esc(folderName)}</span>` : ''}
            </div>
          </div>
        </article>
      `;
    }

    // === МОДАЛЬНОЕ ОКНО «МОИ ЧЕРНОВИКИ» ===
    ensureDraftsModal() {
      if (this._draftsModalEls && document.body.contains(this._draftsModalEls.overlay)) {
        return this._draftsModalEls;
      }
      const existing = document.getElementById('draftsModal');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay drafts-modal';
      overlay.id = 'draftsModal';
      overlay.hidden = true;
      overlay.innerHTML = `
        <div class="modal-box drafts-modal-box" role="dialog" aria-modal="true" aria-labelledby="draftsModalTitle">
          <div class="modal-header">
            <div>
              <h3 id="draftsModalTitle"><i class="fas fa-folder-open"></i> Мои черновики</h3>
              <p class="modal-subtitle" id="draftsModalSubtitle">Хранятся в профиле — доступны с любого устройства</p>
            </div>
            <button type="button" class="modal-close" data-action="close" aria-label="Закрыть">&times;</button>
          </div>
          <div class="drafts-modal-toolbar">
            <div class="drafts-modal-search">
              <i class="fas fa-search"></i>
              <input type="search" id="draftsModalSearch" placeholder="Поиск по названию, тексту и тегам..." autocomplete="off">
            </div>
            <select id="draftsModalSort" class="drafts-modal-sort" aria-label="Сортировка">
              <option value="updated">Недавно изменённые</option>
              <option value="created">Недавно созданные</option>
              <option value="title">По названию</option>
            </select>
            <button type="button" class="drafts-modal-select-btn" data-action="new-folder" title="Создать папку (внутри открытой сейчас папки)">
              <i class="fas fa-folder-plus"></i> <span>Папка</span>
            </button>
            <button type="button" class="drafts-modal-select-btn" data-action="toggle-select" title="Выбрать несколько черновиков — удалить или перенести в папку">
              <i class="far fa-check-square"></i> <span>Выбрать</span>
            </button>
          </div>
          <div class="drafts-modal-status" id="draftsModalStatus" hidden></div>
          <div class="drafts-modal-crumbs" id="draftsModalCrumbs" hidden></div>
          <div class="drafts-modal-body">
            <div class="drafts-modal-folders" id="draftsModalFolders" hidden></div>
            <div class="drafts-modal-grid" id="draftsModalGrid"></div>
            <div class="drafts-modal-empty" id="draftsModalEmpty" hidden></div>
          </div>
          <div class="modal-footer">
            <span class="drafts-modal-count" id="draftsModalCount"></span>
            <div class="drafts-modal-select-actions" hidden>
              <button type="button" class="btn btn-secondary" data-action="select-all"><i class="fas fa-check-double"></i> Все</button>
              <button type="button" class="btn btn-secondary" data-action="move-selected"><i class="fas fa-folder"></i> В папку</button>
              <button type="button" class="btn btn-danger" data-action="delete-selected"><i class="fas fa-trash"></i> Удалить</button>
            </div>
            <button type="button" class="btn btn-secondary" data-action="close">Закрыть</button>
          </div>
          <div class="drafts-move-menu" id="draftsMoveMenu" role="menu" hidden></div>
        </div>
      `;
      document.body.appendChild(overlay);

      const els = {
        overlay,
        search: overlay.querySelector('#draftsModalSearch'),
        sort: overlay.querySelector('#draftsModalSort'),
        status: overlay.querySelector('#draftsModalStatus'),
        grid: overlay.querySelector('#draftsModalGrid'),
        folders: overlay.querySelector('#draftsModalFolders'),
        crumbs: overlay.querySelector('#draftsModalCrumbs'),
        moveMenu: overlay.querySelector('#draftsMoveMenu'),
        empty: overlay.querySelector('#draftsModalEmpty'),
        count: overlay.querySelector('#draftsModalCount'),
        selectBtn: overlay.querySelector('[data-action="toggle-select"]'),
        selectActions: overlay.querySelector('.drafts-modal-select-actions'),
        deleteSelectedBtn: overlay.querySelector('[data-action="delete-selected"]'),
        moveSelectedBtn: overlay.querySelector('[data-action="move-selected"]')
      };
      this._draftsModalEls = els;

      try {
        const savedSort = localStorage.getItem('draftsModalSort');
        if (savedSort && els.sort.querySelector(`option[value="${savedSort}"]`)) els.sort.value = savedSort;
      } catch (e) {}

      overlay.addEventListener('click', (e) => {
        const moveItem = e.target.closest('[data-action="move-to"]');
        if (moveItem) {
          const ids = this._draftsMoveIds || [];
          const movingFolder = this._draftsMoveFolderId;
          this.closeDraftsMoveMenu();
          if (movingFolder) this.moveDraftFolder(movingFolder, moveItem.dataset.folderId || null);
          else this.moveDraftsToFolder(ids, moveItem.dataset.folderId || null);
          return;
        }
        if (e.target.closest('[data-action="move-to-new"]')) {
          const ids = this._draftsMoveIds || [];
          this.closeDraftsMoveMenu();
          this.createDraftFolder(ids);
          return;
        }
        if (!els.moveMenu.hidden && !e.target.closest('#draftsMoveMenu')) {
          this.closeDraftsMoveMenu();
          return;
        }
        if (e.target === overlay || e.target.closest('[data-action="close"]')) {
          this.closeDraftsModal();
          return;
        }
        if (e.target.closest('[data-action="new-folder"]')) { this.createDraftFolder(); return; }
        const crumb = e.target.closest('[data-action="folder-open"]');
        if (crumb) { this.openDraftsFolder(crumb.dataset.folderId || null); return; }
        const moveFolderBtn = e.target.closest('[data-action="move-folder"]');
        if (moveFolderBtn) { this.openDraftsMoveMenu([], moveFolderBtn, this._draftsFolderId); return; }
        if (e.target.closest('[data-action="rename-folder"]')) { this.renameDraftFolder(this._draftsFolderId); return; }
        if (e.target.closest('[data-action="delete-folder"]')) { this.deleteDraftFolder(this._draftsFolderId); return; }
        if (e.target.closest('[data-action="toggle-select"]')) { this.setDraftsSelectMode(!this._draftsSelectMode); return; }
        if (e.target.closest('[data-action="select-all"]')) { this.selectAllVisibleDrafts(); return; }
        if (e.target.closest('[data-action="delete-selected"]')) { this.deleteSelectedDrafts(); return; }
        const moveSelected = e.target.closest('[data-action="move-selected"]');
        if (moveSelected) {
          if (this._draftsSelected && this._draftsSelected.size) this.openDraftsMoveMenu(Array.from(this._draftsSelected), moveSelected);
          return;
        }
        const folderTile = e.target.closest('.drafts-folder');
        if (folderTile) { this.openDraftsFolder(folderTile.dataset.folderId); return; }
        if (this._draftsSelectMode) {
          const selCard = e.target.closest('.drafts-card');
          if (selCard) this.toggleDraftSelected(selCard.dataset.id);
          return;
        }
        const deleteBtn = e.target.closest('[data-action="delete-draft"]');
        if (deleteBtn) {
          e.stopPropagation();
          this.deleteDraft(deleteBtn.dataset.id);
          return;
        }
        const moveBtn = e.target.closest('[data-action="move-draft"]');
        if (moveBtn) {
          e.stopPropagation();
          this.openDraftsMoveMenu([moveBtn.dataset.id], moveBtn);
          return;
        }
        const tagPill = e.target.closest('[data-action="filter-tag"]');
        if (tagPill) {
          e.stopPropagation();
          els.search.value = tagPill.dataset.value;
          this.renderDraftsModal();
          return;
        }
        const card = e.target.closest('.drafts-card');
        if (card) this.openDraftFromModal(card.dataset.id);
      });

      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (!els.moveMenu.hidden) this.closeDraftsMoveMenu();
          else if (this._draftsSelectMode) this.setDraftsSelectMode(false);
          else this.closeDraftsModal();
        } else if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('drafts-folder')) {
          e.preventDefault();
          this.openDraftsFolder(e.target.dataset.folderId);
        } else if (this._draftsSelectMode && (e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('drafts-card')) {
          e.preventDefault();
          this.toggleDraftSelected(e.target.dataset.id);
        } else if (e.key === 'Enter' && e.target === els.search) {
          const first = els.grid.querySelector('.drafts-card');
          if (first) this.openDraftFromModal(first.dataset.id);
        } else if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('drafts-card')) {
          e.preventDefault();
          this.openDraftFromModal(e.target.dataset.id);
        }
      });
      els.search.addEventListener('input', () => this.renderDraftsModal());

      // Drag & drop
      overlay.addEventListener('dragstart', (e) => {
        const card = e.target.closest?.('.drafts-card, .drafts-folder');
        if (!card || this._draftsSelectMode) return;
        const isFolder = card.classList.contains('drafts-folder');
        this._draftsDrag = isFolder ? { folderId: card.dataset.folderId } : { draftId: card.dataset.id };
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', isFolder ? card.dataset.folderId : card.dataset.id); } catch (err) {}
        card.classList.add('is-dragging');
      });
      overlay.addEventListener('dragend', () => {
        overlay.querySelectorAll('.is-dragging, .is-drop-target').forEach((el) => el.classList.remove('is-dragging', 'is-drop-target'));
        this._draftsDrag = null;
      });
      const dropTarget = (e) => {
        const drag = this._draftsDrag;
        if (!drag) return null;
        const target = e.target.closest?.('.drafts-folder, [data-action="folder-open"]');
        if (!target || (drag.folderId && target.dataset.folderId === drag.folderId)) return null;
        return target;
      };
      overlay.addEventListener('dragover', (e) => {
        const target = dropTarget(e);
        if (!target) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        target.classList.add('is-drop-target');
      });
      overlay.addEventListener('dragleave', (e) => {
        const target = dropTarget(e);
        if (target && !target.contains(e.relatedTarget)) target.classList.remove('is-drop-target');
      });
      overlay.addEventListener('drop', (e) => {
        const target = dropTarget(e);
        if (!target) return;
        e.preventDefault();
        target.classList.remove('is-drop-target');
        const drag = this._draftsDrag;
        this._draftsDrag = null;
        const folderId = target.dataset.folderId || null;
        if (drag.folderId) this.moveDraftFolder(drag.folderId, folderId);
        else if (drag.draftId) this.moveDraftsToFolder([drag.draftId], folderId);
      });
      els.sort.addEventListener('change', () => {
        try { localStorage.setItem('draftsModalSort', els.sort.value); } catch (e) {}
        this.renderDraftsModal();
      });

      return els;
    }

    async openDraftsModal() {
      const els = this.ensureDraftsModal();
      els.overlay.hidden = false;
      els.search.value = '';
      this.setDraftsSelectMode(false);
      els.grid.innerHTML = '<div class="drafts-modal-loading"><i class="fas fa-spinner fa-spin"></i> Загрузка черновиков…</div>';
      els.empty.hidden = true;
      els.status.hidden = true;
      els.count.textContent = '';
      setTimeout(() => els.search.focus(), 50);

      await this.flushPendingDrafts();
      await this.refreshDraftsModalIfOpen();
    }

    closeDraftsModal() {
      this.closeDraftsMoveMenu();
      if (this._draftsModalEls) {
        this._draftsModalEls.overlay.hidden = true;
      }
    }

    async refreshDraftsModalIfOpen() {
      const els = this._draftsModalEls;
      if (!els || els.overlay.hidden) return;
      const { items, folders, offline } = await this.fetchDraftList();
      this._draftsModalItems = items;
      this._draftsFolders = folders;
      this._draftsModalOffline = offline;
      this.renderDraftsModal();
    }

    async fetchDraftList() {
      let serverItems = [];
      let folders = [];
      let offline = false;
      if (isAuthenticated()) {
        try {
          const [res, foldersRes] = await Promise.all([
            this.draftsFetch('GET', ''),
            this.draftsFetch('GET', '', null, '/api/draft-folders').catch(() => null)
          ]);
          if (res.ok && Array.isArray(res.json)) {
            serverItems = res.json;
          } else {
            offline = true;
          }
          if (foldersRes && foldersRes.ok && Array.isArray(foldersRes.json)) {
            folders = foldersRes.json;
          } else if (Array.isArray(this._draftsFolders)) {
            folders = this._draftsFolders;
          }
        } catch (error) {
          offline = true;
          if (Array.isArray(this._draftsFolders)) folders = this._draftsFolders;
        }
      } else {
        offline = true;
      }

      const byId = new Map(serverItems.map((d) => [d.id, { ...d, onServer: true, pending: false }]));
      this.getPendingDrafts().forEach((p) => {
        const data = p.data || {};
        const server = byId.get(p.id);
        byId.set(p.id, {
          id: p.id,
          folderId: server ? server.folderId || null : null,
          title: data.title || '',
          text: this.draftContentToText(data.content),
          image: data.image || '',
          tags: this.draftTags(data),
          locked: !!data.locked,
          createdAt: server ? server.createdAt : p.updatedAt,
          updatedAt: p.updatedAt,
          onServer: !!server,
          pending: true
        });
      });

      const items = [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return { items, folders, offline };
    }

    renderDraftsModal() {
      const els = this._draftsModalEls;
      if (!els) return;
      const all = this._draftsModalItems || [];

      const pendingCount = all.filter((d) => d.pending).length;
      if (this._draftsModalOffline) {
        els.status.hidden = false;
        els.status.className = 'drafts-modal-status is-offline';
        els.status.innerHTML = '<i class="fas fa-plug"></i> Нет связи с сервером — показаны только копии, сохранённые на этом устройстве. Они загрузятся сами, когда связь вернётся.';
      } else if (pendingCount) {
        els.status.hidden = false;
        els.status.className = 'drafts-modal-status is-pending';
        els.status.innerHTML = `<i class="fas fa-cloud-upload-alt"></i> Ждут синхронизации: ${pendingCount}`;
      } else {
        els.status.hidden = true;
      }

      const folders = this._draftsFolders || [];
      const tree = this.buildDraftFolderIndex(folders);
      if (this._draftsFolderId && !tree.byId.has(this._draftsFolderId)) this._draftsFolderId = null;
      const currentFolderId = this._draftsFolderId || null;
      const folderOf = (d) => (d.folderId && tree.byId.has(d.folderId) ? d.folderId : null);
      const subtree = currentFolderId ? tree.descendants(currentFolderId) : null;

      const query = this.normalizeDraftSearch(els.search.value.trim().replace(/^#/, ''));
      const terms = query.split(/\s+/).filter(Boolean);
      const scope = terms.length
        ? (subtree ? all.filter((d) => subtree.has(folderOf(d))) : all)
        : all.filter((d) => folderOf(d) === currentFolderId);
      let items = terms.length
        ? scope.filter((d) => {
          const haystack = this.normalizeDraftSearch(`${d.title} ${d.text} ${(d.tags || []).join(' ')}`);
          return terms.every((t) => haystack.includes(t));
        })
        : scope.slice();

      const esc = (v) => this.escapeDraftHtml(v);
      if (currentFolderId) {
        const path = tree.path(currentFolderId);
        const parents = path.slice(0, -1).map((f) => `
          <span class="drafts-crumb-sep">/</span>
          <button type="button" class="drafts-crumb-link" data-action="folder-open" data-folder-id="${esc(f.id)}" title="Открыть папку">${esc(f.name)}</button>`).join('');
        els.crumbs.hidden = false;
        els.crumbs.innerHTML = `
          <button type="button" class="drafts-crumb-root" data-action="folder-open" data-folder-id="" title="Все черновики"><i class="fas fa-home"></i> Все черновики</button>
          ${parents}
          <span class="drafts-crumb-sep">/</span>
          <span class="drafts-crumb-current"><i class="fas fa-folder-open"></i> ${esc(path[path.length - 1].name)}</span>
          <button type="button" class="drafts-crumb-btn" data-action="rename-folder" title="Переименовать папку"><i class="fas fa-pen"></i></button>
          <button type="button" class="drafts-crumb-btn" data-action="move-folder" title="Переместить папку в другую папку"><i class="fas fa-share"></i></button>
          <button type="button" class="drafts-crumb-btn is-danger" data-action="delete-folder" title="Удалить папку"><i class="fas fa-trash"></i></button>
        `;
      } else {
        els.crumbs.hidden = true;
        els.crumbs.innerHTML = '';
      }

      const childFolders = terms.length ? [] : tree.children(currentFolderId);
      els.folders.hidden = !childFolders.length;
      if (childFolders.length) {
        els.folders.innerHTML = childFolders.map((f) => {
          const inside = tree.descendants(f.id);
          const count = all.filter((d) => inside.has(folderOf(d))).length;
          const subCount = inside.size - 1;
          return `
          <div class="drafts-folder" data-folder-id="${esc(f.id)}" tabindex="0" draggable="true" title="Открыть папку${subCount ? ` · вложенных папок: ${subCount}` : ''}">
            <i class="fas fa-folder"></i>
            <span class="drafts-folder-name">${esc(f.name)}</span>
            ${subCount ? '<i class="fas fa-layer-group drafts-folder-nested" aria-hidden="true"></i>' : ''}
            <span class="drafts-folder-count">${count}</span>
          </div>`;
        }).join('');
      } else {
        els.folders.innerHTML = '';
      }

      const sort = els.sort.value;
      if (sort === 'created') items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      else if (sort === 'title') items.sort((a, b) => (a.title || 'Без названия').localeCompare(b.title || 'Без названия', 'ru'));
      else items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

      if (terms.length) els.count.textContent = `Найдено ${items.length} из ${scope.length}`;
      else if (currentFolderId) els.count.textContent = `В папке: ${all.filter((d) => subtree.has(folderOf(d))).length} · всего черновиков: ${all.length}`;
      else els.count.textContent = all.length ? `Всего черновиков: ${all.length}` : '';

      if (!items.length) {
        els.grid.innerHTML = '';
        if (terms.length) {
          els.empty.hidden = false;
          els.empty.innerHTML = `<i class="fas fa-search"></i><div>Ничего не найдено по запросу «${this.escapeDraftHtml(els.search.value.trim())}»</div>`;
        } else if (currentFolderId && !childFolders.length) {
          els.empty.hidden = false;
          els.empty.innerHTML = '<i class="fas fa-folder-open"></i><div>Папка пуста</div><div class="drafts-modal-empty-hint">Перенесите сюда черновик кнопкой <i class="fas fa-folder"></i> на его карточке или перетащите карточку на папку.</div>';
        } else if (!all.length && !folders.length) {
          els.empty.hidden = false;
          els.empty.innerHTML = '<i class="fas fa-file-alt"></i><div>Черновиков пока нет</div><div class="drafts-modal-empty-hint">Нажмите «💾 Черновик» в редакторе, чтобы сохранить статью и вернуться к ней позже — с этого или другого устройства.</div>';
        } else {
          els.empty.hidden = true;
        }
        this.updateDraftsSelectUI();
        return;
      }

      els.empty.hidden = true;
      const folderLabel = (d) => {
        const f = folderOf(d);
        if (!terms.length || f === currentFolderId) return null;
        const path = tree.path(f);
        const from = currentFolderId ? path.findIndex((x) => x.id === currentFolderId) + 1 : 0;
        return path.slice(from).map((x) => x.name).join(' / ');
      };
      els.grid.innerHTML = items.map((d) => this.buildDraftCardHtml(d, terms, folderLabel(d))).join('');
      this.updateDraftsSelectUI();
    }

    openDraftsFolder(folderId) {
      const els = this._draftsModalEls;
      this._draftsFolderId = folderId || null;
      if (els) els.search.value = '';
      this.renderDraftsModal();
      if (els) els.overlay.querySelector('.drafts-modal-body').scrollTop = 0;
    }

    openDraftsMoveMenu(ids, anchor, folderId = null) {
      const els = this._draftsModalEls;
      if (!els || (!ids.length && !folderId)) return;
      this._draftsMoveIds = ids;
      this._draftsMoveFolderId = folderId || null;
      const esc = (v) => this.escapeDraftHtml(v);
      const items = this._draftsModalItems || [];
      const tree = this.buildDraftFolderIndex(this._draftsFolders || []);

      let same;
      let excluded = new Set();
      if (folderId) {
        const f = tree.byId.get(folderId);
        same = (f && f.parentId && tree.byId.has(f.parentId)) ? f.parentId : '';
        excluded = tree.descendants(folderId);
      } else {
        const current = new Set(ids.map((id) => {
          const fid = (items.find((d) => d.id === id) || {}).folderId;
          return fid && tree.byId.has(fid) ? fid : '';
        }));
        same = current.size === 1 ? [...current][0] : undefined;
      }

      const itemHtml = (fid, icon, label, depth = 0) => `
        <button type="button" class="drafts-move-item${same === fid ? ' is-current' : ''}" role="menuitem" data-action="move-to" data-folder-id="${esc(fid)}" style="padding-left: ${10 + depth * 16}px">
          <i class="${icon}"></i> <span>${esc(label)}</span>${same === fid ? ' <i class="fas fa-check drafts-move-check"></i>' : ''}
        </button>`;
      els.moveMenu.innerHTML = `
        <div class="drafts-move-title">${folderId ? 'Переместить папку в' : 'Перенести в папку'}</div>
        ${itemHtml('', 'fas fa-home', folderId ? 'Верхний уровень' : 'Без папки')}
        ${tree.flat().filter(({ folder }) => !excluded.has(folder.id)).map(({ folder, depth }) => itemHtml(folder.id, 'fas fa-folder', folder.name, depth + 1)).join('')}
        ${folderId ? '' : '<button type="button" class="drafts-move-item is-new" role="menuitem" data-action="move-to-new"><i class="fas fa-folder-plus"></i> <span>Новая папка…</span></button>'}
      `;
      els.moveMenu.hidden = false;

      const box = els.overlay.querySelector('.drafts-modal-box');
      const boxRect = box.getBoundingClientRect();
      const a = anchor.getBoundingClientRect();
      const menuW = els.moveMenu.offsetWidth;
      const menuH = els.moveMenu.offsetHeight;
      let top = a.bottom - boxRect.top + 4;
      if (top + menuH > boxRect.height - 8) top = Math.max(8, a.top - boxRect.top - menuH - 4);
      const left = Math.min(Math.max(8, a.right - boxRect.left - menuW), boxRect.width - menuW - 8);
      els.moveMenu.style.top = `${top}px`;
      els.moveMenu.style.left = `${Math.max(8, left)}px`;
      els.moveMenu.querySelector('.drafts-move-item')?.focus();
    }

    closeDraftsMoveMenu() {
      const els = this._draftsModalEls;
      if (els) els.moveMenu.hidden = true;
      this._draftsMoveIds = null;
      this._draftsMoveFolderId = null;
    }

    draftFolderApiError(res, action) {
      if (res.json && res.json.error) return res.json.error;
      if (res.status === 404) return `Не удалось ${action}: сервер не знает о папках`;
      return `Не удалось ${action}: ошибка ${res.status}`;
    }

    async moveDraftsToFolder(ids, folderId) {
      const items = this._draftsModalItems || [];
      const target = folderId || null;
      const toMove = ids.filter((id) => {
        const d = items.find((x) => x.id === id);
        return d && (d.folderId || null) !== target;
      });
      if (!toMove.length) return;
      const localOnly = toMove.filter((id) => !(items.find((x) => x.id === id) || {}).onServer);
      const onServer = toMove.filter((id) => !localOnly.includes(id));
      if (!onServer.length) {
        showMessage('Черновик ещё не загружен на сервер — перенести его в папку можно будет, когда появится связь', 'warning');
        return;
      }

      let res;
      try {
        res = await this.draftsFetch('POST', '/move', { ids: onServer, folderId: target });
      } catch (error) {
        showMessage('Нет связи с сервером — не удалось перенести черновик', 'error');
        return;
      }
      if (!res.ok) {
        showMessage(this.draftFolderApiError(res, 'перенести'), 'error');
        await this.refreshDraftsModalIfOpen();
        return;
      }

      onServer.forEach((id) => {
        const d = items.find((x) => x.id === id);
        if (d) d.folderId = target;
      });
      const folderName = target ? ((this._draftsFolders || []).find((f) => f.id === target) || {}).name : null;
      const where = folderName ? `в папку «${folderName}»` : 'из папки';
      const moved = res.json && Number.isFinite(res.json.moved) ? res.json.moved : onServer.length;
      if (localOnly.length) {
        showMessage(`Перенесено ${where}: ${moved}. Ещё не загруженные на сервер черновики (${localOnly.length}) остались на месте`, 'warning');
      } else {
        showMessage(moved === 1 ? `Черновик перенесён ${where}` : `Перенесено ${where}: ${moved}`, 'success');
      }
      if (this._draftsSelectMode) {
        this._draftsSelectMode = false;
        this._draftsSelected = new Set();
      }
      this.renderDraftsModal();
    }

    async moveDraftFolder(folderId, parentId) {
      const tree = this.buildDraftFolderIndex(this._draftsFolders || []);
      const folder = tree.byId.get(folderId);
      if (!folder) return;
      const target = parentId || null;
      const currentParent = folder.parentId && tree.byId.has(folder.parentId) ? folder.parentId : null;
      if (target === currentParent) return;
      if (target && tree.descendants(folderId).has(target)) {
        showMessage('Нельзя переместить папку в неё саму или во вложенную в неё папку', 'warning');
        return;
      }
      let res;
      try {
        res = await this.draftsFetch('PATCH', `/${encodeURIComponent(folderId)}`, { parentId: target }, '/api/draft-folders');
      } catch (error) {
        showMessage('Нет связи с сервером — папку переместить не удалось', 'error');
        return;
      }
      if (!res.ok) {
        showMessage(this.draftFolderApiError(res, 'переместить папку'), 'error');
        await this.refreshDraftsModalIfOpen();
        return;
      }
      folder.parentId = target;
      const where = target ? `в папку «${tree.byId.get(target).name}»` : 'на верхний уровень';
      showMessage(`Папка «${folder.name}» перемещена ${where}`, 'success');
      this.renderDraftsModal();
    }

    async createDraftFolder(moveIds = null) {
      const parentId = this._draftsFolderId || null;
      const parent = parentId ? (this._draftsFolders || []).find((f) => f.id === parentId) : null;
      const promptMsg = parent ? `Название новой папки внутри «${parent.name}»:` : 'Название новой папки:';
      const name = window.confirmDialog
        ? await window.confirmDialog.prompt({
            title: 'Новая папка черновиков',
            message: promptMsg,
            placeholder: 'Название папки…',
            confirmLabel: 'Создать'
          })
        : prompt(promptMsg);
      if (name == null) return;
      if (!name.trim()) {
        showMessage('Название папки не может быть пустым', 'warning');
        return;
      }
      let res;
      try {
        res = await this.draftsFetch('POST', '', { name: name.trim(), parentId }, '/api/draft-folders');
      } catch (error) {
        showMessage('Нет связи с сервером — папку создать не удалось', 'error');
        return;
      }
      if (!res.ok || !res.json) {
        showMessage(this.draftFolderApiError(res, 'создать папку'), 'error');
        return;
      }
      this._draftsFolders = (this._draftsFolders || []).concat(res.json);
      if (moveIds && moveIds.length) {
        await this.moveDraftsToFolder(moveIds, res.json.id);
      } else {
        showMessage(`Папка «${res.json.name}» создана`, 'success');
        this.renderDraftsModal();
      }
    }

    async renameDraftFolder(folderId) {
      const folder = (this._draftsFolders || []).find((f) => f.id === folderId);
      if (!folder) return;
      const name = window.confirmDialog
        ? await window.confirmDialog.prompt({
            title: 'Переименовать папку',
            message: 'Новое название папки:',
            value: folder.name,
            confirmLabel: 'Сохранить'
          })
        : prompt('Новое название папки:', folder.name);
      if (name == null || name.trim() === folder.name) return;
      if (!name.trim()) {
        showMessage('Название папки не может быть пустым', 'warning');
        return;
      }
      let res;
      try {
        res = await this.draftsFetch('PATCH', `/${encodeURIComponent(folderId)}`, { name: name.trim() }, '/api/draft-folders');
      } catch (error) {
        showMessage('Нет связи с сервером — папку переименовать не удалось', 'error');
        return;
      }
      if (!res.ok || !res.json) {
        showMessage(this.draftFolderApiError(res, 'переименовать папку'), 'error');
        await this.refreshDraftsModalIfOpen();
        return;
      }
      folder.name = res.json.name;
      this.renderDraftsModal();
    }

    async deleteDraftFolder(folderId) {
      const tree = this.buildDraftFolderIndex(this._draftsFolders || []);
      const folder = tree.byId.get(folderId);
      if (!folder) return;
      const parentId = folder.parentId && tree.byId.has(folder.parentId) ? folder.parentId : null;
      const whereTo = parentId ? `в папку «${tree.byId.get(parentId).name}»` : 'в «Все черновики»';
      const drafts = (this._draftsModalItems || []).filter((d) => d.folderId === folderId).length;
      const subfolders = tree.children(folderId).length;
      const parts = [];
      if (drafts) parts.push(`черновики (${drafts})`);
      if (subfolders) parts.push(`вложенные папки (${subfolders})`);
      const ok = window.confirmDialog
        ? await window.confirmDialog.open({
            title: 'Удалить папку?',
            message: parts.length
              ? `Папка «${folder.name}» будет удалена. Её содержимое — ${parts.join(' и ')} — не удалится, а переместится ${whereTo}.`
              : `Удалить пустую папку «${folder.name}»?`
          })
        : confirm(`Удалить папку «${folder.name}»? Её содержимое останется.`);
      if (!ok) return;
      let res;
      try {
        res = await this.draftsFetch('DELETE', `/${encodeURIComponent(folderId)}`, null, '/api/draft-folders');
      } catch (error) {
        showMessage('Нет связи с сервером — папку удалить не удалось', 'error');
        return;
      }
      if (!res.ok) {
        showMessage(this.draftFolderApiError(res, 'удалить папку'), 'error');
        return;
      }
      this._draftsFolders = (this._draftsFolders || []).filter((f) => f.id !== folderId);
      this._draftsFolders.forEach((f) => { if (f.parentId === folderId) f.parentId = parentId; });
      (this._draftsModalItems || []).forEach((d) => { if (d.folderId === folderId) d.folderId = parentId; });
      if (this._draftsFolderId === folderId) this._draftsFolderId = parentId;
      showMessage(`Папка «${folder.name}» удалена`, 'success');
      this.renderDraftsModal();
    }

    setDraftsSelectMode(on) {
      this._draftsSelectMode = !!on;
      this._draftsSelected = new Set();
      this.renderDraftsModal();
      this.updateDraftsSelectUI();
    }

    toggleDraftSelected(id) {
      if (!id) return;
      if (!this._draftsSelected) this._draftsSelected = new Set();
      if (this._draftsSelected.has(id)) this._draftsSelected.delete(id);
      else this._draftsSelected.add(id);
      this.updateDraftsSelectUI();
    }

    selectAllVisibleDrafts() {
      const els = this._draftsModalEls;
      if (!els) return;
      els.grid.querySelectorAll('.drafts-card[data-id]').forEach((c) => this._draftsSelected.add(c.dataset.id));
      this.updateDraftsSelectUI();
    }

    updateDraftsSelectUI() {
      const els = this._draftsModalEls;
      if (!els) return;
      const on = !!this._draftsSelectMode;
      const selected = this._draftsSelected || new Set();
      const ids = new Set((this._draftsModalItems || []).map((d) => d.id));
      selected.forEach((id) => { if (!ids.has(id)) selected.delete(id); });

      els.grid.classList.toggle('is-selecting', on);
      els.grid.querySelectorAll('.drafts-card[data-id]').forEach((c) => c.classList.toggle('is-selected', on && selected.has(c.dataset.id)));
      if (els.selectBtn) {
        els.selectBtn.classList.toggle('active', on);
        els.selectBtn.querySelector('span').textContent = on ? 'Отмена' : 'Выбрать';
      }
      if (els.selectActions) els.selectActions.hidden = !on;
      if (els.deleteSelectedBtn) {
        els.deleteSelectedBtn.disabled = !selected.size;
        els.deleteSelectedBtn.innerHTML = `<i class="fas fa-trash"></i> Удалить${selected.size ? ` (${selected.size})` : ''}`;
      }
      if (els.moveSelectedBtn) els.moveSelectedBtn.disabled = !selected.size;
      if (on) els.count.textContent = selected.size ? `Выбрано: ${selected.size}` : 'Нажмите на черновики для выбора';
    }

    async deleteSelectedDrafts() {
      const ids = Array.from(this._draftsSelected || []);
      if (!ids.length) return;
      const ok = window.confirmDialog
        ? await window.confirmDialog.open({ message: `Удалить выбранные черновики (${ids.length})? Они пропадут на всех устройствах.` })
        : confirm(`Удалить выбранные черновики (${ids.length})?`);
      if (!ok) return;

      const items = this._draftsModalItems || [];
      let offlineOnly = 0;
      for (const id of ids) {
        const item = items.find((d) => d.id === id);
        const removed = await this.removeDraftEverywhere(id);
        if (!removed && !(item && !item.onServer)) offlineOnly++;
        if (id === this.currentDraftId) {
          this.currentDraftId = null;
          this.currentDraftRev = null;
        }
      }
      if (offlineOnly) {
        showMessage(`Удалено: ${ids.length}. Нет связи с сервером — ${offlineOnly} удалены только на этом устройстве`, 'warning');
      } else {
        showMessage(`Удалено черновиков: ${ids.length}`, 'success');
      }
      this._draftsSelectMode = false;
      this._draftsSelected = new Set();
      await this.refreshDraftsModalIfOpen();
      this.updateDraftsSelectUI();
    }

    async openDraftFromModal(draftId) {
      if (!draftId) return;
      const titleEl = document.getElementById('articleTitle');
      const contentEl = document.getElementById('articleContent');
      const editingExisting = !!document.getElementById('saveArticleBtn')?.getAttribute('data-article-id');
      const hasUnsaved = titleEl && contentEl && (titleEl.value.trim() || !this.isDraftContentEmpty(contentEl.innerHTML));
      if (hasUnsaved && draftId !== this.currentDraftId && (editingExisting || !this.currentDraftId || this.hasUnsavedDraftChanges())) {
        const ok = window.confirmDialog
          ? await window.confirmDialog.open({
              title: 'Загрузить черновик?',
              message: 'В редакторе есть несохранённые изменения. Если открыть другой черновик, текущие правки будут потеряны. Продолжить?',
              confirmLabel: 'Открыть черновик',
              cancelLabel: 'Отмена',
              danger: true
            })
          : confirm('В редакторе есть несохранённые изменения. Открыть черновик?');
        if (!ok) return;
      }
      const loaded = await this.loadDraft(draftId);
      if (loaded) this.closeDraftsModal();
    }

    hasUnsavedDraftChanges() {
      if (!this.currentDraftId) return true;
      const pending = this.getPendingDrafts().find((d) => d.id === this.currentDraftId);
      const saved = pending ? pending.data : this._lastLoadedDraftData;
      if (!saved) return true;
      try {
        return JSON.stringify(this.collectFormData()) !== JSON.stringify(saved);
      } catch (e) {
        return true;
      }
    }

    async removeDraftEverywhere(draftId) {
      this.removePendingDraft(draftId);
      if (this._draftRevs) delete this._draftRevs[draftId];
      try {
        const res = await this.draftsFetch('DELETE', `/${encodeURIComponent(draftId)}`);
        return res.ok;
      } catch (error) {
        return false;
      }
    }

    async deleteDraft(draftId) {
      const item = (this._draftsModalItems || []).find((d) => d.id === draftId);
      const title = item && item.title ? `«${item.title}»` : 'этот черновик';
      const ok = window.confirmDialog
        ? await window.confirmDialog.open({
            title: 'Удалить черновик?',
            message: `Удалить ${title}? Он пропадёт на всех устройствах.`,
            confirmLabel: 'Удалить',
            cancelLabel: 'Отмена',
            danger: true
          })
        : confirm(`Удалить ${title}?`);
      if (!ok) return;

      const removed = await this.removeDraftEverywhere(draftId);
      if (draftId === this.currentDraftId) {
        this.currentDraftId = null;
        this.currentDraftRev = null;
      }
      if (removed || (item && !item.onServer)) {
        showMessage('Черновик удалён', 'success');
      } else {
        showMessage('Нет связи с сервером — черновик удалён только на этом устройстве', 'warning');
      }
      await this.refreshDraftsModalIfOpen();
    }
  }

  // Экспортируем контроллер
  window.antropediaEditor = new AntropediaEditorController();
})();
