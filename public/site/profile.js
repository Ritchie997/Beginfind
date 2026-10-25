(function () {
  function el(id) {
    return document.getElementById(id);
  }

  function safeImageUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    var src = value.trim();
    if (src.startsWith('/uploads/')) return src;
    try {
      var url = new URL(src, window.location.origin);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch (error) {
      return '';
    }
  }

  async function requestJson(url, options) {
    var response = await fetch(url, options);
    var data = null;
    try { data = await response.json(); } catch (error) {
      if (!response.ok) throw new Error('Ошибка запроса (' + response.status + ')');
    }
    if (!response.ok) throw new Error(data && data.error || 'Ошибка запроса (' + response.status + ')');
    return data;
  }

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function showFeedback(text, isError) {
    var feedback = el('siteProfileFeedback');
    feedback.textContent = text;
    feedback.classList.toggle('is-error', !!isError);
    feedback.hidden = false;
    window.clearTimeout(showFeedback.timer);
    showFeedback.timer = window.setTimeout(function () { feedback.hidden = true; }, 4500);
  }

  function showForm(form, visible) {
    form.hidden = !visible;
    var section = form.closest('.site-profile-card, .site-profile-note');
    if (!section) return;
    var readView = section.querySelector('#publicProfileName, #publicProfileBio, #publicProfileNoteText');
    if (readView) readView.hidden = visible;
    var editButton = section.querySelector('#publicProfileNameEdit, #publicProfileBioEdit, #publicProfileNoteEdit');
    if (editButton) editButton.hidden = visible;
  }

  function updateCachedUser(changes) {
    var user = window.authManager.getUser();
    if (!user) return;
    window.authManager.setUser(Object.assign({}, user, changes));
    window.authManager.dispatchAuthEvent('profile_updated', { user: window.authManager.getUser() });
  }

  function setAvatar(profile) {
    var avatar = el('publicProfileAvatar');
    var name = profile.display_name || profile.username || '?';
    avatar.replaceChildren();
    var src = safeImageUrl(profile.avatar);
    if (!src) {
      avatar.classList.remove('has-image');
      avatar.textContent = name.trim().charAt(0).toUpperCase() || '?';
    } else {
      var image = document.createElement('img');
      image.src = src;
      image.srcset = window.avatarSrcSet(src);
      image.alt = '';
      image.onerror = function () {
        avatar.classList.remove('has-image');
        avatar.textContent = name.trim().charAt(0).toUpperCase() || '?';
      };
      avatar.classList.add('has-image');
      avatar.appendChild(image);
    }
    el('publicProfileAvatarRemove').hidden = !profile.avatar;
    var user = window.authManager.getUser();
    if (user && String(user.id) === String(profile.id)) {
      updateCachedUser({ avatar: profile.avatar || null });
    }
  }

  function renderServers(servers) {
    var list = el('publicProfileServers');
    list.replaceChildren();
    if (!servers.length) {
      el('publicProfileServersEmpty').hidden = false;
      return;
    }
    el('publicProfileServersEmpty').hidden = true;
    servers.forEach(function (server) {
      var row = make('div', 'site-profile-server');
      var name = make('strong', '', server.name || 'Сервер');
      var roles = make('span', '', (Array.isArray(server.roles) ? server.roles : []).join(', ') || 'Участник');
      row.append(name, roles);
      list.appendChild(row);
    });
  }

  function renderIdentity(profile) {
    var name = profile.display_name || profile.username || 'Пользователь';
    el('publicProfileName').textContent = name;
    el('publicProfileNameInput').value = name;
    el('publicProfileNameEdit').hidden = !profile.can_edit_name;
    el('publicProfileAvatarActions').hidden = !profile.can_edit_name;
    var role = profile.is_root ? 'Владелец' : profile.role_name || 'Пользователь';
    el('publicProfileRole').textContent = role;
    el('publicProfileRole').classList.toggle('is-owner', !!profile.is_root);
    var status = { approved: 'Подтверждён', pending: 'Ожидает подтверждения', rejected: 'Отклонён', blocked: 'Заблокирован' };
    if (profile.can_edit_note && profile.status) {
      el('publicProfileStatus').textContent = status[profile.status] || profile.status;
      el('publicProfileStatus').hidden = false;
    }
    if (profile.username) {
      el('publicProfileUsername').textContent = 'Логин: ' + profile.username;
      el('publicProfileUsername').hidden = false;
    }
    el('publicProfileJoined').textContent = profile.created_at
      ? 'На платформе с ' + new Date(profile.created_at).toLocaleDateString('ru-RU')
      : '';
    setAvatar(profile);
    document.title = name + ' — профиль AllTell';
  }

  function bindEditableProfile(profile, targetId, generation) {
    var nameForm = el('publicProfileNameForm');
    var bioForm = el('publicProfileBioForm');
    var noteForm = el('publicProfileNoteForm');
    var bioText = profile.bio || '';
    var noteText = profile.admin_note || '';

    el('publicProfileBio').textContent = bioText || (profile.can_edit_bio ? 'Вы ещё ничего не написали о себе.' : 'Пользователь пока ничего не рассказал о себе.');
    el('publicProfileBioEdit').hidden = !profile.can_edit_bio;
    el('publicProfileBioInput').value = bioText;
    el('publicProfileBioEdit').addEventListener('click', function () { showForm(bioForm, true); });
    el('publicProfileNameEdit').addEventListener('click', function () { showForm(nameForm, true); });
    document.querySelectorAll('#publicProfileContent [data-cancel]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (button.form === nameForm) el('publicProfileNameInput').value = profile.display_name || '';
        if (button.form === bioForm) el('publicProfileBioInput').value = bioText;
        if (button.form === noteForm) el('publicProfileNoteInput').value = noteText;
        showForm(button.form, false);
      });
    });

    nameForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      var displayName = el('publicProfileNameInput').value.trim();
      if (!displayName) {
        showFeedback('Имя не может быть пустым.', true);
        return;
      }
      var submit = nameForm.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        var data = await requestJson('/api/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ display_name: displayName })
        });
        if (generation !== profileLoadGeneration) return;
        profile.display_name = data.display_name;
        el('publicProfileName').textContent = data.display_name;
        setAvatar(profile);
        updateCachedUser({ display_name: data.display_name });
        showForm(nameForm, false);
        showFeedback('Имя профиля обновлено.');
      } catch (error) {
        if (generation !== profileLoadGeneration) return;
        showFeedback(error.message, true);
      } finally {
        if (generation === profileLoadGeneration) submit.disabled = false;
      }
    });

    bioForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      var submit = bioForm.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        var data = await requestJson('/api/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bio: el('publicProfileBioInput').value })
        });
        if (generation !== profileLoadGeneration) return;
        bioText = data.bio || '';
        profile.bio = bioText;
        el('publicProfileBio').textContent = bioText || 'Вы ещё ничего не написали о себе.';
        showForm(bioForm, false);
        showFeedback('Описание профиля обновлено.');
      } catch (error) {
        if (generation !== profileLoadGeneration) return;
        showFeedback(error.message, true);
      } finally {
        if (generation === profileLoadGeneration) submit.disabled = false;
      }
    });

    el('publicProfileAvatarUpload').addEventListener('click', function () { el('publicProfileAvatarInput').click(); });
    el('publicProfileAvatarInput').addEventListener('change', async function (event) {
      var file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      var form = new FormData();
      form.append('avatar', file);
      try {
        var data = await requestJson('/api/profile/avatar', { method: 'POST', body: form });
        if (generation !== profileLoadGeneration) return;
        profile.avatar = data.avatar || null;
        setAvatar(profile);
        showFeedback('Аватар обновлён.');
      } catch (error) {
        if (generation !== profileLoadGeneration) return;
        showFeedback(error.message, true);
      }
    });
    el('publicProfileAvatarRemove').addEventListener('click', async function () {
      if (!window.confirm('Убрать аватар?')) return;
      try {
        await requestJson('/api/profile/avatar', { method: 'DELETE' });
        if (generation !== profileLoadGeneration) return;
        profile.avatar = null;
        setAvatar(profile);
        showFeedback('Аватар удалён.');
      } catch (error) {
        if (generation !== profileLoadGeneration) return;
        showFeedback(error.message, true);
      }
    });

    el('publicProfileNote').hidden = !profile.can_edit_note;
    if (profile.can_edit_note) {
      el('publicProfileNoteText').textContent = noteText || 'Заметок пока нет.';
      el('publicProfileNoteInput').value = noteText;
      el('publicProfileNoteEdit').addEventListener('click', function () { showForm(noteForm, true); });
      noteForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        var submit = noteForm.querySelector('[type="submit"]');
        submit.disabled = true;
        try {
          var data = await requestJson('/api/users/' + encodeURIComponent(targetId) + '/note', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: el('publicProfileNoteInput').value })
          });
          if (generation !== profileLoadGeneration) return;
          noteText = data.admin_note || '';
          el('publicProfileNoteText').textContent = noteText || 'Заметок пока нет.';
          showForm(noteForm, false);
          showFeedback('Заметка сохранена.');
        } catch (error) {
          if (generation !== profileLoadGeneration) return;
          showFeedback(error.message, true);
        } finally {
          if (generation === profileLoadGeneration) submit.disabled = false;
        }
      });
    }
  }

  function renderRows(items, kind) {
    var container = el('publicProfileMedia');
    container.replaceChildren();
    if (!items.length) {
      container.appendChild(make('p', 'site-profile-muted', 'Здесь пока ничего нет.'));
      return;
    }
    items.forEach(function (item) {
      var row;
      var title;
      var detail;
      if (kind === 'articles') {
        var slug = item.slug || item.id;
        row = make('a', 'site-profile-media-row');
        row.href = '/antropedia/' + encodeURIComponent(slug);
        title = item.title || slug;
        detail = [item.server, item.created_at && new Date(item.created_at).toLocaleDateString('ru-RU')].filter(Boolean).join(' · ');
      } else if (kind === 'bookmarks') {
        row = make('a', 'site-profile-media-row');
        row.href = '/antropedia/' + encodeURIComponent(item.slug);
        title = item.name || item.title || item.slug || 'Закладка';
        detail = item.quote || item.title || '';
      } else {
        row = make('div', 'site-profile-media-row');
        title = item.title || item.name || 'Публикация';
        detail = kind === 'arts'
          ? (item.pagesCount ? item.pagesCount + ' страниц' : 'Работа в галерее')
          : [(item.stickersCount || 0) + ' стикеров', item.status && item.status !== 'approved' ? item.status : ''].filter(Boolean).join(' · ');
        if (kind === 'arts' && item.cover) {
          var cover = safeImageUrl(item.cover);
          if (cover) {
            var image = make('img', 'site-profile-media-cover');
            image.src = cover;
            image.alt = '';
            image.loading = 'lazy';
            row.appendChild(image);
          }
        }
      }
      var text = make('span', 'site-profile-media-copy');
      text.appendChild(make('strong', '', title));
      if (detail) text.appendChild(make('small', '', detail));
      row.appendChild(text);
      container.appendChild(row);
    });
  }

  var currentTargetId;
  var activeMediaTab;
  var mediaRequestId = 0;
  var profileLoadGeneration = 0;

  async function loadMedia(tab) {
    var requestId = ++mediaRequestId;
    activeMediaTab = tab;
    var status = el('publicProfileMediaStatus');
    status.classList.remove('is-error');
    status.textContent = 'Загрузка…';
    el('publicProfileMedia').replaceChildren();
    try {
      var paths = {
        articles: '/api/articles?author=' + encodeURIComponent(currentTargetId),
        arts: '/api/gallery/works?author=' + encodeURIComponent(currentTargetId) + '&sort=newest&limit=24',
        stickers: '/api/stickers/by-user/' + encodeURIComponent(currentTargetId),
        bookmarks: '/api/bookmarks'
      };
      var path = paths[tab];
      if (!path) throw new Error('Неизвестная вкладка профиля.');
      var data = await requestJson(path);
      if (requestId !== mediaRequestId || activeMediaTab !== tab) return;
      var items = tab === 'arts' ? data.data : data;
      if (!Array.isArray(items)) throw new Error('Сервер вернул неверный формат публикаций.');
      renderRows(items, tab);
      status.textContent = '';
      status.classList.remove('is-error');
    } catch (error) {
      if (requestId !== mediaRequestId || activeMediaTab !== tab) return;
      status.textContent = error.message;
      status.classList.add('is-error');
      var retry = make('button', 'site-profile-media-retry', 'Повторить');
      retry.type = 'button';
      retry.addEventListener('click', function () { loadMedia(tab); });
      status.appendChild(document.createTextNode(' '));
      status.appendChild(retry);
    }
  }

  function bindMediaTabs(isSelf) {
    var bookmarksTab = el('publicProfileBookmarksTab');
    bookmarksTab.hidden = !isSelf;
    document.querySelectorAll('[data-profile-tab]').forEach(function (button) {
      button.addEventListener('click', function () {
        var tab = button.dataset.profileTab;
        if (tab === 'bookmarks' && !isSelf) return;
        document.querySelectorAll('[data-profile-tab]').forEach(function (item) {
          var active = item === button;
          item.classList.toggle('is-active', active);
          item.setAttribute('aria-selected', String(active));
        });
        loadMedia(tab);
      });
    });
    loadMedia('articles');
  }

  async function loadProfile() {
    var generation = ++profileLoadGeneration;
    mediaRequestId++;
    var auth = window.authManager;
    el('siteProfileLogin').addEventListener('click', function () {
      if (typeof window.showModalLogin === 'function') window.showModalLogin('login');
    });
    if (!auth || !auth.isAuthenticated()) {
      el('siteProfileLoading').hidden = true;
      el('siteProfileGate').hidden = false;
      return;
    }

    try {
      if (!await auth.validateToken()) {
        if (generation !== profileLoadGeneration) return;
        el('siteProfileLoading').hidden = true;
        el('siteProfileGate').hidden = false;
        return;
      }
      if (generation !== profileLoadGeneration) return;
      var me = auth.getUser() || {};
      var pathId = window.location.pathname.match(/^\/profile\/([^/]+)\/?$/);
      var targetId = pathId ? decodeURIComponent(pathId[1]) : me.id;
      if (!targetId) throw new Error('Не удалось определить пользователя профиля.');
      currentTargetId = targetId;
      var data = await requestJson('/api/users/' + encodeURIComponent(targetId) + '/profile');
      if (generation !== profileLoadGeneration) return;
      var profile = data.profile;
      if (!profile || !profile.id) throw new Error('Сервер не вернул профиль пользователя.');

      renderIdentity(profile);
      renderServers(Array.isArray(profile.servers) ? profile.servers : []);
      bindEditableProfile(profile, targetId, generation);
      el('siteProfileLoading').hidden = true;
      el('siteProfileContent').hidden = false;
      bindMediaTabs(String(targetId) === String(me.id));
    } catch (error) {
      if (generation !== profileLoadGeneration) return;
      el('siteProfileLoading').hidden = true;
      el('siteProfileErrorText').textContent = error.message;
      el('siteProfileError').hidden = false;
    }
  }

  window.PublicProfile = {
    init: loadProfile,
    cleanup: function () {
      profileLoadGeneration++;
      mediaRequestId++;
      activeMediaTab = null;
      window.clearTimeout(showFeedback.timer);
    }
  };
})();
