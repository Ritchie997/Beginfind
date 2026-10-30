(function () {
  'use strict';

  var POST_TYPES = {
    news: 'Новость',
    announcement: 'Объявление',
    event: 'Событие'
  };
  var POST_STATUS_LABELS = {
    pending: 'На подтверждении',
    rejected: 'Отклонено'
  };
  var HUB_STATUSES = { active: 'Ведётся', paused: 'Приостановлено', finished: 'Завершено' };
  var IMAGE_UPLOAD_CHUNK = 8;

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[character];
    });
  }

  function postSocialKey(franchiseId, postId) {
    return String(franchiseId) + '-' + String(postId);
  }

  function token() {
    return window.authManager && window.authManager.getToken();
  }

  function notifyError(message) {
    if (typeof window.showMessage === 'function') {
      window.showMessage(message, 'error');
      return;
    }
    var previous = document.getElementById('message-container');
    if (previous) previous.remove();
    var toast = document.createElement('div');
    toast.id = 'message-container';
    toast.className = 'toast toast-error';
    toast.style.cssText = 'position:fixed;top:20px;right:20px;z-index:10001;max-width:min(420px,calc(100vw - 40px));';
    toast.textContent = message;
    document.body.appendChild(toast);
    window.setTimeout(function () { toast.remove(); }, 5000);
  }

  async function request(path, method, data) {
    var headers = {};
    var accessToken = token();
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    var response = await fetch(path, {
      method: method || 'GET',
      headers: headers,
      credentials: 'same-origin',
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    var result = {};
    try { result = await response.json(); } catch (error) { /* non-JSON error response */ }
    if (!response.ok) throw new Error(result.error || 'Не удалось выполнить запрос');
    return result;
  }

  async function uploadSingleImage(file) {
    if (!token()) throw new Error('Требуется авторизация');
    if (!file) throw new Error('Файл не выбран');
    var uploadData = new FormData();
    uploadData.append('image', file);
    var uploadResponse = await fetch('/api/upload-image', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token() },
      credentials: 'same-origin',
      body: uploadData
    });
    var uploadResult = {};
    try { uploadResult = await uploadResponse.json(); } catch (e) {}
    if (!uploadResponse.ok || !uploadResult.url) {
      throw new Error(uploadResult.error || 'Не удалось загрузить изображение');
    }
    return uploadResult.url;
  }

  function dateLabel(value) {
    if (!value) return '';
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ru-RU', {
      dateStyle: 'medium',
      timeStyle: 'short'
    });
  }

  function normalizeImageUrl(url) {
    if (!url || typeof url !== 'string') return '';
    var s = url.trim();
    if (!s) return '';
    if (s.charCodeAt(0) === 91 && s.charCodeAt(s.length - 1) === 93) {
      try {
        var arr = JSON.parse(s);
        if (Array.isArray(arr) && arr.length) return normalizeImageUrl(arr[0]);
      } catch (e) {}
    }
    if (/^https?:\/\//i.test(s)) {
      try {
        var parsed = new URL(s);
        if (parsed.pathname.startsWith('/uploads/')) return parsed.pathname + parsed.search;
        if (window.location && window.location.protocol === 'https:' && s.startsWith('http://')) {
          return 'https://' + s.slice(7);
        }
      } catch (e) {}
      return s;
    }
    if (s.startsWith('uploads/')) return '/' + s;
    if (s.startsWith('./uploads/')) return s.slice(1);
    if (!s.includes('/') && /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(s)) return '/uploads/' + s;
    return s;
  }

  function extractPostImages(post) {
    if (!post) return [];
    var rawList = [];
    if (Array.isArray(post.images) && post.images.length) {
      rawList = post.images;
    } else if (typeof post.images === 'string' && post.images.trim()) {
      try {
        var p = JSON.parse(post.images);
        rawList = Array.isArray(p) ? p : [p];
      } catch (e) {
        rawList = [post.images.trim()];
      }
    } else if (Array.isArray(post.image_urls) && post.image_urls.length) {
      rawList = post.image_urls;
    } else if (typeof post.image_urls === 'string' && post.image_urls.trim()) {
      try {
        var p2 = JSON.parse(post.image_urls);
        rawList = Array.isArray(p2) ? p2 : [p2];
      } catch (e) {
        rawList = [post.image_urls.trim()];
      }
    } else if (post.image_url && typeof post.image_url === 'string') {
      rawList = [post.image_url.trim()];
    }

    var result = [];
    rawList.forEach(function (item) {
      var norm = normalizeImageUrl(item);
      if (norm && !result.includes(norm)) result.push(norm);
    });
    return result;
  }

  function initials(value) {
    var words = String(value || '').trim().split(/\s+/).filter(Boolean);
    return words.slice(0, 2).map(function (word) { return word.charAt(0); }).join('').toLocaleUpperCase() || '✶';
  }

  function avatarSrcSet(url) {
    return typeof window.avatarSrcSet === 'function' ? window.avatarSrcSet(url) : '';
  }

  var FRANCHISE_GRADIENTS = [
    'linear-gradient(135deg, #5865f2 0%, #8b5cf6 50%, #2dd4bf 100%)',
    'linear-gradient(135deg, #ec4899 0%, #a855f7 50%, #6366f1 100%)',
    'linear-gradient(135deg, #3b82f6 0%, #06b6d4 50%, #10b981 100%)',
    'linear-gradient(135deg, #f59e0b 0%, #ef4444 50%, #8b5cf6 100%)',
    'linear-gradient(135deg, #8b5cf6 0%, #3b82f6 50%, #14b8a6 100%)',
    'linear-gradient(135deg, #10b981 0%, #3b82f6 50%, #6366f1 100%)'
  ];

  var AVATAR_PALETTE = ['#5865f2', '#eb459e', '#3ba55d', '#faa81a', '#00b0f4', '#ed4245', '#9b59b6', '#1abc9c'];

  function franchiseAvatarColor(name) {
    var str = String(name || '').trim();
    var hash = 0;
    for (var i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
    return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
  }

  var AUDIT_LABELS = {
    server_created: 'создал франшизу',
    server_updated: 'изменил настройки франшизы',
    server_deleted: 'удалил франшизу',
    role_created: 'создал роль',
    role_updated: 'изменил роль',
    role_deleted: 'удалил роль',
    member_added: 'добавил участника',
    member_removed: 'удалил участника',
    role_assigned: 'назначил роль',
    role_unassigned: 'снял роль',
    channel_created: 'создал канал',
    channel_updated: 'изменил канал',
    channel_deleted: 'удалил канал',
    hub_created: 'создал хаб',
    hub_updated: 'изменил хаб',
    hub_deleted: 'удалил хаб',
    hub_status_changed: 'изменил статус хаба',
    owner_changed: 'сменил владельца'
  };

  function auditActionLabel(action) {
    return AUDIT_LABELS[action] || action;
  }

  function auditDetailsText(action, details) {
    if (!details) return '';
    if (typeof details === 'string') {
      try { details = JSON.parse(details); } catch (e) { return details; }
    }
    switch (action) {
      case 'server_created':
      case 'server_updated':
      case 'server_deleted':
      case 'channel_created':
      case 'channel_updated':
      case 'channel_deleted':
      case 'role_created':
      case 'role_updated':
      case 'role_deleted':
      case 'hub_created':
      case 'hub_updated':
      case 'hub_deleted':
        return details.name ? `«${details.name}»` : '';
      case 'hub_status_changed':
        return `хаб ID ${details.hubId}: ${HUB_STATUSES[details.from] || details.from} → ${HUB_STATUSES[details.to] || details.to}`;
      case 'member_added':
      case 'member_removed':
        return details.self ? '(сам себя)' : `ID ${details.targetUserId}`;
      case 'role_assigned':
      case 'role_unassigned':
        return `пользователю ID ${details.targetUserId}`;
      case 'owner_changed':
        return details.newOwnerUsername ? `на ${details.newOwnerUsername}` : '';
      default:
        return '';
    }
  }

  function openModal(arg1, arg2, arg3) {
    var title = '';
    var subtitle = '';
    var hero = null;
    var bodyHtml = '';
    var footerHtml = '';
    var onMount = null;
    var wide = false;

    if (typeof arg1 === 'object' && arg1 !== null) {
      title = arg1.title || '';
      subtitle = arg1.subtitle || '';
      hero = arg1.hero || null;
      bodyHtml = arg1.bodyHtml || '';
      footerHtml = arg1.footerHtml || '';
      onMount = arg1.onMount || arg2;
      wide = !!arg1.wide;
    } else if (typeof arg1 === 'string' && typeof arg2 === 'string') {
      title = arg1;
      bodyHtml = arg2;
      onMount = arg3;
    } else if (typeof arg1 === 'string') {
      bodyHtml = arg1;
      onMount = arg2;
    }

    closeModal();

    var container = document.createElement('div');
    container.id = 'alltell-modal-container';
    container.className = 'alltell-modal-overlay';

    var headerHtml = '';
    if (hero) {
      headerHtml = `
        <div class="alltell-modal-header">
          <div class="alltell-modal-header-hero">
            ${hero}
            <div>
              <h3 class="alltell-modal-title">${escapeHtml(title)}</h3>
              ${subtitle ? `<p class="alltell-modal-subtitle">${escapeHtml(subtitle)}</p>` : ''}
            </div>
          </div>
          <button type="button" class="alltell-modal-close" data-modal-close aria-label="Закрыть">&times;</button>
        </div>
      `;
    } else if (title) {
      headerHtml = `
        <div class="alltell-modal-header">
          <div>
            <h3 class="alltell-modal-title">${escapeHtml(title)}</h3>
            ${subtitle ? `<p class="alltell-modal-subtitle">${escapeHtml(subtitle)}</p>` : ''}
          </div>
          <button type="button" class="alltell-modal-close" data-modal-close aria-label="Закрыть">&times;</button>
        </div>
      `;
    }

    container.innerHTML = `
      <div class="alltell-modal-box ${wide ? 'alltell-modal-box-wide' : ''}">
        ${headerHtml}
        <div class="alltell-modal-body">
          ${bodyHtml}
        </div>
        ${footerHtml ? `<div class="alltell-modal-footer">${footerHtml}</div>` : ''}
      </div>
    `;

    document.body.appendChild(container);

    container.addEventListener('click', function (e) {
      if (e.target === container || e.target.closest('[data-modal-close]')) {
        closeModal();
      }
    });

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        closeModal();
        document.removeEventListener('keydown', onKeyDown);
      }
    }
    document.addEventListener('keydown', onKeyDown);

    if (typeof onMount === 'function') {
      onMount(container);
    }
    return container;
  }

  function closeModal() {
    var existing = document.getElementById('alltell-modal-container');
    if (existing) existing.remove();
  }

  function showHubInfoModal(hub, franchiseName, franchiseId) {
    if (!hub) return;
    var isHubActive = hub.status === 'active';
    var isHubPaused = hub.status === 'paused';
    var statusLabel = HUB_STATUSES[hub.status] || hub.status;
    var statusColor = isHubActive ? '#10b981' : (isHubPaused ? '#f59e0b' : '#94a3b8');

    openModal({
      hero: hub.avatar_url
        ? `<img src="${escapeHtml(normalizeImageUrl(hub.avatar_url))}" class="alltell-modal-avatar-preview" style="border-radius:12px;object-fit:cover;" alt="">`
        : `<div class="alltell-modal-avatar-preview" style="background:var(--blurple);border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;"><i class="fas fa-dice-d20"></i></div>`,
      title: hub.name,
      subtitle: franchiseName ? `Франшиза «${franchiseName}»` : 'Игровой хаб AllTell',
      bodyHtml: `
        <div class="alltell-hub-info-dialog">
          <div class="alltell-hub-info-meta-bar">
            <div class="alltell-hub-info-status-pill" style="border-color:${statusColor};color:${statusColor};">
              <span class="alltell-status-dot ${isHubActive ? 'active' : (isHubPaused ? 'paused' : '')}"></span>
              <strong>${escapeHtml(statusLabel)}</strong>
            </div>
            <span class="alltell-hub-info-badge"><i class="fas fa-layer-group"></i> Игровой хаб</span>
            ${hub.is_public ? '<span class="alltell-hub-info-badge"><i class="fas fa-globe"></i> Публичный</span>' : '<span class="alltell-hub-info-badge"><i class="fas fa-lock"></i> Скрытый</span>'}
          </div>

          <div class="alltell-hub-info-section">
            <div class="alltell-hub-info-section-title">
              <i class="fas fa-book-open"></i> Описание и сюжет ролевой игры
            </div>
            <div class="alltell-hub-info-desc-content">${(hub.description || '').trim() ? escapeHtml((hub.description || '').trim()) : '<p style="color:var(--text-muted);font-style:italic;margin:0;">Описание ролевого хаба пока не добавлено создателем.</p>'}</div>
          </div>
        </div>
      `,
      footerHtml: `
        <button type="button" class="btn btn-secondary" data-modal-close>Закрыть</button>
        ${franchiseId ? `
          <a href="/alltell?franchise=${Number(franchiseId)}" class="btn btn-primary">
            <i class="fas fa-arrow-right"></i> В сообщество
          </a>
        ` : ''}
      `
    });
  }

  function franchiseGradient(id, name) {
    var hash = 0;
    var str = String(name || '') + String(id || 0);
    for (var i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) & 0xffffffff;
    return FRANCHISE_GRADIENTS[Math.abs(hash) % FRANCHISE_GRADIENTS.length];
  }

  function franchiseCard(franchise, member, isOwner, isRoot, isExpanded, previewHubs, cardKey) {
    var hubSummary = [
      franchise.active_hubs ? franchise.active_hubs + ' активных' : '',
      franchise.paused_hubs ? franchise.paused_hubs + ' на паузе' : '',
      franchise.finished_hubs ? franchise.finished_hubs + ' завершено' : ''
    ].filter(Boolean).join(' · ') || 'Хабов пока нет';
    var unread = Number(franchise.unread_count || 0);
    var gradient = franchiseGradient(franchise.id, franchise.name);
    var hasActiveHubs = Number(franchise.active_hubs || 0) > 0;
    var totalHubs = Number(franchise.hub_count || 0);
    return `
      <article class="alltell-live-card ${isExpanded ? 'has-flyout' : ''}" data-franchise-id="${Number(franchise.id)}">
        <div class="alltell-live-card-banner" style="background: ${gradient}">
          <div class="alltell-card-banner-pattern" aria-hidden="true"></div>
          ${member ? '<span class="alltell-card-member-pill"><i class="fas fa-check" aria-hidden="true"></i> Вы состоите</span>' : ''}
          ${isOwner ? '<span class="alltell-card-owner-pill"><i class="fas fa-crown" aria-hidden="true"></i> Вы создатель</span>' : ''}
          ${unread ? `<span class="alltell-unread-badge"><i class="fas fa-bell" aria-hidden="true"></i> ${unread} новых</span>` : ''}
        </div>
        <div class="alltell-live-card-content">
          <div class="alltell-live-avatar" style="background: ${gradient}">
            ${franchise.avatar_url
              ? `<img src="${escapeHtml(normalizeImageUrl(franchise.avatar_url))}" alt="${escapeHtml(franchise.name)}">`
              : escapeHtml(initials(franchise.name))}
          </div>
          <div class="alltell-live-title-row">
            <h3 title="${escapeHtml(franchise.name)}"><a href="/alltell?franchise=${Number(franchise.id)}">${escapeHtml(franchise.name)}</a></h3>
          </div>
          <p class="alltell-live-description ${!franchise.description ? 'is-placeholder' : ''}">${escapeHtml((franchise.description || '').trim() || 'Описание сообщества пока не заполнено.')}</p>
          <div class="alltell-live-chips">
            <span class="alltell-meta-chip"><i class="fas fa-layer-group" aria-hidden="true"></i> ${totalHubs} хабов</span>
            <span class="alltell-meta-chip ${hasActiveHubs ? 'is-active' : ''}">
              <span class="alltell-status-dot ${hasActiveHubs ? 'active' : ''}" aria-hidden="true"></span>
              ${escapeHtml(hubSummary)}
            </span>
          </div>
          <div class="alltell-card-hubs-dropdown-wrap">
            <button type="button" class="alltell-card-hubs-toggle ${isExpanded ? 'is-expanded' : ''}" data-action="toggle-hub-preview" data-franchise-id="${Number(franchise.id)}" data-card-key="${cardKey || ''}" aria-expanded="${isExpanded}">
              <i class="fas fa-chevron-${isExpanded ? 'up' : 'down'}"></i> ${isExpanded ? 'Скрыть хабы' : 'Показать хабы (' + totalHubs + ')'}
            </button>
            ${isExpanded ? `
              <div class="alltell-card-hubs-flyout" data-card-hubs-flyout="${Number(franchise.id)}">
                <div class="alltell-card-hubs-header">
                  <span class="alltell-card-hubs-header-title"><i class="fas fa-layer-group"></i> Игровые хабы</span>
                  <div style="display:flex;align-items:center;gap:8px;">
                    <span class="alltell-card-hubs-header-count">${previewHubs ? previewHubs.length : '…'}</span>
                    <button type="button" class="alltell-card-hubs-close-btn" data-action="toggle-hub-preview" data-franchise-id="${Number(franchise.id)}" data-card-key="${cardKey || ''}" title="Скрыть хабы">
                      <i class="fas fa-xmark"></i>
                    </button>
                  </div>
                </div>
                ${previewHubs ? (previewHubs.length ? `
                  <div class="alltell-card-hubs-list">
                    ${previewHubs.map(function(h) {
                      var statusTitle = HUB_STATUSES[h.status] || h.status;
                      return `
                        <div class="alltell-card-hub-item status-${escapeHtml(h.status)}" data-hub-id="${h.id}" title="Статус: ${escapeHtml(statusTitle)}">
                          <div class="alltell-card-hub-main">
                            <span class="alltell-card-hub-avatar-wrap">
                              ${h.avatar_url
                                ? `<img src="${escapeHtml(normalizeImageUrl(h.avatar_url))}" class="alltell-card-hub-avatar" alt="">`
                                : `<i class="fas fa-dice-d20"></i>`
                              }
                            </span>
                            <span class="alltell-card-hub-name" title="${escapeHtml(h.name)}">${escapeHtml(h.name)}</span>
                          </div>
                          <button type="button" class="alltell-card-hub-desc-btn" data-action="open-hub-info" data-franchise-id="${Number(franchise.id)}" data-hub-id="${h.id}" title="Информация о РП">
                            <i class="fas fa-circle-info"></i>
                          </button>
                        </div>
                      `;
                    }).join('')}
                  </div>
                ` : '<div class="alltell-card-hubs-empty"><i class="fas fa-inbox"></i> В этой франшизе пока нет хабов</div>') : '<div class="alltell-card-hubs-loading"><i class="fas fa-spinner fa-spin"></i> Загрузка хабов…</div>'}
              </div>
            ` : ''}
          </div>
          <div class="alltell-live-card-foot">
            <span class="alltell-members-count"><i class="fas fa-users" aria-hidden="true"></i> ${Number(franchise.member_count || 0)} участников</span>
            <a class="btn btn-secondary btn-sm alltell-card-action" href="/alltell?franchise=${Number(franchise.id)}">
              <span>${member ? 'В сообщество' : 'Подробнее'}</span>
              <i class="fas fa-arrow-right" aria-hidden="true"></i>
            </a>
          </div>
        </div>
      </article>`;
  }

  function renderViewTabs(view, counts) {
    counts = counts || {};
    var unreadBadge = counts.unread ? `<span class="alltell-tab-badge">${counts.unread}</span>` : '';
    return `<div class="alltell-tabs-wrapper">
      <nav class="alltell-view-tabs" aria-label="Разделы AllTell">
        <button type="button" data-action="switch-view" data-view="feed" class="alltell-tab-btn ${view === 'feed' ? 'active' : ''}" aria-current="${view === 'feed' ? 'page' : 'false'}">
          <i class="fas fa-rss" aria-hidden="true"></i>
          <span>Лента подписок</span>
          ${unreadBadge}
        </button>
        <button type="button" data-action="switch-view" data-view="catalog" class="alltell-tab-btn ${view === 'catalog' ? 'active' : ''}" aria-current="${view === 'catalog' ? 'page' : 'false'}">
          <i class="fas fa-compass" aria-hidden="true"></i>
          <span>Каталог франшиз</span>
          ${counts.total != null ? `<span class="alltell-tab-counter">${counts.total}</span>` : ''}
        </button>
      </nav>
    </div>`;
  }

  function renderCatalog(root, state) {
    if (state.loading && (!state.franchises || !state.franchises.length)) {
      root.innerHTML = `
        <div class="alltell-catalog-view">
          <div class="alltell-toolbar-container">
            ${renderViewTabs(state.view, { total: null, unread: 0 })}
            <div class="alltell-toolbar">
              <div class="alltell-toolbar-header">
                <h2><i class="fas fa-compass" aria-hidden="true"></i> Каталог франшиз</h2>
                <p>Исследуйте сообщества AllTell, знакомьтесь с ролевыми мирами и следите за развитием историй.</p>
              </div>
            </div>
          </div>
          <div class="alltell-state"><div class="alltell-spinner-sm"></div> Загрузка каталога…</div>
        </div>
      `;
      return;
    }

    var query = state.query.trim().toLocaleLowerCase();
    var filter = state.catalogFilter || 'all';
    var hubFilter = state.catalogHubFilter || 'all';
    var sort = state.catalogSort || 'created_desc';
    var currentUser = window.authManager && window.authManager.getUser();
    var currentUserId = currentUser && currentUser.id;
    var isRoot = !!(currentUser && currentUser.is_root);

    var allFranchises = Array.isArray(state.franchises) ? state.franchises : [];
    var franchises = allFranchises.filter(function (franchise) {
      var matchQuery = !query || (franchise.name + ' ' + (franchise.description || '')).toLocaleLowerCase().includes(query);
      if (!matchQuery) return false;
      if (filter === 'active' && Number(franchise.active_hubs || 0) <= 0) return false;
      if (filter === 'mine') {
        var isMine = state.mine && state.mine.some(function (item) { return item.id === franchise.id; });
        if (!isMine) return false;
      }
      if (hubFilter === 'with' && Number(franchise.hub_count || 0) === 0) return false;
      if (hubFilter === 'without' && Number(franchise.hub_count || 0) > 0) return false;
      if (hubFilter === 'active' && Number(franchise.active_hubs || 0) === 0) return false;
      if (hubFilter === 'paused' && Number(franchise.paused_hubs || 0) === 0) return false;
      if (hubFilter === 'finished' && Number(franchise.finished_hubs || 0) === 0) return false;
      return true;
    });

    franchises.sort(function (a, b) {
      if (sort === 'created_asc') return new Date(a.created_at) - new Date(b.created_at);
      if (sort === 'name_asc') return (a.name || '').localeCompare(b.name || '', 'ru');
      if (sort === 'members_desc') return Number(b.member_count || 0) - Number(a.member_count || 0);
      return new Date(b.created_at) - new Date(a.created_at);
    });

    var mine = state.mine;
    var counts = {
      total: Array.isArray(state.franchises) ? state.franchises.length : null,
      unread: state.mine ? state.mine.reduce(function (sum, item) { return sum + Number(item.unread_count || 0); }, 0) : 0
    };

    var totalFranchises = allFranchises.length;
    var totalHubs = allFranchises.reduce(function (sum, f) { return sum + Number(f.hub_count || 0); }, 0);
    var totalMembers = allFranchises.reduce(function (sum, f) { return sum + Number(f.member_count || 0); }, 0);

    root.innerHTML = `
      <div class="alltell-catalog-view">
        <div class="alltell-toolbar-container">
          ${renderViewTabs(state.view, counts)}
          <div class="alltell-toolbar">
            <div class="alltell-toolbar-header">
              <h2><i class="fas fa-compass" aria-hidden="true"></i> Каталог франшиз</h2>
              <p>Исследуйте сообщества AllTell, знакомьтесь с ролевыми мирами и следите за развитием историй.</p>
            </div>
            <form class="alltell-search-box" data-search-form role="search">
              <div class="alltell-search-input-wrap">
                <i class="fas fa-search alltell-search-icon" aria-hidden="true"></i>
                <input id="alltell-search-input" type="search" name="q" value="${escapeHtml(state.query)}" placeholder="Поиск по названию или описанию…" autocomplete="off" aria-label="Поиск франшиз">
                ${state.query ? `<button class="alltell-search-clear" type="button" data-action="clear-search" aria-label="Очистить поиск" title="Очистить поиск"><i class="fas fa-xmark"></i></button>` : ''}
              </div>
              <button class="btn btn-secondary alltell-search-btn" type="submit">Найти</button>
            </form>
          </div>

          <div class="alltell-filter-chips" role="group" aria-label="Фильтры каталога">
            <button type="button" class="alltell-filter-chip ${filter === 'all' ? 'active' : ''}" data-action="filter-catalog" data-filter="all">
              <i class="fas fa-globe"></i> Все сообщества (${totalFranchises})
            </button>
            <button type="button" class="alltell-filter-chip ${filter === 'active' ? 'active' : ''}" data-action="filter-catalog" data-filter="active">
              <span class="alltell-status-dot active"></span> С активными играми (${allFranchises.filter(function (f) { return Number(f.active_hubs || 0) > 0; }).length})
            </button>
            ${mine && mine.length ? `
              <button type="button" class="alltell-filter-chip ${filter === 'mine' ? 'active' : ''}" data-action="filter-catalog" data-filter="mine">
                <i class="fas fa-bookmark"></i> Мои подписки (${mine.length})
              </button>
            ` : ''}
          </div>

          <div class="alltell-catalog-controls">
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;">
              <select class="alltell-select" data-action="change-hub-filter" aria-label="Фильтр по хабам">
                <option value="all" ${hubFilter === 'all' ? 'selected' : ''}>Все франшизы</option>
                <option value="with" ${hubFilter === 'with' ? 'selected' : ''}>С хабами</option>
                <option value="without" ${hubFilter === 'without' ? 'selected' : ''}>Без хабов</option>
                <option value="active" ${hubFilter === 'active' ? 'selected' : ''}>Есть активные хабы</option>
                <option value="paused" ${hubFilter === 'paused' ? 'selected' : ''}>Есть хабы на паузе</option>
                <option value="finished" ${hubFilter === 'finished' ? 'selected' : ''}>Есть завершённые</option>
              </select>
              <select class="alltell-select" data-action="change-sort" aria-label="Сортировка франшиз">
                <option value="created_desc" ${sort === 'created_desc' ? 'selected' : ''}>Сначала новые</option>
                <option value="created_asc" ${sort === 'created_asc' ? 'selected' : ''}>Сначала старые</option>
                <option value="name_asc" ${sort === 'name_asc' ? 'selected' : ''}>По названию (А-Я)</option>
                <option value="members_desc" ${sort === 'members_desc' ? 'selected' : ''}>Больше участников</option>
              </select>
            </div>
            <div class="alltell-stats-chips">
              <span class="alltell-stat-chip-pill"><i class="fas fa-layer-group"></i> Франшиз: <strong>${totalFranchises}</strong></span>
              <span class="alltell-stat-chip-pill"><i class="fas fa-cubes"></i> Хабов: <strong>${totalHubs}</strong></span>
              <span class="alltell-stat-chip-pill"><i class="fas fa-users"></i> Участников: <strong>${totalMembers}</strong></span>
            </div>
          </div>
        </div>

        ${state.error ? `<div class="alltell-state alltell-error" role="alert"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(state.error)}</div>` : ''}
        ${state.mineError ? `<div class="alltell-state alltell-error" role="alert"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(state.mineError)}</div>` : ''}

        ${mine && mine.length && filter === 'all' && !query && hubFilter === 'all' ? `
          <section class="alltell-live-section alltell-mine-section" aria-labelledby="alltell-mine-heading">
            <div class="alltell-live-section-heading">
              <div class="alltell-heading-title">
                <h2 id="alltell-mine-heading"><i class="fas fa-bookmark" aria-hidden="true"></i> Моё AllTell</h2>
                <span>Сообщества, в которых вы состоите</span>
              </div>
              <span class="alltell-section-count">${mine.length}</span>
            </div>
            <div class="alltell-live-grid">${mine.map(function (item) {
              var catalogItem = allFranchises.find(function (franchise) { return Number(franchise.id) === Number(item.id); });
              var isOwner = currentUserId && (Number(item.owner_id) === Number(currentUserId) || (catalogItem && Number(catalogItem.owner_id) === Number(currentUserId)));
              var itemIdNum = Number(item.id);
              var cardKey = 'mine:' + itemIdNum;
              var isExpanded = state.expandedCardKey === cardKey;
              var previewHubs = state.hubPreviewCache.get(itemIdNum);
              return franchiseCard(Object.assign({
                active_hubs: 0, paused_hubs: 0, finished_hubs: 0, member_count: 0
              }, catalogItem || item, item), true, isOwner, isRoot, isExpanded, previewHubs, cardKey);
            }).join('')}</div>
          </section>
        ` : ''}

        <section class="alltell-live-section" aria-labelledby="alltell-catalog-heading">
          <div class="alltell-live-section-heading">
            <div class="alltell-heading-title">
              <h2 id="alltell-catalog-heading">
                <i class="fas ${filter === 'active' ? 'fa-dice-d20' : (filter === 'mine' ? 'fa-bookmark' : 'fa-globe')}" aria-hidden="true"></i>
                ${filter === 'active' ? 'Франшизы с активными играми' : (filter === 'mine' ? 'Мои подписки' : 'Все франшизы')}
              </h2>
              <span>${query ? `По запросу «${escapeHtml(query)}»` : 'Доступные для вступления миры'}</span>
            </div>
            <span class="alltell-section-count">${franchises.length} ${franchises.length === 1 ? 'сообщество' : (franchises.length >= 2 && franchises.length <= 4 ? 'сообщества' : 'сообществ')}</span>
          </div>

          ${state.loading ? `
            <div class="alltell-state alltell-state-loading">
              <div class="alltell-spinner" aria-hidden="true"></div>
              <h3>Загружаем каталог франшиз…</h3>
              <p>Связываемся с мирами AllTell</p>
            </div>
          ` : franchises.length ? `
            <div class="alltell-live-grid">${franchises.map(function (franchise) {
              var isUserMember = mine && mine.some(function (item) { return Number(item.id) === Number(franchise.id); });
              var isOwner = currentUserId && Number(franchise.owner_id) === Number(currentUserId);
              var franchiseIdNum = Number(franchise.id);
              var cardKey = 'catalog:' + franchiseIdNum;
              var isExpanded = state.expandedCardKey === cardKey;
              var previewHubs = state.hubPreviewCache.get(franchiseIdNum);
              return franchiseCard(franchise, isUserMember, isOwner, isRoot, isExpanded, previewHubs, cardKey);
            }).join('')}</div>
          ` : `
            <div class="alltell-state alltell-state-empty">
              <div class="alltell-empty-icon"><i class="fas fa-compass" aria-hidden="true"></i></div>
              <h3>${query || filter !== 'all' || hubFilter !== 'all' ? 'Ничего не найдено' : 'Каталог пока пуст'}</h3>
              <p>${query ? 'Попробуйте изменить поисковый запрос или сбросить фильтры.' : ((filter !== 'all' || hubFilter !== 'all') ? 'По выбранным фильтрам сообществ не найдено.' : 'Франшизы появятся здесь после публикации создателями.')}</p>
              ${query || filter !== 'all' || hubFilter !== 'all' ? `
                <div class="alltell-empty-actions">
                  <button type="button" class="btn btn-secondary" data-action="clear-search"><i class="fas fa-rotate-left"></i> Сбросить фильтры</button>
                </div>
              ` : ''}
            </div>
          `}
        </section>

        <aside class="alltell-create-banner">
          <div class="alltell-create-banner-content">
            <div class="alltell-create-banner-icon"><i class="fas fa-wand-magic-sparkles"></i></div>
            <div>
              <h3>Создаёте собственный мир?</h3>
              <p>Создайте франшизу в AllTell — она объединит игроков, сюжетные хабы и появится в общем каталоге.</p>
            </div>
          </div>
          <button class="btn btn-primary" type="button" data-action="open-create-franchise">
            <i class="fas fa-plus"></i> Создать франшизу
          </button>
        </aside>
      </div>
    `;
  }

  function renderFeed(root, state) {
    var feedPosts = state.feedPosts || [];
    var user = window.authManager && window.authManager.getUser();
    var filter = state.feedFilter || 'all';
    var filteredPosts = feedPosts.filter(function (post) {
      if (filter && filter !== 'all') return post.type === filter;
      return true;
    });
    var counts = {
      total: Array.isArray(state.franchises) ? state.franchises.length : null,
      unread: state.mine ? state.mine.reduce(function (sum, item) { return sum + Number(item.unread_count || 0); }, 0) : 0
    };

    root.innerHTML = `
      <div class="alltell-feed-view">
        <div class="alltell-toolbar-container">
          ${renderViewTabs(state.view, counts)}
          <div class="alltell-toolbar">
            <div class="alltell-toolbar-header">
              <h2><i class="fas fa-rss" aria-hidden="true"></i> Лента подписок</h2>
              <p>Свежие хроники, новости и события из франшиз, на которые вы подписаны.</p>
            </div>
            ${token() && state.followedCount ? `
              <div class="alltell-filter-chips" role="group" aria-label="Фильтр публикаций">
                <button type="button" class="alltell-filter-chip ${filter === 'all' ? 'active' : ''}" data-action="filter-feed" data-filter="all">
                  Все записи (${feedPosts.length})
                </button>
                <button type="button" class="alltell-filter-chip ${filter === 'news' ? 'active' : ''}" data-action="filter-feed" data-filter="news">
                  <i class="fas fa-newspaper"></i> Новости (${feedPosts.filter(function (p) { return p.type === 'news'; }).length})
                </button>
                <button type="button" class="alltell-filter-chip ${filter === 'announcement' ? 'active' : ''}" data-action="filter-feed" data-filter="announcement">
                  <i class="fas fa-bullhorn"></i> Объявления (${feedPosts.filter(function (p) { return p.type === 'announcement'; }).length})
                </button>
                <button type="button" class="alltell-filter-chip ${filter === 'event' ? 'active' : ''}" data-action="filter-feed" data-filter="event">
                  <i class="fas fa-calendar-check"></i> События (${feedPosts.filter(function (p) { return p.type === 'event'; }).length})
                </button>
              </div>
            ` : ''}
          </div>
        </div>

        ${state.error ? `<div class="alltell-state alltell-error" role="alert"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(state.error)}</div>` : ''}

        ${!token() ? `
          <div class="alltell-guest-showcase">
            <div class="alltell-guest-glow" aria-hidden="true"></div>
            <div class="alltell-guest-badge"><i class="fas fa-sparkles"></i> Сообщества AllTell</div>
            <h3>Добро пожаловать в живую ленту</h3>
            <p class="alltell-guest-lead">В ленте объединяются авторские сюжеты, хроники ролевых игр и важные новости из франшиз, к которым вы присоединились.</p>
            <div class="alltell-guest-features">
              <div class="alltell-guest-feature-card">
                <div class="alltell-guest-feature-icon"><i class="fas fa-book-open"></i></div>
                <h4>Хроники и сюжеты</h4>
                <p>Читайте новые главы, отчеты о событиях и авторские материалы любимых вселенных.</p>
              </div>
              <div class="alltell-guest-feature-card">
                <div class="alltell-guest-feature-icon"><i class="fas fa-dice-d20"></i></div>
                <h4>Игровые хабы</h4>
                <p>Будьте в курсе наборов игроков, статуса ролевых сессий и правил миров.</p>
              </div>
              <div class="alltell-guest-feature-card">
                <div class="alltell-guest-feature-icon"><i class="fas fa-comments"></i></div>
                <h4>Живые обсуждения</h4>
                <p>Оставляйте комментарии, делитесь реакциями и коллекционными стикерами фэндома.</p>
              </div>
            </div>
            <div class="alltell-guest-actions">
              <button type="button" class="btn btn-primary btn-lg" data-action="login"><i class="fas fa-right-to-bracket"></i> Войти в аккаунт</button>
              <button type="button" class="btn btn-secondary btn-lg" data-action="switch-view" data-view="catalog"><i class="fas fa-compass"></i> Смотреть каталог франшиз</button>
            </div>
          </div>
        ` : state.loading ? `
          <div class="alltell-state alltell-state-loading">
            <div class="alltell-spinner" aria-hidden="true"></div>
            <h3>Загружаем вашу персональную ленту…</h3>
            <p>Собираем свежие записи из подписок</p>
          </div>
        ` : !state.followedCount ? `
          <div class="alltell-state alltell-state-onboarding">
            <div class="alltell-empty-icon"><i class="fas fa-compass" aria-hidden="true"></i></div>
            <h3>Вы пока не подписались ни на одну франшизу</h3>
            <p>Откройте каталог сообществ, выберите понравившиеся миры и нажмите «Подписаться» — тогда их хроники и новости будут появляться в вашей ленте.</p>
            <div class="alltell-empty-actions">
              <button type="button" class="btn btn-primary btn-lg" data-action="switch-view" data-view="catalog">
                <i class="fas fa-compass"></i> Открыть каталог франшиз
              </button>
            </div>
          </div>
        ` : filteredPosts.length ? `
          <div class="alltell-post-list">
            ${filteredPosts.map(function (post) {
              var postSocial = state.postSocial[postSocialKey(post.franchise_id, post.id)];
              var gradient = franchiseGradient(post.franchise_id, post.franchise_name);
              return `
                <div class="alltell-feed-item">
                  <div class="alltell-feed-franchise-card">
                    <a class="alltell-feed-franchise-link" href="/alltell?franchise=${Number(post.franchise_id)}">
                      <span class="alltell-feed-franchise-avatar" style="background:${gradient}">
                        ${post.franchise_avatar_url
                          ? `<img src="${escapeHtml(normalizeImageUrl(post.franchise_avatar_url))}" alt="">`
                          : escapeHtml(initials(post.franchise_name))}
                      </span>
                      <span class="alltell-feed-franchise-meta">
                        <strong class="alltell-feed-franchise-name">${escapeHtml(post.franchise_name)}</strong>
                        ${post.hub_name ? `<span class="alltell-feed-hub-tag"><i class="fas fa-layer-group"></i> ${escapeHtml(post.hub_name)}</span>` : '<span class="alltell-feed-tag">Франшиза</span>'}
                      </span>
                      <i class="fas fa-arrow-right alltell-feed-arrow" aria-hidden="true"></i>
                    </a>
                  </div>
                  ${renderPost(post, new Map(), false, postSocial, user && user.id, true, post.franchise_id)}
                </div>
              `;
            }).join('')}
          </div>
        ` : `
          <div class="alltell-state alltell-state-empty">
            <div class="alltell-empty-icon"><i class="fas fa-inbox" aria-hidden="true"></i></div>
            <h3>${filter !== 'all' ? 'Записей в этой категории пока нет' : 'Лента пока пуста'}</h3>
            <p>${filter !== 'all' ? 'Попробуйте выбрать категорию «Все записи».' : 'В франшизах, на которые вы подписаны, ещё не появилось опубликованных записей.'}</p>
            <div class="alltell-empty-actions">
              ${filter !== 'all' ? `
                <button type="button" class="btn btn-secondary" data-action="filter-feed" data-filter="all"><i class="fas fa-rotate-left"></i> Показать все записи</button>
              ` : `
                <button type="button" class="btn btn-secondary" data-action="switch-view" data-view="catalog"><i class="fas fa-compass"></i> Найти ещё франшизы в каталоге</button>
              `}
            </div>
          </div>
        `}
      </div>
    `;
  }

  function renderStickerText(comment) {
    var content = String(comment.content || '');
    var stickers = comment.stickers || {};
    return content.split(/(:[a-z0-9-]{1,80}:[a-z0-9-]{1,80}:)/gi).map(function (part) {
      var match = /^:([a-z0-9-]{1,80}:[a-z0-9-]{1,80}):$/i.exec(part);
      if (!match) return escapeHtml(part);
      var sticker = stickers[match[1]];
      return sticker
        ? `<img class="alltell-comment-sticker" data-pack-id="${Number(sticker.packId)}" src="${escapeHtml(sticker.url)}" alt="${escapeHtml(part)}" title="${escapeHtml(part)}">`
        : escapeHtml(part);
    }).join('');
  }

  function renderReactionBar(reactions, targetType, targetId) {
    var pills = (reactions || []).map(function (reaction) {
      return `<button class="alltell-reaction-pill${reaction.reacted ? ' active' : ''}" type="button" data-action="toggle-reaction" data-target-type="${targetType}" data-target-id="${Number(targetId)}" data-shortcode="${escapeHtml(reaction.shortcode)}" title="${escapeHtml(reaction.packTitle || reaction.shortcode)}">
        <img src="${escapeHtml(reaction.url)}" alt=""><span>${Number(reaction.count)}</span>
      </button>`;
    }).join('');
    return `<div class="alltell-reaction-bar">${pills}<button class="alltell-reaction-add" type="button" data-action="open-sticker-picker" data-picker-mode="reaction" data-target-type="${targetType}" data-target-id="${Number(targetId)}" title="Добавить реакцию"><i class="far fa-face-smile" aria-hidden="true"></i></button></div>`;
  }

  function commentsLabel(count) {
    var remainder = count % 100;
    var form = remainder >= 11 && remainder <= 14 ? 'комментариев' :
      (count % 10 === 1 ? 'комментарий' : (count % 10 >= 2 && count % 10 <= 4 ? 'комментария' : 'комментариев'));
    return count + ' ' + form;
  }

  function renderPostComment(comment, replies, postId, canManage, userId) {
    var own = Number(comment.userId) === Number(userId);
    var reactions = renderReactionBar(comment.reactions, 'franchise_post_comment', comment.id);
    return `<article class="alltell-comment ${replies ? 'alltell-comment-top' : ''}" data-comment-id="${Number(comment.id)}">
      <div class="alltell-comment-heading">
        <div class="alltell-comment-author-avatar">
          ${comment.authorAvatar
            ? `<img src="${escapeHtml(comment.authorAvatar)}"${avatarSrcSet(comment.authorAvatar) ? ` srcset="${escapeHtml(avatarSrcSet(comment.authorAvatar))}"` : ''} alt="">`
            : `<span class="alltell-avatar-fallback">${escapeHtml(initials(comment.authorName))}</span>`}
        </div>
        <div class="alltell-comment-author-info">
          <strong>${escapeHtml(comment.authorName)}</strong>
          <time>${escapeHtml(dateLabel(comment.createdAt))}</time>
        </div>
      </div>
      <div class="alltell-comment-content">${renderStickerText(comment)}</div>
      <div class="alltell-comment-actions">
        ${reactions}
        <button type="button" class="alltell-comment-reply" data-action="reply-comment" data-comment-id="${Number(comment.id)}" data-author="${escapeHtml(comment.authorName)}">
          <i class="far fa-message" aria-hidden="true"></i> Ответить
        </button>
        ${own || canManage ? `<button type="button" class="alltell-comment-delete" data-action="delete-comment" data-comment-id="${Number(comment.id)}" title="Удалить"><i class="fas fa-trash-can"></i></button>` : ''}
      </div>
      ${replies ? `<div class="alltell-comment-replies">${replies.map(function (reply) {
        return renderPostComment(reply, null, postId, canManage, userId);
      }).join('')}</div>` : ''}
    </article>`;
  }

  function renderPostSocial(post, social, canManage, userId, loggedIn, franchiseId) {
    var comments = social.comments || [];
    var topLevel = comments.filter(function (comment) { return !comment.parentId; });
    var commentsHtml = topLevel.map(function (comment) {
      var replies = comments.filter(function (reply) { return Number(reply.parentId) === Number(comment.id); });
      return renderPostComment(comment, replies.length ? replies : null, post.id, canManage, userId);
    }).join('');
    var compose = loggedIn && social.open
      ? `<form class="alltell-comment-form" data-comment-form data-post-id="${Number(post.id)}">
          ${social.replyTo ? `<div class="alltell-replying"><span>Ответ для <strong>${escapeHtml(social.replyTo.authorName)}</strong></span> <button type="button" data-action="cancel-reply"><i class="fas fa-xmark"></i> Отмена</button></div>` : ''}
          <div class="alltell-comment-input-wrap">
            <textarea name="content" rows="2" maxlength="2000" placeholder="Напишите комментарий…" required>${escapeHtml(social.replyTo
              ? `@${/\s/.test(social.replyTo.authorName) ? '[' + social.replyTo.authorName + ']' : social.replyTo.authorName} `
              : '')}</textarea>
            <div class="alltell-comment-form-actions">
              <button class="alltell-sticker-insert" type="button" data-action="open-sticker-picker" data-picker-mode="insert" data-target-type="comment" data-target-id="${Number(post.id)}"><i class="far fa-face-smile" aria-hidden="true"></i> Стикеры</button>
              <button class="btn btn-primary btn-sm" type="submit">${social.replyTo ? 'Ответить' : 'Отправить'}</button>
            </div>
          </div>
        </form>`
      : (social.open ? '<p class="alltell-comment-login"><button type="button" data-action="login"><i class="fas fa-lock"></i> Войдите, чтобы комментировать и ставить реакции</button></p>' : '');

    return `<div class="alltell-post-social" data-post-social="${postSocialKey(franchiseId, post.id)}" data-franchise-id="${Number(franchiseId)}" data-post-id="${Number(post.id)}">
      <div class="alltell-social-bar">
        <div class="alltell-social-actions">
          <button type="button" class="alltell-like-button ${social.liked ? 'active' : ''}" data-action="toggle-post-like" data-post-id="${Number(post.id)}" title="${social.liked ? 'Убрать отметку' : 'Нравится'}">
            <i class="${social.liked ? 'fas' : 'far'} fa-heart" aria-hidden="true"></i>
            <span>${Number(social.likes || 0)}</span>
          </button>
          <button type="button" class="alltell-comments-toggle ${social.open ? 'active' : ''}" data-action="toggle-comments" data-post-id="${Number(post.id)}">
            <i class="far fa-message" aria-hidden="true"></i>
            <span>${commentsLabel(Number(social.commentCount || 0))}</span>
            <i class="fas fa-chevron-${social.open ? 'up' : 'down'} alltell-comments-chevron" aria-hidden="true"></i>
          </button>
        </div>
        ${renderReactionBar(social.reactions || [], 'franchise_post', post.id)}
      </div>

      <section class="alltell-comments-panel" ${social.open ? '' : 'hidden'}>
        <div class="alltell-comments-list">${social.loaded
          ? (commentsHtml || '<div class="alltell-comments-empty"><i class="far fa-comments"></i> Комментариев пока нет. Будьте первым!</div>')
          : (social.loading ? '<div class="alltell-comments-loading"><div class="alltell-spinner-sm"></div> Загружаем комментарии…</div>'
            : (social.loadError ? `<div class="alltell-comments-error">${escapeHtml(social.loadError)} <button type="button" data-action="reload-comments" data-post-id="${Number(post.id)}">Повторить</button></div>`
              : (loggedIn ? '<div class="alltell-comments-loading"><div class="alltell-spinner-sm"></div> Загрузка комментариев…</div>' : '')))}</div>
        ${compose}
      </section>
    </div>`;
  }

  function pickTextColor(hex) {
    var c = String(hex || '').replace('#', '');
    var full = c.length === 3 ? c.split('').map(function (ch) { return ch + ch; }).join('') : c.padEnd(6, '0').slice(0, 6);
    var r = parseInt(full.slice(0, 2), 16), g = parseInt(full.slice(2, 4), 16), b = parseInt(full.slice(4, 6), 16);
    var luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6 ? '#1a1a1a' : '#ffffff';
  }

  var HIGHLIGHT_PRESETS = [
    { hex: '#faa81a', label: 'Жёлтый (по умолчанию)' },
    { hex: '#3ba55d', label: 'Зелёный' },
    { hex: '#5865f2', label: 'Синий' },
    { hex: '#ed4245', label: 'Красный' },
    { hex: '#eb459e', label: 'Розовый' }
  ];

  var activePostHlPicker = null;

  function closePostHighlightPicker() {
    if (activePostHlPicker) {
      activePostHlPicker.remove();
      activePostHlPicker = null;
    }
  }

  function openPostHighlightPicker(anchorBtn, state) {
    if (activePostHlPicker) {
      closePostHighlightPicker();
      return;
    }
    var picker = document.createElement('div');
    picker.className = 'alltell-color-picker';
    var swatches = document.createElement('div');
    swatches.className = 'eb-color-picker-swatches';

    HIGHLIGHT_PRESETS.forEach(function (preset) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'eb-color-swatch';
      btn.style.background = preset.hex;
      btn.title = preset.label;
      btn.addEventListener('mousedown', function (e) {
        e.preventDefault();
        applyPostInlineFormat('highlight', state, { hex: preset.hex === '#faa81a' ? null : preset.hex });
        closePostHighlightPicker();
      });
      swatches.appendChild(btn);
    });

    var custom = document.createElement('input');
    custom.type = 'color';
    custom.className = 'eb-color-swatch-custom';
    custom.title = 'Свой цвет';
    custom.value = '#faa81a';
    custom.addEventListener('change', function () {
      applyPostInlineFormat('highlight', state, { hex: custom.value });
      closePostHighlightPicker();
    });
    custom.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    swatches.appendChild(custom);
    picker.appendChild(swatches);

    document.body.appendChild(picker);
    activePostHlPicker = picker;

    var rect = anchorBtn.getBoundingClientRect();
    var left = Math.max(10, Math.min(window.innerWidth - 200, rect.left - 10));
    var top = rect.bottom + 6;
    picker.style.top = top + 'px';
    picker.style.left = left + 'px';

    function onDocHlClick(e) {
      if (picker.contains(e.target) || anchorBtn.contains(e.target)) return;
      closePostHighlightPicker();
      document.removeEventListener('mousedown', onDocHlClick);
    }
    setTimeout(function () {
      document.addEventListener('mousedown', onDocHlClick);
    }, 10);
  }

  function formatPostBody(body) {
    if (!body) return '';
    var text = escapeHtml(body);

    // Заголовки (#, ##, ###, ####)
    text = text.replace(/^(#{1,4})\s+(.+)$/gm, function (_, hashes, content) {
      var lvl = hashes.length;
      return '<h' + lvl + ' class="alltell-post-h' + lvl + '">' + content.trim() + '</h' + lvl + '>';
    });

    // Чек-листы
    text = text.replace(/((?:^[-*]\s+\[[ xX]\][^\n]*(?:\n|$))+)/gm, function (match) {
      var lines = match.trim().split('\n');
      var items = lines.map(function (line) {
        var m = line.match(/^[-*]\s+\[([ xX])\]\s*(.*)$/);
        var checked = m && m[1].toLowerCase() === 'x';
        var content = m ? m[2].trim() : line;
        return '<li class="alltell-checklist-item' + (checked ? ' is-checked' : '') + '">' +
               '<input type="checkbox"' + (checked ? ' checked' : '') + ' onchange="this.parentElement.classList.toggle(\'is-checked\', this.checked)">' +
               '<span>' + content + '</span></li>';
      }).join('');
      return '<ul class="alltell-checklist blk-checklist">' + items + '</ul>';
    });

    // Нумерованные списки
    text = text.replace(/((?:^\d+\.\s+[^\n]*(?:\n|$))+)/gm, function (match) {
      var lines = match.trim().split('\n');
      var items = lines.map(function (line) {
        var content = line.replace(/^\d+\.\s+/, '').trim();
        return '<li>' + content + '</li>';
      }).join('');
      return '<ol class="alltell-post-ol">' + items + '</ol>';
    });

    // Маркированные списки
    text = text.replace(/((?:^[-*•]\s+[^\n]*(?:\n|$))+)/gm, function (match) {
      var lines = match.trim().split('\n');
      var items = lines.map(function (line) {
        var content = line.replace(/^[-*•]\s+/, '').trim();
        return '<li>' + content + '</li>';
      }).join('');
      return '<ul class="alltell-post-ul">' + items + '</ul>';
    });

    // Цитаты: группировка строк, начинающихся с > или &gt;
    text = text.replace(/((?:^(?:>|&gt;)[^\n]*(?:\n|$))+)/gm, function (match) {
      var inner = match.split('\n').map(function (line) {
        return line.replace(/^(?:>|&gt;)\s*/, '');
      }).join('<br>').replace(/(?:<br>)+$/, '');
      return '<blockquote class="alltell-post-quote">' + inner + '</blockquote>';
    });

    // Выделение цветом: ==текст==(#hex) или ==текст==
    text = text.replace(/==([\s\S]+?)==\((#[0-9a-fA-F]{3,8})\)/g, function (_, content, hex) {
      return '<mark class="alltell-post-highlight" style="background:' + hex + ';color:' + pickTextColor(hex) + ';">' + content + '</mark>';
    });
    text = text.replace(/==([\s\S]+?)==/g, '<mark class="alltell-post-highlight">$1</mark>');

    // Инлайн-спойлеры: ||скрытый текст||
    text = text.replace(/\|\|([\s\S]+?)\|\|/g, '<span class="alltell-post-spoiler" title="Спойлер (нажмите для просмотра)" onclick="this.classList.toggle(\'is-revealed\')">$1</span>');

    // Жирный текст: **текст**
    text = text.replace(/\*\*([^\*\n]+?)\*\*/g, '<strong>$1</strong>');

    // Курсив: *текст* (если не звёздочки) или _текст_
    text = text.replace(/(^|[^\*])\*([^\*\n]+?)\*([^\*]|$)/g, '$1<em>$2</em>$3');
    text = text.replace(/(^|[^_])_([^_ \n][^_\n]*?[^_ \n])_([^_]|$)/g, '$1<em>$2</em>$3');

    // Зачёркнутый текст: ~~текст~~
    text = text.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');

    // Подчёркнутый текст: ++текст++ или <u>текст</u>
    text = text.replace(/\+\+([^\+\n]+?)\+\+/g, '<u>$1</u>');
    text = text.replace(/&lt;u&gt;([\s\S]+?)&lt;\/u&gt;/gi, '<u>$1</u>');

    // Инлайн-код: `код`
    text = text.replace(/`([^`\n]+?)`/g, '<code class="alltell-inline-code">$1</code>');

    // Разделитель: --- или ***
    text = text.replace(/^(?:---|—{3,}|\*\*\*)\s*$/gm, '<hr class="alltell-post-divider">');

    // Wiki-ссылки на Antropedia: [[slug|title]], [[slug]] или [title]((slug))
    text = text.replace(/\[\[([^\]\|]+)(?:\|([^\]]+))?\]\]/g, function (_, slug, title) {
      var s = slug.trim();
      var t = (title || s).trim();
      return '<a href="/antropedia/' + encodeURIComponent(s) + '" class="alltell-post-wikilink"><i class="fas fa-book-bookmark"></i> ' + t + '</a>';
    });
    text = text.replace(/\[([^\]]+)\]\(\(([a-zA-Z0-9_\-\.]+)\)\)/g, function (_, title, slug) {
      return '<a href="/antropedia/' + encodeURIComponent(slug.trim()) + '" class="alltell-post-wikilink"><i class="fas fa-book-bookmark"></i> ' + title.trim() + '</a>';
    });

    // Обычные markdown-ссылки: [название](url)
    text = text.replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^\s\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="alltell-post-link">$1 <i class="fas fa-arrow-up-right-from-square"></i></a>');

    return text;
  }

  function renderPost(post, hubMap, canManage, social, userId, loggedIn, franchiseId) {
    franchiseId = franchiseId || post.franchise_id;
    var hub = post.hub_id ? hubMap.get(String(post.hub_id)) : null;
    var canEdit = canManage || post.can_edit;
    var images = extractPostImages(post);
    var postArticles = Array.isArray(post.articles) && post.articles.length
      ? post.articles
      : (post.article ? [post.article] : []);

    return `
      <article class="alltell-post-card" data-post-id="${Number(post.id)}">
        <div class="alltell-post-card-header">
          <div class="alltell-post-author-block">
            <div class="alltell-author-avatar">${escapeHtml(initials(post.created_by_name))}</div>
            <div class="alltell-author-info">
              <strong class="alltell-author-name">${escapeHtml(post.created_by_name)}</strong>
              <time class="alltell-post-date" datetime="${escapeHtml(post.created_at)}">${escapeHtml(dateLabel(post.created_at))}</time>
            </div>
          </div>
          <div class="alltell-post-badges">
            <span class="alltell-post-type alltell-post-type-${escapeHtml(post.type)}">
              <i class="fas ${post.type === 'news' ? 'fa-newspaper' : (post.type === 'announcement' ? 'fa-bullhorn' : 'fa-calendar-check')}"></i>
              ${escapeHtml(POST_TYPES[post.type] || 'Публикация')}
            </span>
            ${hub ? `<span class="alltell-post-hub">${hub.avatar_url ? `<img src="${escapeHtml(normalizeImageUrl(hub.avatar_url))}" class="alltell-post-hub-avatar" alt="">` : '<i class="fas fa-layer-group" aria-hidden="true"></i>'} ${escapeHtml(hub.name)}</span>` : ''}
            ${post.hub_status ? `<span class="alltell-hub-status alltell-hub-status-${escapeHtml(post.hub_status)}">${escapeHtml(HUB_STATUSES[post.hub_status] || '')}</span>` : ''}
            ${post.approval_status !== 'published' ? `<span class="alltell-post-review alltell-post-review-${escapeHtml(post.approval_status)}">${escapeHtml(POST_STATUS_LABELS[post.approval_status] || '')}</span>` : ''}
          </div>
        </div>

        <h3 class="alltell-post-title">${escapeHtml(post.title)}</h3>

        ${post.body ? `<div class="alltell-post-body">${formatPostBody(post.body)}</div>` : ''}

        ${images.length ? `
          <div class="alltell-post-carousel" data-image-carousel>
            <div class="alltell-post-images" data-image-track>
              ${images.map(function (image, index) {
                return `
                  <div class="alltell-image-slide" data-image-index="${index}">
                    <img class="alltell-post-image"
                         src="${escapeHtml(image)}"
                         alt="Изображение к записи ${escapeHtml(post.title)}"
                         loading="lazy"
                         data-image-src="${escapeHtml(image)}"
                         onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"
                         onload="this.classList.add('is-loaded');">
                    <div class="alltell-image-fallback" style="display:none;">
                      <i class="far fa-image" aria-hidden="true"></i>
                      <span>Изображение недоступно</span>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
            ${images.length > 1 ? `
              <button class="alltell-image-arrow alltell-image-prev" type="button" data-image-step="-1" aria-label="Предыдущее изображение"><i class="fas fa-chevron-left" aria-hidden="true"></i></button>
              <button class="alltell-image-arrow alltell-image-next" type="button" data-image-step="1" aria-label="Следующее изображение"><i class="fas fa-chevron-right" aria-hidden="true"></i></button>
              <span class="alltell-image-count" data-image-count>1 / ${images.length}</span>
            ` : ''}
          </div>
        ` : ''}

        ${postArticles.length ? `
          <div class="alltell-post-articles-list">
            ${postArticles.map(function (art) {
              var href = art.is_public
                ? '/antropedia/' + encodeURIComponent(art.slug)
                : '/admin-panel/antropedia/' + encodeURIComponent(art.slug);
              return `
                <a class="alltell-post-article-card" href="${escapeHtml(href)}">
                  <div class="alltell-article-icon"><i class="fas fa-book-bookmark" aria-hidden="true"></i></div>
                  <div class="alltell-article-details">
                    <span class="alltell-article-tag">Статья в Antropedia</span>
                    <strong class="alltell-article-title">${escapeHtml(art.title || art.slug)}</strong>
                  </div>
                  <i class="fas fa-arrow-up-right-from-square alltell-article-arrow" aria-hidden="true"></i>
                </a>
              `;
            }).join('')}
          </div>
        ` : ''}

        ${canEdit || (canManage && post.approval_status === 'pending') ? `
          <div class="alltell-post-admin-actions">
            ${canManage && post.approval_status === 'pending' ? `
              <button type="button" class="btn btn-primary btn-sm" data-action="approve-post" data-post-id="${Number(post.id)}"><i class="fas fa-check"></i> Подтвердить</button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="reject-post" data-post-id="${Number(post.id)}"><i class="fas fa-xmark"></i> Отклонить</button>
            ` : ''}
            ${canEdit ? `
              <button type="button" class="btn btn-secondary btn-sm" data-action="edit-post" data-post-id="${Number(post.id)}"><i class="fas fa-pen"></i> Изменить</button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="delete-post" data-post-id="${Number(post.id)}"><i class="fas fa-trash"></i> Удалить</button>
            ` : ''}
          </div>
        ` : ''}

        ${post.approval_status === 'published'
          ? renderPostSocial(post, social || {
            likes: post.likes_count || 0,
            liked: !!post.liked,
            commentCount: post.comments_count || 0,
            reactions: post.reactions || [],
            open: false,
            loaded: false,
            comments: []
          }, canManage, userId, loggedIn, franchiseId)
          : ''}
      </article>`;
  }

  function renderPostImageItems(images, disabled) {
    return images.map(function (image, index) {
      var statusHtml = '';
      if (image.uploading) {
        statusHtml = '<span class="alltell-image-status is-uploading" title="Загрузка на сервер…"><i class="fas fa-spinner fa-spin"></i> Загрузка…</span>';
      } else if (image.error) {
        statusHtml = '<span class="alltell-image-status is-error" title="' + escapeHtml(image.error) + '"><i class="fas fa-triangle-exclamation"></i> Сбой</span>';
      } else if (image.url) {
        statusHtml = '<span class="alltell-image-status is-uploaded" title="Загружено на сервер"><i class="fas fa-check"></i> Загружено</span>';
      } else if (image.file) {
        statusHtml = '<span class="alltell-image-status is-new" title="В очереди на загрузку"><i class="fas fa-clock"></i> В очереди</span>';
      }

      return `<article class="alltell-form-image-item${image.uploading ? ' is-uploading' : (image.url ? ' is-uploaded' : ' is-pending')}" data-post-image="${index}" ${disabled ? '' : 'draggable="true"'}>
        <div class="alltell-form-image-thumb">
          <img class="alltell-form-image-preview" src="${escapeHtml(image.preview || image.url)}" alt="${escapeHtml(image.file ? image.file.name : 'Изображение ' + (index + 1))}">
          <span class="alltell-form-image-order" title="Порядковый номер">${index + 1}</span>
          <button class="alltell-form-image-delete" type="button" data-action="remove-image" data-image-index="${index}" title="Удалить изображение" aria-label="Удалить изображение" ${disabled ? 'disabled' : ''}>
            <i class="fas fa-xmark" aria-hidden="true"></i>
          </button>
          ${statusHtml}
        </div>
        <div class="alltell-form-image-bar">
          <button class="alltell-form-image-nav" type="button" data-action="move-image" data-direction="-1" data-image-index="${index}" title="Переместить левее" aria-label="Переместить влево" ${index === 0 || disabled ? 'disabled' : ''}>
            <i class="fas fa-chevron-left" aria-hidden="true"></i>
          </button>
          <span class="alltell-form-image-pos">${index + 1} / ${images.length}</span>
          <button class="alltell-form-image-nav" type="button" data-action="move-image" data-direction="1" data-image-index="${index}" title="Переместить правее" aria-label="Переместить вправо" ${index === images.length - 1 || disabled ? 'disabled' : ''}>
            <i class="fas fa-chevron-right" aria-hidden="true"></i>
          </button>
        </div>
      </article>`;
    }).join('');
  }

  function renderSelectedArticleChips(articles) {
    if (!articles || !articles.length) return '';
    return articles.map(function (art) {
      return `
        <span class="alltell-article-tag-chip" data-slug="${escapeHtml(art.slug)}">
          <i class="fas fa-book-bookmark" aria-hidden="true"></i>
          <span class="alltell-article-tag-title" title="${escapeHtml(art.title || art.slug)}">${escapeHtml(art.title || art.slug)}</span>
          <button type="button" class="alltell-article-tag-remove" data-action="remove-article-tag" data-slug="${escapeHtml(art.slug)}" title="Удалить из выбранных" aria-label="Удалить статью">
            <i class="fas fa-xmark" aria-hidden="true"></i>
          </button>
        </span>
      `;
    }).join('');
  }

  // ===== AllTell Post Block Editor Engine =====

  function genBlockId() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function blockTypeTag(block) {
    if (!block) return 'Текст';
    if (block.type === 'heading') return 'Заголовок H' + (block.data.level || 2);
    if (block.type === 'list') {
      return { bullet: 'Список', ordered: 'Нумерованный список', checklist: 'Чек-лист' }[block.data.style] || 'Список';
    }
    if (block.type === 'quote') return 'Цитата';
    return 'Текст';
  }

  function autosizeField(el) {
    if (!el || !el.isConnected) return;
    el.style.height = 'auto';
    el.style.height = Math.max(26, el.scrollHeight) + 'px';
  }

  function parsePostBlocks(body) {
    if (!body || typeof body !== 'string' || !body.trim()) {
      return [{ id: genBlockId(), type: 'paragraph', data: { markdown: '' } }];
    }
    var rawBlocks = body.split(/\n{2,}/);
    var blocks = [];

    rawBlocks.forEach(function (raw) {
      var trimmed = raw.trim();
      if (!trimmed) return;

      var headingMatch = trimmed.match(/^(#{1,6})\s+([\s\S]+)$/);
      if (headingMatch && !trimmed.includes('\n')) {
        blocks.push({
          id: genBlockId(),
          type: 'heading',
          data: {
            level: Math.min(3, Math.max(1, headingMatch[1].length)),
            markdown: headingMatch[2].trim()
          }
        });
        return;
      }

      var lines = trimmed.split('\n');
      var isQuote = lines.every(function (l) { return !l.trim() || /^(?:>|&gt;)\s*/.test(l.trim()); }) &&
                    lines.some(function (l) { return /^(?:>|&gt;)\s*/.test(l.trim()); });
      if (isQuote) {
        var quoteText = lines.map(function (l) { return l.replace(/^(?:>|&gt;)\s*/, ''); }).join('\n');
        blocks.push({
          id: genBlockId(),
          type: 'quote',
          data: { markdown: quoteText }
        });
        return;
      }

      var isChecklist = lines.every(function (l) { return /^[-*]\s+\[[ xX]\]\s*/.test(l.trim()); });
      if (isChecklist) {
        var items = lines.map(function (l) {
          var m = l.trim().match(/^[-*]\s+\[([ xX])\]\s*(.*)$/);
          return {
            checked: m ? m[1].toLowerCase() === 'x' : false,
            markdown: m ? m[2] : l
          };
        });
        blocks.push({
          id: genBlockId(),
          type: 'list',
          data: { style: 'checklist', items: items.length ? items : [{ markdown: '', checked: false }] }
        });
        return;
      }

      var isOrdered = lines.every(function (l) { return /^\d+\.\s+/.test(l.trim()); });
      if (isOrdered) {
        var ordItems = lines.map(function (l) {
          return {
            checked: false,
            markdown: l.trim().replace(/^\d+\.\s+/, '')
          };
        });
        blocks.push({
          id: genBlockId(),
          type: 'list',
          data: { style: 'ordered', items: ordItems.length ? ordItems : [{ markdown: '', checked: false }] }
        });
        return;
      }

      var isBullet = lines.every(function (l) { return /^[-*•]\s+/.test(l.trim()); });
      if (isBullet) {
        var bulItems = lines.map(function (l) {
          return {
            checked: false,
            markdown: l.trim().replace(/^[-*•]\s+/, '')
          };
        });
        blocks.push({
          id: genBlockId(),
          type: 'list',
          data: { style: 'bullet', items: bulItems.length ? bulItems : [{ markdown: '', checked: false }] }
        });
        return;
      }

      blocks.push({
        id: genBlockId(),
        type: 'paragraph',
        data: { markdown: trimmed }
      });
    });

    if (!blocks.length) {
      blocks.push({ id: genBlockId(), type: 'paragraph', data: { markdown: '' } });
    }
    return blocks;
  }

  function serializePostBlocks(blocks) {
    if (!blocks || !blocks.length) return '';
    var parts = [];
    blocks.forEach(function (b) {
      if (!b) return;
      if (b.type === 'paragraph') {
        var text = (b.data && b.data.markdown != null ? b.data.markdown : '').trim();
        if (text) parts.push(text);
      } else if (b.type === 'heading') {
        var level = (b.data && b.data.level) || 2;
        var hashes = '#'.repeat(Math.max(1, Math.min(3, level)));
        var hText = (b.data && b.data.markdown != null ? b.data.markdown : '').trim();
        if (hText) parts.push(hashes + ' ' + hText);
      } else if (b.type === 'quote') {
        var qText = (b.data && b.data.markdown != null ? b.data.markdown : '').trim();
        if (qText) {
          var lines = qText.split('\n').map(function (l) { return '> ' + l; }).join('\n');
          parts.push(lines);
        }
      } else if (b.type === 'list') {
        var items = (b.data && b.data.items) || [];
        var style = (b.data && b.data.style) || 'bullet';
        var listLines = [];
        items.forEach(function (item, idx) {
          var itText = (item.markdown != null ? item.markdown : '').trim();
          if (!itText && items.length > 1) return;
          if (style === 'checklist') {
            listLines.push('- [' + (item.checked ? 'x' : ' ') + '] ' + itText);
          } else if (style === 'ordered') {
            listLines.push((idx + 1) + '. ' + itText);
          } else {
            listLines.push('- ' + itText);
          }
        });
        if (listLines.length) parts.push(listLines.join('\n'));
      }
    });
    return parts.join('\n\n');
  }

  function syncPostEditorState(state) {
    if (!state || !state.postBlocks) return;
    var md = serializePostBlocks(state.postBlocks);
    var bodyInput = document.getElementById('postBodyInput');
    if (bodyInput) bodyInput.value = md;

    var counter = document.querySelector('[data-char-counter]');
    if (counter) counter.textContent = md.length.toLocaleString('ru-RU') + ' / 10 000';

    var previewEl = document.querySelector('[data-post-preview-pane]');
    if (previewEl) {
      var bodyHtml = '';
      if (!md.trim()) {
        bodyHtml = '<p class="preview-empty">Нечего показывать — начните писать в редакторе.</p>';
      } else {
        bodyHtml = formatPostBody(md);
      }
      var previewImages = (state.postImages || []).map(function (item) { return item.preview || item.url; }).filter(Boolean);
      if (previewImages.length) {
        bodyHtml += '<div class="alltell-post-preview-images" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);">' +
          previewImages.map(function (src) {
            return '<div style="position:relative;width:96px;height:96px;border-radius:8px;overflow:hidden;background:#14161a;border:1px solid rgba(255,255,255,0.1);flex-shrink:0;">' +
              '<img src="' + escapeHtml(src) + '" style="width:100%;height:100%;object-fit:cover;" alt="">' +
            '</div>';
          }).join('') +
        '</div>';
      }
      previewEl.innerHTML = bodyHtml;
    }
  }

  function updatePostPreview(form, state) {
    if (!state) return;
    syncPostEditorState(state);
  }

  function setPostEditorMode(form, mode, state) {
    if (!form) form = document.querySelector('[data-post-form]');
    if (!form) return;
    var panes = form.querySelector('[data-post-panes]');
    if (panes) panes.setAttribute('data-mode', mode);
    form.querySelectorAll('[data-post-mode]').forEach(function (tab) {
      tab.classList.toggle('active', (tab.dataset.postMode || tab.getAttribute('data-mode')) === mode);
    });
    if (state) syncPostEditorState(state);
    if (mode === 'edit' || mode === 'split') {
      var container = form.querySelector('#postBlocksContent');
      if (container) {
        container.querySelectorAll('textarea').forEach(function (ta) { autosizeField(ta); });
      }
    }
  }

  function updatePostToolbarFade(scrollEl) {
    if (!scrollEl) return;
    var maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth;
    scrollEl.classList.toggle('can-scroll-l', scrollEl.scrollLeft > 2);
    scrollEl.classList.toggle('can-scroll-r', maxScroll > 2 && scrollEl.scrollLeft < maxScroll - 2);
  }

  function createBlockTextarea(value, opts) {
    opts = opts || {};
    var ta = document.createElement('textarea');
    ta.className = 'eb-text' + (opts.className ? ' ' + opts.className : '');
    ta.value = value || '';
    ta.rows = 1;
    if (opts.placeholder) ta.placeholder = opts.placeholder;

    requestAnimationFrame(function () { autosizeField(ta); });

    ta.addEventListener('focus', function () {
      if (opts.state) {
        opts.state._activePostTextarea = ta;
        opts.state._activePostBlockId = opts.block ? opts.block.id : null;
      }
    });

    ta.addEventListener('input', function () {
      autosizeField(ta);
      if (opts.onInput) opts.onInput(ta.value);
      if (opts.state) syncPostEditorState(opts.state);
    });

    ta.addEventListener('keydown', function (e) {
      if (opts.splitOnEnter && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        splitPostTextBlockAtCursor(ta, opts.block, opts.state);
        return;
      }
      if (e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0 && opts.state && opts.state.postBlocks.length > 1 && !ta.value) {
        e.preventDefault();
        removePostBlock(opts.state, opts.block.id, true);
        return;
      }
      var mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); applyPostInlineFormat('bold', opts.state); }
      else if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); applyPostInlineFormat('italic', opts.state); }
      else if (mod && e.key.toLowerCase() === 'u') { e.preventDefault(); applyPostInlineFormat('underline', opts.state); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'x') { e.preventDefault(); applyPostInlineFormat('strike', opts.state); }
    });

    return ta;
  }

  function splitPostTextBlockAtCursor(ta, block, state) {
    if (!state || !state.postBlocks || !block) return;
    var blocks = state.postBlocks;
    var idx = blocks.indexOf(block);
    if (idx === -1) idx = blocks.length - 1;

    var pos = ta.selectionStart;
    var before = ta.value.slice(0, pos);
    var after = ta.value.slice(pos);

    block.data.markdown = before;
    var newBlock = { id: genBlockId(), type: 'paragraph', data: { markdown: after } };
    blocks.splice(idx + 1, 0, newBlock);

    state._pendingFocusBlockId = newBlock.id;
    var container = document.getElementById('postBlocksContent');
    if (container) renderPostBlocksList(container, state);
    syncPostEditorState(state);
  }

  function removePostBlock(state, blockId, focusPrev) {
    if (!state || !state.postBlocks) return;
    var blocks = state.postBlocks;
    if (blocks.length <= 1) {
      blocks[0] = { id: genBlockId(), type: 'paragraph', data: { markdown: '' } };
      state._pendingFocusBlockId = blocks[0].id;
    } else {
      var idx = blocks.findIndex(function (b) { return b.id === blockId; });
      if (idx !== -1) {
        if (focusPrev && idx > 0) {
          state._pendingFocusBlockId = blocks[idx - 1].id;
          state._pendingFocusAtEnd = true;
        } else if (idx < blocks.length - 1) {
          state._pendingFocusBlockId = blocks[idx + 1].id;
        }
        blocks.splice(idx, 1);
      }
    }
    var container = document.getElementById('postBlocksContent');
    if (container) renderPostBlocksList(container, state);
    syncPostEditorState(state);
  }

  function movePostBlock(state, blockId, dir) {
    if (!state || !state.postBlocks) return;
    var blocks = state.postBlocks;
    var idx = blocks.findIndex(function (b) { return b.id === blockId; });
    if (idx === -1) return;
    var targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= blocks.length) return;
    var temp = blocks[idx];
    blocks[idx] = blocks[targetIdx];
    blocks[targetIdx] = temp;
    state._pendingFocusBlockId = blockId;
    var container = document.getElementById('postBlocksContent');
    if (container) renderPostBlocksList(container, state);
    syncPostEditorState(state);
  }

  function addPostParagraphBlock(state) {
    if (!state || !state.postBlocks) return;
    var blocks = state.postBlocks;
    var activeId = state._activePostBlockId;
    var idx = blocks.findIndex(function (b) { return b.id === activeId; });
    var active = idx !== -1 ? blocks[idx] : null;

    if (active && (active.type === 'heading' || active.type === 'quote') && !active.data.markdown) {
      active.type = 'paragraph';
      active.data = { markdown: '' };
      state._pendingFocusBlockId = active.id;
    } else {
      var newBlock = { id: genBlockId(), type: 'paragraph', data: { markdown: '' } };
      if (idx !== -1) {
        blocks.splice(idx + 1, 0, newBlock);
      } else {
        blocks.push(newBlock);
      }
      state._pendingFocusBlockId = newBlock.id;
    }
    var container = document.getElementById('postBlocksContent');
    if (container) renderPostBlocksList(container, state);
    syncPostEditorState(state);
  }

  function addPostHeadingBlock(state, level) {
    if (!state || !state.postBlocks) return;
    level = Math.min(3, Math.max(1, parseInt(level, 10) || 2));
    var blocks = state.postBlocks;
    var activeId = state._activePostBlockId;
    var idx = blocks.findIndex(function (b) { return b.id === activeId; });
    var active = idx !== -1 ? blocks[idx] : null;

    if (active && (active.type === 'paragraph' || active.type === 'quote' || active.type === 'heading')) {
      active.type = 'heading';
      active.data = { level: level, markdown: (active.data && active.data.markdown) || '' };
      state._pendingFocusBlockId = active.id;
    } else if (active && active.type === 'list' && (!active.data.items || !active.data.items.length || (active.data.items.length === 1 && !active.data.items[0].markdown))) {
      active.type = 'heading';
      active.data = { level: level, markdown: '' };
      state._pendingFocusBlockId = active.id;
    } else {
      var newBlock = { id: genBlockId(), type: 'heading', data: { level: level, markdown: '' } };
      if (idx !== -1) {
        blocks.splice(idx + 1, 0, newBlock);
      } else {
        blocks.push(newBlock);
      }
      state._pendingFocusBlockId = newBlock.id;
    }
    var container = document.getElementById('postBlocksContent');
    if (container) renderPostBlocksList(container, state);
    syncPostEditorState(state);
  }

  function addPostListBlock(state, style) {
    if (!state || !state.postBlocks) return;
    style = style || 'bullet';
    var blocks = state.postBlocks;
    var activeId = state._activePostBlockId;
    var idx = blocks.findIndex(function (b) { return b.id === activeId; });
    var active = idx !== -1 ? blocks[idx] : null;

    if (active && active.type === 'list') {
      active.data.style = style;
      state._pendingFocusBlockId = active.id;
    } else if (active && (active.type === 'paragraph' || active.type === 'heading' || active.type === 'quote')) {
      var text = (active.data && active.data.markdown != null) ? active.data.markdown.trim() : '';
      var items = text ? text.split('\n').map(function (l) { return { markdown: l.trim(), checked: false }; }) : [{ markdown: '', checked: false }];
      active.type = 'list';
      active.data = { style: style, items: items };
      state._pendingFocusBlockId = active.id;
    } else {
      var newBlock = { id: genBlockId(), type: 'list', data: { style: style, items: [{ markdown: '', checked: false }] } };
      if (idx !== -1) {
        blocks.splice(idx + 1, 0, newBlock);
      } else {
        blocks.push(newBlock);
      }
      state._pendingFocusBlockId = newBlock.id;
    }
    var container = document.getElementById('postBlocksContent');
    if (container) renderPostBlocksList(container, state);
    syncPostEditorState(state);
  }

  function addPostQuoteBlock(state) {
    if (!state || !state.postBlocks) return;
    var blocks = state.postBlocks;
    var activeId = state._activePostBlockId;
    var idx = blocks.findIndex(function (b) { return b.id === activeId; });
    var active = idx !== -1 ? blocks[idx] : null;

    if (active && (active.type === 'paragraph' || active.type === 'heading')) {
      active.type = 'quote';
      active.data = { markdown: (active.data && active.data.markdown) || '' };
      state._pendingFocusBlockId = active.id;
    } else if (active && active.type === 'list') {
      var text = (active.data.items || []).map(function (it) { return it.markdown || ''; }).filter(Boolean).join('\n');
      active.type = 'quote';
      active.data = { markdown: text };
      state._pendingFocusBlockId = active.id;
    } else if (active && active.type === 'quote') {
      state._pendingFocusBlockId = active.id;
    } else {
      var newBlock = { id: genBlockId(), type: 'quote', data: { markdown: '' } };
      if (idx !== -1) {
        blocks.splice(idx + 1, 0, newBlock);
      } else {
        blocks.push(newBlock);
      }
      state._pendingFocusBlockId = newBlock.id;
    }
    var container = document.getElementById('postBlocksContent');
    if (container) renderPostBlocksList(container, state);
    syncPostEditorState(state);
  }

  function applyPostInlineFormat(cmd, state, extra) {
    var ta = state && state._activePostTextarea;
    if (!ta || !document.body.contains(ta)) {
      ta = document.querySelector('#postBlocksContent textarea');
      if (!ta) return;
    }
    var start = ta.selectionStart;
    var end = ta.selectionEnd;
    var val = ta.value;
    var selected = val.substring(start, end);

    var before = '', after = '';
    var placeholder = 'текст';
    switch (cmd) {
      case 'bold': before = '**'; after = '**'; placeholder = 'жирный текст'; break;
      case 'italic': before = '_'; after = '_'; placeholder = 'курсив'; break;
      case 'underline': before = '++'; after = '++'; placeholder = 'подчёркнутый текст'; break;
      case 'strike': before = '~~'; after = '~~'; placeholder = 'зачёркнутый текст'; break;
      case 'code': before = '`'; after = '`'; placeholder = 'код'; break;
      case 'spoiler': before = '||'; after = '||'; placeholder = 'спойлер'; break;
      case 'highlight':
        before = '==';
        after = (extra && extra.hex) ? '==(' + extra.hex + ')' : '==';
        placeholder = 'выделение';
        break;
      default: return;
    }

    var leadWs = (selected.match(/^\s*/) || [''])[0];
    var trailWs = (selected.match(/\s*$/) || [''])[0];
    var core = selected.slice(leadWs.length, selected.length - trailWs.length);
    if (!core && !selected) core = placeholder;
    var inserted = leadWs + before + core + after + trailWs;
    ta.value = val.substring(0, start) + inserted + val.substring(end);
    var newStart = start + leadWs.length + before.length;
    var newEnd = newStart + core.length;
    ta.selectionStart = newStart;
    ta.selectionEnd = newEnd;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    autosizeField(ta);
    if (state) syncPostEditorState(state);
  }

  function applyPostCommand(cmd, state, dataset) {
    dataset = dataset || {};
    switch (cmd) {
      case 'paragraph':
        addPostParagraphBlock(state);
        break;
      case 'heading':
        addPostHeadingBlock(state, parseInt(dataset.level, 10) || 2);
        break;
      case 'list':
        addPostListBlock(state, dataset.style || 'bullet');
        break;
      case 'quote':
        addPostQuoteBlock(state);
        break;
      case 'bold':
      case 'italic':
      case 'underline':
      case 'strike':
      case 'code':
      case 'spoiler':
        applyPostInlineFormat(cmd, state);
        break;
    }
  }

  function renderPostBlockBody(block, state, containerEl) {
    if (block.type === 'paragraph') {
      return createBlockTextarea(block.data.markdown, {
        placeholder: 'Начните писать текст… Enter — новый абзац, Shift+Enter — перенос строки.',
        splitOnEnter: true,
        block: block,
        state: state,
        onInput: function (val) { block.data.markdown = val; }
      });
    }
    if (block.type === 'heading') {
      return createBlockTextarea(block.data.markdown, {
        placeholder: 'Заголовок H' + (block.data.level || 2) + '…',
        splitOnEnter: true,
        block: block,
        state: state,
        onInput: function (val) { block.data.markdown = val; }
      });
    }
    if (block.type === 'quote') {
      return createBlockTextarea(block.data.markdown, {
        placeholder: 'Текст цитаты…',
        splitOnEnter: false,
        block: block,
        state: state,
        onInput: function (val) { block.data.markdown = val; }
      });
    }
    if (block.type === 'list') {
      var wrap = document.createElement('div');
      wrap.className = 'eb-gap';

      var styleGroup = document.createElement('div');
      styleGroup.className = 'eb-list-style-group';
      [
        { key: 'bullet', label: 'Маркеры' },
        { key: 'ordered', label: 'Нумерация' },
        { key: 'checklist', label: 'Чек-лист' }
      ].forEach(function (s) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = s.label;
        if (block.data.style === s.key) btn.className = 'active';
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          block.data.style = s.key;
          renderPostBlocksList(containerEl, state);
          syncPostEditorState(state);
        });
        styleGroup.appendChild(btn);
      });
      wrap.appendChild(styleGroup);

      var itemsEl = document.createElement('div');
      itemsEl.className = 'eb-gap';
      (block.data.items || []).forEach(function (item, idx) {
        itemsEl.appendChild(renderPostListItem(block, item, idx, state, containerEl));
      });
      wrap.appendChild(itemsEl);

      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'eb-mini-btn';
      addBtn.innerHTML = '<i class="fas fa-plus"></i> Пункт';
      addBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        block.data.items = block.data.items || [];
        block.data.items.push({ markdown: '', checked: false });
        state._pendingFocusBlockId = block.id;
        renderPostBlocksList(containerEl, state);
        syncPostEditorState(state);
      });
      wrap.appendChild(addBtn);

      return wrap;
    }
    return document.createElement('div');
  }

  function renderPostListItem(block, item, idx, state, containerEl) {
    var row = document.createElement('div');
    row.className = 'eb-list-item';

    if (block.data.style === 'checklist') {
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!item.checked;
      cb.addEventListener('change', function () {
        item.checked = cb.checked;
        syncPostEditorState(state);
      });
      row.appendChild(cb);
    } else {
      var marker = document.createElement('span');
      marker.className = 'eb-list-marker';
      marker.textContent = (block.data.style === 'ordered' ? (idx + 1) + '.' : '•');
      row.appendChild(marker);
    }

    var ta = createBlockTextarea(item.markdown, {
      placeholder: 'Пункт списка…',
      block: block,
      state: state,
      onInput: function (val) { item.markdown = val; }
    });

    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        var pos = ta.selectionStart;
        var before = ta.value.slice(0, pos);
        var after = ta.value.slice(pos);
        item.markdown = before;
        block.data.items.splice(idx + 1, 0, { markdown: after, checked: false });
        state._pendingFocusBlockId = block.id;
        renderPostBlocksList(containerEl, state);
        syncPostEditorState(state);
      } else if (e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0 && block.data.items.length > 1) {
        e.preventDefault();
        block.data.items.splice(idx, 1);
        state._pendingFocusBlockId = block.id;
        state._pendingFocusAtEnd = true;
        renderPostBlocksList(containerEl, state);
        syncPostEditorState(state);
      }
    });

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'eb-icon-btn';
    del.title = 'Удалить пункт';
    del.innerHTML = '<i class="fas fa-xmark"></i>';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      if (block.data.items.length <= 1) return;
      block.data.items.splice(idx, 1);
      renderPostBlocksList(containerEl, state);
      syncPostEditorState(state);
    });

    row.append(ta, del);
    return row;
  }

  function closeBlockMoveMenu() {
    var old = document.querySelector('.eb-block-action-menu');
    if (old) old.remove();
  }

  function openBlockMoveMenu(button, block, state, containerEl) {
    closeBlockMoveMenu();
    var menu = document.createElement('div');
    menu.className = 'eb-block-action-menu';
    var blocks = state.postBlocks || [];
    var idx = blocks.findIndex(function (b) { return b.id === block.id; });

    var upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.innerHTML = '<i class="fas fa-arrow-up"></i> <span>Вверх</span>';
    upBtn.disabled = idx <= 0;
    upBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeBlockMoveMenu();
      movePostBlock(state, block.id, -1);
    });

    var downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.innerHTML = '<i class="fas fa-arrow-down"></i> <span>Вниз</span>';
    downBtn.disabled = idx === -1 || idx >= blocks.length - 1;
    downBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeBlockMoveMenu();
      movePostBlock(state, block.id, 1);
    });

    menu.append(upBtn, downBtn);
    document.body.appendChild(menu);

    var rect = button.getBoundingClientRect();
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.left = rect.left + 'px';

    function onDocClick(ev) {
      if (!menu.contains(ev.target) && ev.target !== button) {
        closeBlockMoveMenu();
        document.removeEventListener('click', onDocClick, true);
      }
    }
    setTimeout(function () {
      document.addEventListener('click', onDocClick, true);
    }, 10);
  }

  function renderPostBlocksList(containerEl, state) {
    if (!containerEl) return;
    containerEl.innerHTML = '';
    closeBlockMoveMenu();

    if (!state.postBlocks || !state.postBlocks.length) {
      state.postBlocks = [{ id: genBlockId(), type: 'paragraph', data: { markdown: '' } }];
    }

    state.postBlocks.forEach(function (block) {
      var wrap = document.createElement('div');
      wrap.className = 'eb-block eb-' + block.type + (block.type === 'heading' ? ' eb-heading-' + (block.data.level || 2) : '');
      wrap.dataset.blockId = block.id;

      var controls = document.createElement('div');
      controls.className = 'eb-block-controls';

      var dragBtn = document.createElement('button');
      dragBtn.type = 'button';
      dragBtn.className = 'eb-drag-handle';
      dragBtn.title = 'Потяните — переместить, клик — меню позиции';
      dragBtn.innerHTML = '<i class="fas fa-grip-vertical"></i>';
      dragBtn.draggable = true;
      dragBtn.addEventListener('dragstart', function (e) {
        e.dataTransfer.setData('text/plain', block.id);
        e.dataTransfer.effectAllowed = 'move';
        wrap.classList.add('eb-dragging');
      });
      dragBtn.addEventListener('dragend', function () {
        wrap.classList.remove('eb-dragging');
        containerEl.querySelectorAll('.eb-block').forEach(function (el) {
          el.classList.remove('eb-drop-target-above', 'eb-drop-target-below');
        });
      });
      dragBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        openBlockMoveMenu(dragBtn, block, state, containerEl);
      });

      var copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'eb-copy-btn';
      copyBtn.title = 'Копировать / дублировать блок';
      copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
      copyBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var idx = state.postBlocks.findIndex(function (b) { return b.id === block.id; });
        if (idx === -1) return;
        var clone = JSON.parse(JSON.stringify(block));
        clone.id = genBlockId();
        state.postBlocks.splice(idx + 1, 0, clone);
        state._pendingFocusBlockId = clone.id;
        renderPostBlocksList(containerEl, state);
        syncPostEditorState(state);
        showToast('Блок продублирован');
      });

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'eb-remove';
      delBtn.title = 'Удалить блок';
      delBtn.innerHTML = '<i class="fas fa-trash"></i>';
      delBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        removePostBlock(state, block.id, false);
      });

      controls.append(dragBtn, copyBtn, delBtn);

      // Drag & drop перетаскивание между блоками
      wrap.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        var rect = wrap.getBoundingClientRect();
        var isAbove = (e.clientY - rect.top) < (rect.height / 2);
        wrap.classList.toggle('eb-drop-target-above', isAbove);
        wrap.classList.toggle('eb-drop-target-below', !isAbove);
      });
      wrap.addEventListener('dragleave', function () {
        wrap.classList.remove('eb-drop-target-above', 'eb-drop-target-below');
      });
      wrap.addEventListener('drop', function (e) {
        e.preventDefault();
        wrap.classList.remove('eb-drop-target-above', 'eb-drop-target-below');
        var srcId = e.dataTransfer.getData('text/plain');
        if (!srcId || srcId === block.id) return;
        var fromIdx = state.postBlocks.findIndex(function (b) { return b.id === srcId; });
        var toIdx = state.postBlocks.findIndex(function (b) { return b.id === block.id; });
        if (fromIdx === -1 || toIdx === -1) return;
        var rect = wrap.getBoundingClientRect();
        var isAbove = (e.clientY - rect.top) < (rect.height / 2);
        var moved = state.postBlocks.splice(fromIdx, 1)[0];
        var newIdx = state.postBlocks.findIndex(function (b) { return b.id === block.id; });
        if (!isAbove) newIdx += 1;
        state.postBlocks.splice(newIdx, 0, moved);
        state._pendingFocusBlockId = moved.id;
        renderPostBlocksList(containerEl, state);
        syncPostEditorState(state);
      });

      var tag = document.createElement('span');
      tag.className = 'eb-block-type-tag';
      tag.textContent = blockTypeTag(block);

      var body = renderPostBlockBody(block, state, containerEl);

      wrap.append(controls, tag, body);
      containerEl.appendChild(wrap);
    });

    if (state._pendingFocusBlockId) {
      var targetId = state._pendingFocusBlockId;
      state._pendingFocusBlockId = null;
      var targetEl = containerEl.querySelector('[data-block-id="' + targetId + '"] textarea');
      if (targetEl) {
        targetEl.focus();
        if (state._pendingFocusAtEnd) {
          targetEl.selectionStart = targetEl.selectionEnd = targetEl.value.length;
          state._pendingFocusAtEnd = false;
        }
      }
    }
  }

  function renderPostForm(state, hubs, canManage) {
    var post = state.editingPost;
    var images = state.postImages || [];
    var hubOptions = hubs.map(function (hub) {
      return `<option value="${Number(hub.id)}" ${post && Number(post.hub_id) === Number(hub.id) ? 'selected' : ''}>${escapeHtml(hub.name)}</option>`;
    }).join('');
    var postArticles = state.postArticles || [];
    return `
      <div class="antropedia-editor-view alltell-post-editor-view" data-post-form-container>
        <div class="antropedia-editor-header">
          <div class="antropedia-editor-header-left">
            <button type="button" class="btn btn-secondary btn-sm antropedia-editor-back-btn" data-action="${post ? 'cancel-edit' : 'cancel-post-form'}">
              <i class="fas fa-arrow-left"></i> <span>Назад к ленте</span>
            </button>
            <h2 class="antropedia-editor-title">
              <i class="fas ${post ? 'fa-pen-to-square' : 'fa-wand-magic-sparkles'}" style="color:#818cf8; margin-right:8px;"></i>
              ${post ? 'Редактировать публикацию' : (canManage ? 'Новая публикация' : 'Предложить публикацию')}
            </h2>
            <span class="draft-save-status">
              <i class="fas ${canManage ? 'fa-shield-halved' : 'fa-clock'}"></i>
              ${canManage ? 'От имени франшизы' : 'На модерацию'}
            </span>
          </div>
          <div class="antropedia-editor-header-right">
            <button type="button" class="btn btn-secondary btn-sm" data-action="${post ? 'cancel-edit' : 'cancel-post-form'}">
              <i class="fas fa-xmark"></i> <span>Отмена</span>
            </button>
            <button type="button" class="btn btn-primary btn-sm" data-action="submit-post-form-top">
              <i class="fas ${post ? 'fa-check' : 'fa-paper-plane'}"></i>
              <span>${post ? 'Сохранить' : (canManage ? 'Опубликовать' : 'Отправить')}</span>
            </button>
          </div>
        </div>

        <form class="antropedia-editor-container" data-post-form>
          <!-- СЕКЦИЯ 1: ПАРАМЕТРЫ ПУБЛИКАЦИИ -->
          <details class="form-section antropedia-editor-section" open>
            <summary>
              <i class="fas fa-paper-plane"></i>
              <span>Параметры публикации</span>
              <span class="form-section-hint">Заголовок, тип записи и привязка к хабу</span>
              <i class="fas fa-chevron-down form-section-chevron"></i>
            </summary>
            <div class="form-section-body">
              <div class="form-group full-width">
                <label class="form-label" for="postTitleInput">
                  Заголовок публикации <span style="color:var(--red,#ed4245); font-weight:bold;">*</span>
                </label>
                <input id="postTitleInput" name="title" class="form-input" maxlength="160" required
                       value="${escapeHtml(post ? post.title : '')}"
                       placeholder="Короткий и выразительный заголовок новости, хроники или события…">
                <div class="form-hint">Заголовок отображается в общей ленте вселенных и привлекает внимание читателей.</div>
              </div>

              <div class="form-section-grid">
                <div class="form-group">
                  <label class="form-label" for="postTypeSelect">Тип публикации</label>
                  <select id="postTypeSelect" name="type" class="form-select">
                    ${Object.keys(POST_TYPES).map(function (type) {
                      var selected = post ? post.type === type : type === 'news';
                      return `<option value="${type}" ${selected ? 'selected' : ''}>${POST_TYPES[type]}</option>`;
                    }).join('')}
                  </select>
                  <div class="form-hint">Задаёт тему и акцентную категорию записи в ленте сообщества.</div>
                </div>

                <div class="form-group">
                  <label class="form-label" for="postHubSelect">Привязка к хабу <span class="form-section-hint">необязательно</span></label>
                  <select id="postHubSelect" name="hub_id" class="form-select">
                    <option value="">Вся франшиза (общий пост)</option>${hubOptions}
                  </select>
                  <div class="form-hint">Выберите ролевую сессию или оставьте пост общим для всей вселенной.</div>
                </div>

                <div class="form-group" data-hub-status-field ${post && post.hub_id ? '' : 'hidden'}>
                  <label class="form-label" for="postHubStatusSelect">Статус хаба <span class="form-section-hint">при изменении</span></label>
                  <select id="postHubStatusSelect" name="hub_status" class="form-select" ${post && post.hub_id ? '' : 'disabled'}>
                    <option value="">Без изменения статуса</option>
                    ${Object.keys(HUB_STATUSES).map(function (status) {
                      return `<option value="${status}" ${post && post.hub_status === status ? 'selected' : ''}>${HUB_STATUSES[status]}</option>`;
                    }).join('')}
                  </select>
                  <div class="form-hint">Статус активности хаба обновится одновременно с публикацией.</div>
                </div>
              </div>
            </div>
          </details>

          <!-- СЕКЦИЯ 2: СОДЕРЖАНИЕ (КОНТЕНТ) -->
          <details class="form-section antropedia-editor-section" open>
            <summary>
              <i class="fas fa-align-left"></i>
              <span>Содержание</span>
              <span class="form-section-hint">Текст публикации и форматирование</span>
              <i class="fas fa-chevron-down form-section-chevron"></i>
            </summary>
            <div class="form-section-body">
              <div class="form-group full-width">
                <label class="form-label" for="postBodyInput">
                  <span>Текст публикации</span>
                </label>
                <div class="editor-wrapper">
                  <div class="editor-toolbar-sticky alltell-post-toolbar">
                    <div class="toolbar-format-scroll" data-alltell-toolbar-scroll>
                      <div class="toolbar-row toolbar-row-format" data-alltell-toolbar-row>
                        <div class="toolbar-group-wrap">
                          <div class="toolbar-group">
                            <button type="button" class="toolbar-button" data-post-cmd="paragraph" title="Текст — новый абзац"><i class="fas fa-paragraph"></i></button>
                          </div>
                          <span class="toolbar-group-label">текст</span>
                        </div>
                        <div class="toolbar-group-wrap">
                          <div class="toolbar-group">
                            <button type="button" class="toolbar-button" data-post-cmd="bold" title="Жирный (Ctrl+B)"><i class="fas fa-bold"></i></button>
                            <button type="button" class="toolbar-button" data-post-cmd="italic" title="Курсив (Ctrl+I)"><i class="fas fa-italic"></i></button>
                            <button type="button" class="toolbar-button" data-post-cmd="underline" title="Подчёркнутый (Ctrl+U)"><i class="fas fa-underline"></i></button>
                            <button type="button" class="toolbar-button" data-post-cmd="strike" title="Зачёркнутый (Ctrl+Shift+X)"><i class="fas fa-strikethrough"></i></button>
                            <button type="button" class="toolbar-button" data-post-cmd="highlight" title="Выделение цветом"><i class="fas fa-highlighter"></i></button>
                            <button type="button" class="toolbar-button" data-post-cmd="code" title="Код (строка)"><i class="fas fa-code"></i></button>
                          </div>
                          <span class="toolbar-group-label">формат</span>
                        </div>
                        <div class="toolbar-group-wrap">
                          <div class="toolbar-group">
                            <button type="button" class="toolbar-button" data-post-cmd="spoiler" title="Инлайн-спойлер — скрытая фраза"><i class="fas fa-eye-slash"></i></button>
                          </div>
                          <span class="toolbar-group-label">спойлер</span>
                        </div>
                        <div class="toolbar-group-wrap">
                          <div class="toolbar-group">
                            <button type="button" class="toolbar-button" data-post-cmd="heading" data-level="1" title="Заголовок 1"><i class="fas fa-heading"></i>1</button>
                            <button type="button" class="toolbar-button" data-post-cmd="heading" data-level="2" title="Заголовок 2"><i class="fas fa-heading"></i>2</button>
                            <button type="button" class="toolbar-button" data-post-cmd="heading" data-level="3" title="Заголовок 3"><i class="fas fa-heading"></i>3</button>
                          </div>
                          <span class="toolbar-group-label">заголовки</span>
                        </div>
                        <div class="toolbar-group-wrap">
                          <div class="toolbar-group">
                            <button type="button" class="toolbar-button" data-post-cmd="list" data-style="bullet" title="Маркированный список"><i class="fas fa-list-ul"></i></button>
                            <button type="button" class="toolbar-button" data-post-cmd="list" data-style="ordered" title="Нумерованный список"><i class="fas fa-list-ol"></i></button>
                            <button type="button" class="toolbar-button" data-post-cmd="list" data-style="checklist" title="Чек-лист"><i class="fas fa-check-square"></i></button>
                          </div>
                          <span class="toolbar-group-label">списки</span>
                        </div>
                        <div class="toolbar-group-wrap">
                          <div class="toolbar-group">
                            <button type="button" class="toolbar-button" data-post-cmd="quote" title="Цитата"><i class="fas fa-quote-right"></i></button>
                          </div>
                          <span class="toolbar-group-label">цитата</span>
                        </div>
                      </div>
                      <div class="toolbar-fade toolbar-fade-l"><i class="fas fa-chevron-left toolbar-fade-arrow"></i></div>
                      <div class="toolbar-fade toolbar-fade-r"><i class="fas fa-chevron-right toolbar-fade-arrow"></i></div>
                    </div>
                    <div class="toolbar-row toolbar-row-modes">
                      <div class="editor-mode-tabs" data-post-mode-tabs>
                        <button type="button" class="editor-mode-tab active" data-mode="edit" data-post-mode="edit" title="Редактирование"><i class="fas fa-pen"></i> <span class="editor-mode-tab-label">Редактирование</span></button>
                        <button type="button" class="editor-mode-tab" data-mode="preview" data-post-mode="preview" title="Просмотр"><i class="fas fa-eye"></i> <span class="editor-mode-tab-label">Просмотр</span></button>
                        <button type="button" class="editor-mode-tab" data-mode="split" data-post-mode="split" title="Двойной просмотр"><i class="fas fa-columns"></i> <span class="editor-mode-tab-label">Разделить</span></button>
                      </div>
                    </div>
                  </div>
                  <div class="editor-panes" data-mode="edit" data-post-panes>
                    <div class="editor-pane">
                      <div id="postBlocksContent" class="eb-blocklist" data-eb-empty-hint="Нажмите на кнопку «P» в тулбаре, чтобы добавить первый блок…"></div>
                    </div>
                    <div class="preview-pane alltell-post-body" data-post-preview-pane>
                      ${post && post.body ? formatPostBody(post.body) : '<p class="preview-empty">Нечего показывать — начните писать в редакторе.</p>'}
                    </div>
                  </div>
                </div>
                <input type="hidden" name="body" id="postBodyInput" value="${escapeHtml(serializePostBlocks(state.postBlocks || []))}">
                <div class="alltell-post-body-footer">
                  <span class="alltell-post-format-hint">
                    <i class="fab fa-markdown"></i> Поддерживается разметка: **жирный**, *курсив*, ||спойлеры||, списки и цитаты
                  </span>
                  <span class="alltell-post-char-counter" data-char-counter>
                    ${(post && post.body ? post.body.length : 0).toLocaleString('ru-RU')} / 10 000
                  </span>
                </div>
              </div>
            </div>
          </details>

          <!-- СЕКЦИЯ 3: МЕДИА И СТАТЬИ -->
          <details class="form-section antropedia-editor-section" open>
            <summary>
              <i class="fas fa-paperclip"></i>
              <span>Медиа и статьи</span>
              <span class="form-section-hint">Изображения галереи и прикрепление статей Antropedia</span>
              <i class="fas fa-chevron-down form-section-chevron"></i>
            </summary>
            <div class="form-section-body">
              <!-- ГАЛЕРЕЯ ИЗОБРАЖЕНИЙ -->
              <div class="form-group full-width alltell-post-image-editor" data-image-drop>
                <div class="alltell-image-editor-heading">
                  <label class="form-label" style="margin:0;">
                    <i class="fas fa-images"></i>
                    <span>Галерея изображений публикации</span>
                  </label>
                  <span class="alltell-editor-badge" data-image-selection>
                    ${images.length ? images.length + ' добавлено' : 'Перетащите или выберите'}
                  </span>
                </div>

                <label class="alltell-image-dropzone">
                  <input name="images" type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple hidden ${state.uploadingImages ? 'disabled' : ''}>
                  <div class="alltell-image-dropzone-content">
                    <div class="alltell-image-dropzone-icon"><i class="fas fa-cloud-arrow-up"></i></div>
                    <div class="alltell-image-dropzone-text">
                      <strong>Нажмите для выбора изображений</strong> или перетащите файлы в эту область
                      <div class="form-hint" style="margin-top:4px;">Поддерживаются форматы JPG, PNG, WEBP и GIF</div>
                    </div>
                  </div>
                </label>

                <div class="alltell-form-images" data-post-image-grid>
                  ${renderPostImageItems(images, state.uploadingImages)}
                </div>

                <div class="alltell-upload-progress" data-image-progress hidden>
                  <div>
                    <span data-image-progress-label>Загрузка изображений…</span>
                    <span data-image-progress-count></span>
                  </div>
                  <progress max="100" value="0" data-image-progress-bar></progress>
                </div>
              </div>

              <!-- СВЯЗАННЫЕ СТАТЬИ -->
              <div class="form-group full-width alltell-article-picker-field">
                <div class="alltell-article-picker-header">
                  <label class="form-label" style="margin:0;">
                    <i class="fas fa-book-bookmark"></i>
                    <span>Связанные статьи Antropedia</span>
                  </label>
                  <span class="alltell-editor-badge" data-article-count>
                    ${postArticles.length ? postArticles.length + ' выбрано' : 'Не выбрано'}
                  </span>
                </div>

                <div class="alltell-article-picker-wrapper" style="position: relative;">
                  <div class="alltell-article-picker-box" data-article-picker-box>
                    <div class="alltell-selected-articles" data-selected-articles>
                      ${renderSelectedArticleChips(postArticles)}
                    </div>
                    <input name="article_search"
                           type="text"
                           class="alltell-article-search-input"
                           autocomplete="off"
                           value=""
                           placeholder="${postArticles.length ? 'Прикрепить ещё статью…' : 'Поиск статьи по названию для прикрепления…'}"
                           data-article-search>
                  </div>
                  <div class="alltell-article-options" data-article-options hidden></div>
                </div>
                <div class="form-hint">Прикреплённые статьи появятся в виде кликабельных карточек с быстрым переходом к чтению.</div>
              </div>
            </div>
          </details>

          <!-- НИЖНИЕ ДЕЙСТВИЯ -->
          <div class="alltell-post-form-footer">
            <div class="alltell-post-form-footer-left">
              <i class="fas fa-info-circle"></i>
              <span>${canManage ? 'Запись появится в ленте франшизы сразу после сохранения' : 'Запись поступит создателю франшизы на модерацию'}</span>
            </div>
            <div class="alltell-post-form-footer-right">
              <button class="btn btn-secondary" type="button" data-action="${post ? 'cancel-edit' : 'cancel-post-form'}">
                <i class="fas fa-xmark"></i> Отмена
              </button>
              <button class="btn btn-primary" type="submit">
                <i class="fas ${post ? 'fa-check' : 'fa-paper-plane'}"></i>
                <span>${post ? 'Сохранить изменения' : (canManage ? 'Опубликовать запись' : 'Отправить на модерацию')}</span>
              </button>
            </div>
          </div>
        </form>
      </div>`;
  }

  function renderMembersView(state, data, canManage, isOwner, isRoot) {
    var members = state.workspaceData.members || [];
    var currentUser = window.authManager && window.authManager.getUser();
    var userId = currentUser && currentUser.id;
    return `
      <section class="alltell-live-section">
        <div class="alltell-live-section-heading">
          <div class="alltell-heading-title">
            <h2><i class="fas fa-users" aria-hidden="true"></i> Участники сообщества</h2>
            <span>${members.length || Number(data.franchise.member_count || 0)} участников состоят во франшизе</span>
          </div>
          ${canManage ? `
            <button class="btn btn-primary btn-sm" type="button" data-action="manage-add-member">
              <i class="fas fa-user-plus"></i> Добавить участника
            </button>
          ` : ''}
        </div>
        ${members.length ? `
          <div class="alltell-table-wrap">
            <table class="alltell-table">
              <thead>
                <tr>
                  <th>Пользователь</th>
                  <th>Роли</th>
                  ${(canManage || userId) ? '<th class="alltell-table-action-col">Действия</th>' : ''}
                </tr>
              </thead>
              <tbody>
                ${members.map(function (m) {
                  var isMemberOwner = Number(m.id) === Number(data.franchise.owner_id);
                  var isSelf = Number(m.id) === Number(userId);
                  var rolesHtml = (m.roles && m.roles.length) ? m.roles.map(function (r) {
                    return `<span class="alltell-role-chip ${r.type === 'system' ? 'is-system' : 'is-custom'}">
                      ${escapeHtml(r.name)}
                      ${canManage ? `<button type="button" class="alltell-role-remove" data-action="manage-remove-role" data-user-id="${m.id}" data-role-id="${r.id}" title="Снять роль">×</button>` : ''}
                    </span>`;
                  }).join('') : '<span style="color:var(--text-muted);font-size:12px;">Участник</span>';

                  var actionsHtml = '';
                  if (isMemberOwner) {
                    actionsHtml = '<div class="alltell-table-actions"><span class="alltell-card-owner-pill"><i class="fas fa-crown"></i> Создатель</span></div>';
                  } else if (canManage) {
                    actionsHtml = `
                      <div class="alltell-table-actions">
                        <button class="btn btn-secondary btn-sm" type="button" data-action="manage-assign-role" data-user-id="${m.id}" data-user-name="${escapeHtml(m.display_name || m.username)}" title="Назначить роль">
                          <i class="fas fa-user-gear"></i> <span>Роль</span>
                        </button>
                        <button class="btn btn-danger btn-sm" type="button" data-action="manage-kick-member" data-user-id="${m.id}" data-user-name="${escapeHtml(m.display_name || m.username)}" title="Исключить участника">
                          <i class="fas fa-user-xmark"></i> <span>Исключить</span>
                        </button>
                      </div>
                    `;
                  } else if (isSelf) {
                    actionsHtml = `
                      <div class="alltell-table-actions">
                        <button class="btn btn-danger btn-sm" type="button" data-action="leave" title="Покинуть франшизу">
                          <i class="fas fa-right-from-bracket"></i> <span>Покинуть</span>
                        </button>
                      </div>
                    `;
                  }

                  return `
                    <tr>
                      <td>
                        <div style="display:flex;align-items:center;gap:10px;">
                          <div class="alltell-live-avatar" style="width:34px;height:34px;font-size:13px;border-radius:10px;">${escapeHtml(initials(m.display_name || m.username))}</div>
                          <div>
                            <strong>${escapeHtml(m.display_name || m.username)}</strong>
                            ${isSelf ? '<span style="color:var(--text-muted);font-size:11px;"> (вы)</span>' : ''}
                            <div style="font-size:11px;color:var(--text-muted);">ID ${m.id}</div>
                          </div>
                        </div>
                      </td>
                      <td>${rolesHtml}</td>
                      ${(canManage || userId) ? `<td class="alltell-table-action-cell">${actionsHtml}</td>` : ''}
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="alltell-state alltell-state-empty">
            <div class="alltell-empty-icon"><i class="fas fa-users"></i></div>
            <h3>Список участников загружается…</h3>
          </div>
        `}
      </section>
    `;
  }

  function renderWorkspaceOverviewTab(state, data, canManage, isOwner, isRoot) {
    var members = state.workspaceData.members || [];
    var roles = state.workspaceData.roles || [];
    var channels = state.workspaceData.channels || [];
    var hubs = state.workspaceData.hubs || data.hubs || [];
    var customRoles = roles.filter(function (r) { return r.role_type === 'custom'; }).length;

    return `
      <div class="alltell-ws-section-header">
        <h3 class="alltell-ws-title"><i class="fas fa-chart-pie" style="color:var(--blurple)"></i> Сводка франшизы</h3>
      </div>
      <div class="alltell-ws-stats-grid">
        <div class="alltell-ws-stat-card">
          <div class="alltell-ws-stat-value">${members.length || Number(data.franchise.member_count || 0)}</div>
          <div class="alltell-ws-stat-label">Участников</div>
        </div>
        <div class="alltell-ws-stat-card">
          <div class="alltell-ws-stat-value">${roles.length}</div>
          <div class="alltell-ws-stat-label">Ролей (${customRoles} своих)</div>
        </div>
        <div class="alltell-ws-stat-card">
          <div class="alltell-ws-stat-value">${channels.length}</div>
          <div class="alltell-ws-stat-label">Каналов</div>
        </div>
        <div class="alltell-ws-stat-card">
          <div class="alltell-ws-stat-value">${hubs.length}</div>
          <div class="alltell-ws-stat-label">Игровых хабов</div>
        </div>
      </div>
      <div style="background:var(--background-tertiary);border:1px solid var(--background-accent);border-radius:12px;padding:18px;margin-bottom:20px;">
        <h4 style="margin:0 0 8px;font-size:0.95rem;color:var(--text-normal);display:flex;align-items:center;gap:8px;">
          <i class="fas fa-circle-info" style="color:var(--blurple)"></i> О системе управления
        </h4>
        <p style="margin:0;font-size:0.86rem;color:var(--text-muted);line-height:1.5;">
          Франшиза объединяет ваши ролевые миры, хабы и публикации. Роли используются в Antropedia для ограничения доступа («Доступ для»), а также определяют права участников внутри вселенной.
        </p>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;">
        <button type="button" class="btn btn-primary" data-action="switch-ws-tab" data-ws-tab="hubs"><i class="fas fa-layer-group"></i> Управление хабами</button>
        <button type="button" class="btn btn-secondary" data-action="switch-ws-tab" data-ws-tab="members"><i class="fas fa-user-plus"></i> Добавить участника</button>
        <button type="button" class="btn btn-secondary" data-action="switch-ws-tab" data-ws-tab="roles"><i class="fas fa-plus"></i> Создать роль</button>
        <button type="button" class="btn btn-secondary" data-action="switch-ws-tab" data-ws-tab="settings"><i class="fas fa-gear"></i> Настройки франшизы</button>
      </div>
    `;
  }

  function renderWorkspaceMembersTab(state, data, canManage, isOwner, isRoot) {
    var members = state.workspaceData.members || [];
    var currentUser = window.authManager && window.authManager.getUser();
    var userId = currentUser && currentUser.id;
    return `
      ${!canManage ? '<div class="alltell-permission-note"><i class="fas fa-circle-info"></i> Добавлять участников, назначать и снимать роли может только администратор франшизы. Вы просматриваете список в режиме чтения.</div>' : ''}
      <div class="alltell-ws-section-header">
        <h3 class="alltell-ws-title"><i class="fas fa-users" style="color:var(--blurple)"></i> Участники (${members.length})</h3>
        ${canManage ? `
          <button type="button" class="btn btn-primary btn-sm" data-action="manage-add-member">
            <i class="fas fa-user-plus"></i> Добавить участника
          </button>
        ` : ''}
      </div>
      <div class="alltell-table-wrap">
        <table class="alltell-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Пользователь</th>
              <th>Роли</th>
              <th class="alltell-table-action-col">Действия</th>
            </tr>
          </thead>
          <tbody>
            ${members.length ? members.map(function (m) {
              var isMemberOwner = Number(m.id) === Number(data.franchise.owner_id);
              var isSelf = Number(m.id) === Number(userId);
              var rolesHtml = (m.roles && m.roles.length) ? m.roles.map(function (r) {
                return `<span class="alltell-role-chip ${r.type === 'system' ? 'is-system' : 'is-custom'}">
                  ${escapeHtml(r.name)}
                  ${canManage ? `<button type="button" class="alltell-role-remove" data-action="manage-remove-role" data-user-id="${m.id}" data-role-id="${r.id}" title="Снять роль">×</button>` : ''}
                </span>`;
              }).join('') : '<span style="color:var(--text-muted);font-size:12px;">Нет ролей</span>';

              var actionsHtml = '';
              if (isMemberOwner) {
                actionsHtml = '<div class="alltell-table-actions"><span class="alltell-card-owner-pill"><i class="fas fa-crown"></i> Владелец</span></div>';
              } else if (canManage) {
                actionsHtml = `
                  <div class="alltell-table-actions">
                    <button class="btn btn-secondary btn-sm" type="button" data-action="manage-assign-role" data-user-id="${m.id}" data-user-name="${escapeHtml(m.display_name || m.username)}" title="Назначить роль">
                      <i class="fas fa-user-gear"></i> <span>Роль</span>
                    </button>
                    <button class="btn btn-danger btn-sm" type="button" data-action="manage-kick-member" data-user-id="${m.id}" data-user-name="${escapeHtml(m.display_name || m.username)}" title="Исключить участника">
                      <i class="fas fa-user-xmark"></i> <span>Исключить</span>
                    </button>
                  </div>
                `;
              } else if (isSelf) {
                actionsHtml = `
                  <div class="alltell-table-actions">
                    <button class="btn btn-danger btn-sm" type="button" data-action="leave" title="Покинуть франшизу">
                      <i class="fas fa-right-from-bracket"></i> <span>Покинуть</span>
                    </button>
                  </div>
                `;
              }

              return `
                <tr>
                  <td style="color:var(--text-muted);font-size:12px;">${m.id}</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:10px;">
                      <div class="alltell-live-avatar" style="width:32px;height:32px;font-size:12px;border-radius:10px;">${escapeHtml(initials(m.display_name || m.username))}</div>
                      <div>
                        <strong>${escapeHtml(m.display_name || m.username)}</strong>
                        ${isSelf ? '<span style="color:var(--text-muted);font-size:11px;"> (вы)</span>' : ''}
                      </div>
                    </div>
                  </td>
                  <td>${rolesHtml}</td>
                  <td class="alltell-table-action-cell">${actionsHtml}</td>
                </tr>
              `;
            }).join('') : '<tr class="alltell-table-empty"><td colspan="4">Участников пока нет</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderWorkspaceRolesTab(state, data, canManage, isOwner, isRoot) {
    var roles = state.workspaceData.roles || [];
    var permLabels = {
      read_messages: 'Чтение',
      send_messages: 'Отправка',
      manage_channels: 'Каналы',
      manage_roles: 'Роли',
      ban_users: 'Блокировка'
    };
    return `
      ${!canManage ? '<div class="alltell-permission-note"><i class="fas fa-circle-info"></i> Создавать и изменять роли может только администратор этой франшизы.</div>' : ''}
      <div class="alltell-ws-section-header">
        <h3 class="alltell-ws-title"><i class="fas fa-user-shield" style="color:var(--blurple)"></i> Роли (${roles.length})</h3>
        ${canManage ? `
          <button type="button" class="btn btn-primary btn-sm" data-action="manage-create-role">
            <i class="fas fa-plus"></i> Создать роль
          </button>
        ` : ''}
      </div>
      <div class="alltell-table-wrap">
        <table class="alltell-table">
          <thead>
            <tr>
              <th>Название</th>
              <th>Тип</th>
              <th>Уровень</th>
              <th>Права</th>
              <th class="alltell-table-action-col">Действия</th>
            </tr>
          </thead>
          <tbody>
            ${roles.length ? roles.map(function (r) {
              var isSystem = r.role_type === 'system';
              var permsList = Object.entries(permLabels).filter(function (e) {
                return r.permissions && r.permissions[e[0]];
              }).map(function (e) { return e[1]; }).join(', ') || '—';

              var actionsHtml = isSystem
                ? '<div class="alltell-table-actions"><span class="alltell-table-note">Системная</span></div>'
                : (canManage ? `
                  <div class="alltell-table-actions">
                    <button class="btn btn-secondary btn-sm" type="button" data-action="manage-edit-role" data-role-id="${r.id}" title="Редактировать роль">
                      <i class="fas fa-pen"></i> <span>Изменить</span>
                    </button>
                    <button class="btn btn-danger btn-sm" type="button" data-action="manage-delete-role" data-role-id="${r.id}" data-role-name="${escapeHtml(r.name)}" title="Удалить роль">
                      <i class="fas fa-trash"></i> <span>Удалить</span>
                    </button>
                  </div>
                ` : '—');

              return `
                <tr>
                  <td><strong style="color:${isSystem ? 'var(--blurple)' : '#eb459e'};">${escapeHtml(r.name)}</strong></td>
                  <td><span class="alltell-role-chip ${isSystem ? 'is-system' : 'is-custom'}">${isSystem ? 'Системная' : 'Пользовательская'}</span></td>
                  <td>${r.hierarchy_level}</td>
                  <td style="color:var(--text-muted);font-size:12px;">${escapeHtml(permsList)}</td>
                  <td class="alltell-table-action-cell">${actionsHtml}</td>
                </tr>
              `;
            }).join('') : '<tr class="alltell-table-empty"><td colspan="5">Ролей пока нет</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderWorkspaceChannelsTab(state, data, canManage, isOwner, isRoot) {
    var channels = state.workspaceData.channels || [];
    return `
      ${!canManage ? '<div class="alltell-permission-note"><i class="fas fa-circle-info"></i> Создавать и изменять каналы может только администратор франшизы.</div>' : ''}
      <div class="alltell-ws-section-header">
        <h3 class="alltell-ws-title"><i class="fas fa-hashtag" style="color:var(--blurple)"></i> Каналы (${channels.length})</h3>
        ${canManage ? `
          <button type="button" class="btn btn-primary btn-sm" data-action="manage-create-channel">
            <i class="fas fa-plus"></i> Создать канал
          </button>
        ` : ''}
      </div>
      <div class="alltell-table-wrap">
        <table class="alltell-table">
          <thead>
            <tr>
              <th>Название</th>
              <th>Тип</th>
              <th>Описание</th>
              <th class="alltell-table-action-col">Действия</th>
            </tr>
          </thead>
          <tbody>
            ${channels.length ? channels.map(function (c) {
              var isVoice = c.channel_type === 'voice';
              var actionsHtml = canManage ? `
                <div class="alltell-table-actions">
                  <button class="btn btn-secondary btn-sm" type="button" data-action="manage-edit-channel" data-channel-id="${c.id}" title="Редактировать канал">
                    <i class="fas fa-pen"></i> <span>Изменить</span>
                  </button>
                  <button class="btn btn-danger btn-sm" type="button" data-action="manage-delete-channel" data-channel-id="${c.id}" data-channel-name="${escapeHtml(c.name)}" title="Удалить канал">
                    <i class="fas fa-trash"></i> <span>Удалить</span>
                  </button>
                </div>
              ` : '—';
              return `
                <tr>
                  <td><i class="fas ${isVoice ? 'fa-volume-high' : 'fa-hashtag'}" style="color:var(--text-muted);margin-right:6px;"></i><strong>${escapeHtml(c.name)}</strong></td>
                  <td>${isVoice ? '🔊 Голосовой' : '💬 Текстовый'}</td>
                  <td style="color:var(--text-muted);font-size:13px;">${escapeHtml(c.description || '—')}</td>
                  <td class="alltell-table-action-cell">${actionsHtml}</td>
                </tr>
              `;
            }).join('') : '<tr class="alltell-table-empty"><td colspan="4">Каналов пока нет. Создайте каналы для общения сообщества!</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderWorkspaceHubsTab(state, data, canManage, isOwner, isRoot) {
    var hubs = state.workspaceData.hubs || data.hubs || [];
    var editingId = state.editingHubId;
    var editingHub = editingId && editingId !== 'new'
      ? hubs.find(function (h) { return String(h.id) === String(editingId); })
      : (editingId === 'new' ? { name: '', description: '', is_public: 1, avatar_url: null } : null);

    var formHtml = editingHub ? `
      <form class="alltell-hub-edit-form" data-hub-form>
        <h4>${editingId === 'new' ? '<i class="fas fa-plus"></i> Новый игровой хаб' : '<i class="fas fa-pen"></i> Редактировать хаб'}</h4>
        <div class="alltell-field">
          <label class="alltell-field-label">Название хаба <span style="color:#f23f43">*</span></label>
          <input type="text" name="name" maxlength="120" placeholder="Например: Игровая сессия 1: Забытые пески" required value="${escapeHtml(editingHub.name || '')}">
        </div>
        <div class="alltell-field">
          <label class="alltell-field-label">Описание хаба</label>
          <textarea name="description" class="alltell-hub-desc-textarea" data-autogrow rows="3" maxlength="5000" placeholder="Краткое описание сюжета, правил или формата игры">${escapeHtml(editingHub.description || '')}</textarea>
        </div>
        <div class="alltell-field">
          <label class="alltell-field-label">Аватарка хаба</label>
          <div style="display:flex;align-items:center;gap:14px;">
            <div id="hub-avatar-preview" style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg, var(--blurple), var(--accent-teal));display:grid;place-items:center;color:#fff;font-size:18px;overflow:hidden;flex-shrink:0;">
              ${editingHub.avatar_url ? `<img src="${escapeHtml(normalizeImageUrl(editingHub.avatar_url))}" style="width:100%;height:100%;object-fit:cover;" alt="">` : '<i class="fas fa-dice-d20"></i>'}
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
              <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0;">
                <i class="fas fa-camera"></i> <span id="hub-avatar-label">${editingHub.avatar_url ? 'Сменить аватарку' : 'Загрузить аватарку'}</span>
                <input type="file" id="hub-avatar-file" accept="image/jpeg,image/png,image/gif,image/webp" hidden>
              </label>
              <button type="button" class="btn btn-secondary btn-sm" id="hub-avatar-remove" data-action="manage-remove-hub-avatar" style="${editingHub.avatar_url ? '' : 'display:none;'}color:var(--status-danger);">
                <i class="fas fa-trash"></i> Удалить
              </button>
              <input type="hidden" name="avatar_url" id="hub-avatar-url" value="${escapeHtml(editingHub.avatar_url || '')}">
            </div>
          </div>
        </div>
        <div style="display:flex;gap:10px;margin-top:6px;">
          <button type="submit" class="btn btn-primary" id="hub-form-submit-btn">${editingId === 'new' ? 'Создать хаб' : 'Сохранить'}</button>
          <button type="button" class="btn btn-secondary" data-action="manage-cancel-hub">Отмена</button>
        </div>
      </form>
    ` : '';

    return `
      <div class="alltell-ws-section-header">
        <div>
          <h3 class="alltell-ws-title"><i class="fas fa-layer-group" style="color:var(--blurple)"></i> Игровые хабы (${hubs.length})</h3>
          <p style="margin:4px 0 0;font-size:0.84rem;color:var(--text-muted);">Каждый хаб объединяет сюжетную линию, игровую сессию или ролевой раздел франшизы.</p>
        </div>
        ${canManage && !editingHub ? `
          <button type="button" class="btn btn-primary btn-sm" data-action="manage-create-hub">
            <i class="fas fa-plus"></i> Создать хаб
          </button>
        ` : ''}
      </div>
      ${formHtml}
      ${hubs.length ? `
        <div class="alltell-hub-grid">
          ${hubs.map(function (hub) {
            var isHubActive = hub.status === 'active';
            var isHubPaused = hub.status === 'paused';
            var statusTitle = HUB_STATUSES[hub.status] || hub.status;
            return `
              <article class="alltell-hub-card status-${escapeHtml(hub.status)} ${isHubActive ? 'is-hub-active' : ''}" data-hub-id="${hub.id}" title="Статус хаба: ${escapeHtml(statusTitle)}">
                <div class="alltell-hub-card-header">
                  <div class="alltell-hub-icon">
                    ${hub.avatar_url
                      ? `<img src="${escapeHtml(normalizeImageUrl(hub.avatar_url))}" alt="${escapeHtml(hub.name)}">`
                      : '<i class="fas fa-dice-d20"></i>'}
                  </div>
                  <div class="alltell-hub-title-block">
                    <h3 title="${escapeHtml(hub.name)}">${escapeHtml(hub.name)}</h3>
                  </div>
                  <label class="alltell-hub-pub-check" title="${canManage ? (hub.is_public ? 'Публичный хаб (виден всем). Нажмите, чтобы скрыть' : 'Скрытый хаб (виден только участникам). Нажмите, чтобы опубликовать') : (hub.is_public ? 'Публичный хаб' : 'Скрытый хаб')}">
                    <input type="checkbox" data-action="toggle-hub-public" data-hub-id="${hub.id}" data-franchise-id="${data.franchise.id}" ${hub.is_public ? 'checked' : ''} ${!canManage ? 'disabled' : ''}>
                  </label>
                </div>
                <div class="alltell-hub-card-desc-wrap">
                  <p class="alltell-hub-card-desc ${!hub.description ? 'is-placeholder' : ''}">${escapeHtml((hub.description || '').trim() || 'Описание ролевого хаба пока не добавлено.')}</p>
                  ${hub.description ? `
                    <button type="button" class="alltell-hub-desc-toggle-btn" data-action="open-hub-desc" data-hub-id="${hub.id}">
                      <i class="fas fa-expand"></i> <span>Читать описание</span>
                    </button>
                  ` : ''}
                </div>
                ${hub.description ? `
                  <div class="alltell-hub-desc-modal" data-hub-modal="${hub.id}" hidden>
                    <div class="alltell-hub-modal-header">
                      <div class="alltell-hub-modal-title-row">
                        <div class="alltell-hub-icon" style="width:26px;height:26px;font-size:12px;border-radius:8px;">
                          ${hub.avatar_url ? `<img src="${escapeHtml(normalizeImageUrl(hub.avatar_url))}" alt="">` : '<i class="fas fa-dice-d20"></i>'}
                        </div>
                        <strong>${escapeHtml(hub.name)}</strong>
                      </div>
                      <button type="button" class="alltell-hub-modal-close-btn" data-action="close-hub-desc" data-hub-id="${hub.id}" title="Закрыть">
                        <i class="fas fa-xmark"></i>
                      </button>
                    </div>
                    <div class="alltell-hub-modal-badges">
                      <span class="alltell-hub-status alltell-hub-status-${escapeHtml(hub.status)}">
                        <span class="alltell-status-dot ${isHubActive ? 'active' : (isHubPaused ? 'paused' : '')}"></span>
                        ${escapeHtml(HUB_STATUSES[hub.status] || 'Неизвестно')}
                      </span>
                      <label class="alltell-hub-pub-toggle ${hub.is_public ? 'is-pub' : 'is-priv'}" title="${canManage ? 'Нажмите, чтобы переключить видимость хаба' : ''}">
                        <input type="checkbox" data-action="toggle-hub-public" data-hub-id="${hub.id}" data-franchise-id="${data.franchise.id}" ${hub.is_public ? 'checked' : ''} ${!canManage ? 'disabled' : ''}>
                        <span>${hub.is_public ? 'Публичный' : 'Скрытый'}</span>
                      </label>
                    </div>
                    <div class="alltell-hub-modal-body">${escapeHtml((hub.description || '').trim())}</div>
                    <div class="alltell-hub-modal-footer">
                      <button type="button" class="btn btn-secondary btn-sm" data-action="close-hub-desc" data-hub-id="${hub.id}">
                        <i class="fas fa-compress"></i> <span>Свернуть</span>
                      </button>
                    </div>
                  </div>
                ` : ''}
                <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;display:flex;flex-wrap:wrap;gap:8px;">
                  <span>Создан: ${dateLabel(hub.created_at)}</span>
                  ${hub.created_by_name ? `<span>Автор: ${escapeHtml(hub.created_by_name)}</span>` : ''}
                </div>
                ${canManage ? `
                  <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding-top:10px;border-top:1px solid var(--background-accent);margin-top:auto;">
                    <select class="alltell-select" data-action="manage-change-hub-status" data-hub-id="${hub.id}" style="font-size:0.8rem;padding:5px 8px;">
                      <option value="active" ${hub.status === 'active' ? 'selected' : ''}>Ведётся</option>
                      <option value="paused" ${hub.status === 'paused' ? 'selected' : ''}>Приостановлено</option>
                      <option value="finished" ${hub.status === 'finished' ? 'selected' : ''}>Завершено</option>
                    </select>
                    <div class="alltell-table-actions">
                      <button type="button" class="btn btn-secondary btn-sm" data-action="manage-edit-hub" data-hub-id="${hub.id}" title="Редактировать"><i class="fas fa-pen"></i></button>
                      <button type="button" class="btn btn-danger btn-sm" data-action="manage-delete-hub" data-hub-id="${hub.id}" data-hub-name="${escapeHtml(hub.name)}" title="Удалить"><i class="fas fa-trash"></i></button>
                    </div>
                  </div>
                ` : ''}
              </article>
            `;
          }).join('')}
        </div>
      ` : (!editingHub ? `
        <div class="alltell-state alltell-state-empty">
          <div class="alltell-empty-icon"><i class="fas fa-layer-group"></i></div>
          <h3>Хабов пока нет</h3>
          <p>Создайте первый игровой хаб для этой вселенной!</p>
          ${canManage ? `<button type="button" class="btn btn-primary" data-action="manage-create-hub"><i class="fas fa-plus"></i> Создать первый хаб</button>` : ''}
        </div>
      ` : '')}
    `;
  }

  function renderWorkspaceMapsTab(state, data, canManage, isOwner, isRoot) {
    var maps = state.workspaceData.maps || [];
    var world = state.workspaceData.world;
    var calendar = (world && world.calendar) || null;
    return `
      <div class="alltell-ws-section-header">
        <div>
          <h3 class="alltell-ws-title"><i class="fas fa-map" style="color:var(--blurple)"></i> Интерактивные карты (${maps.length})</h3>
          <p style="margin:4px 0 0;font-size:0.84rem;color:var(--text-muted);">Карты материков, планет и локаций, привязанные к этому миру.</p>
        </div>
        ${canManage ? `
          <button type="button" class="btn btn-primary btn-sm" data-action="manage-toggle-create-map">
            <i class="fas fa-plus"></i> Создать карту
          </button>
        ` : ''}
      </div>

      <div id="alltell-create-map-box" class="alltell-hub-edit-form" ${state.showCreateMap ? '' : 'hidden'}>
        <h4><i class="fas fa-plus"></i> Новая карта мира</h4>
        <div class="alltell-field">
          <label class="alltell-field-label">Название карты <span style="color:#f23f43">*</span></label>
          <input id="new-map-title-input" type="text" maxlength="120" placeholder="Например: Континент Эйра">
        </div>
        <div style="display:flex;gap:10px;">
          <button type="button" class="btn btn-primary" data-action="manage-save-map">Создать</button>
          <button type="button" class="btn btn-secondary" data-action="manage-toggle-create-map">Отмена</button>
        </div>
      </div>

      ${maps.length ? `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin-bottom:28px;">
          ${maps.map(function (m) {
            return `
              <div style="background:var(--background-tertiary);border:1px solid var(--background-accent);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;">
                <div style="display:flex;align-items:center;gap:10px;">
                  <div style="width:38px;height:38px;border-radius:10px;background:rgba(88,101,242,0.15);color:var(--blurple);display:flex;align-items:center;justify-content:center;font-size:18px;">
                    <i class="fas fa-map-location-dot"></i>
                  </div>
                  <div>
                    <h4 style="margin:0;font-size:0.95rem;color:var(--text-normal);">${escapeHtml(m.title)}</h4>
                    <span style="font-size:11px;color:var(--text-muted);">${m.zoneCount || 0} зон · ${m.basemapCount || 0} слоёв</span>
                  </div>
                </div>
                <div style="margin-top:auto;display:flex;gap:8px;padding-top:10px;border-top:1px solid var(--background-accent);">
                  <a class="btn btn-secondary btn-sm" href="/map/${m.id}" target="_blank" style="flex:1;justify-content:center;"><i class="fas fa-eye"></i> Открыть</a>
                  ${m.can_edit ? `<a class="btn btn-secondary btn-sm" href="/map/${m.id}/edit" target="_blank" title="Редактор"><i class="fas fa-pen"></i></a>` : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      ` : `
        <div class="alltell-state alltell-state-empty" style="margin-bottom:24px;">
          <div class="alltell-empty-icon"><i class="fas fa-map"></i></div>
          <h3>В этом мире пока нет карт</h3>
          <p>Создайте интерактивную карту для визуализации локаций и привязки статей.</p>
        </div>
      `}

      <div style="border-top:1px solid var(--background-accent);padding-top:20px;">
        <h4 style="margin:0 0 8px;font-size:1rem;color:var(--text-normal);display:flex;align-items:center;gap:8px;">
          <i class="fas fa-calendar-days" style="color:var(--blurple)"></i> Календарь мира
        </h4>
        <p style="margin:0 0 14px;font-size:0.84rem;color:var(--text-muted);">
          Календарь определяет счёт лет, месяцев и дней внутри этого ролевого мира.
        </p>
        ${calendar ? `
          <div style="background:var(--background-tertiary);border:1px solid var(--background-accent);border-radius:10px;padding:14px;font-size:0.88rem;color:var(--text-normal);">
            <div><strong>Эпоха / Название:</strong> ${escapeHtml(calendar.name || calendar.epoch || 'Стандартный')}</div>
            <div style="margin-top:4px;color:var(--text-muted);font-size:0.82rem;">Месяцев: ${calendar.months ? calendar.months.length : '12'} · Дней в неделе: ${calendar.daysInWeek || '7'}</div>
          </div>
        ` : `
          <div style="background:var(--background-tertiary);border:1px solid var(--background-accent);border-radius:10px;padding:14px;font-size:0.86rem;color:var(--text-muted);">
            Используется стандартный календарь вселенной AllTell.
          </div>
        `}
      </div>
    `;
  }

  function renderWorkspaceLogTab(state, data, canManage, isOwner, isRoot) {
    var logs = state.workspaceData.auditLog || [];
    return `
      <div class="alltell-ws-section-header">
        <div>
          <h3 class="alltell-ws-title"><i class="fas fa-clock-rotate-left" style="color:var(--blurple)"></i> Журнал действий (${logs.length})</h3>
          <p style="margin:4px 0 0;font-size:0.84rem;color:var(--text-muted);">История изменений ролей, хабов, участников и настроек этой франшизы.</p>
        </div>
      </div>
      <div class="alltell-table-wrap">
        <table class="alltell-table">
          <thead>
            <tr>
              <th>Когда</th>
              <th>Кто</th>
              <th>Действие</th>
            </tr>
          </thead>
          <tbody>
            ${logs.length ? logs.map(function (item) {
              return `
                <tr>
                  <td style="color:var(--text-muted);font-size:12px;white-space:nowrap;">${dateLabel(item.created_at)}</td>
                  <td><strong>${escapeHtml(item.actor_username || ('ID ' + item.actor_id))}</strong></td>
                  <td>${escapeHtml(auditActionLabel(item.action))} <span style="color:var(--text-muted);">${escapeHtml(auditDetailsText(item.action, item.details))}</span></td>
                </tr>
              `;
            }).join('') : '<tr class="alltell-table-empty"><td colspan="3">Журнал пока пуст — действия над франшизой отобразятся здесь</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderWorkspaceSettingsTab(state, data, canManage, isOwner, isRoot) {
    var franchise = data.franchise;
    var canEdit = isOwner || isRoot;
    return `
      ${!canEdit ? '<div class="alltell-permission-note"><i class="fas fa-circle-info"></i> Изменять настройки и название франшизы может только её владелец.</div>' : ''}
      <form data-settings-form style="display:flex;flex-direction:column;gap:18px;">
        <div class="alltell-field">
          <label class="alltell-field-label" for="settings-name-input">Название франшизы <span style="color:#f23f43">*</span></label>
          <input id="settings-name-input" type="text" name="name" maxlength="100" required value="${escapeHtml(franchise.name || '')}" ${canEdit ? '' : 'disabled'}>
        </div>
        <div class="alltell-field">
          <label class="alltell-field-label" for="settings-desc-input">Описание</label>
          <textarea id="settings-desc-input" name="description" rows="3" maxlength="500" ${canEdit ? '' : 'disabled'}>${escapeHtml(franchise.description || '')}</textarea>
        </div>
        <div class="alltell-field">
          <label class="alltell-field-label">Аватарка франшизы</label>
          <div style="display:flex;align-items:center;gap:16px;">
            <div id="settings-avatar-preview" style="width:64px;height:64px;border-radius:18px;background:${franchiseGradient(franchise.id, franchise.name)};display:grid;place-items:center;font-size:22px;font-weight:800;color:#fff;overflow:hidden;flex-shrink:0;box-shadow:0 4px 12px rgba(0,0,0,0.3);">
              ${franchise.avatar_url ? `<img src="${escapeHtml(normalizeImageUrl(franchise.avatar_url))}" style="width:100%;height:100%;object-fit:cover;" alt="">` : escapeHtml(initials(franchise.name))}
            </div>
            ${canEdit ? `
              <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
                <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0;">
                  <i class="fas fa-camera"></i> <span id="settings-avatar-label">${franchise.avatar_url ? 'Сменить аватарку' : 'Загрузить аватарку'}</span>
                  <input type="file" id="settings-avatar-file" accept="image/jpeg,image/png,image/gif,image/webp" hidden>
                </label>
                <button type="button" class="btn btn-secondary btn-sm" id="settings-avatar-remove" data-action="manage-remove-settings-avatar" style="${franchise.avatar_url ? '' : 'display:none;'}color:var(--status-danger);">
                  <i class="fas fa-trash"></i> Удалить
                </button>
                <input type="hidden" name="avatar_url" id="settings-avatar-url" value="${escapeHtml(franchise.avatar_url || '')}">
              </div>
            ` : ''}
          </div>
        </div>
        ${canEdit ? `
          <div>
            <button type="submit" class="btn btn-primary" id="save-settings-btn"><i class="fas fa-floppy-disk"></i> Сохранить изменения</button>
          </div>
        ` : ''}
      </form>

      ${isRoot ? `
        <div style="margin-top:28px;padding-top:20px;border-top:1px solid var(--background-accent);">
          <h4 style="margin:0 0 6px;font-size:0.95rem;color:var(--text-normal);"><i class="fas fa-shield-halved" style="color:var(--blurple)"></i> Владение франшизой</h4>
          <p style="margin:0 0 12px;font-size:0.84rem;color:var(--text-muted);">Доступно владельцу системы (root). Вы можете передать права владельца другому подтверждённому пользователю.</p>
          <button type="button" class="btn btn-secondary btn-sm" data-action="manage-open-change-owner"><i class="fas fa-user-shield"></i> Передать другому пользователю</button>
        </div>
      ` : ''}

      ${canEdit ? `
        <div class="alltell-danger-box">
          <h4>Опасная зона</h4>
          <p>Удаление франшизы безвозвратно сотрёт все связанные с ней хабы, роли, каналы, участников и публикации. Это действие нельзя отменить.</p>
          <button type="button" class="btn btn-danger" data-action="manage-delete-franchise"><i class="fas fa-trash"></i> Удалить франшизу</button>
        </div>
      ` : ''}
    `;
  }

  function renderFranchiseWorkspace(state, data, canManage, isOwner, isRoot) {
    var wsTab = state.workspaceTab || 'overview';
    var membersCount = (state.workspaceData.members || []).length;
    var rolesCount = (state.workspaceData.roles || []).length;
    var channelsCount = (state.workspaceData.channels || []).length;
    var hubsCount = (state.workspaceData.hubs || data.hubs || []).length;
    var mapsCount = (state.workspaceData.maps || []).length;

    return `
      <section class="alltell-workspace">
        <div class="alltell-workspace-nav" role="tablist">
          <button type="button" class="alltell-ws-tab-btn ${wsTab === 'overview' ? 'active' : ''}" data-action="switch-ws-tab" data-ws-tab="overview">
            <i class="fas fa-chart-pie"></i> Обзор
          </button>
          <button type="button" class="alltell-ws-tab-btn ${wsTab === 'members' ? 'active' : ''}" data-action="switch-ws-tab" data-ws-tab="members">
            <i class="fas fa-users"></i> Участники <span class="alltell-ws-tab-badge">${membersCount}</span>
          </button>
          <button type="button" class="alltell-ws-tab-btn ${wsTab === 'roles' ? 'active' : ''}" data-action="switch-ws-tab" data-ws-tab="roles">
            <i class="fas fa-user-shield"></i> Роли <span class="alltell-ws-tab-badge">${rolesCount}</span>
          </button>
          <button type="button" class="alltell-ws-tab-btn ${wsTab === 'channels' ? 'active' : ''}" data-action="switch-ws-tab" data-ws-tab="channels">
            <i class="fas fa-hashtag"></i> Каналы <span class="alltell-ws-tab-badge">${channelsCount}</span>
          </button>
          <button type="button" class="alltell-ws-tab-btn ${wsTab === 'hubs' ? 'active' : ''}" data-action="switch-ws-tab" data-ws-tab="hubs">
            <i class="fas fa-layer-group"></i> Хабы <span class="alltell-ws-tab-badge">${hubsCount}</span>
          </button>
          <button type="button" class="alltell-ws-tab-btn ${wsTab === 'maps' ? 'active' : ''}" data-action="switch-ws-tab" data-ws-tab="maps">
            <i class="fas fa-map"></i> Карты <span class="alltell-ws-tab-badge">${mapsCount}</span>
          </button>
          <button type="button" class="alltell-ws-tab-btn ${wsTab === 'log' ? 'active' : ''}" data-action="switch-ws-tab" data-ws-tab="log">
            <i class="fas fa-clock-rotate-left"></i> Журнал
          </button>
          <button type="button" class="alltell-ws-tab-btn ${wsTab === 'settings' ? 'active' : ''}" data-action="switch-ws-tab" data-ws-tab="settings">
            <i class="fas fa-gear"></i> Настройки
          </button>
        </div>

        <div class="alltell-workspace-body">
          ${wsTab === 'overview' ? renderWorkspaceOverviewTab(state, data, canManage, isOwner, isRoot) : ''}
          ${wsTab === 'members' ? renderWorkspaceMembersTab(state, data, canManage, isOwner, isRoot) : ''}
          ${wsTab === 'roles' ? renderWorkspaceRolesTab(state, data, canManage, isOwner, isRoot) : ''}
          ${wsTab === 'channels' ? renderWorkspaceChannelsTab(state, data, canManage, isOwner, isRoot) : ''}
          ${wsTab === 'hubs' ? renderWorkspaceHubsTab(state, data, canManage, isOwner, isRoot) : ''}
          ${wsTab === 'maps' ? renderWorkspaceMapsTab(state, data, canManage, isOwner, isRoot) : ''}
          ${wsTab === 'log' ? renderWorkspaceLogTab(state, data, canManage, isOwner, isRoot) : ''}
          ${wsTab === 'settings' ? renderWorkspaceSettingsTab(state, data, canManage, isOwner, isRoot) : ''}
        </div>
      </section>
    `;
  }

  function renderDetail(root, state) {
    var data = state.detail;
    var franchise = data.franchise;
    var member = data.is_member;
    var canManage = data.can_manage;
    var isOwner = data.is_owner;
    var currentUser = window.authManager && window.authManager.getUser();
    var userId = currentUser && currentUser.id;
    var isRoot = !!(currentUser && currentUser.is_root);
    var hubMap = new Map(data.hubs.map(function (hub) { return [String(hub.id), hub]; }));
    var posts = data.posts.filter(function (post) { return post.approval_status === 'published'; });
    var suggestions = data.posts.filter(function (post) { return post.approval_status !== 'published'; });
    var gradient = franchiseGradient(franchise.id, franchise.name);
    var activeTab = state.detailTab || 'all';

    root.innerHTML = `
      <div class="alltell-detail-view">
        <div class="alltell-detail-navigation">
          <a class="alltell-back-link" href="/alltell?view=catalog">
            <i class="fas fa-arrow-left" aria-hidden="true"></i>
            <span>Каталог франшиз</span>
          </a>
          <nav class="alltell-view-tabs alltell-view-tabs--compact" aria-label="Быстрый переход">
            <button type="button" data-action="switch-view" data-view="feed" class="alltell-tab-btn"><i class="fas fa-rss"></i> Лента</button>
            <button type="button" data-action="switch-view" data-view="catalog" class="alltell-tab-btn"><i class="fas fa-compass"></i> Каталог</button>
          </nav>
        </div>

        ${state.error ? `<div class="alltell-state alltell-error" role="alert"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(state.error)}</div>` : ''}

        <header class="alltell-franchise-hero">
          <div class="alltell-franchise-cover" style="background: ${gradient}">
            <div class="alltell-cover-pattern" aria-hidden="true"></div>
          </div>
          <div class="alltell-franchise-header-body">
            <div class="alltell-franchise-avatar-wrap">
              <div class="alltell-franchise-avatar" style="background: ${gradient}">
                ${franchise.avatar_url
                  ? `<img src="${escapeHtml(normalizeImageUrl(franchise.avatar_url))}" alt="${escapeHtml(franchise.name)}">`
                  : escapeHtml(initials(franchise.name))}
              </div>
            </div>
            <div class="alltell-franchise-meta">
              <div class="alltell-franchise-title-row">
                <h2>${escapeHtml(franchise.name)}</h2>
                ${isOwner ? '<span class="alltell-owner-pill"><i class="fas fa-crown"></i> Создатель</span>' : ''}
              </div>
              ${franchise.description ? `<p class="alltell-franchise-desc">${escapeHtml(franchise.description)}</p>` : ''}
              <div class="alltell-franchise-stats">
                <span class="alltell-stat-chip"><i class="fas fa-users"></i> <strong>${Number(franchise.member_count || (state.workspaceData.members && state.workspaceData.members.length) || 0)}</strong> участников</span>
                <span class="alltell-stat-chip"><i class="fas fa-layer-group"></i> <strong>${data.hubs.length}</strong> хабов</span>
                <span class="alltell-stat-chip"><i class="fas fa-newspaper"></i> <strong>${posts.length}</strong> публикаций</span>
              </div>
            </div>
            <div class="alltell-franchise-actions">
              ${(canManage || isOwner) ? `
                <button class="btn ${activeTab === 'manage' ? 'btn-primary' : 'btn-secondary'} alltell-manage-toggle-btn" type="button" data-action="toggle-manage">
                  <i class="fas ${activeTab === 'manage' ? 'fa-arrow-left' : 'fa-sliders'}"></i> ${activeTab === 'manage' ? 'К витрине' : 'Управление'}
                </button>
              ` : ''}
              ${isOwner
                ? '<span class="alltell-card-owner-pill"><i class="fas fa-crown"></i> Создатель</span>'
                : (member
                  ? '<button class="btn btn-secondary alltell-join-btn is-member" type="button" data-action="leave"><i class="fas fa-check"></i> Вы подписаны</button>'
                  : `<button class="btn btn-primary alltell-join-btn" type="button" data-action="${token() ? 'join' : 'login'}"><i class="fas fa-user-plus"></i> ${token() ? 'Подписаться' : 'Войти, чтобы подписаться'}</button>`)}
            </div>
          </div>
        </header>

        <div class="alltell-detail-subnav-container">
          <nav class="alltell-detail-subnav" aria-label="Вкладки франшизы">
            <button class="alltell-subnav-btn ${activeTab === 'all' ? 'active' : ''}" type="button" data-action="switch-detail-tab" data-detail-tab="all">
              <i class="fas fa-border-all"></i> Всё
            </button>
            <button class="alltell-subnav-btn ${activeTab === 'posts' ? 'active' : ''}" type="button" data-action="switch-detail-tab" data-detail-tab="posts">
              <i class="fas fa-bullhorn"></i> Публикации <span class="alltell-count-badge">${posts.length}</span>
            </button>
            <button class="alltell-subnav-btn ${activeTab === 'hubs' ? 'active' : ''}" type="button" data-action="switch-detail-tab" data-detail-tab="hubs">
              <i class="fas fa-layer-group"></i> Хабы и игры <span class="alltell-count-badge">${data.hubs.length}</span>
            </button>
            <button class="alltell-subnav-btn ${activeTab === 'members' ? 'active' : ''}" type="button" data-action="switch-detail-tab" data-detail-tab="members">
              <i class="fas fa-users"></i> Участники <span class="alltell-count-badge">${Number(franchise.member_count || (state.workspaceData.members && state.workspaceData.members.length) || 0)}</span>
            </button>
            ${(canManage || isOwner) ? `
              <button class="alltell-subnav-btn ${activeTab === 'manage' ? 'active' : ''}" type="button" data-action="switch-detail-tab" data-detail-tab="manage">
                <i class="fas fa-sliders"></i> Управление
              </button>
            ` : ''}
          </nav>
        </div>

        <div class="alltell-detail-content">
          ${activeTab === 'manage' ? renderFranchiseWorkspace(state, data, canManage, isOwner, isRoot) : ''}
          ${activeTab === 'members' ? renderMembersView(state, data, canManage, isOwner, isRoot) : ''}

          ${(activeTab === 'all' || activeTab === 'hubs') && data.hubs.length ? `
            <section class="alltell-live-section alltell-detail-hubs">
              <div class="alltell-live-section-heading">
                <div class="alltell-heading-title">
                  <h2><i class="fas fa-layer-group" aria-hidden="true"></i> Игровые хабы</h2>
                  <span>Серверы и ролевые пространства этой вселенной</span>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                  <span class="alltell-section-count">${data.hubs.length}</span>
                  ${canManage ? `
                    <button class="btn btn-primary btn-sm" type="button" data-action="manage-create-hub">
                      <i class="fas fa-plus"></i> Создать хаб
                    </button>
                  ` : ''}
                </div>
              </div>
              <div class="alltell-hub-grid">
                ${data.hubs.map(function (hub) {
                  var isHubActive = hub.status === 'active';
                  var isHubPaused = hub.status === 'paused';
                  var statusTitle = HUB_STATUSES[hub.status] || hub.status;
                  return `
                    <article class="alltell-hub-card status-${escapeHtml(hub.status)} ${isHubActive ? 'is-hub-active' : ''}" data-hub-id="${hub.id}" title="Статус хаба: ${escapeHtml(statusTitle)}">
                      <div class="alltell-hub-card-header">
                        <div class="alltell-hub-icon">
                          ${hub.avatar_url
                            ? `<img src="${escapeHtml(normalizeImageUrl(hub.avatar_url))}" alt="${escapeHtml(hub.name)}">`
                            : '<i class="fas fa-dice-d20"></i>'}
                        </div>
                        <div class="alltell-hub-title-block">
                          <h3 title="${escapeHtml(hub.name)}">${escapeHtml(hub.name)}</h3>
                        </div>
                        <label class="alltell-hub-pub-check" title="${canManage ? (hub.is_public ? 'Публичный хаб (виден всем). Нажмите, чтобы скрыть' : 'Скрытый хаб (виден только участникам). Нажмите, чтобы опубликовать') : (hub.is_public ? 'Публичный хаб' : 'Скрытый хаб')}">
                          <input type="checkbox" data-action="toggle-hub-public" data-hub-id="${hub.id}" data-franchise-id="${data.franchise.id}" ${hub.is_public ? 'checked' : ''} ${!canManage ? 'disabled' : ''}>
                        </label>
                      </div>
                      <div class="alltell-hub-card-desc-wrap">
                        <p class="alltell-hub-card-desc ${!hub.description ? 'is-placeholder' : ''}">${escapeHtml((hub.description || '').trim() || 'Описание ролевого хаба пока не добавлено.')}</p>
                        ${hub.description ? `
                          <button type="button" class="alltell-hub-desc-toggle-btn" data-action="open-hub-desc" data-hub-id="${hub.id}">
                            <i class="fas fa-expand"></i> <span>Читать описание</span>
                          </button>
                        ` : ''}
                      </div>
                      ${hub.description ? `
                        <div class="alltell-hub-desc-modal" data-hub-modal="${hub.id}" hidden>
                          <div class="alltell-hub-modal-header">
                            <div class="alltell-hub-modal-title-row">
                              <div class="alltell-hub-icon" style="width:26px;height:26px;font-size:12px;border-radius:8px;">
                                ${hub.avatar_url ? `<img src="${escapeHtml(normalizeImageUrl(hub.avatar_url))}" alt="">` : '<i class="fas fa-dice-d20"></i>'}
                              </div>
                              <strong>${escapeHtml(hub.name)}</strong>
                            </div>
                            <button type="button" class="alltell-hub-modal-close-btn" data-action="close-hub-desc" data-hub-id="${hub.id}" title="Закрыть">
                              <i class="fas fa-xmark"></i>
                            </button>
                          </div>
                          <div class="alltell-hub-modal-badges">
                            <span class="alltell-hub-status alltell-hub-status-${escapeHtml(hub.status)}">
                              <span class="alltell-status-dot ${isHubActive ? 'active' : (isHubPaused ? 'paused' : '')}"></span>
                              ${escapeHtml(HUB_STATUSES[hub.status] || 'Неизвестно')}
                            </span>
                            ${canManage ? `
                              <label class="alltell-hub-pub-toggle ${hub.is_public ? 'is-pub' : 'is-priv'}" title="Нажмите, чтобы переключить видимость хаба">
                                <input type="checkbox" data-action="toggle-hub-public" data-hub-id="${hub.id}" data-franchise-id="${data.franchise.id}" ${hub.is_public ? 'checked' : ''}>
                                <span>${hub.is_public ? 'Публичный' : 'Скрытый'}</span>
                              </label>
                            ` : (hub.is_public ? `
                              <span class="alltell-hub-pub-toggle is-pub" style="cursor:default;"><i class="fas fa-globe" style="font-size:10px;"></i> Публичный</span>
                            ` : `
                              <span class="alltell-hub-pub-toggle is-priv" style="cursor:default;"><i class="fas fa-lock" style="font-size:10px;"></i> Скрытый</span>
                            `)}
                          </div>
                          <div class="alltell-hub-modal-body">${escapeHtml((hub.description || '').trim())}</div>
                          <div class="alltell-hub-modal-footer">
                            <button type="button" class="btn btn-secondary btn-sm" data-action="close-hub-desc" data-hub-id="${hub.id}">
                              <i class="fas fa-compress"></i> <span>Свернуть</span>
                            </button>
                          </div>
                        </div>
                      ` : ''}
                      <div class="alltell-hub-card-foot">
                        <span class="alltell-hub-tag"><i class="fas fa-server"></i> Хаб франшизы</span>
                        ${canManage ? `
                          <button class="btn btn-secondary btn-sm" type="button" data-action="switch-detail-tab" data-detail-tab="manage" style="margin-left:auto;padding:3px 8px;font-size:0.75rem;">
                            Управление
                          </button>
                        ` : ''}
                      </div>
                    </article>
                  `;
                }).join('')}
              </div>
            </section>
          ` : (activeTab === 'hubs' && !data.hubs.length ? `
            <div class="alltell-state alltell-state-empty">
              <div class="alltell-empty-icon"><i class="fas fa-layer-group"></i></div>
              <h3>В этой франшизе пока нет хабов</h3>
              <p>Создатель ещё не добавил ролевые серверы или игровые пространства.</p>
              ${canManage ? `
                <div class="alltell-empty-actions">
                  <button class="btn btn-primary" type="button" data-action="manage-create-hub">
                    <i class="fas fa-plus"></i> Создать первый хаб
                  </button>
                </div>
              ` : ''}
            </div>
          ` : '')}

          ${activeTab === 'all' || activeTab === 'posts' ? `
            <section class="alltell-live-section alltell-feed-section">
              <div class="alltell-live-section-heading alltell-detail-feed-heading">
                <div class="alltell-heading-title">
                  <h2><i class="fas fa-bullhorn" aria-hidden="true"></i> Публикации франшизы</h2>
                  <span>${posts.length} ${posts.length === 1 ? 'публикация' : (posts.length >= 2 && posts.length <= 4 ? 'публикации' : 'публикаций')}</span>
                </div>
                ${(canManage || token())
                  ? (state.showPostForm ? '' : `
                    <button class="btn btn-primary btn-sm alltell-new-post-btn" type="button" data-action="toggle-post-form" aria-expanded="false">
                      <i class="fas fa-plus" aria-hidden="true"></i>
                      <span>${canManage ? 'Создать публикацию' : 'Предложить публикацию'}</span>
                    </button>
                  `)
                  : '<button class="btn btn-secondary btn-sm" type="button" data-action="login"><i class="fas fa-right-to-bracket"></i> Войти, чтобы предложить запись</button>'}
              </div>

              ${state.showPostForm && (canManage || token()) ? renderPostForm(state, data.hubs, canManage) : ''}

              ${suggestions.length ? `
                <div class="alltell-suggestions-panel">
                  <div class="alltell-suggestions-heading">
                    <h3><i class="fas fa-clock-rotate-left"></i> ${canManage ? 'Предложения на модерации' : 'Мои предложения'}</h3>
                    <span class="alltell-badge-warning">${canManage
                      ? suggestions.filter(function (post) { return post.approval_status === 'pending'; }).length + ' ожидают решения'
                      : suggestions.length + ' отправлено'}</span>
                  </div>
                  <div class="alltell-post-list">
                    ${suggestions.map(function (post) { return renderPost(post, hubMap, canManage, null, userId, !!token(), franchise.id); }).join('')}
                  </div>
                </div>
              ` : ''}

              ${posts.length ? `
                <div class="alltell-post-list">
                  ${posts.map(function (post) {
                    var postSocial = state.postSocial[postSocialKey(franchise.id, post.id)];
                    return renderPost(post, hubMap, canManage, postSocial, userId, !!token(), franchise.id);
                  }).join('')}
                </div>
              ` : `
                <div class="alltell-state alltell-state-empty">
                  <div class="alltell-empty-icon"><i class="fas fa-comment-dots" aria-hidden="true"></i></div>
                  <h3>Публикаций пока нет</h3>
                  <p>Будьте первым, кто расскажет о событиях или новостях этой вселенной!</p>
                  ${(canManage || token()) && !state.showPostForm ? `
                    <div class="alltell-empty-actions">
                      <button class="btn btn-primary" type="button" data-action="toggle-post-form">
                        <i class="fas fa-plus"></i> ${canManage ? 'Создать первую публикацию' : 'Предложить публикацию'}
                      </button>
                    </div>
                  ` : ''}
                </div>
              `}
            </section>
          ` : ''}
        </div>
      </div>
    `;
    root.querySelectorAll('textarea[data-autogrow]').forEach(function (ta) {
      ta.style.height = 'auto';
      ta.style.overflow = 'hidden';
      ta.style.height = Math.max(140, ta.scrollHeight) + 'px';
    });
    var postBlocksContainer = root.querySelector('#postBlocksContent');
    if (postBlocksContainer) {
      if (!state.postBlocks || !state.postBlocks.length) {
        state.postBlocks = parsePostBlocks(state.editingPost ? state.editingPost.body : '');
      }
      renderPostBlocksList(postBlocksContainer, state);
      syncPostEditorState(state);
    }
    var toolbarScroll = root.querySelector('[data-alltell-toolbar-scroll]');
    if (toolbarScroll) updatePostToolbarFade(toolbarScroll);
  }

  async function init() {
    var root = document.getElementById('alltell-app');
    if (!root) return null;
    var main = root.closest('.site-main');
    var section = root.closest('section');
    if (main && section) main.replaceChildren(section);
    var state = {
      franchises: null,
      mine: [],
      detail: null,
      detailTab: new URLSearchParams(window.location.search).get('tab') || 'all',
      feedFilter: 'all',
      catalogFilter: 'all',
      catalogHubFilter: 'all',
      catalogSort: 'created_desc',
      expandedHubs: new Set(),
      expandedCardKey: null,
      hubPreviewCache: new Map(),
      workspaceTab: new URLSearchParams(window.location.search).get('wstab') || 'overview',
      workspaceData: {
        members: [],
        roles: [],
        channels: [],
        hubs: [],
        maps: [],
        world: null,
        auditLog: []
      },
      workspaceLoading: false,
      editingHubId: null,
      showCreateMap: false,
      view: new URLSearchParams(window.location.search).get('view') === 'catalog' ? 'catalog' : 'feed',
      feedPosts: [],
      followedCount: 0,
      editingPost: null,
      showPostForm: false,
      postBlocks: null,
      _activePostBlockId: null,
      _activePostTextarea: null,
      _pendingFocusBlockId: null,
      _pendingFocusAtEnd: false,
      postSocial: {},
      stickerPacks: null,
      favoriteStickers: null,
      postImages: [],
      postArticles: [],
      uploadingImages: false,
      submittingPost: false,
      draggedImageIndex: null,
      articleIndex: [],
      articleIndexError: '',
      loading: true,
      error: '',
      mineError: '',
      query: '',
      disposed: false,
      toastTimer: null
    };

    function showToast(message) {
      if (typeof window.showMessage === 'function') {
        window.showMessage(message, 'success');
        return;
      }
      var previous = document.querySelector('.alltell-toast');
      if (previous) previous.remove();
      var toast = document.createElement('div');
      toast.className = 'alltell-toast';
      toast.setAttribute('role', 'status');
      toast.textContent = message;
      document.body.appendChild(toast);
      window.clearTimeout(state.toastTimer);
      state.toastTimer = window.setTimeout(function () { toast.remove(); }, 3600);
    }

    function releasePostImages() {
      state.postImages.forEach(function (image) {
        if (image.preview && image.preview.startsWith('blob:')) URL.revokeObjectURL(image.preview);
      });
      state.postImages = [];
      state.uploadingImages = false;
      state.submittingPost = false;
    }

    function setPostImages(post) {
      releasePostImages();
      var images = Array.isArray(post && post.images) && post.images.length
        ? post.images
        : (post && post.image_url ? [post.image_url] : []);
      state.postImages = images.map(function (url) {
        return { url: url, preview: url, file: null, uploading: false, error: null };
      });
    }

    function setPostArticles(post) {
      if (post && Array.isArray(post.articles) && post.articles.length) {
        state.postArticles = post.articles.map(function (art) {
          return {
            slug: art.slug,
            title: art.title || art.slug,
            is_public: art.is_public !== false
          };
        });
      } else if (post && post.article) {
        state.postArticles = [{
          slug: post.article.slug,
          title: post.article.title || post.article.slug,
          is_public: post.article.is_public !== false
        }];
      } else {
        state.postArticles = [];
      }
    }

    function updateArticlePickerUI(form) {
      if (!form) return;
      var selectedContainer = form.querySelector('[data-selected-articles]');
      if (selectedContainer) {
        selectedContainer.innerHTML = renderSelectedArticleChips(state.postArticles || []);
      }
      var countEl = form.querySelector('[data-article-count]');
      if (countEl) {
        var count = (state.postArticles || []).length;
        countEl.textContent = count ? count + ' выбрано' : 'Не выбрано';
      }
      var searchInput = form.querySelector('[data-article-search]');
      if (searchInput) {
        searchInput.placeholder = (state.postArticles || []).length ? 'Добавить ещё статью…' : 'Поиск статьи по названию…';
      }
      var options = form.querySelector('[data-article-options]');
      if (options) {
        if (!options.hidden && searchInput && searchInput.value.trim()) {
          renderArticleOptions(searchInput);
        } else if (searchInput && !searchInput.value.trim()) {
          options.hidden = true;
          options.replaceChildren();
        }
      }
    }

    function renderPostImageQueue() {
      var form = root.querySelector('[data-post-form]');
      if (!form) return;
      var grid = form.querySelector('[data-post-image-grid]');
      if (grid) {
        grid.innerHTML = renderPostImageItems(state.postImages, state.uploadingImages);
      }
      var badge = form.querySelector('[data-image-selection]');
      if (badge) {
        var total = state.postImages.length;
        var uploaded = state.postImages.filter(function (img) { return img.url && !img.file; }).length;
        var uploading = state.postImages.filter(function (img) { return img.uploading; }).length;
        var errors = state.postImages.filter(function (img) { return img.error; }).length;

        if (uploading > 0) {
          badge.textContent = 'Загрузка: ' + uploaded + ' / ' + total;
        } else if (errors > 0) {
          badge.textContent = errors + ' с ошибкой · нажмите чтобы удалить';
        } else if (total > 0 && uploaded === total) {
          badge.textContent = total + ' загружено на сервер';
        } else if (total > 0) {
          badge.textContent = total + ' изображений';
        } else {
          badge.textContent = 'Перетащите или выберите';
        }
      }
      syncPostEditorState(state);
    }

    async function uploadPendingPostImages() {
      if (state.uploadingImages) return;
      var pending = state.postImages.filter(function (img) { return img.file && !img.url && !img.uploading; });
      if (!pending.length) return;

      state.uploadingImages = true;
      var total = pending.length;
      var done = 0;
      pending.forEach(function (img) {
        img.uploading = true;
        img.error = null;
      });
      renderPostImageQueue();
      updateImageProgress(done, total);

      for (var i = 0; i < pending.length; i += IMAGE_UPLOAD_CHUNK) {
        var chunk = pending.slice(i, i + IMAGE_UPLOAD_CHUNK);
        var formData = new FormData();
        chunk.forEach(function (img) { formData.append('images', img.file); });

        try {
          var uploadResponse = await fetch('/api/upload-images', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token() },
            credentials: 'same-origin',
            body: formData
          });
          var uploadResult = {};
          try { uploadResult = await uploadResponse.json(); } catch (e) {}
          if (!uploadResponse.ok || !Array.isArray(uploadResult.urls) || uploadResult.urls.length !== chunk.length) {
            throw new Error(uploadResult.error || 'Не удалось загрузить изображения');
          }
          chunk.forEach(function (image, index) {
            image.url = uploadResult.urls[index];
            image.file = null;
            image.uploading = false;
            image.error = null;
            if (image.preview && image.preview.startsWith('blob:')) {
              URL.revokeObjectURL(image.preview);
            }
            image.preview = image.url;
            done++;
          });
          updateImageProgress(done, total);
        } catch (err) {
          chunk.forEach(function (image) {
            image.uploading = false;
            image.error = err.message || 'Ошибка загрузки';
          });
          notifyError('Ошибка загрузки изображений: ' + (err.message || 'Сбой сети'));
        }
        renderPostImageQueue();
      }
      state.uploadingImages = false;
      renderPostImageQueue();
      var form = root.querySelector('[data-post-form]');
      var progress = form && form.querySelector('[data-image-progress]');
      if (progress) progress.hidden = true;
    }

    function addPostImages(fileList) {
      var files = Array.from(fileList || []).filter(function (file) {
        return /^image\/(jpeg|png|webp|gif)$/.test(file.type);
      }).sort(function (a, b) {
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
      if (fileList && fileList.length && !files.length) {
        notifyError('Подходят только изображения JPG, PNG, WEBP или GIF');
        return;
      }
      files.forEach(function (file) {
        state.postImages.push({
          file: file,
          preview: URL.createObjectURL(file),
          url: null,
          uploading: false,
          error: null
        });
      });
      renderPostImageQueue();
      uploadPendingPostImages();
    }

    function updateImageProgress(done, total) {
      var form = root.querySelector('[data-post-form]');
      if (!form) return;
      var progress = form.querySelector('[data-image-progress]');
      if (!progress) return;
      progress.hidden = false;
      var label = form.querySelector('[data-image-progress-label]');
      if (label) label.textContent = 'Загрузка: ' + done + ' / ' + total;
      var count = form.querySelector('[data-image-progress-count]');
      if (count) count.textContent = Math.round(total ? (done / total * 100) : 0) + '%';
      var bar = form.querySelector('[data-image-progress-bar]');
      if (bar) bar.value = total ? Math.round(done / total * 100) : 0;
    }

    function findPost(postId, franchiseId) {
      var posts = (state.detail && state.detail.posts || []).concat(state.feedPosts || []);
      return posts.find(function (item) {
        return String(item.id) === String(postId) &&
          (franchiseId == null || String(item.franchise_id || state.detail && state.detail.franchise.id) === String(franchiseId));
      });
    }

    function franchiseIdForPost(postId, franchiseId) {
      if (franchiseId != null) return Number(franchiseId);
      var post = findPost(postId);
      return Number(post && (post.franchise_id || state.detail && state.detail.franchise.id));
    }

    function getPostSocial(postId, franchiseId) {
      franchiseId = franchiseIdForPost(postId, franchiseId);
      var key = postSocialKey(franchiseId, postId);
      if (!state.postSocial[key]) {
        var post = findPost(postId, franchiseId) || {};
        state.postSocial[key] = {
          likes: Number(post.likes_count || 0),
          liked: !!post.liked,
          commentCount: Number(post.comments_count || 0),
          reactions: post.reactions || [],
          comments: [],
          loaded: false,
          loading: false,
          loadError: '',
          open: false,
          replyTo: null,
          pickerTarget: null
        };
      }
      return state.postSocial[key];
    }

    function renderSocialPanel(postId, franchiseId) {
      franchiseId = franchiseIdForPost(postId, franchiseId);
      var post = findPost(postId, franchiseId);
      var key = postSocialKey(franchiseId, postId);
      var panel = root.querySelector('[data-post-social="' + key + '"]');
      if (!post || !panel) return;
      var canManage = !!(state.detail && Number(state.detail.franchise.id) === franchiseId && state.detail.can_manage);
      panel.outerHTML = renderPostSocial(post, getPostSocial(postId, franchiseId), canManage,
        (window.authManager && window.authManager.getUser() || {}).id, !!token(), franchiseId);
    }

    async function loadPostComments(postId, franchiseId) {
      franchiseId = franchiseIdForPost(postId, franchiseId);
      var social = getPostSocial(postId, franchiseId);
      if (social.loading) return;
      social.loading = true;
      social.open = true;
      social.loadError = '';
      renderSocialPanel(postId, franchiseId);
      try {
        social.comments = await request('/api/franchises/' + franchiseId + '/posts/' + postId + '/comments');
        social.commentCount = social.comments.length;
        social.loaded = true;
      } catch (error) {
        social.loadError = error.message;
        throw error;
      } finally {
        social.loading = false;
        renderSocialPanel(postId, franchiseId);
      }
    }

    function ensureStickerPicker() {
      if (window.PublicStickerPicker) return Promise.resolve(window.PublicStickerPicker);
      return new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = '/site/stickers.js';
        script.onload = function () { resolve(window.PublicStickerPicker); };
        script.onerror = function () { reject(new Error('Не удалось загрузить модуль стикеров')); };
        document.body.appendChild(script);
      });
    }

    async function openPostStickerPicker(button) {
      if (!token()) {
        if (typeof window.showModalLogin === 'function') window.showModalLogin('login');
        else window.location.href = '/admin-panel';
        return;
      }
      var postRoot = button.closest('[data-post-social]');
      if (!postRoot) return;
      var postId = postRoot.dataset.postId;
      var franchiseId = franchiseIdForPost(postId, postRoot.dataset.franchiseId);
      var mode = button.dataset.pickerMode;
      var targetType = button.dataset.targetType;
      var targetId = button.dataset.targetId;

      var picker;
      try {
        picker = await ensureStickerPicker();
      } catch (err) {
        notifyError(err.message);
        return;
      }
      if (!picker) return;

      picker.open(button, async function (shortcode, imageUrl) {
        var cleanCode = String(shortcode || '').replace(/^:+|:+$/g, '').trim();
        if (mode === 'insert') {
          var textarea = postRoot.querySelector('[data-comment-form] textarea[name="content"]');
          if (!textarea) return;
          var insertText = ':' + cleanCode + ': ';
          var start = textarea.selectionStart;
          var end = textarea.selectionEnd;
          textarea.setRangeText(insertText, start, end, 'end');
          textarea.focus();
          return;
        }

        var endpoint = '/api/franchises/' + franchiseId + '/posts/' + postId;
        if (targetType === 'franchise_post_comment') endpoint += '/comments/' + targetId;
        endpoint += '/reactions/toggle';
        try {
          var result = await request(endpoint, 'POST', { shortcode: cleanCode });
          var social = getPostSocial(postId, franchiseId);
          if (targetType === 'franchise_post') {
            social.reactions = result.reactions || [];
            renderSocialPanel(postId, franchiseId);
          } else {
            social.comments = await request('/api/franchises/' + franchiseId + '/posts/' + postId + '/comments');
            renderSocialPanel(postId, franchiseId);
          }
        } catch (error) {
          notifyError(error.message);
        }
      });
    }

    async function togglePostLike(postId, franchiseId) {
      try {
        var result = await request('/api/franchises/' + franchiseId + '/posts/' + postId + '/likes/toggle', 'POST', {});
        var social = getPostSocial(postId, franchiseId);
        social.likes = result.count;
        social.liked = result.liked;
        renderSocialPanel(postId, franchiseId);
      } catch (error) {
        notifyError(error.message);
      }
    }

    async function togglePostReaction(button) {
      var postRoot = button.closest('[data-post-social]');
      var postId = postRoot.dataset.postId;
      var franchiseId = postRoot.dataset.franchiseId;
      var targetType = button.dataset.targetType;
      var targetId = button.dataset.targetId;
      var endpoint = '/api/franchises/' + franchiseId + '/posts/' + postId;
      if (targetType === 'franchise_post_comment') endpoint += '/comments/' + targetId;
      endpoint += '/reactions/toggle';
      try {
        var result = await request(endpoint, 'POST', { shortcode: button.dataset.shortcode });
        var social = getPostSocial(postId, franchiseId);
        if (targetType === 'franchise_post') social.reactions = result.reactions || [];
        else social.comments = await request('/api/franchises/' + franchiseId + '/posts/' + postId + '/comments');
        renderSocialPanel(postId, franchiseId);
      } catch (error) {
        notifyError(error.message);
      }
    }

    function buildStickerReplyTargets(postId, franchiseId, commentId) {
      var social = getPostSocial(postId, franchiseId);
      var comment = social.comments.find(function (item) { return Number(item.id) === Number(commentId); });
      if (!comment) return [];
      var rootCommentId = comment.parentId || comment.id;
      var base = '/api/franchises/' + franchiseId + '/posts/' + postId;
      return [
        {
          label: 'Реакция на этот комментарий',
          send: async function (code) {
            await request(base + '/comments/' + comment.id + '/reactions/toggle', 'POST', {
              shortcode: code.replace(/^:+|:+$/g, '')
            });
            social.comments = await request(base + '/comments');
            renderSocialPanel(postId, franchiseId);
            return true;
          }
        },
        {
          label: 'Ответ на комментарий — стикером',
          send: async function (code) {
            await request(base + '/comments', 'POST', { content: code, parentId: rootCommentId });
            social.comments = await request(base + '/comments');
            social.commentCount = social.comments.length;
            social.loaded = true;
            renderSocialPanel(postId, franchiseId);
            showToast('Ответ добавлен');
            return true;
          }
        },
        {
          label: 'Реакция на публикацию',
          send: async function (code) {
            var result = await request(base + '/reactions/toggle', 'POST', {
              shortcode: code.replace(/^:+|:+$/g, '')
            });
            social.reactions = result.reactions || [];
            renderSocialPanel(postId, franchiseId);
            return true;
          }
        }
      ];
    }

    async function submitPostComment(form) {
      var postId = form.dataset.postId;
      var franchiseId = form.closest('[data-post-social]').dataset.franchiseId;
      var social = getPostSocial(postId, franchiseId);
      var content = new FormData(form).get('content');
      try {
        await request('/api/franchises/' + franchiseId + '/posts/' + postId + '/comments', 'POST', {
          content: content,
          parentId: social.replyTo ? social.replyTo.id : null
        });
        social.replyTo = null;
        social.comments = await request('/api/franchises/' + franchiseId + '/posts/' + postId + '/comments');
        social.commentCount = social.comments.length;
        social.loaded = true;
        social.open = true;
        renderSocialPanel(postId, franchiseId);
        showToast('Комментарий добавлен');
      } catch (error) {
        notifyError(error.message);
      }
    }

    async function loadMine() {
      if (!token()) {
        state.mine = [];
        state.mineError = '';
        return;
      }
      try {
        state.mine = await request('/api/franchises/mine');
        state.mineError = '';
      } catch (error) {
        console.error('Не удалось загрузить список франшиз пользователя:', error);
        state.mine = [];
        state.mineError = 'Не удалось загрузить «Моё AllTell»: ' + error.message;
      }
    }

    async function loadArticleIndex() {
      if (!token()) {
        state.articleIndex = [];
        state.articleIndexError = '';
        return;
      }
      try {
        var result = await request('/api/articles-index');
        state.articleIndex = Array.isArray(result.accessible) ? result.accessible : [];
        state.articleIndexError = '';
      } catch (error) {
        console.error('Не удалось загрузить доступные статьи:', error);
        state.articleIndex = [];
        state.articleIndexError = error.message;
      }
    }

    async function loadCatalog() {
      state.view = 'catalog';
      state.loading = (!state.franchises || !state.franchises.length);
      state.error = '';
      renderCatalog(root, state);
      try {
        var results = await Promise.all([
          request('/api/public/franchises'),
          loadMine()
        ]);
        if (state.disposed) return;
        state.franchises = results[0];
        state.loading = false;
        renderCatalog(root, state);
      } catch (error) {
        if (state.disposed) return;
        state.loading = false;
        state.error = error.message;
        renderCatalog(root, state);
      }
    }

    async function loadFeed() {
      state.view = 'feed';
      state.postSocial = {};
      state.loading = true;
      state.error = '';
      renderFeed(root, state);

      var feedPromise = token()
        ? request('/api/franchises/feed').catch(function (err) { return { error: err.message }; })
        : Promise.resolve({ posts: [], followed_count: 0 });

      var catalogPromise = (!state.franchises || !state.franchises.length)
        ? request('/api/public/franchises').catch(function () { return []; })
        : Promise.resolve(state.franchises);

      var minePromise = token()
        ? loadMine().catch(function () { return []; })
        : Promise.resolve(state.mine || []);

      try {
        var results = await Promise.all([feedPromise, catalogPromise, minePromise]);
        if (state.disposed) return;

        var feedResult = results[0];
        if (Array.isArray(results[1])) {
          state.franchises = results[1];
        }

        state.loading = false;
        if (feedResult && feedResult.error) {
          state.error = feedResult.error;
        } else {
          state.feedPosts = (feedResult && feedResult.posts) || [];
          state.followedCount = Number((feedResult && feedResult.followed_count) || 0);
          if (state.followedCount) {
            request('/api/franchises/feed/read', 'POST', {}).catch(function (error) {
              notifyError(error.message);
            });
          }
        }
        renderFeed(root, state);
      } catch (error) {
        if (state.disposed) return;
        state.loading = false;
        state.error = error.message;
        renderFeed(root, state);
      }
    }

    async function loadWorkspaceData(franchiseId) {
      state.workspaceLoading = true;
      try {
        var results = await Promise.all([
          request('/api/servers/' + encodeURIComponent(franchiseId) + '/users').catch(function () { return []; }),
          request('/api/servers/' + encodeURIComponent(franchiseId) + '/roles').catch(function () { return []; }),
          request('/api/servers/' + encodeURIComponent(franchiseId) + '/channels').catch(function () { return []; }),
          request('/api/servers/' + encodeURIComponent(franchiseId) + '/hubs').catch(function () { return []; })
        ]);
        state.workspaceData.members = Array.isArray(results[0]) ? results[0] : [];
        state.workspaceData.roles = Array.isArray(results[1]) ? results[1] : [];
        state.workspaceData.channels = Array.isArray(results[2]) ? results[2] : [];
        state.workspaceData.hubs = Array.isArray(results[3]) ? results[3] : [];
      } catch (err) {
        console.error('Ошибка загрузки данных управления франшизой:', err);
      } finally {
        state.workspaceLoading = false;
      }
    }

    async function loadMapsData(franchiseId) {
      try {
        var results = await Promise.all([
          request('/api/maps?serverId=' + encodeURIComponent(franchiseId)).catch(function () { return []; }),
          request('/api/servers/' + encodeURIComponent(franchiseId) + '/world').catch(function () { return null; })
        ]);
        state.workspaceData.maps = Array.isArray(results[0]) ? results[0] : [];
        state.workspaceData.world = results[1];
      } catch (err) {
        console.error('Ошибка загрузки карт:', err);
      }
    }

    async function loadAuditLog(franchiseId) {
      try {
        var log = await request('/api/servers/' + encodeURIComponent(franchiseId) + '/audit-log?limit=50').catch(function () { return []; });
        state.workspaceData.auditLog = Array.isArray(log) ? log : [];
      } catch (err) {
        console.error('Ошибка загрузки журнала действий:', err);
      }
    }

    async function removeMemberRole(franchiseId, userId, roleId) {
      try {
        await request('/api/servers/' + franchiseId + '/users/' + userId + '/roles/' + roleId, 'DELETE');
        showToast('Роль снята');
        await loadWorkspaceData(franchiseId);
        renderDetail(root, state);
      } catch (error) {
        notifyError(error.message);
      }
    }

    async function kickMember(franchiseId, userId, userName) {
      var ok = window.confirmDialog
        ? await window.confirmDialog.open({
            title: 'Удалить участника?',
            message: 'Удалить пользователя «' + (userName || ('ID ' + userId)) + '» из франшизы?',
            confirmLabel: 'Удалить',
            cancelLabel: 'Отмена',
            danger: true
          })
        : confirm('Удалить пользователя «' + (userName || ('ID ' + userId)) + '» из франшизы?');
      if (!ok) return;
      try {
        await request('/api/servers/' + franchiseId + '/users/' + userId, 'DELETE');
        showToast('Участник удалён');
        await loadWorkspaceData(franchiseId);
        if (state.detail && state.detail.franchise) {
          state.detail.franchise.member_count = Math.max(0, Number(state.detail.franchise.member_count || 1) - 1);
        }
        renderDetail(root, state);
      } catch (error) {
        notifyError(error.message);
      }
    }

    async function deleteRole(franchiseId, roleId, roleName) {
      var ok = window.confirmDialog
        ? await window.confirmDialog.open({
            title: 'Удалить роль?',
            message: 'Удалить роль «' + (roleName || '') + '»? Она будет снята со всех участников.',
            confirmLabel: 'Удалить',
            cancelLabel: 'Отмена',
            danger: true
          })
        : confirm('Удалить роль «' + (roleName || '') + '»?');
      if (!ok) return;
      try {
        await request('/api/servers/' + franchiseId + '/roles/' + roleId, 'DELETE');
        showToast('Роль удалена');
        await loadWorkspaceData(franchiseId);
        renderDetail(root, state);
      } catch (error) {
        notifyError(error.message);
      }
    }

    async function deleteChannel(franchiseId, channelId, channelName) {
      var ok = window.confirmDialog
        ? await window.confirmDialog.open({
            title: 'Удалить канал?',
            message: 'Удалить канал «' + (channelName || '') + '»?',
            confirmLabel: 'Удалить',
            cancelLabel: 'Отмена',
            danger: true
          })
        : confirm('Удалить канал «' + (channelName || '') + '»?');
      if (!ok) return;
      try {
        await request('/api/servers/' + franchiseId + '/channels/' + channelId, 'DELETE');
        showToast('Канал удалён');
        await loadWorkspaceData(franchiseId);
        renderDetail(root, state);
      } catch (error) {
        notifyError(error.message);
      }
    }

    async function deleteFranchise(franchiseId, franchiseName) {
      var ok = window.confirmDialog
        ? await window.confirmDialog.open({
            title: 'Удалить франшизу?',
            message: 'Удалить франшизу «' + (franchiseName || '') + '» со всеми связанными хабами, ролями, каналами и публикациями? Действие необратимо.',
            confirmLabel: 'Удалить навсегда',
            cancelLabel: 'Отмена',
            danger: true
          })
        : confirm('Удалить франшизу «' + (franchiseName || '') + '» со всеми данными? Действие необратимо.');
      if (!ok) return;
      try {
        await request('/api/servers/' + franchiseId, 'DELETE');
        showToast('Франшиза удалена');
        await loadMine();
        if (state.detail && Number(state.detail.franchise.id) === Number(franchiseId)) {
          window.history.pushState({}, '', '/alltell?view=catalog');
          await loadCatalog();
        } else {
          await loadCatalog();
        }
      } catch (error) {
        notifyError(error.message);
      }
    }

    async function changeHubStatus(franchiseId, hubId, status) {
      try {
        await request('/api/servers/' + franchiseId + '/hubs/' + hubId + '/status', 'PUT', { status: status });
        showToast('Статус хаба обновлён');
        await loadWorkspaceData(franchiseId);
        if (state.detail) state.detail.hubs = state.workspaceData.hubs;
        renderDetail(root, state);
      } catch (error) {
        notifyError(error.message);
      }
    }

    async function deleteHub(franchiseId, hubId, hubName) {
      var ok = window.confirmDialog
        ? await window.confirmDialog.open({
            title: 'Удалить хаб?',
            message: 'Удалить игровой хаб «' + (hubName || '') + '»? Если к хабу привязаны статьи или публикации, предварительно отвяжите их.',
            confirmLabel: 'Удалить',
            cancelLabel: 'Отмена',
            danger: true
          })
        : confirm('Удалить хаб «' + (hubName || '') + '»?');
      if (!ok) return;
      try {
        await request('/api/servers/' + franchiseId + '/hubs/' + hubId, 'DELETE');
        showToast('Хаб удалён');
        await loadWorkspaceData(franchiseId);
        if (state.detail) state.detail.hubs = state.workspaceData.hubs;
        renderDetail(root, state);
      } catch (error) {
        notifyError(error.message);
      }
    }

    async function saveNewMap(franchiseId) {
      var input = document.getElementById('new-map-title-input');
      var title = input ? input.value.trim() : '';
      if (!title) {
        notifyError('Введите название карты');
        return;
      }
      try {
        await request('/api/maps', 'POST', { serverId: Number(franchiseId), title: title });
        showToast('Карта создана');
        state.showCreateMap = false;
        await loadMapsData(franchiseId);
        renderDetail(root, state);
      } catch (error) {
        notifyError(error.message);
      }
    }

    async function toggleHubPreview(franchiseId, cardKey) {
      var id = Number(franchiseId);
      if (!id) return;
      var key = cardKey || ('catalog:' + id);
      if (state.expandedCardKey === key) {
        state.expandedCardKey = null;
        state.expandedHubs.clear();
        renderCatalog(root, state);
        return;
      }
      state.expandedCardKey = key;
      state.expandedHubs.clear();
      state.expandedHubs.add(id);
      if (!state.hubPreviewCache.has(id)) {
        renderCatalog(root, state);
        try {
          var hubs = await request('/api/servers/' + id + '/hubs');
          state.hubPreviewCache.set(id, Array.isArray(hubs) ? hubs : []);
        } catch (error) {
          console.error('Ошибка загрузки хабов франшизы:', error);
          state.hubPreviewCache.set(id, []);
        }
      }
      renderCatalog(root, state);
    }

    function openHubInfoPopup(franchiseId, hubId) {
      franchiseId = Number(franchiseId);
      hubId = Number(hubId);
      var franchise = state.franchises.find(function (f) { return Number(f.id) === franchiseId; });
      if (!franchise && state.mine) {
        franchise = state.mine.find(function (f) { return Number(f.id) === franchiseId; });
      }
      var franchiseName = franchise ? franchise.name : (state.detail && state.detail.franchise ? state.detail.franchise.name : '');

      var hubs = (franchiseId && state.hubPreviewCache.get(franchiseId)) || [];
      if (!hubs.length && state.detail && state.detail.hubs) hubs = state.detail.hubs;
      if (!hubs.length && state.workspaceData && state.workspaceData.hubs) hubs = state.workspaceData.hubs;

      var hub = hubs.find(function (h) { return Number(h.id) === hubId; });
      if (hub) {
        showHubInfoModal(hub, franchiseName, franchiseId);
      } else if (franchiseId) {
        request('/api/servers/' + franchiseId + '/hubs').then(function (loadedHubs) {
          if (Array.isArray(loadedHubs)) {
            state.hubPreviewCache.set(franchiseId, loadedHubs);
            var target = loadedHubs.find(function (h) { return Number(h.id) === hubId; });
            if (target) showHubInfoModal(target, franchiseName, franchiseId);
          }
        }).catch(function (err) {
          notifyError('Не удалось загрузить информацию о хабе: ' + err.message);
        });
      }
    }

    function openCreateFranchiseModal() {
      var heroHtml = `<div class="alltell-modal-avatar-preview" id="create-franchise-avatar-preview" style="background:${FRANCHISE_GRADIENTS[0]}">?</div>`;

      var bodyHtml = `
        <form id="alltell-create-franchise-form">
          <div class="alltell-field">
            <label class="alltell-field-label" for="create-franchise-name-input">
              Название вселенной <span style="color:#f23f43">*</span>
            </label>
            <input type="text"
                   id="create-franchise-name-input"
                   name="name"
                   maxlength="100"
                   placeholder="Например: Хроники Серебряного Ветра"
                   autocomplete="off"
                   required
                   autofocus>
            <span style="font-size:11px;color:var(--text-muted);margin-top:4px;display:block;">
              Уникальное название вашей франшизы в каталоге AllTell
            </span>
          </div>

          <div class="alltell-field">
            <label class="alltell-field-label" for="create-franchise-desc-input">Краткое описание</label>
            <textarea id="create-franchise-desc-input"
                      name="description"
                      rows="3"
                      maxlength="500"
                      placeholder="Опишите сеттинг, атмосферу или ключевую тему вашей франшизы"></textarea>
          </div>

          <div class="alltell-field">
            <label class="alltell-field-label">Аватарка вселенной</label>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
              <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0;">
                <i class="fas fa-camera"></i> <span id="create-franchise-avatar-label">Выбрать фото</span>
                <input type="file" id="create-franchise-avatar-file" accept="image/jpeg,image/png,image/gif,image/webp" hidden>
              </label>
              <button type="button" class="btn btn-secondary btn-sm" id="create-franchise-avatar-remove" style="display:none;color:var(--status-danger);">
                <i class="fas fa-trash"></i> Удалить
              </button>
            </div>
            <span style="font-size:11px;color:var(--text-muted);margin-top:4px;display:block;">
              Рекомендуется квадратное изображение (PNG, JPG, WebP)
            </span>
          </div>

          <div class="alltell-modal-hint" style="margin-top:4px;">
            <i class="fas fa-circle-info"></i>
            <span>После создания вы автоматически становитесь администратором франшизы и сможете настроить хабы, роли и статьи лора.</span>
          </div>

          <div class="alltell-modal-footer" style="padding:16px 0 0;margin-top:14px;background:none;border-top:1px solid var(--background-accent);">
            <button type="button" class="btn btn-secondary" data-modal-close>Отмена</button>
            <button type="submit" class="btn btn-primary" id="create-franchise-submit-btn">
              <i class="fas fa-plus"></i> Создать франшизу
            </button>
          </div>
        </form>
      `;

      openModal({
        title: 'Новая вселенная AllTell',
        subtitle: 'Создание ролевой франшизы сообщества',
        hero: heroHtml,
        bodyHtml: bodyHtml,
        onMount: function (container) {
          var nameInput = container.querySelector('#create-franchise-name-input');
          var avatarPreview = container.querySelector('#create-franchise-avatar-preview');
          var form = container.querySelector('#alltell-create-franchise-form');
          var avatarUrl = null;
          var fileInput = container.querySelector('#create-franchise-avatar-file');
          var removeBtn = container.querySelector('#create-franchise-avatar-remove');
          var labelSpan = container.querySelector('#create-franchise-avatar-label');

          fileInput.addEventListener('change', async function () {
            if (!fileInput.files || !fileInput.files[0]) return;
            var prevLabel = labelSpan.textContent;
            labelSpan.textContent = 'Загрузка…';
            fileInput.disabled = true;
            try {
              var uploadedUrl = await uploadSingleImage(fileInput.files[0]);
              avatarUrl = uploadedUrl;
              avatarPreview.textContent = '';
              avatarPreview.innerHTML = '<img src="' + escapeHtml(normalizeImageUrl(uploadedUrl)) + '" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;" alt="">';
              removeBtn.style.display = 'inline-flex';
              labelSpan.textContent = 'Сменить фото';
            } catch (err) {
              notifyError(err.message);
              labelSpan.textContent = prevLabel;
            } finally {
              fileInput.disabled = false;
              fileInput.value = '';
            }
          });

          removeBtn.addEventListener('click', function () {
            avatarUrl = null;
            removeBtn.style.display = 'none';
            labelSpan.textContent = 'Выбрать фото';
            var val = nameInput.value.trim();
            avatarPreview.textContent = initials(val) || '?';
            avatarPreview.style.background = franchiseAvatarColor(val || 'Franchise');
          });

          nameInput.addEventListener('input', function () {
            if (avatarUrl) return;
            var val = nameInput.value.trim();
            avatarPreview.textContent = initials(val) || '?';
            avatarPreview.style.background = franchiseAvatarColor(val || 'Franchise');
          });

          form.addEventListener('submit', async function (e) {
            e.preventDefault();
            var name = nameInput.value.trim();
            var description = container.querySelector('#create-franchise-desc-input').value.trim();
            if (!name) return;
            var btn = container.querySelector('#create-franchise-submit-btn');
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Создание…';
            try {
              var server = await request('/api/servers', 'POST', { name: name, description: description, avatar_url: avatarUrl });
              closeModal();
              showToast('Франшиза «' + name + '» успешно создана!');
              window.history.pushState({}, '', '/alltell?franchise=' + server.id + '&tab=manage');
              state.detailTab = 'manage';
              state.workspaceTab = 'overview';
              await loadDetail(server.id);
              await loadMine();
            } catch (error) {
              btn.disabled = false;
              btn.innerHTML = '<i class="fas fa-plus"></i> Создать франшизу';
              notifyError(error.message);
            }
          });

          setTimeout(function () { nameInput.focus(); }, 60);
        }
      });
    }

    function openAddMemberModal(franchiseId) {
      var bodyHtml = `
        <div class="alltell-field">
          <label class="alltell-field-label" for="add-member-search-input">Поиск пользователя по имени</label>
          <div class="alltell-user-search-wrap">
            <input type="search" id="add-member-search-input" placeholder="Начните вводить имя участника..." autocomplete="off">
            <div id="add-member-search-results" class="alltell-user-dropdown" hidden></div>
          </div>
          <span style="font-size:11px;color:var(--text-muted);margin-top:4px;display:block;">
            Поиск работает по подтверждённым пользователям платформы.
          </span>
        </div>
        <div class="alltell-field" style="margin-top:14px;">
          <label class="alltell-field-label" for="add-member-id-input">Или укажите точный ID пользователя</label>
          <input type="number" id="add-member-id-input" placeholder="Например: 12" min="1">
        </div>
        <div class="alltell-modal-footer" style="padding:16px 0 0;margin-top:14px;background:none;border-top:1px solid var(--background-accent);">
          <button type="button" class="btn btn-secondary" data-modal-close>Отмена</button>
          <button type="button" class="btn btn-primary" id="confirm-add-member-btn">
            <i class="fas fa-user-plus"></i> Добавить участника
          </button>
        </div>
      `;

      openModal({
        title: 'Добавить участника',
        subtitle: 'Приглашение пользователя во вселенную',
        bodyHtml: bodyHtml,
        onMount: function (container) {
          var searchInput = container.querySelector('#add-member-search-input');
          var resultsDropdown = container.querySelector('#add-member-search-results');
          var idInput = container.querySelector('#add-member-id-input');
          var confirmBtn = container.querySelector('#confirm-add-member-btn');
          var debounceTimer = null;

          searchInput.addEventListener('input', function () {
            window.clearTimeout(debounceTimer);
            var q = searchInput.value.trim();
            if (!q) {
              resultsDropdown.hidden = true;
              resultsDropdown.innerHTML = '';
              return;
            }
            debounceTimer = window.setTimeout(async function () {
              try {
                var users = await request('/api/users/search?q=' + encodeURIComponent(q));
                if (!Array.isArray(users) || !users.length) {
                  resultsDropdown.innerHTML = '<div class="alltell-user-item" style="color:var(--text-muted);cursor:default;">Никого не найдено</div>';
                } else {
                  resultsDropdown.innerHTML = users.map(function (u) {
                    return `<div class="alltell-user-item" data-uid="${u.id}" data-uname="${escapeHtml(u.display_name)}">
                      <strong>${escapeHtml(u.display_name)}</strong>
                      <span style="color:var(--text-muted);font-size:11px;">ID ${u.id}</span>
                    </div>`;
                  }).join('');
                  resultsDropdown.querySelectorAll('[data-uid]').forEach(function (item) {
                    item.addEventListener('click', function () {
                      idInput.value = item.dataset.uid;
                      searchInput.value = item.dataset.uname;
                      resultsDropdown.hidden = true;
                    });
                  });
                }
                resultsDropdown.hidden = false;
              } catch (err) {
                resultsDropdown.hidden = true;
              }
            }, 300);
          });

          confirmBtn.addEventListener('click', async function () {
            var targetUserId = idInput.value.trim();
            if (!targetUserId) {
              notifyError('Укажите пользователя или его точный ID');
              return;
            }
            confirmBtn.disabled = true;
            confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Добавление…';
            try {
              await request('/api/servers/' + franchiseId + '/users/' + targetUserId, 'POST', {});
              closeModal();
              showToast('Участник успешно добавлен');
              await loadWorkspaceData(franchiseId);
              if (state.detail && state.detail.franchise) {
                state.detail.franchise.member_count = Number(state.detail.franchise.member_count || 0) + 1;
              }
              renderDetail(root, state);
            } catch (error) {
              confirmBtn.disabled = false;
              confirmBtn.innerHTML = '<i class="fas fa-user-plus"></i> Добавить участника';
              notifyError(error.message);
            }
          });

          setTimeout(function () { searchInput.focus(); }, 60);
        }
      });
    }

    function openAssignRoleModal(franchiseId, userId, userName) {
      var roles = state.workspaceData.roles || [];
      if (!roles.length) {
        notifyError('Во франшизе пока нет созданных ролей. Сначала создайте роль во вкладке «Роли».');
        return;
      }
      var bodyHtml = `
        <p style="margin:0 0 14px;font-size:0.9rem;color:var(--text-muted);">
          Пользователь: <strong style="color:var(--text-normal);">${escapeHtml(userName)}</strong> (ID ${userId})
        </p>
        <div class="alltell-field">
          <label class="alltell-field-label" for="assign-role-select">Выберите роль</label>
          <select id="assign-role-select" class="alltell-select" style="width:100%;">
            ${roles.map(function (r) {
              return `<option value="${r.id}">${escapeHtml(r.name)} (уровень ${r.hierarchy_level}${r.role_type === 'system' ? ', системная' : ''})</option>`;
            }).join('')}
          </select>
        </div>
        <div class="alltell-modal-footer" style="padding:16px 0 0;margin-top:14px;background:none;border-top:1px solid var(--background-accent);">
          <button type="button" class="btn btn-secondary" data-modal-close>Отмена</button>
          <button type="button" class="btn btn-primary" id="confirm-assign-role-btn">
            <i class="fas fa-check"></i> Назначить роль
          </button>
        </div>
      `;

      openModal({
        title: 'Назначить роль участнику',
        subtitle: 'Управление доступом во франшизе',
        bodyHtml: bodyHtml,
        onMount: function (container) {
          var confirmBtn = container.querySelector('#confirm-assign-role-btn');
          confirmBtn.addEventListener('click', async function () {
            var roleId = container.querySelector('#assign-role-select').value;
            if (!roleId) return;
            confirmBtn.disabled = true;
            confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Назначение…';
            try {
              await request('/api/servers/' + franchiseId + '/users/' + userId + '/roles/' + roleId, 'POST', {});
              closeModal();
              showToast('Роль успешно назначена');
              await loadWorkspaceData(franchiseId);
              renderDetail(root, state);
            } catch (error) {
              confirmBtn.disabled = false;
              confirmBtn.innerHTML = '<i class="fas fa-check"></i> Назначить роль';
              notifyError(error.message);
            }
          });
        }
      });
    }

    function openRoleEditorModal(franchiseId, roleId) {
      var role = roleId ? (state.workspaceData.roles || []).find(function (r) { return String(r.id) === String(roleId); }) : null;
      var perms = (role && role.permissions) || {};
      var bodyHtml = `
        <form id="role-editor-form">
          <div class="alltell-field">
            <label class="alltell-field-label" for="role-name-input">
              Название роли <span style="color:#f23f43">*</span>
            </label>
            <input type="text" id="role-name-input" maxlength="50" required placeholder="Например: Мастер игры" value="${escapeHtml(role ? role.name : '')}" autofocus>
          </div>
          <div class="alltell-field">
            <label class="alltell-field-label" for="role-level-input">Уровень иерархии (0–99)</label>
            <input type="number" id="role-level-input" min="0" max="99" value="${role ? role.hierarchy_level : 0}">
            <span style="font-size:11px;color:var(--text-muted);margin-top:4px;display:block;">
              Чем выше число, тем выше приоритет роли при проверках доступа.
            </span>
          </div>
          <div class="alltell-field">
            <label class="alltell-field-label">Права роли</label>
            <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px;">
              <label class="alltell-perm-check">
                <input type="checkbox" id="perm-read-messages" ${perms.read_messages ? 'checked' : (!role ? 'checked' : '')}>
                <span>Чтение сообщений</span>
              </label>
              <label class="alltell-perm-check">
                <input type="checkbox" id="perm-send-messages" ${perms.send_messages ? 'checked' : (!role ? 'checked' : '')}>
                <span>Отправка сообщений</span>
              </label>
              <label class="alltell-perm-check">
                <input type="checkbox" id="perm-manage-channels" ${perms.manage_channels ? 'checked' : ''}>
                <span>Управление каналами</span>
              </label>
              <label class="alltell-perm-check">
                <input type="checkbox" id="perm-manage-roles" ${perms.manage_roles ? 'checked' : ''}>
                <span>Управление ролями</span>
              </label>
              <label class="alltell-perm-check">
                <input type="checkbox" id="perm-ban-users" ${perms.ban_users ? 'checked' : ''}>
                <span>Блокировка пользователей</span>
              </label>
            </div>
          </div>
          <div class="alltell-modal-footer" style="padding:16px 0 0;margin-top:14px;background:none;border-top:1px solid var(--background-accent);">
            <button type="button" class="btn btn-secondary" data-modal-close>Отмена</button>
            <button type="submit" class="btn btn-primary" id="role-submit-btn">
              ${role ? '<i class="fas fa-check"></i> Сохранить изменения' : '<i class="fas fa-plus"></i> Создать роль'}
            </button>
          </div>
        </form>
      `;

      openModal({
        title: role ? 'Редактировать роль' : 'Создать новую роль',
        subtitle: role ? `Настройка роли «${role.name}»` : 'Роль для участников франшизы и прав в Antropedia',
        bodyHtml: bodyHtml,
        onMount: function (container) {
          var form = container.querySelector('#role-editor-form');
          form.addEventListener('submit', async function (e) {
            e.preventDefault();
            var name = container.querySelector('#role-name-input').value.trim();
            var level = Number(container.querySelector('#role-level-input').value) || 0;
            if (!name) return;
            var permissions = {
              read_messages: container.querySelector('#perm-read-messages').checked,
              send_messages: container.querySelector('#perm-send-messages').checked,
              manage_channels: container.querySelector('#perm-manage-channels').checked,
              manage_roles: container.querySelector('#perm-manage-roles').checked,
              ban_users: container.querySelector('#perm-ban-users').checked
            };
            var btn = container.querySelector('#role-submit-btn');
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Сохранение…';
            try {
              if (roleId) {
                await request('/api/servers/' + franchiseId + '/roles/' + roleId, 'PUT', { name: name, hierarchy_level: level, permissions: permissions });
                showToast('Роль успешно обновлена');
              } else {
                await request('/api/servers/' + franchiseId + '/roles', 'POST', { name: name, hierarchy_level: level, permissions: permissions });
                showToast('Роль успешно создана');
              }
              closeModal();
              await loadWorkspaceData(franchiseId);
              renderDetail(root, state);
            } catch (error) {
              btn.disabled = false;
              btn.innerHTML = role ? '<i class="fas fa-check"></i> Сохранить изменения' : '<i class="fas fa-plus"></i> Создать роль';
              notifyError(error.message);
            }
          });

          setTimeout(function () { container.querySelector('#role-name-input')?.focus(); }, 60);
        }
      });
    }

    function openChannelEditorModal(franchiseId, channelId) {
      var channel = channelId ? (state.workspaceData.channels || []).find(function (c) { return String(c.id) === String(channelId); }) : null;
      var bodyHtml = `
        <form id="channel-editor-form">
          <div class="alltell-field">
            <label class="alltell-field-label" for="channel-name-input">
              Название канала <span style="color:#f23f43">*</span>
            </label>
            <input type="text" id="channel-name-input" maxlength="100" required placeholder="Например: general или таверна" value="${escapeHtml(channel ? channel.name : '')}" autofocus>
          </div>
          <div class="alltell-field">
            <label class="alltell-field-label" for="channel-type-select">Тип канала</label>
            <select id="channel-type-select" class="alltell-select" style="width:100%;">
              <option value="text" ${channel && channel.channel_type === 'text' ? 'selected' : ''}>💬 Текстовый</option>
              <option value="voice" ${channel && channel.channel_type === 'voice' ? 'selected' : ''}>🔊 Голосовой</option>
            </select>
          </div>
          <div class="alltell-field">
            <label class="alltell-field-label" for="channel-desc-input">Тема / Описание канала</label>
            <textarea id="channel-desc-input" rows="2" maxlength="500" placeholder="О чём этот канал...">${escapeHtml(channel ? channel.description || '' : '')}</textarea>
          </div>
          <div class="alltell-modal-footer" style="padding:16px 0 0;margin-top:14px;background:none;border-top:1px solid var(--background-accent);">
            <button type="button" class="btn btn-secondary" data-modal-close>Отмена</button>
            <button type="submit" class="btn btn-primary" id="channel-submit-btn">
              ${channel ? '<i class="fas fa-check"></i> Сохранить изменения' : '<i class="fas fa-plus"></i> Создать канал'}
            </button>
          </div>
        </form>
      `;

      openModal({
        title: channel ? 'Редактировать канал' : 'Создать канал',
        subtitle: channel ? `Настройка канала #${channel.name}` : 'Канал для общения участников вселенной',
        bodyHtml: bodyHtml,
        onMount: function (container) {
          var form = container.querySelector('#channel-editor-form');
          form.addEventListener('submit', async function (e) {
            e.preventDefault();
            var name = container.querySelector('#channel-name-input').value.trim();
            var channelType = container.querySelector('#channel-type-select').value;
            var description = container.querySelector('#channel-desc-input').value.trim();
            if (!name) return;
            var btn = container.querySelector('#channel-submit-btn');
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Сохранение…';
            try {
              if (channelId) {
                await request('/api/servers/' + franchiseId + '/channels/' + channelId, 'PUT', { name: name, channel_type: channelType, description: description });
                showToast('Канал обновлён');
              } else {
                await request('/api/servers/' + franchiseId + '/channels', 'POST', { name: name, channel_type: channelType, description: description });
                showToast('Канал создан');
              }
              closeModal();
              await loadWorkspaceData(franchiseId);
              renderDetail(root, state);
            } catch (error) {
              btn.disabled = false;
              btn.innerHTML = channel ? '<i class="fas fa-check"></i> Сохранить изменения' : '<i class="fas fa-plus"></i> Создать канал';
              notifyError(error.message);
            }
          });

          setTimeout(function () { container.querySelector('#channel-name-input')?.focus(); }, 60);
        }
      });
    }

    function openChangeOwnerModal(franchiseId) {
      var bodyHtml = `
        <p style="margin:0 0 14px;font-size:0.9rem;color:var(--text-muted);">
          Выберите подтверждённого пользователя для передачи прав создателя (владельца) этой франшизы.
        </p>
        <div class="alltell-field">
          <label class="alltell-field-label" for="change-owner-select">Новый владелец</label>
          <select id="change-owner-select" class="alltell-select" style="width:100%;">
            <option value="">Загрузка пользователей…</option>
          </select>
        </div>
        <div class="alltell-modal-footer" style="padding:16px 0 0;margin-top:14px;background:none;border-top:1px solid var(--background-accent);">
          <button type="button" class="btn btn-secondary" data-modal-close>Отмена</button>
          <button type="submit" class="btn btn-primary" id="confirm-change-owner-btn">
            <i class="fas fa-crown"></i> Передать права
          </button>
        </div>
      `;

      openModal({
        title: 'Передать владение франшизой',
        subtitle: 'Действие доступно только администратору платформы (root)',
        bodyHtml: bodyHtml,
        onMount: async function (container) {
          var select = container.querySelector('#change-owner-select');
          var confirmBtn = container.querySelector('#confirm-change-owner-btn');
          try {
            var users = await request('/api/users/search?q=');
            if (!Array.isArray(users) || !users.length) {
              users = state.workspaceData.members || [];
            }
            select.innerHTML = users.map(function (u) {
              return `<option value="${u.id}">${escapeHtml(u.display_name || u.username)} (ID ${u.id})</option>`;
            }).join('') || '<option value="">Нет доступных пользователей</option>';
          } catch (err) {
            select.innerHTML = '<option value="">Не удалось загрузить список</option>';
          }

          confirmBtn.addEventListener('click', async function () {
            var newOwnerId = select.value;
            if (!newOwnerId) return;
            confirmBtn.disabled = true;
            confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Передача прав…';
            try {
              await request('/api/servers/' + franchiseId + '/owner', 'PUT', { new_owner_id: Number(newOwnerId) });
              closeModal();
              showToast('Владелец франшизы успешно изменён');
              await loadDetail(franchiseId);
            } catch (error) {
              confirmBtn.disabled = false;
              confirmBtn.innerHTML = '<i class="fas fa-crown"></i> Передать права';
              notifyError(error.message);
            }
          });
        }
      });
    }

    async function loadDetail(franchiseId) {
      state.detail = null;
      state.postSocial = {};
      state.error = '';
      state.expandedCardKey = null;
      state.expandedHubs.clear();
      root.innerHTML = '<p class="alltell-state">Загружаем франшизу…</p>';
      try {
        state.detail = await request('/api/public/franchises/' + encodeURIComponent(franchiseId));
        if (state.disposed) return;
        if (state.detail.can_manage || state.detail.is_owner || state.detailTab === 'manage' || state.detailTab === 'members') {
          await loadWorkspaceData(franchiseId);
          if (state.workspaceTab === 'maps') await loadMapsData(franchiseId);
          else if (state.workspaceTab === 'log') await loadAuditLog(franchiseId);
        }
        renderDetail(root, state);
        if (state.detail.is_member) {
          try {
            await request('/api/franchises/' + encodeURIComponent(franchiseId) + '/feed/read', 'POST', {});
            await loadMine();
          } catch (error) {
            console.error('Не удалось отметить публикации прочитанными:', error);
            state.error = 'Не удалось отметить публикации прочитанными: ' + error.message;
            renderDetail(root, state);
          }
        }
      } catch (error) {
        if (state.disposed) return;
        state.error = error.message;
        root.innerHTML = `<div class="alltell-state alltell-error" role="alert">${escapeHtml(error.message)}<p><a href="/alltell">Вернуться в каталог</a></p></div>`;
      }
    }

    function refreshCurrentView() {
      var urlParams = new URLSearchParams(window.location.search);
      var franchiseId = urlParams.get('franchise');
      var tabParam = urlParams.get('tab');
      if (tabParam) state.detailTab = tabParam;
      var wsTabParam = urlParams.get('wstab');
      if (wsTabParam) state.workspaceTab = wsTabParam;
      if (franchiseId && /^\d+$/.test(franchiseId)) return loadDetail(franchiseId);
      state.view = urlParams.get('view') === 'catalog' ? 'catalog' : 'feed';
      return state.view === 'catalog' ? loadCatalog() : loadFeed();
    }

    function switchView(view) {
      if (view !== 'feed' && view !== 'catalog') return;
      state.view = view;
      window.history.pushState({}, '', '/alltell?view=' + view);
      if (view === 'catalog') loadCatalog();
      else loadFeed();
    }

    async function joinFranchise() {
      var user = window.authManager && window.authManager.getUser();
      if (!user || !user.id) throw new Error('Не удалось определить пользователя. Обновите страницу и повторите попытку.');
      var id = state.detail.franchise.id;
      await request('/api/servers/' + encodeURIComponent(id) + '/users/' + encodeURIComponent(user.id), 'POST', {});
      await loadDetail(id);
      await loadMine();
      showToast('Вы вступили во франшизу');
    }

    async function leaveFranchise() {
      var user = window.authManager && window.authManager.getUser();
      if (!user || !user.id) throw new Error('Не удалось определить пользователя. Обновите страницу и повторите попытку.');
      var id = state.detail.franchise.id;
      await request('/api/servers/' + encodeURIComponent(id) + '/users/' + encodeURIComponent(user.id), 'DELETE');
      await loadDetail(id);
      await loadMine();
      showToast('Вы отписались от франшизы');
    }

    async function savePost(form, formData) {
      var pendingImages = (state.postImages || []).filter(function (image) { return image.file && !image.url; });
      if (pendingImages.length) {
        if (state.uploadingImages) {
          throw new Error('Пожалуйста, дождитесь завершения загрузки изображений на сервер');
        }
        await uploadPendingPostImages();
      }
      var failedImages = (state.postImages || []).filter(function (image) { return image.error; });
      if (failedImages.length) {
        throw new Error('Некоторые изображения не удалось загрузить на сервер. Удалите их или попробуйте снова.');
      }
      var imageUrls = state.postImages.map(function (image) { return image.url; }).filter(Boolean);
      var postArticles = state.postArticles || [];
      var articleSlugs = postArticles.map(function (a) { return a.slug; }).filter(Boolean);
      var bodyValue = formData.get('body');
      if (state.postBlocks && state.postBlocks.length) {
        bodyValue = serializePostBlocks(state.postBlocks);
      }
      var payload = {
        type: formData.get('type'),
        hub_id: formData.get('hub_id'),
        hub_status: formData.get('hub_id') ? formData.get('hub_status') : '',
        title: formData.get('title'),
        body: bodyValue,
        article_slug: articleSlugs[0] || null,
        article_slugs: articleSlugs,
        image_urls: imageUrls
      };
      var franchiseId = state.detail.franchise.id;
      var postId = state.editingPost && state.editingPost.id;
      var post = await request('/api/franchises/' + franchiseId + '/posts' + (postId ? '/' + postId : ''), postId ? 'PUT' : 'POST', payload);
      if (postId) {
        state.detail.posts = state.detail.posts.map(function (item) { return item.id === post.id ? post : item; });
      } else {
        state.detail.posts.unshift(post);
      }
      state.editingPost = null;
      state.showPostForm = false;
      state.postBlocks = null;
      releasePostImages();
      state.postArticles = [];
      renderDetail(root, state);
      showToast(post.approval_status === 'pending'
        ? 'Предложение отправлено создателю франшизы'
        : (postId ? 'Публикация обновлена' : 'Публикация сохранена'));
    }

    function renderArticleOptions(input) {
      var form = input.closest('[data-post-form]');
      if (!form) return;
      var options = form.querySelector('[data-article-options]');
      if (!options) return;
      var query = input.value.trim().toLocaleLowerCase();
      if (!query) {
        options.hidden = true;
        options.replaceChildren();
        return;
      }
      var selectedSlugs = new Set((state.postArticles || []).map(function (a) { return a.slug; }));
      var list = state.articleIndex || [];
      var matches = list.filter(function (article) {
        return ((article.title || '') + ' ' + (article.slug || '')).toLocaleLowerCase().includes(query);
      }).slice(0, 20);

      if (!matches.length) {
        options.innerHTML = state.articleIndexError
          ? `<div class="alltell-article-option-empty">Не удалось загрузить статьи: ${escapeHtml(state.articleIndexError)}</div>`
          : '<div class="alltell-article-option-empty">Статьи не найдены по запросу</div>';
      } else {
        options.innerHTML = `
          <div class="alltell-article-options-header">
            <span>Найдено совпадений: ${matches.length}</span>
            <span class="alltell-article-options-hint">Нажмите для выбора / отмены</span>
          </div>
          <div class="alltell-article-options-list">
            ${matches.map(function (article) {
              var isSelected = selectedSlugs.has(article.slug);
              var tagsText = Array.isArray(article.tags) && article.tags.length
                ? article.tags.slice(0, 2).map(function (t) { return '#' + escapeHtml(t); }).join(' ')
                : '';
              return `
                <button type="button"
                        class="alltell-article-choice-chip ${isSelected ? 'is-selected' : ''}"
                        data-article-choice
                        data-article-slug="${escapeHtml(article.slug)}"
                        data-article-title="${escapeHtml(article.title || article.slug)}">
                  <div class="alltell-article-choice-icon">
                    <i class="fas ${isSelected ? 'fa-check' : 'fa-book-bookmark'}" aria-hidden="true"></i>
                  </div>
                  <div class="alltell-article-choice-info">
                    <span class="alltell-article-choice-title">${escapeHtml(article.title || article.slug)}</span>
                    ${tagsText ? `<span class="alltell-article-choice-tags">${tagsText}</span>` : ''}
                  </div>
                  <span class="alltell-article-choice-status">
                    ${isSelected ? '<i class="fas fa-check" aria-hidden="true"></i> Выбрана' : 'Выбрать'}
                  </span>
                </button>
              `;
            }).join('')}
          </div>
        `;
      }
      options.hidden = false;
    }

    function onMouseDown(event) {
      var postCmdBtn = event.target.closest('[data-post-cmd]');
      if (postCmdBtn) {
        event.preventDefault();
        var cmd = postCmdBtn.dataset.postCmd;
        if (cmd === 'highlight') {
          openPostHighlightPicker(postCmdBtn, state);
          return;
        }
        applyPostCommand(cmd, state, postCmdBtn.dataset);
        return;
      }
    }

    async function onClick(event) {
      var postCmdBtn = event.target.closest('[data-post-cmd]');
      if (postCmdBtn) {
        event.preventDefault();
        return;
      }
      var modeTab = event.target.closest('[data-post-mode]');
      if (modeTab) {
        event.preventDefault();
        var mode = modeTab.dataset.postMode || modeTab.getAttribute('data-mode');
        var form = modeTab.closest('[data-post-form]') || root.querySelector('[data-post-form]');
        setPostEditorMode(form, mode, state);
        return;
      }
      var fadeArrow = event.target.closest('.toolbar-fade');
      if (fadeArrow) {
        var scrollContainer = fadeArrow.closest('[data-alltell-toolbar-scroll]');
        if (scrollContainer) {
          var delta = fadeArrow.classList.contains('toolbar-fade-l') ? -180 : 180;
          scrollContainer.scrollBy({ left: delta, behavior: 'smooth' });
          return;
        }
      }
      var commentSticker = event.target.closest('.alltell-comment-sticker[data-pack-id]');
      if (commentSticker) {
        if (!token()) {
          if (typeof window.showModalLogin === 'function') window.showModalLogin('login');
          else window.location.href = '/admin-panel';
          return;
        }
        var socialPanel = commentSticker.closest('[data-post-social]');
        var commentElement = commentSticker.closest('[data-comment-id]');
        var targets = buildStickerReplyTargets(socialPanel.dataset.postId, socialPanel.dataset.franchiseId, commentElement.dataset.commentId);
        if (targets.length) {
          window.stickerPackView?.open(commentSticker.dataset.packId, { replyTargets: targets });
        }
        return;
      }
      var imageStep = event.target.closest('[data-image-step]');
      if (imageStep) {
        var track = imageStep.closest('[data-image-carousel]').querySelector('[data-image-track]');
        track.scrollBy({ left: Number(imageStep.dataset.imageStep) * track.clientWidth, behavior: 'smooth' });
        return;
      }
      var articleChoice = event.target.closest('[data-article-choice]');
      if (articleChoice) {
        var form = articleChoice.closest('[data-post-form]');
        var slug = articleChoice.dataset.articleSlug;
        var title = articleChoice.dataset.articleTitle;
        if (!slug) return;
        state.postArticles = state.postArticles || [];
        var existingIdx = state.postArticles.findIndex(function (a) { return a.slug === slug; });
        if (existingIdx >= 0) {
          state.postArticles.splice(existingIdx, 1);
        } else {
          var source = (state.articleIndex || []).find(function (a) { return a.slug === slug; });
          state.postArticles.push({
            slug: slug,
            title: title,
            is_public: source ? !!source.is_public : true
          });
        }
        var searchInput = form && form.querySelector('[data-article-search]');
        if (searchInput) {
          searchInput.value = '';
          searchInput.focus();
        }
        var options = form && form.querySelector('[data-article-options]');
        if (options) {
          options.hidden = true;
          options.replaceChildren();
        }
        updateArticlePickerUI(form);
        return;
      }
      var removeTagBtn = event.target.closest('[data-action="remove-article-tag"]');
      if (removeTagBtn) {
        var form = removeTagBtn.closest('[data-post-form]');
        var slugToRemove = removeTagBtn.dataset.slug;
        state.postArticles = (state.postArticles || []).filter(function (a) { return a.slug !== slugToRemove; });
        updateArticlePickerUI(form);
        return;
      }
      var searchInputEl = event.target.closest('[data-article-search]');
      if (searchInputEl) {
        if (searchInputEl.value.trim()) renderArticleOptions(searchInputEl);
        return;
      }
      var pickerBox = event.target.closest('[data-article-picker-box]');
      if (pickerBox && !event.target.closest('button, input')) {
        var input = pickerBox.querySelector('[data-article-search]');
        if (input) {
          input.focus();
          if (input.value.trim()) renderArticleOptions(input);
        }
        return;
      }
      var button = event.target.closest('[data-action]');
      if (!button) return;
      var action = button.dataset.action;
      if (action === 'switch-view') {
        switchView(button.dataset.view);
      } else if (action === 'switch-detail-tab') {
        state.detailTab = button.dataset.detailTab;
        if ((state.detailTab === 'manage' || state.detailTab === 'members') && state.detail) {
          loadWorkspaceData(state.detail.franchise.id).then(function () {
            if (state.workspaceTab === 'maps') loadMapsData(state.detail.franchise.id);
            else if (state.workspaceTab === 'log') loadAuditLog(state.detail.franchise.id);
            renderDetail(root, state);
          });
        }
        renderDetail(root, state);
      } else if (action === 'filter-feed') {
        state.feedFilter = button.dataset.filter;
        renderFeed(root, state);
      } else if (action === 'filter-catalog') {
        state.catalogFilter = button.dataset.filter;
        renderCatalog(root, state);
      } else if (action === 'clear-search') {
        state.query = '';
        state.catalogFilter = 'all';
        renderCatalog(root, state);
      } else if (action === 'toggle-post-like') {
        if (!token()) {
          if (typeof window.showModalLogin === 'function') window.showModalLogin('login');
          else window.location.href = '/admin-panel';
          return;
        }
        var likeRoot = button.closest('[data-post-social]');
        togglePostLike(likeRoot.dataset.postId, likeRoot.dataset.franchiseId);
      } else if (action === 'toggle-comments') {
        var commentsRoot = button.closest('[data-post-social]');
        var commentsPostId = commentsRoot.dataset.postId;
        var commentsFranchiseId = commentsRoot.dataset.franchiseId;
        var postSocial = getPostSocial(commentsPostId, commentsFranchiseId);
        if (!token()) {
          postSocial.open = !postSocial.open;
          renderSocialPanel(commentsPostId, commentsFranchiseId);
        } else if (postSocial.open) {
          postSocial.open = false;
          renderSocialPanel(commentsPostId, commentsFranchiseId);
        } else {
          loadPostComments(commentsPostId, commentsFranchiseId).catch(function (error) { notifyError(error.message); });
        }
      } else if (action === 'reload-comments') {
        var reloadRoot = button.closest('[data-post-social]');
        loadPostComments(reloadRoot.dataset.postId, reloadRoot.dataset.franchiseId).catch(function (error) { notifyError(error.message); });
      } else if (action === 'reply-comment') {
        var commentRoot = button.closest('[data-post-social]');
        var commentPostId = commentRoot.dataset.postId;
        var commentFranchiseId = commentRoot.dataset.franchiseId;
        var commentSocial = getPostSocial(commentPostId, commentFranchiseId);
        var targetComment = commentSocial.comments.find(function (comment) {
          return Number(comment.id) === Number(button.dataset.commentId);
        });
        if (!targetComment) return;
        commentSocial.replyTo = { id: targetComment.parentId || targetComment.id, authorName: button.dataset.author };
        commentSocial.open = true;
        renderSocialPanel(commentPostId, commentFranchiseId);
        root.querySelector('[data-post-social="' + postSocialKey(commentFranchiseId, commentPostId) + '"] [data-comment-form] textarea')?.focus();
      } else if (action === 'cancel-reply') {
        var replyPanel = button.closest('[data-post-social]');
        var replyState = getPostSocial(replyPanel.dataset.postId, replyPanel.dataset.franchiseId);
        replyState.replyTo = null;
        renderSocialPanel(replyPanel.dataset.postId, replyPanel.dataset.franchiseId);
      } else if (action === 'delete-comment') {
        var ok = window.confirmDialog
          ? await window.confirmDialog.open({
              title: 'Удалить комментарий?',
              message: 'Удалить комментарий вместе с ответами? Действие необратимо.',
              confirmLabel: 'Удалить',
              cancelLabel: 'Отмена',
              danger: true
            })
          : true;
        if (!ok) return;
        var deletePanel = button.closest('[data-post-social]');
        var deletePostId = deletePanel.dataset.postId;
        var deleteFranchiseId = deletePanel.dataset.franchiseId;
        request('/api/franchises/' + deleteFranchiseId + '/posts/' + deletePostId +
          '/comments/' + button.dataset.commentId, 'DELETE')
          .then(async function () {
            var deletedSocial = getPostSocial(deletePostId, deleteFranchiseId);
            deletedSocial.comments = await request('/api/franchises/' + deleteFranchiseId + '/posts/' + deletePostId + '/comments');
            deletedSocial.commentCount = deletedSocial.comments.length;
            renderSocialPanel(deletePostId, deleteFranchiseId);
          }).catch(function (error) { notifyError(error.message); });
      } else if (action === 'toggle-reaction') {
        if (!token()) {
          if (typeof window.showModalLogin === 'function') window.showModalLogin('login');
          else window.location.href = '/admin-panel';
          return;
        }
        togglePostReaction(button);
      } else if (action === 'open-sticker-picker') {
        if (!token()) {
          if (typeof window.showModalLogin === 'function') window.showModalLogin('login');
          else window.location.href = '/admin-panel';
          return;
        }
        openPostStickerPicker(button);
      } else if (action === 'login') {
        if (typeof window.showModalLogin === 'function') window.showModalLogin('login');
        else window.location.href = '/admin-panel';
      } else if (action === 'join') {
        button.disabled = true;
        joinFranchise().catch(function (error) {
          button.disabled = false;
          notifyError(error.message);
        });
      } else if (action === 'leave') {
        var ok = window.confirmDialog
          ? await window.confirmDialog.open({
              title: 'Отписка от франшизы',
              message: 'Отписаться от этой франшизы? Вы больше не будете участником и не увидите её в своей ленте.',
              confirmLabel: 'Отписаться',
              cancelLabel: 'Остаться',
              danger: true
            })
          : true;
        if (!ok) return;
        button.disabled = true;
        leaveFranchise().catch(function (error) {
          button.disabled = false;
          notifyError(error.message);
        });
      } else if (action === 'submit-post-form-top') {
        var postForm = root.querySelector('[data-post-form]');
        if (postForm) {
          if (typeof postForm.requestSubmit === 'function') postForm.requestSubmit();
          else postForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
        return;
      } else if (action === 'toggle-post-form') {
        state.editingPost = null;
        state.showPostForm = true;
        state.postBlocks = [{ id: genBlockId(), type: 'paragraph', data: { markdown: '' } }];
        setPostImages(null);
        setPostArticles(null);
        renderDetail(root, state);
        (root.querySelector('[data-post-form-container]') || root.querySelector('[data-post-form]'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        root.querySelector('#postTitleInput')?.focus();
      } else if (action === 'edit-post') {
        state.editingPost = state.detail.posts.find(function (post) {
          return String(post.id) === button.dataset.postId;
        }) || null;
        state.showPostForm = true;
        state.postBlocks = parsePostBlocks(state.editingPost ? state.editingPost.body : '');
        setPostImages(state.editingPost);
        setPostArticles(state.editingPost);
        renderDetail(root, state);
        (root.querySelector('[data-post-form-container]') || root.querySelector('[data-post-form]'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        root.querySelector('#postTitleInput')?.focus();
      } else if (action === 'cancel-edit') {
        state.editingPost = null;
        state.showPostForm = false;
        state.postBlocks = null;
        state._activePostBlockId = null;
        state._activePostTextarea = null;
        releasePostImages();
        state.postArticles = [];
        renderDetail(root, state);
      } else if (action === 'cancel-post-form') {
        state.editingPost = null;
        state.showPostForm = false;
        state.postBlocks = null;
        state._activePostBlockId = null;
        state._activePostTextarea = null;
        releasePostImages();
        state.postArticles = [];
        renderDetail(root, state);
      } else if (action === 'move-image') {
        var imageIndex = Number(button.dataset.imageIndex);
        var destination = imageIndex + Number(button.dataset.direction);
        if (destination >= 0 && destination < state.postImages.length) {
          var movedImage = state.postImages.splice(imageIndex, 1)[0];
          state.postImages.splice(destination, 0, movedImage);
          renderPostImageQueue();
        }
      } else if (action === 'remove-image') {
        var removedImage = state.postImages.splice(Number(button.dataset.imageIndex), 1)[0];
        if (removedImage && removedImage.preview && removedImage.preview.startsWith('blob:')) {
          URL.revokeObjectURL(removedImage.preview);
        }
        var hasUploadingOrPending = (state.postImages || []).some(function (img) {
          return img.uploading || (img.file && !img.url);
        });
        if (!hasUploadingOrPending) {
          state.uploadingImages = false;
          var form = root.querySelector('[data-post-form]');
          var progress = form && form.querySelector('[data-image-progress]');
          if (progress) progress.hidden = true;
        }
        renderPostImageQueue();
      } else if (action === 'approve-post' || action === 'reject-post') {
        var postId = button.dataset.postId;
        button.disabled = true;
        request('/api/franchises/' + state.detail.franchise.id + '/posts/' + postId + '/' + (action === 'approve-post' ? 'approve' : 'reject'), 'POST', {})
          .then(function (post) {
            state.detail.posts = state.detail.posts.map(function (item) { return item.id === post.id ? post : item; });
            renderDetail(root, state);
            showToast(action === 'approve-post' ? 'Предложение опубликовано' : 'Предложение отклонено');
          })
          .catch(function (error) {
            notifyError(error.message);
          });
      } else if (action === 'delete-post') {
        var ok = window.confirmDialog
          ? await window.confirmDialog.open({
              title: 'Удалить публикацию?',
              message: 'Удалить эту публикацию? Действие необратимо.',
              confirmLabel: 'Удалить',
              cancelLabel: 'Отмена',
              danger: true
            })
          : true;
        if (!ok) return;
        var postId = button.dataset.postId;
        button.disabled = true;
        request('/api/franchises/' + state.detail.franchise.id + '/posts/' + postId, 'DELETE')
          .then(function () {
            state.detail.posts = state.detail.posts.filter(function (post) { return String(post.id) !== postId; });
            renderDetail(root, state);
            showToast('Публикация удалена');
          })
          .catch(function (error) {
            notifyError(error.message);
          });
      } else if (action === 'open-create-franchise') {
        if (!token()) {
          if (typeof window.showModalLogin === 'function') window.showModalLogin('login');
          else window.location.href = '/admin-panel';
          return;
        }
        openCreateFranchiseModal();
      } else if (action === 'toggle-hub-preview') {
        toggleHubPreview(button.dataset.franchiseId, button.dataset.cardKey);
      } else if (action === 'close-hub-desc') {
        var modal = root.querySelector('[data-hub-modal="' + button.dataset.hubId + '"]');
        if (modal) modal.hidden = true;
      } else if (action === 'toggle-manage') {
        state.detailTab = (state.detailTab === 'manage' ? 'all' : 'manage');
        if (state.detailTab === 'manage' && state.detail) {
          loadWorkspaceData(state.detail.franchise.id).then(function () {
            if (state.workspaceTab === 'maps') loadMapsData(state.detail.franchise.id);
            else if (state.workspaceTab === 'log') loadAuditLog(state.detail.franchise.id);
            renderDetail(root, state);
          });
        }
        renderDetail(root, state);
      } else if (action === 'switch-ws-tab') {
        state.workspaceTab = button.dataset.wsTab;
        if (state.detail) {
          if (state.workspaceTab === 'maps') loadMapsData(state.detail.franchise.id).then(function () { renderDetail(root, state); });
          else if (state.workspaceTab === 'log') loadAuditLog(state.detail.franchise.id).then(function () { renderDetail(root, state); });
        }
        renderDetail(root, state);
      } else if (action === 'manage-add-member') {
        openAddMemberModal(state.detail.franchise.id);
      } else if (action === 'manage-assign-role') {
        openAssignRoleModal(state.detail.franchise.id, button.dataset.userId, button.dataset.userName);
      } else if (action === 'manage-remove-role') {
        removeMemberRole(state.detail.franchise.id, button.dataset.userId, button.dataset.roleId);
      } else if (action === 'manage-kick-member') {
        kickMember(state.detail.franchise.id, button.dataset.userId, button.dataset.userName);
      } else if (action === 'manage-create-role') {
        openRoleEditorModal(state.detail.franchise.id, null);
      } else if (action === 'manage-edit-role') {
        openRoleEditorModal(state.detail.franchise.id, button.dataset.roleId);
      } else if (action === 'manage-delete-role') {
        deleteRole(state.detail.franchise.id, button.dataset.roleId, button.dataset.roleName);
      } else if (action === 'manage-create-channel') {
        openChannelEditorModal(state.detail.franchise.id, null);
      } else if (action === 'manage-edit-channel') {
        openChannelEditorModal(state.detail.franchise.id, button.dataset.channelId);
      } else if (action === 'manage-delete-channel') {
        deleteChannel(state.detail.franchise.id, button.dataset.channelId, button.dataset.channelName);
      } else if (action === 'manage-create-hub') {
        state.detailTab = 'manage';
        state.workspaceTab = 'hubs';
        state.editingHubId = 'new';
        renderDetail(root, state);
        var hubTa = root.querySelector('[data-hub-form] textarea[data-autogrow]');
        if (hubTa) {
          hubTa.style.height = 'auto';
          hubTa.style.overflow = 'hidden';
          hubTa.style.height = Math.max(96, hubTa.scrollHeight) + 'px';
        }
        root.querySelector('[data-hub-form]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (action === 'manage-edit-hub') {
        state.editingHubId = button.dataset.hubId;
        renderDetail(root, state);
        var hubTa = root.querySelector('[data-hub-form] textarea[data-autogrow]');
        if (hubTa) {
          hubTa.style.height = 'auto';
          hubTa.style.overflow = 'hidden';
          hubTa.style.height = Math.max(96, hubTa.scrollHeight) + 'px';
        }
        root.querySelector('[data-hub-form]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (action === 'manage-cancel-hub') {
        state.editingHubId = null;
        renderDetail(root, state);
      } else if (action === 'manage-delete-hub') {
        deleteHub(state.detail.franchise.id, button.dataset.hubId, button.dataset.hubName);
      } else if (action === 'open-hub-info') {
        var franchiseId = button.dataset.franchiseId ? Number(button.dataset.franchiseId) : null;
        var hubId = Number(button.dataset.hubId);
        openHubInfoPopup(franchiseId, hubId);
      } else if (action === 'open-hub-desc') {
        var hubId = Number(button.dataset.hubId);
        var fId = state.detail && state.detail.franchise ? state.detail.franchise.id : null;
        openHubInfoPopup(fId, hubId);
      } else if (action === 'manage-toggle-create-map') {
        state.showCreateMap = !state.showCreateMap;
        renderDetail(root, state);
      } else if (action === 'manage-save-map') {
        saveNewMap(state.detail.franchise.id);
      } else if (action === 'manage-open-change-owner') {
        openChangeOwnerModal(state.detail.franchise.id);
      } else if (action === 'manage-delete-franchise') {
        deleteFranchise(state.detail.franchise.id, state.detail.franchise.name);
      } else if (action === 'manage-remove-settings-avatar') {
        var sPreview = root.querySelector('#settings-avatar-preview');
        var sUrlInput = root.querySelector('#settings-avatar-url');
        var sLabel = root.querySelector('#settings-avatar-label');
        if (sUrlInput) sUrlInput.value = '';
        if (sPreview) sPreview.innerHTML = escapeHtml(initials(state.detail && state.detail.franchise ? state.detail.franchise.name : ''));
        button.style.display = 'none';
        if (sLabel) sLabel.textContent = 'Загрузить аватарку';
      } else if (action === 'manage-remove-hub-avatar') {
        var hPreview = root.querySelector('#hub-avatar-preview');
        var hUrlInput = root.querySelector('#hub-avatar-url');
        var hLabel = root.querySelector('#hub-avatar-label');
        if (hUrlInput) hUrlInput.value = '';
        if (hPreview) hPreview.innerHTML = '<i class="fas fa-dice-d20"></i>';
        button.style.display = 'none';
        if (hLabel) hLabel.textContent = 'Загрузить аватарку';
      }
    }

    function onInput(event) {
      if (event.target.matches('[data-article-search]')) renderArticleOptions(event.target);
      if (event.target.matches('textarea[data-autogrow]')) {
        event.target.style.height = 'auto';
        event.target.style.overflow = 'hidden';
        event.target.style.height = Math.max(140, event.target.scrollHeight) + 'px';
      }
      if (event.target.matches('textarea[name="body"]')) {
        var form = event.target.closest('[data-post-form]');
        var counter = form ? form.querySelector('[data-char-counter]') : null;
        if (counter) {
          var len = event.target.value.length;
          counter.textContent = len.toLocaleString('ru-RU') + ' / 10 000';
          counter.classList.toggle('is-near-limit', len > 9500);
        }
        updatePostPreview(form);
      }
    }

    function onKeyDown(event) {
      if (event.target.matches('textarea[name="body"]')) {
        var mod = event.ctrlKey || event.metaKey;
        if (mod) {
          var key = event.key.toLowerCase();
          var form = event.target.closest('[data-post-form]') || root.querySelector('[data-post-form]');
          if (key === 'b') {
            event.preventDefault();
            applyPostFormat('bold', form);
          } else if (key === 'i') {
            event.preventDefault();
            applyPostFormat('italic', form);
          } else if (key === 'u') {
            event.preventDefault();
            applyPostFormat('underline', form);
          } else if (event.shiftKey && key === 'x') {
            event.preventDefault();
            applyPostFormat('strike', form);
          } else if (key === 'enter') {
            event.preventDefault();
            if (form) {
              if (typeof form.requestSubmit === 'function') form.requestSubmit();
              else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            }
          }
        }
      }
    }

    function onDragOver(event) {
      var dropzone = event.target.closest('[data-image-drop]');
      if (!dropzone || state.uploadingImages) return;
      event.preventDefault();
      dropzone.classList.add('is-dragging-files');
      dropzone.querySelectorAll('.is-drop-target').forEach(function (node) { node.classList.remove('is-drop-target'); });
      var target = event.target.closest('[data-post-image]');
      if (state.draggedImageIndex !== null && target) target.classList.add('is-drop-target');
    }

    function onImageDragStart(event) {
      var item = event.target.closest('[data-post-image]');
      if (!item || state.uploadingImages) return;
      state.draggedImageIndex = Number(item.dataset.postImage);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', 'alltell-image');
      item.classList.add('is-dragging');
    }

    function onImageDragEnd(event) {
      var item = event.target.closest('[data-post-image]');
      if (item) item.classList.remove('is-dragging');
      state.draggedImageIndex = null;
    }

    function onDragLeave(event) {
      var dropzone = event.target.closest('[data-image-drop]');
      if (!dropzone || dropzone.contains(event.relatedTarget)) return;
      dropzone.classList.remove('is-dragging-files');
      dropzone.querySelectorAll('.is-drop-target').forEach(function (node) { node.classList.remove('is-drop-target'); });
    }

    function onDrop(event) {
      var dropzone = event.target.closest('[data-image-drop]');
      if (!dropzone || state.uploadingImages) return;
      event.preventDefault();
      dropzone.classList.remove('is-dragging-files');
      var targetItem = event.target.closest('[data-post-image]');
      dropzone.querySelectorAll('.is-drop-target').forEach(function (node) { node.classList.remove('is-drop-target'); });
      if (state.draggedImageIndex !== null && targetItem) {
        var toIndex = Number(targetItem.dataset.postImage);
        var movedImage = state.postImages.splice(state.draggedImageIndex, 1)[0];
        state.postImages.splice(toIndex, 0, movedImage);
        state.draggedImageIndex = null;
        renderPostImageQueue();
      } else if (event.dataTransfer.files.length) {
        addPostImages(event.dataTransfer.files);
      }
    }

    function onScroll(event) {
      var scrollWrap = event.target.closest('[data-alltell-toolbar-scroll]');
      if (scrollWrap) {
        updatePostToolbarFade(scrollWrap);
      }
      var track = event.target.closest('[data-image-track]');
      if (!track) return;
      var carousel = track.closest('[data-image-carousel]');
      var count = carousel.querySelector('[data-image-count]');
      if (!count) return;
      var images = track.querySelectorAll('[data-image-index]');
      var activeIndex = Math.min(images.length - 1, Math.round(track.scrollLeft / track.clientWidth));
      count.textContent = (activeIndex + 1) + ' / ' + images.length;
    }

    function onChange(event) {
      if (event.target.matches('textarea[data-autogrow]')) {
        event.target.style.height = 'auto';
        event.target.style.overflow = 'hidden';
        event.target.style.height = Math.max(140, event.target.scrollHeight) + 'px';
      }
      if (event.target.id === 'settings-avatar-file') {
        var sFile = event.target.files && event.target.files[0];
        if (!sFile) return;
        var sLabel = root.querySelector('#settings-avatar-label');
        var sPrevText = sLabel ? sLabel.textContent : '';
        if (sLabel) sLabel.textContent = 'Загрузка…';
        event.target.disabled = true;
        uploadSingleImage(sFile).then(function (url) {
          var sPreview = root.querySelector('#settings-avatar-preview');
          var sUrlInput = root.querySelector('#settings-avatar-url');
          var sRemoveBtn = root.querySelector('#settings-avatar-remove');
          if (sUrlInput) sUrlInput.value = url;
          if (sPreview) sPreview.innerHTML = '<img src="' + escapeHtml(normalizeImageUrl(url)) + '" style="width:100%;height:100%;object-fit:cover;" alt="">';
          if (sRemoveBtn) sRemoveBtn.style.display = 'inline-flex';
          if (sLabel) sLabel.textContent = 'Сменить аватарку';
        }).catch(function (err) {
          notifyError(err.message);
          if (sLabel) sLabel.textContent = sPrevText;
        }).finally(function () {
          event.target.disabled = false;
          event.target.value = '';
        });
        return;
      }
      if (event.target.id === 'hub-avatar-file') {
        var hFile = event.target.files && event.target.files[0];
        if (!hFile) return;
        var hLabel = root.querySelector('#hub-avatar-label');
        var hPrevText = hLabel ? hLabel.textContent : '';
        if (hLabel) hLabel.textContent = 'Загрузка…';
        event.target.disabled = true;
        uploadSingleImage(hFile).then(function (url) {
          var hPreview = root.querySelector('#hub-avatar-preview');
          var hUrlInput = root.querySelector('#hub-avatar-url');
          var hRemoveBtn = root.querySelector('#hub-avatar-remove');
          if (hUrlInput) hUrlInput.value = url;
          if (hPreview) hPreview.innerHTML = '<img src="' + escapeHtml(normalizeImageUrl(url)) + '" style="width:100%;height:100%;object-fit:cover;" alt="">';
          if (hRemoveBtn) hRemoveBtn.style.display = 'inline-flex';
          if (hLabel) hLabel.textContent = 'Сменить аватарку';
        }).catch(function (err) {
          notifyError(err.message);
          if (hLabel) hLabel.textContent = hPrevText;
        }).finally(function () {
          event.target.disabled = false;
          event.target.value = '';
        });
        return;
      }
      if (event.target.matches('[data-action="toggle-hub-public"]')) {
        var checkbox = event.target;
        var hubId = checkbox.dataset.hubId;
        var fId = checkbox.dataset.franchiseId || (state.detail && state.detail.franchise ? state.detail.franchise.id : null);
        if (!fId || !hubId) return;
        var isPublic = checkbox.checked;
        checkbox.disabled = true;
        request('/api/servers/' + fId + '/hubs/' + hubId + '/visibility', 'PUT', { is_public: isPublic }).then(function () {
          showToast(isPublic ? 'Хаб теперь публичный' : 'Хаб теперь скрытый');
          if (state.workspaceData && state.workspaceData.hubs) {
            var h = state.workspaceData.hubs.find(function (x) { return String(x.id) === String(hubId); });
            if (h) h.is_public = isPublic ? 1 : 0;
          }
          if (state.detail && state.detail.hubs) {
            var h2 = state.detail.hubs.find(function (x) { return String(x.id) === String(hubId); });
            if (h2) h2.is_public = isPublic ? 1 : 0;
          }
          if (state.hubPreviewCache && state.hubPreviewCache.has(Number(fId))) {
            var cached = state.hubPreviewCache.get(Number(fId));
            var h3 = cached && cached.find(function (x) { return String(x.id) === String(hubId); });
            if (h3) h3.is_public = isPublic ? 1 : 0;
          }
          // Обновляем состояние чекбоксов и классов в DOM точечно, без перезагрузки всей страницы
          root.querySelectorAll('[data-action="toggle-hub-public"][data-hub-id="' + hubId + '"]').forEach(function (el) {
            el.checked = isPublic;
            el.disabled = false;
            var label = el.closest('.alltell-hub-pub-check, .alltell-hub-pub-toggle');
            if (label) {
              label.classList.toggle('is-pub', isPublic);
              label.classList.toggle('is-priv', !isPublic);
              label.title = isPublic ? 'Публичный хаб (виден всем). Нажмите, чтобы скрыть' : 'Скрытый хаб (виден только участникам). Нажмите, чтобы опубликовать';
              var span = label.querySelector('span');
              if (span && !label.classList.contains('alltell-hub-pub-check')) {
                span.textContent = isPublic ? 'Публичный' : 'Скрытый';
              }
            }
          });
        }).catch(function (err) {
          root.querySelectorAll('[data-action="toggle-hub-public"][data-hub-id="' + hubId + '"]').forEach(function (el) {
            el.checked = !isPublic;
            el.disabled = false;
            var label = el.closest('.alltell-hub-pub-check, .alltell-hub-pub-toggle');
            if (label) {
              label.classList.toggle('is-pub', !isPublic);
              label.classList.toggle('is-priv', isPublic);
            }
          });
          notifyError(err.message);
        });
        return;
      }
      if (event.target.matches('[data-action="change-hub-filter"]')) {
        state.catalogHubFilter = event.target.value;
        renderCatalog(root, state);
        return;
      }
      if (event.target.matches('[data-action="change-sort"]')) {
        state.catalogSort = event.target.value;
        renderCatalog(root, state);
        return;
      }
      if (event.target.matches('[data-action="manage-change-hub-status"]')) {
        changeHubStatus(state.detail.franchise.id, event.target.dataset.hubId, event.target.value);
        return;
      }
      if (event.target.matches('[name="images"]')) {
        if (state.uploadingImages) return;
        addPostImages(event.target.files);
        event.target.value = '';
        return;
      }
      var form = event.target.closest('[data-post-form]');
      if (!form || !event.target.matches('[name="hub_id"]')) return;
      var hubSelected = !!event.target.value;
      var statusField = form.querySelector('[data-hub-status-field]');
      var statusSelect = statusField.querySelector('[name="hub_status"]');
      statusField.hidden = !hubSelected;
      statusSelect.disabled = !hubSelected;
      statusSelect.value = '';
    }

    function onSubmit(event) {
      if (event.target.matches('[data-hub-form]')) {
        event.preventDefault();
        var hubFormData = new FormData(event.target);
        var hubPayload = {
          name: (hubFormData.get('name') || '').trim(),
          description: (hubFormData.get('description') || '').trim(),
          avatar_url: (hubFormData.get('avatar_url') || '').trim() || null
        };
        var isPubInput = event.target.querySelector('[name="is_public"]');
        if (isPubInput) {
          hubPayload.is_public = isPubInput.checked ? 1 : 0;
        } else if (state.editingHubId === 'new') {
          hubPayload.is_public = 1;
        }
        var fId = state.detail.franchise.id;
        var submitBtn = event.target.querySelector('#hub-form-submit-btn');
        if (submitBtn) submitBtn.disabled = true;
        (state.editingHubId === 'new'
          ? request('/api/servers/' + fId + '/hubs', 'POST', hubPayload)
          : request('/api/servers/' + fId + '/hubs/' + state.editingHubId, 'PUT', hubPayload)
        ).then(async function () {
          showToast(state.editingHubId === 'new' ? 'Хаб создан' : 'Хаб обновлён');
          state.editingHubId = null;
          await loadWorkspaceData(fId);
          if (state.detail) state.detail.hubs = state.workspaceData.hubs;
          renderDetail(root, state);
        }).catch(function (err) {
          if (submitBtn) submitBtn.disabled = false;
          notifyError(err.message);
        });
        return;
      }
      if (event.target.matches('[data-settings-form]')) {
        event.preventDefault();
        var setFormData = new FormData(event.target);
        var setPayload = {
          name: (setFormData.get('name') || '').trim(),
          description: (setFormData.get('description') || '').trim(),
          avatar_url: (setFormData.get('avatar_url') || '').trim() || null
        };
        var sFId = state.detail.franchise.id;
        var sBtn = event.target.querySelector('#save-settings-btn');
        if (sBtn) sBtn.disabled = true;
        request('/api/servers/' + sFId, 'PUT', setPayload).then(async function () {
          showToast('Настройки франшизы сохранены');
          if (sBtn) sBtn.disabled = false;
          state.detail.franchise.name = setPayload.name;
          state.detail.franchise.description = setPayload.description;
          state.detail.franchise.avatar_url = setPayload.avatar_url;
          renderDetail(root, state);
          loadMine();
        }).catch(function (err) {
          if (sBtn) sBtn.disabled = false;
          notifyError(err.message);
        });
        return;
      }
      if (event.target.matches('[data-search-form]')) {
        event.preventDefault();
        state.query = new FormData(event.target).get('q') || '';
        renderCatalog(root, state);
      } else if (event.target.matches('[data-comment-form]')) {
        event.preventDefault();
        if (!token()) {
          if (typeof window.showModalLogin === 'function') window.showModalLogin('login');
          else window.location.href = '/admin-panel';
          return;
        }
        submitPostComment(event.target);
      } else if (event.target.matches('[data-post-form]')) {
        event.preventDefault();
        if (state.submittingPost) return;
        var hasUploadingOrPending = (state.postImages || []).some(function (img) {
          return img.uploading || (img.file && !img.url);
        });
        if (hasUploadingOrPending && state.uploadingImages) {
          notifyError('Пожалуйста, дождитесь завершения загрузки изображений на сервер');
          return;
        }
        var formData = new FormData(event.target);
        state.submittingPost = true;
        var container = event.target.closest('[data-post-form-container]') || event.target;
        container.querySelectorAll('input, select, textarea, button').forEach(function (control) {
          control.disabled = true;
        });
        renderPostImageQueue();
        savePost(event.target, formData).catch(function (error) {
          notifyError(error.message);
          state.submittingPost = false;
          var progress = root.querySelector('[data-image-progress]');
          if (progress) progress.hidden = true;
          renderPostImageQueue();
          var activeContainer = root.querySelector('[data-post-form-container]') || root.querySelector('[data-post-form]');
          if (activeContainer) {
            activeContainer.querySelectorAll('input, select, textarea, button').forEach(function (control) {
              control.disabled = false;
            });
            var statusField = activeContainer.querySelector('[data-hub-status-field]');
            var hubSelect = activeContainer.querySelector('[name="hub_id"]');
            if (statusField && hubSelect && !hubSelect.value) {
              var statusSel = statusField.querySelector('[name="hub_status"]');
              if (statusSel) statusSel.disabled = true;
            }
          }
        });
      }
    }

    function onAuthChanged() {
      loadArticleIndex();
      if (new URLSearchParams(window.location.search).has('franchise')) {
        loadDetail(new URLSearchParams(window.location.search).get('franchise'));
      } else if (new URLSearchParams(window.location.search).get('view') === 'catalog') {
        loadCatalog();
      } else {
        loadFeed();
      }
    }

    function onDocClick(event) {
      var pickerField = event.target.closest('.alltell-article-picker-field');
      if (!pickerField) {
        root.querySelectorAll('[data-article-options]').forEach(function (opt) {
          opt.hidden = true;
        });
      }
      var createBtn = event.target.closest('[data-action="open-create-franchise"]');
      if (createBtn) {
        if (root && root.contains(createBtn)) return;
        if (!token()) {
          if (typeof window.showModalLogin === 'function') window.showModalLogin('login');
          else window.location.href = '/admin-panel';
          return;
        }
        openCreateFranchiseModal();
        return;
      }

      var flyoutToggle = event.target.closest('[data-action="toggle-hub-preview"]');
      var flyoutBox = event.target.closest('.alltell-card-hubs-flyout');
      var hubInfoBtn = event.target.closest('[data-action="open-hub-info"]');
      if (!state.detail && !flyoutToggle && !flyoutBox && !hubInfoBtn && (state.expandedCardKey || (state.expandedHubs && state.expandedHubs.size > 0))) {
        state.expandedCardKey = null;
        state.expandedHubs.clear();
        renderCatalog(root, state);
      }
    }

    root.addEventListener('mousedown', onMouseDown);
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('scroll', onScroll, true);
    root.addEventListener('change', onChange);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('dragleave', onDragLeave);
    root.addEventListener('drop', onDrop);
    root.addEventListener('dragstart', onImageDragStart);
    root.addEventListener('dragend', onImageDragEnd);
    root.addEventListener('submit', onSubmit);
    document.addEventListener('click', onDocClick);
    window.addEventListener('authChanged', onAuthChanged);
    await loadArticleIndex();
    await refreshCurrentView();
    return function () {
      state.disposed = true;
      closePostHighlightPicker();
      root.removeEventListener('mousedown', onMouseDown);
      root.removeEventListener('click', onClick);
      root.removeEventListener('input', onInput);
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('scroll', onScroll, true);
      root.removeEventListener('change', onChange);
      root.removeEventListener('dragover', onDragOver);
      root.removeEventListener('dragleave', onDragLeave);
      root.removeEventListener('drop', onDrop);
      root.removeEventListener('dragstart', onImageDragStart);
      root.removeEventListener('dragend', onImageDragEnd);
      root.removeEventListener('submit', onSubmit);
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('authChanged', onAuthChanged);
      window.clearTimeout(state.toastTimer);
      releasePostImages();
      document.querySelector('.alltell-toast')?.remove();
    };
  }

  window.AllTellClient = { init: init };
})();
