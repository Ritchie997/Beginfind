// antropedia-editor-client.js — Полнофункциональный клиент редактора статей Antropedia
// для витрины основы: блоки EditorManager, инлайн-форматирование, превью (split/preview/edit),
// черновики (localStorage + облако /api/drafts), папки черновиков, многослойность и публикация.

(function () {
  'use strict';

  function currentUser() {
    return window.authManager && typeof window.authManager.getUser === 'function'
      ? window.authManager.getUser()
      : null;
  }

  function token() {
    return window.authManager && typeof window.authManager.getToken === 'function'
      ? window.authManager.getToken()
      : null;
  }

  function isAuthenticated() {
    return !!(window.authManager && window.authManager.isAuthenticated && window.authManager.isAuthenticated());
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

      let hasContent = false;
      try {
        const doc = JSON.parse(data.content);
        hasContent = Array.isArray(doc.blocks) && doc.blocks.length > 0;
      } catch (e) {}

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
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenVal}`
        },
        body: body ? JSON.stringify(body) : undefined
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
      // Ищем сначала в локальных
      const pending = this.getPendingDrafts().find((d) => d.id === draftId);
      if (pending) {
        await this.loadDraftData(pending.id, pending.data);
        return;
      }
      // Иначе грузим с сервера
      if (isAuthenticated()) {
        try {
          const res = await this.draftsFetch('GET', `/${encodeURIComponent(draftId)}`);
          if (res.ok && res.json) {
            this.currentDraftRev = res.json.rev;
            await this.loadDraftData(draftId, res.json.data);
          }
        } catch (e) {
          showMessage('Не удалось загрузить черновик', 'error');
        }
      }
    }

    async loadDraftData(draftId, data) {
      if (!data) return;
      this.clearForm();
      this.currentDraftId = draftId;
      this._lastLoadedDraftData = data;

      const titleInput = document.getElementById('articleTitle');
      if (titleInput) titleInput.value = data.title || '';

      const contentEl = document.getElementById('articleContent');
      if (contentEl) contentEl.innerHTML = data.content || JSON.stringify({ version: 1, blocks: [] });

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
      if (this.editorManager) {
        this.editorManager.renderAll();
        this.editorManager.scheduleRenderPreview(true);
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
              <p class="modal-subtitle" id="draftsModalSubtitle">Локальные и облачные черновики ваших статей</p>
            </div>
            <button type="button" class="modal-close" data-action="close" aria-label="Закрыть">&times;</button>
          </div>
          <div class="drafts-modal-toolbar">
            <div class="drafts-modal-search">
              <i class="fas fa-search"></i>
              <input type="search" id="draftsModalSearch" placeholder="Поиск по названию и тегам..." autocomplete="off">
            </div>
            <button type="button" class="btn btn-secondary btn-sm" data-action="new-folder" title="Создать папку">
              <i class="fas fa-folder-plus"></i> <span>Папка</span>
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
            <button type="button" class="btn btn-secondary btn-sm" data-action="close">Закрыть</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const els = {
        overlay,
        search: overlay.querySelector('#draftsModalSearch'),
        status: overlay.querySelector('#draftsModalStatus'),
        grid: overlay.querySelector('#draftsModalGrid'),
        folders: overlay.querySelector('#draftsModalFolders'),
        crumbs: overlay.querySelector('#draftsModalCrumbs'),
        empty: overlay.querySelector('#draftsModalEmpty'),
        count: overlay.querySelector('#draftsModalCount')
      };
      this._draftsModalEls = els;

      // События модалки
      overlay.addEventListener('click', async (e) => {
        if (e.target === overlay || e.target.closest('[data-action="close"]')) {
          this.closeDraftsModal();
          return;
        }
        if (e.target.closest('[data-action="new-folder"]')) {
          const name = window.confirmDialog
            ? await window.confirmDialog.prompt({
                title: 'Новая папка черновиков',
                message: 'Введите название новой папки:',
                placeholder: 'Название папки…',
                confirmLabel: 'Создать'
              })
            : null;
          if (name && name.trim()) {
            await this.createDraftFolder(name.trim());
          }
          return;
        }
        const crumb = e.target.closest('[data-action="folder-open"]');
        if (crumb) {
          this.openDraftsFolder(crumb.dataset.folderId || null);
          return;
        }
        const folderTile = e.target.closest('.drafts-folder');
        if (folderTile) {
          this.openDraftsFolder(folderTile.dataset.folderId);
          return;
        }
        const deleteBtn = e.target.closest('[data-action="delete-draft"]');
        if (deleteBtn) {
          e.stopPropagation();
          const draftId = deleteBtn.dataset.id;
          const ok = window.confirmDialog
            ? await window.confirmDialog.open({
                title: 'Удалить черновик?',
                message: 'Удалить этот черновик? Это действие нельзя отменить.',
                confirmLabel: 'Удалить',
                cancelLabel: 'Отмена',
                danger: true
              })
            : false;
          if (ok) {
            await this.deleteDraft(draftId);
          }
          return;
        }
        const card = e.target.closest('.drafts-card');
        if (card) {
          const draftId = card.dataset.id;
          await this.loadDraft(draftId);
          this.closeDraftsModal();
          return;
        }
      });

      els.search?.addEventListener('input', () => this.renderDraftsModal());

      return els;
    }

    async openDraftsModal() {
      const els = this.ensureDraftsModal();
      els.overlay.hidden = false;
      els.search.value = '';
      els.grid.innerHTML = '<div class="drafts-modal-loading"><i class="fas fa-spinner fa-spin"></i> Загрузка черновиков…</div>';
      els.empty.hidden = true;
      els.status.hidden = true;

      await this.flushPendingDrafts();
      await this.fetchDraftList();
      this.renderDraftsModal();
      setTimeout(() => els.search.focus(), 100);
    }

    closeDraftsModal() {
      if (this._draftsModalEls) {
        this._draftsModalEls.overlay.hidden = true;
      }
    }

    async fetchDraftList() {
      const local = this.getPendingDrafts().map((d) => ({
        id: d.id,
        title: (d.data && d.data.title) || 'Без названия',
        text: (d.data && d.data.content) || '',
        tags: (d.data && d.data.tags) || [],
        updatedAt: d.updatedAt,
        folderId: d.folderId || null,
        localOnly: true
      }));

      let serverItems = [];
      let folders = [];
      if (isAuthenticated()) {
        try {
          const res = await this.draftsFetch('GET', '');
          if (res.ok && res.json && Array.isArray(res.json.items)) {
            serverItems = res.json.items;
          }
        } catch (e) {}

        try {
          const fRes = await this.draftsFetch('GET', '', null, '/api/draft-folders');
          if (fRes.ok && fRes.json && Array.isArray(fRes.json)) {
            folders = fRes.json;
          }
        } catch (e) {}
      }

      // Объединяем, отдавая приоритет локальным изменениям
      const localIds = new Set(local.map((d) => d.id));
      const combined = [...local, ...serverItems.filter((s) => !localIds.has(s.id))];
      this._draftsModalItems = combined;
      this._draftsFolders = folders;
    }

    renderDraftsModal() {
      const els = this._draftsModalEls;
      if (!els || els.overlay.hidden) return;

      const q = (els.search.value || '').trim().toLowerCase();
      const currentFolder = this._draftsFolderId || null;

      // Фильтрация
      let items = this._draftsModalItems.filter((d) => {
        if (currentFolder) return d.folderId === currentFolder;
        return !d.folderId;
      });

      if (q) {
        items = this._draftsModalItems.filter((d) => {
          const title = (d.title || '').toLowerCase();
          const tags = Array.isArray(d.tags) ? d.tags.join(' ').toLowerCase() : '';
          return title.includes(q) || tags.includes(q);
        });
      }

      // Папки
      const childFolders = (this._draftsFolders || []).filter((f) => {
        if (q) return false;
        return (f.parentId || null) === currentFolder;
      });

      // Хлебные крошки
      if (currentFolder) {
        const curF = (this._draftsFolders || []).find((f) => f.id === currentFolder);
        els.crumbs.hidden = false;
        els.crumbs.innerHTML = `
          <button type="button" class="drafts-crumb-link" data-action="folder-open" data-folder-id="">Все черновики</button>
          <span class="drafts-crumb-sep">/</span>
          <span class="drafts-crumb-current">${curF ? curF.name : 'Папка'}</span>
        `;
      } else {
        els.crumbs.hidden = true;
      }

      // Отрисовка папок
      if (childFolders.length) {
        els.folders.hidden = false;
        els.folders.innerHTML = childFolders.map((f) => `
          <div class="drafts-folder" data-folder-id="${f.id}" tabindex="0">
            <i class="fas fa-folder drafts-folder-icon"></i>
            <span class="drafts-folder-name">${f.name}</span>
          </div>
        `).join('');
      } else {
        els.folders.hidden = true;
      }

      // Отрисовка черновиков
      if (items.length) {
        els.empty.hidden = true;
        els.grid.innerHTML = items.map((d) => {
          const isCurrent = d.id === this.currentDraftId;
          const date = new Date(d.updatedAt || Date.now()).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
          const tagsHtml = Array.isArray(d.tags) && d.tags.length
            ? `<div class="drafts-card-tags">${d.tags.slice(0, 3).map((t) => `<span class="wiki-tag">#${t}</span>`).join('')}</div>`
            : '';
          return `
            <article class="antropedia-card drafts-card${isCurrent ? ' is-current' : ''}" data-id="${d.id}" tabindex="0">
              <div class="drafts-card-badges">
                ${isCurrent ? '<span class="drafts-card-badge is-current"><i class="fas fa-pen"></i> Открыт</span>' : ''}
                ${d.localOnly ? '<span class="drafts-card-badge is-local"><i class="fas fa-mobile-alt"></i> Локально</span>' : '<span class="drafts-card-badge is-synced"><i class="fas fa-cloud"></i> Облако</span>'}
              </div>
              <button type="button" class="drafts-card-delete" data-action="delete-draft" data-id="${d.id}" title="Удалить черновик">&times;</button>
              <h3 class="antropedia-card-title">${d.title || 'Без названия'}</h3>
              <div class="drafts-card-date"><i class="far fa-clock"></i> ${date}</div>
              ${tagsHtml}
            </article>
          `;
        }).join('');
      } else if (!childFolders.length) {
        els.grid.innerHTML = '';
        els.empty.hidden = false;
        els.empty.innerHTML = '<i class="fas fa-folder-open"></i><div>В этой папке нет черновиков</div>';
      } else {
        els.grid.innerHTML = '';
        els.empty.hidden = true;
      }

      if (els.count) {
        els.count.textContent = `Всего: ${items.length}`;
      }
    }

    openDraftsFolder(folderId) {
      this._draftsFolderId = folderId || null;
      this.renderDraftsModal();
    }

    async createDraftFolder(name) {
      if (!isAuthenticated()) {
        showMessage('Папки черновиков доступны после входа в аккаунт', 'info');
        return;
      }
      try {
        const res = await this.draftsFetch('POST', '', { name, parentId: this._draftsFolderId || null }, '/api/draft-folders');
        if (res.ok && res.json) {
          this._draftsFolders.push(res.json);
          this.renderDraftsModal();
          showMessage('Папка создана', 'success');
        }
      } catch (e) {
        showMessage('Не удалось создать папку', 'error');
      }
    }

    async deleteDraft(draftId) {
      this.removePendingDraft(draftId);
      this._draftsModalItems = this._draftsModalItems.filter((d) => d.id !== draftId);
      if (this.currentDraftId === draftId) {
        this.currentDraftId = null;
        this.currentDraftRev = null;
      }
      await this.deleteDraftOnServer(draftId);
      this.renderDraftsModal();
      showMessage('Черновик удалён', 'info');
    }
  }

  // Экспортируем контроллер
  window.antropediaEditor = new AntropediaEditorController();
})();
