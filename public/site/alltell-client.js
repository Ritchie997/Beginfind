(function () {
  'use strict';

  var HUB_STATUSES = {
    active: 'Ведётся',
    paused: 'Приостановлено',
    finished: 'Завершено'
  };
  var POST_TYPES = {
    news: 'Новость',
    announcement: 'Объявление',
    event: 'Событие'
  };

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

  function token() {
    return window.authManager && window.authManager.getToken();
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

  function dateLabel(value) {
    if (!value) return '';
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ru-RU', {
      dateStyle: 'medium',
      timeStyle: 'short'
    });
  }

  function initials(value) {
    var words = String(value || '').trim().split(/\s+/).filter(Boolean);
    return words.slice(0, 2).map(function (word) { return word.charAt(0); }).join('').toLocaleUpperCase() || '✶';
  }

  function franchiseCard(franchise, member) {
    var hubSummary = [
      franchise.active_hubs ? franchise.active_hubs + ' активных' : '',
      franchise.paused_hubs ? franchise.paused_hubs + ' на паузе' : '',
      franchise.finished_hubs ? franchise.finished_hubs + ' завершено' : ''
    ].filter(Boolean).join(' · ') || 'Хабов пока нет';
    var unread = Number(franchise.unread_count || 0);
    return `
      <article class="alltell-live-card">
        <div class="alltell-live-card-banner"></div>
        <div class="alltell-live-card-content">
          <div class="alltell-live-avatar">${escapeHtml(initials(franchise.name))}</div>
          <div class="alltell-live-title-row">
            <h3>${escapeHtml(franchise.name)}</h3>
            ${unread ? `<span class="alltell-unread-badge">${unread} новых</span>` : ''}
          </div>
          <p class="alltell-live-description">${escapeHtml(franchise.description || 'Описание пока не добавлено.')}</p>
          <p class="alltell-live-summary">
            <span><i class="fas fa-layer-group" aria-hidden="true"></i> ${Number(franchise.hub_count || 0)} хабов</span>
            <span>${escapeHtml(hubSummary)}</span>
          </p>
          <div class="alltell-live-card-foot">
            <span><i class="fas fa-user-group" aria-hidden="true"></i> ${Number(franchise.member_count || 0)} участников</span>
            <a class="btn btn-secondary btn-sm" href="/alltell?franchise=${Number(franchise.id)}">${member ? 'Открыть' : 'Подробнее'}</a>
          </div>
        </div>
      </article>`;
  }

  function renderCatalog(root, state) {
    var query = state.query.trim().toLocaleLowerCase();
    var franchises = state.franchises.filter(function (franchise) {
      return !query || (franchise.name + ' ' + (franchise.description || '')).toLocaleLowerCase().includes(query);
    });
    var mine = state.mine;
    root.innerHTML = `
      <div class="alltell-toolbar">
        <div>
          <h2><i class="fas fa-compass" aria-hidden="true"></i> Каталог франшиз</h2>
          <p>Выберите сообщество и присоединяйтесь к его истории.</p>
        </div>
        <form class="alltell-search" data-search-form>
          <label class="visually-hidden" for="alltell-search-input">Поиск франшиз</label>
          <input id="alltell-search-input" type="search" name="q" value="${escapeHtml(state.query)}" placeholder="Название или описание">
          <button class="btn btn-secondary" type="submit"><i class="fas fa-search" aria-hidden="true"></i> Найти</button>
        </form>
      </div>
      ${state.error ? `<div class="alltell-state alltell-error" role="alert">${escapeHtml(state.error)}</div>` : ''}
      ${state.mineError ? `<div class="alltell-state alltell-error" role="alert">${escapeHtml(state.mineError)}</div>` : ''}
      ${mine && mine.length ? `
        <section class="alltell-live-section" aria-labelledby="alltell-mine-heading">
          <div class="alltell-live-section-heading">
            <h2 id="alltell-mine-heading"><i class="fas fa-bookmark" aria-hidden="true"></i> Моё AllTell</h2>
            <span>Ваши франшизы и непрочитанные публикации</span>
          </div>
          <div class="alltell-live-grid">${mine.map(function (item) {
            var catalogItem = state.franchises.find(function (franchise) { return franchise.id === item.id; });
            return franchiseCard(Object.assign({
              active_hubs: 0, paused_hubs: 0, finished_hubs: 0, member_count: 0
            }, catalogItem || item, item), true);
          }).join('')}</div>
        </section>
      ` : ''}
      <section class="alltell-live-section" aria-labelledby="alltell-catalog-heading">
        <div class="alltell-live-section-heading">
          <h2 id="alltell-catalog-heading"><i class="fas fa-globe" aria-hidden="true"></i> Все франшизы</h2>
          <span>${franchises.length} ${franchises.length === 1 ? 'сообщество' : 'сообществ'}</span>
        </div>
        ${state.loading ? '<p class="alltell-state">Загружаем каталог…</p>' :
          franchises.length ? `<div class="alltell-live-grid">${franchises.map(function (franchise) {
            return franchiseCard(franchise, false);
          }).join('')}</div>` :
            `<div class="alltell-state"><i class="fas fa-compass" aria-hidden="true"></i><h3>${state.franchises.length ? 'Ничего не найдено' : 'Каталог пока пуст'}</h3><p>${state.franchises.length ? 'Измените поисковый запрос.' : 'Франшизы появятся здесь после публикации создателями.'}</p></div>`}
      </section>
      <p class="alltell-create-note">Создаёте собственный мир? <a href="/admin-panel">Создайте франшизу в AllTell</a>, а затем опубликуйте её.</p>
    `;
  }

  function renderPost(post, hubMap, canManage) {
    var hub = post.hub_id ? hubMap.get(String(post.hub_id)) : null;
    return `
      <article class="alltell-post-card">
        <div class="alltell-post-topline">
          <span class="alltell-post-type alltell-post-type-${escapeHtml(post.type)}">${escapeHtml(POST_TYPES[post.type] || 'Публикация')}</span>
          ${hub ? `<span class="alltell-post-hub"><i class="fas fa-layer-group" aria-hidden="true"></i> ${escapeHtml(hub.name)}</span>` : ''}
          ${post.type === 'event' && post.event_at ? `<time>${escapeHtml(dateLabel(post.event_at))}</time>` : ''}
        </div>
        <h3>${escapeHtml(post.title)}</h3>
        <p class="alltell-post-body">${escapeHtml(post.body)}</p>
        ${post.article ? `<a class="alltell-post-article" href="/antropedia/${encodeURIComponent(post.article.slug)}"><i class="fas fa-book-open" aria-hidden="true"></i> ${escapeHtml(post.article.title)}</a>` : ''}
        <div class="alltell-post-footer">
          <span>${escapeHtml(post.created_by_name)} · ${escapeHtml(dateLabel(post.created_at))}</span>
          ${canManage ? `<div class="alltell-post-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-action="edit-post" data-post-id="${Number(post.id)}">Изменить</button>
            <button type="button" class="btn btn-secondary btn-sm" data-action="delete-post" data-post-id="${Number(post.id)}">Удалить</button>
          </div>` : ''}
        </div>
      </article>`;
  }

  function renderPostForm(state, hubs) {
    var post = state.editingPost;
    var hubOptions = hubs.map(function (hub) {
      return `<option value="${Number(hub.id)}" ${post && Number(post.hub_id) === Number(hub.id) ? 'selected' : ''}>${escapeHtml(hub.name)}</option>`;
    }).join('');
    var dateValue = '';
    if (post && post.event_at) {
      var date = new Date(post.event_at);
      if (!Number.isNaN(date.getTime())) {
        dateValue = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      }
    }
    return `
      <form class="alltell-post-form" data-post-form>
        <h3>${post ? 'Редактировать публикацию' : 'Новая публикация'}</h3>
        <div class="alltell-form-row">
          <label>Тип
            <select name="type">
              ${Object.keys(POST_TYPES).map(function (type) {
                return `<option value="${type}" ${post && post.type === type ? 'selected' : ''}>${POST_TYPES[type]}</option>`;
              }).join('')}
            </select>
          </label>
          <label>Хаб
            <select name="hub_id">
              <option value="">Вся франшиза</option>${hubOptions}
            </select>
          </label>
        </div>
        <label>Заголовок<input name="title" maxlength="160" required value="${escapeHtml(post ? post.title : '')}"></label>
        <label>Текст<textarea name="body" maxlength="10000" rows="5" required>${escapeHtml(post ? post.body : '')}</textarea></label>
        <div class="alltell-form-row">
          <label>Дата и время события
            <input name="event_at" type="datetime-local" value="${escapeHtml(dateValue)}">
          </label>
          <label>Ссылка на открытую статью (slug)
            <input name="article_slug" maxlength="160" value="${escapeHtml(post && post.article ? post.article.slug : '')}" placeholder="например, istoriya-mira">
          </label>
        </div>
        <p class="alltell-form-hint">Дата нужна только для публикации типа «Событие». Ссылки разрешены только на статьи, доступные публично.</p>
        <div class="alltell-post-form-actions">
          <button class="btn btn-primary" type="submit">${post ? 'Сохранить' : 'Опубликовать'}</button>
          ${post ? '<button class="btn btn-secondary" type="button" data-action="cancel-edit">Отмена</button>' : ''}
        </div>
      </form>`;
  }

  function renderDetail(root, state) {
    var data = state.detail;
    var franchise = data.franchise;
    var member = data.is_member;
    var hubMap = new Map(data.hubs.map(function (hub) { return [String(hub.id), hub]; }));
    root.innerHTML = `
      <a class="alltell-back-link" href="/alltell"><i class="fas fa-arrow-left" aria-hidden="true"></i> К каталогу</a>
      ${state.error ? `<div class="alltell-state alltell-error" role="alert">${escapeHtml(state.error)}</div>` : ''}
      <header class="alltell-detail-header">
        <div class="alltell-live-avatar alltell-detail-avatar">${escapeHtml(initials(franchise.name))}</div>
        <div class="alltell-detail-heading">
          <h2>${escapeHtml(franchise.name)}</h2>
          <p>${escapeHtml(franchise.description || 'Описание пока не добавлено.')}</p>
          <span><i class="fas fa-user-group" aria-hidden="true"></i> ${Number(franchise.member_count || 0)} участников</span>
        </div>
        ${member ? '<span class="alltell-member-label"><i class="fas fa-check" aria-hidden="true"></i> Вы участник</span>' :
          `<button class="btn btn-primary" type="button" data-action="${token() ? 'join' : 'login'}">${token() ? 'Вступить во франшизу' : 'Войти, чтобы вступить'}</button>`}
      </header>
      <section class="alltell-live-section">
        <div class="alltell-live-section-heading"><h2><i class="fas fa-layer-group" aria-hidden="true"></i> Хабы</h2><span>${data.hubs.length} направлений</span></div>
        ${data.hubs.length ? `<div class="alltell-hub-grid">${data.hubs.map(function (hub) {
          return `<article class="alltell-hub-card">
            <div class="alltell-hub-heading"><h3>${escapeHtml(hub.name)}</h3><span class="alltell-hub-status alltell-hub-status-${escapeHtml(hub.status)}">${escapeHtml(HUB_STATUSES[hub.status] || 'Неизвестно')}</span></div>
            <p>${escapeHtml(hub.description || 'Описание пока не добавлено.')}</p>
            <span class="alltell-hub-date">Создан ${escapeHtml(dateLabel(hub.created_at))}</span>
          </article>`;
        }).join('')}</div>` : '<div class="alltell-state"><p>В этой франшизе пока нет хабов.</p></div>'}
      </section>
      <section class="alltell-live-section">
        <div class="alltell-live-section-heading">
          <h2><i class="fas fa-bullhorn" aria-hidden="true"></i> Новости и события</h2>
          <span>${data.posts.length} публикаций</span>
        </div>
        ${data.can_manage ? renderPostForm(state, data.hubs) : ''}
        ${data.posts.length ? `<div class="alltell-post-list">${data.posts.map(function (post) {
          return renderPost(post, hubMap, data.can_manage);
        }).join('')}</div>` : `<div class="alltell-state"><p>${data.can_manage ? 'Добавьте первую новость, объявление или событие.' : 'Публикаций пока нет.'}</p></div>`}
      </section>
    `;
  }

  async function init() {
    var root = document.getElementById('alltell-app');
    if (!root) return null;
    var main = root.closest('.site-main');
    var section = root.closest('section');
    if (main && section) main.replaceChildren(section);
    var state = {
      franchises: [],
      mine: [],
      detail: null,
      editingPost: null,
      loading: true,
      error: '',
      mineError: '',
      query: '',
      disposed: false,
      toastTimer: null
    };

    function showToast(message) {
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

    async function loadCatalog() {
      state.loading = true;
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

    async function loadDetail(franchiseId) {
      state.detail = null;
      state.error = '';
      root.innerHTML = '<p class="alltell-state">Загружаем франшизу…</p>';
      try {
        state.detail = await request('/api/public/franchises/' + encodeURIComponent(franchiseId));
        if (state.disposed) return;
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
      var franchiseId = new URLSearchParams(window.location.search).get('franchise');
      if (franchiseId && /^\d+$/.test(franchiseId)) return loadDetail(franchiseId);
      return loadCatalog();
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

    async function savePost(form) {
      var formData = new FormData(form);
      var payload = {
        type: formData.get('type'),
        hub_id: formData.get('hub_id'),
        title: formData.get('title'),
        body: formData.get('body'),
        article_slug: formData.get('article_slug'),
        event_at: formData.get('event_at')
      };
      if (payload.type !== 'event') payload.event_at = '';
      else if (payload.event_at) {
        var eventDate = new Date(payload.event_at);
        if (Number.isNaN(eventDate.getTime())) throw new Error('Укажите корректные дату и время события');
        payload.event_at = eventDate.toISOString();
      }
      var franchiseId = state.detail.franchise.id;
      var postId = state.editingPost && state.editingPost.id;
      var post = await request('/api/franchises/' + franchiseId + '/posts' + (postId ? '/' + postId : ''), postId ? 'PUT' : 'POST', payload);
      if (postId) {
        state.detail.posts = state.detail.posts.map(function (item) { return item.id === post.id ? post : item; });
      } else {
        state.detail.posts.unshift(post);
      }
      state.editingPost = null;
      renderDetail(root, state);
      showToast(postId ? 'Публикация обновлена' : 'Публикация добавлена');
    }

    function onClick(event) {
      var button = event.target.closest('[data-action]');
      if (!button) return;
      var action = button.dataset.action;
      if (action === 'login') {
        if (typeof window.showModalLogin === 'function') window.showModalLogin('login');
        else window.location.href = '/admin-panel';
      } else if (action === 'join') {
        button.disabled = true;
        joinFranchise().catch(function (error) {
          state.error = error.message;
          renderDetail(root, state);
        });
      } else if (action === 'edit-post') {
        state.editingPost = state.detail.posts.find(function (post) {
          return String(post.id) === button.dataset.postId;
        }) || null;
        renderDetail(root, state);
        root.querySelector('[data-post-form]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (action === 'cancel-edit') {
        state.editingPost = null;
        renderDetail(root, state);
      } else if (action === 'delete-post') {
        if (!window.confirm('Удалить эту публикацию?')) return;
        var postId = button.dataset.postId;
        button.disabled = true;
        request('/api/franchises/' + state.detail.franchise.id + '/posts/' + postId, 'DELETE')
          .then(function () {
            state.detail.posts = state.detail.posts.filter(function (post) { return String(post.id) !== postId; });
            renderDetail(root, state);
            showToast('Публикация удалена');
          })
          .catch(function (error) {
            state.error = error.message;
            renderDetail(root, state);
          });
      }
    }

    function onSubmit(event) {
      if (event.target.matches('[data-search-form]')) {
        event.preventDefault();
        state.query = new FormData(event.target).get('q') || '';
        renderCatalog(root, state);
      } else if (event.target.matches('[data-post-form]')) {
        event.preventDefault();
        var submitButton = event.target.querySelector('[type="submit"]');
        submitButton.disabled = true;
        savePost(event.target).catch(function (error) {
          state.error = error.message;
          var form = root.querySelector('[data-post-form]');
          if (!form) return;
          var message = document.createElement('p');
          message.className = 'alltell-form-error';
          message.setAttribute('role', 'alert');
          message.textContent = error.message;
          form.prepend(message);
          form.querySelector('[type="submit"]').disabled = false;
        });
      }
    }

    function onAuthChanged() {
      if (new URLSearchParams(window.location.search).has('franchise')) {
        loadDetail(new URLSearchParams(window.location.search).get('franchise'));
      } else {
        loadCatalog();
      }
    }

    root.addEventListener('click', onClick);
    root.addEventListener('submit', onSubmit);
    window.addEventListener('authChanged', onAuthChanged);
    await refreshCurrentView();
    return function () {
      state.disposed = true;
      root.removeEventListener('click', onClick);
      root.removeEventListener('submit', onSubmit);
      window.removeEventListener('authChanged', onAuthChanged);
      window.clearTimeout(state.toastTimer);
      document.querySelector('.alltell-toast')?.remove();
    };
  }

  window.AllTellClient = { init: init };
})();
