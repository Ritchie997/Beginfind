(function () {
  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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
    options = options || {};
    var headers = Object.assign({}, options.headers);
    var token = window.authManager && typeof window.authManager.getToken === 'function' ? window.authManager.getToken() : null;
    if (token && !headers.Authorization && !headers.authorization) {
      headers.Authorization = 'Bearer ' + token;
    }
    options.headers = headers;
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

  function renderEmpty(iconClass, text) {
    var empty = make('div', 'site-profile-empty');
    var icon = make('i', iconClass);
    var span = make('span', '', text);
    empty.append(icon, span);
    return empty;
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
    var user = window.authManager && window.authManager.getUser();
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
      avatar.style.cursor = '';
      avatar.title = '';
      avatar.onclick = null;
    } else {
      var image = document.createElement('img');
      image.src = src;
      if (window.avatarSrcSet) image.srcset = window.avatarSrcSet(src);
      image.alt = '';
      image.onerror = function () {
        avatar.classList.remove('has-image');
        avatar.textContent = name.trim().charAt(0).toUpperCase() || '?';
        avatar.style.cursor = '';
        avatar.title = '';
        avatar.onclick = null;
      };
      avatar.classList.add('has-image');
      avatar.appendChild(image);
      avatar.style.cursor = 'pointer';
      avatar.title = 'Нажмите для полноэкранного просмотра';
      avatar.onclick = function () {
        if (window.imageLightbox) {
          window.imageLightbox.open([src], 0);
        }
      };
    }
    el('publicProfileAvatarRemove').hidden = !profile.avatar;
    var user = window.authManager && window.authManager.getUser();
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
      var ok = window.confirmDialog
        ? await window.confirmDialog.open({
            title: 'Убрать аватар?',
            message: 'Убрать текущий аватар профиля?',
            confirmLabel: 'Убрать',
            cancelLabel: 'Отмена',
            danger: true
          })
        : true;
      if (!ok) return;
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

  // --- Вкладка "Статьи" ---
  function renderArticlesTab(articles, targetId) {
    var container = el('publicProfileMedia');
    container.replaceChildren();
    if (!articles || !articles.length) {
      container.appendChild(renderEmpty('fas fa-book-open', 'Пока нет ни одной статьи'));
      return;
    }
    var sorted = articles.slice().sort(function (a, b) {
      return new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at);
    });

    var list = make('div', 'site-profile-articles-list');
    sorted.forEach(function (article) {
      var slug = article.slug || article.id;
      var card = make('a', 'site-profile-article-card');
      card.href = '/antropedia/' + encodeURIComponent(slug);

      var isCoAuthor = String(article.author && article.author.id) !== String(targetId);
      var date = article.created_at ? new Date(article.created_at).toLocaleDateString('ru-RU') : '';

      var main = make('div', 'site-profile-article-main');
      var titleRow = make('div', 'site-profile-article-title');
      var icon = make('i', 'fas fa-file-alt');
      titleRow.appendChild(icon);
      titleRow.appendChild(document.createTextNode(' ' + (article.title || slug)));
      if (isCoAuthor) {
        titleRow.appendChild(document.createTextNode(' '));
        titleRow.appendChild(make('span', 'site-profile-coauthor-badge', 'соавтор'));
      }
      main.appendChild(titleRow);

      var meta = make('div', 'site-profile-article-meta');
      if (article.server) {
        meta.appendChild(make('span', 'site-profile-server-tag', article.server));
      }
      if (date) {
        meta.appendChild(make('span', 'site-profile-date', date));
      }
      main.appendChild(meta);
      card.appendChild(main);

      var arrow = make('i', 'fas fa-chevron-right site-profile-article-arrow');
      card.appendChild(arrow);
      list.appendChild(card);
    });
    container.appendChild(list);
  }

  // --- Вкладка "Арты" ---
  var PROFILE_ARTS_PAGE = 24;
  var artsOffset = 0;
  var artsTotal = 0;

  function renderArtCard(work) {
    if (typeof window.galleryCardHtml === 'function') {
      return window.galleryCardHtml(work);
    }
    var cover = work.cover;
    var coverUrl = cover ? safeImageUrl(cover.thumb || cover.url) : '';
    var title = work.title || 'Без названия';
    var pagesBadge = work.pagesCount > 1
      ? '<span class="site-profile-art-pages"><i class="far fa-images"></i> ' + work.pagesCount + '</span>'
      : '';
    var imgHtml = coverUrl
      ? '<img src="' + escapeHtml(coverUrl) + '" alt="' + escapeHtml(title) + '" loading="lazy">'
      : '<div class="gallery-card-empty"><i class="far fa-image"></i><span>Нет страниц</span></div>';

    return '<article class="site-profile-art-card gallery-card" data-work-id="' + escapeHtml(work.id) + '" tabindex="0" title="' + escapeHtml(title) + '">'
      + '<div class="site-profile-art-thumb">'
      + imgHtml
      + pagesBadge
      + '</div>'
      + '<div class="site-profile-art-meta">'
      + '<div class="site-profile-art-title">' + escapeHtml(title) + '</div>'
      + '<div class="site-profile-art-stats">'
      + '<span><i class="far fa-heart"></i> ' + (work.likes || 0) + '</span>'
      + '<span><i class="far fa-eye"></i> ' + (work.views || 0) + '</span>'
      + '</div>'
      + '</div>'
      + '</article>';
  }

  function renderArtsTab(data, isSelf, append) {
    var container = el('publicProfileMedia');
    var items = data && Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
    artsTotal = (data && typeof data.total === 'number') ? data.total : items.length;

    var artsCountEl = el('publicProfileArtsCount');
    if (artsCountEl) {
      artsCountEl.textContent = artsTotal ? ' (' + artsTotal + ')' : '';
    }

    if (!append) {
      container.replaceChildren();
      artsOffset = 0;

      if (isSelf) {
        var toolbar = make('div', 'site-profile-arts-toolbar');
        var uploadBtn = make('button', 'site-profile-button is-primary', ' Выложить работу');
        uploadBtn.type = 'button';
        var uploadIcon = make('i', 'fas fa-upload');
        uploadBtn.prepend(uploadIcon);
        uploadBtn.addEventListener('click', async function () {
          if (window.galleryEditor && typeof window.galleryEditor.open === 'function') {
            var saved = await window.galleryEditor.open(null);
            if (saved) {
              loadMedia('arts');
              if (window.galleryViewer && typeof window.galleryViewer.openWork === 'function') {
                window.galleryViewer.openWork(saved.id);
              }
            }
          } else {
            window.location.href = '/site/gallery.html#upload';
          }
        });
        toolbar.appendChild(uploadBtn);
        container.appendChild(toolbar);
      }

      if (!items.length) {
        container.appendChild(renderEmpty('fas fa-images', isSelf ? 'Вы ещё не выкладывали работ в галерею' : 'Пока нет ни одной работы в галерее'));
        return;
      }

      var grid = make('div', 'site-profile-arts-grid profile-arts-grid');
      grid.id = 'publicProfileArtsGrid';
      grid.addEventListener('click', function (e) {
        var card = e.target.closest('[data-work-id]');
        if (card && card.dataset.workId) {
          if (window.galleryViewer && typeof window.galleryViewer.openWork === 'function') {
            window.galleryViewer.openWork(card.dataset.workId);
          } else {
            window.location.href = '/site/gallery.html?work=' + encodeURIComponent(card.dataset.workId);
          }
        }
      });
      grid.addEventListener('keydown', function (e) {
        var card = e.target.closest('[data-work-id]');
        if (card && card.dataset.workId && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          if (window.galleryViewer && typeof window.galleryViewer.openWork === 'function') {
            window.galleryViewer.openWork(card.dataset.workId);
          } else {
            window.location.href = '/site/gallery.html?work=' + encodeURIComponent(card.dataset.workId);
          }
        }
      });
      container.appendChild(grid);

      var moreWrap = make('div', 'site-profile-arts-more-wrap');
      moreWrap.id = 'publicProfileArtsMoreWrap';
      var moreBtn = make('button', 'site-profile-button is-secondary', 'Показать ещё');
      moreBtn.type = 'button';
      moreBtn.id = 'publicProfileArtsMore';
      moreBtn.addEventListener('click', async function () {
        moreBtn.disabled = true;
        try {
          var moreData = await requestJson('/api/gallery/works?author=' + encodeURIComponent(currentTargetId) + '&sort=newest&limit=' + PROFILE_ARTS_PAGE + '&offset=' + artsOffset);
          renderArtsTab(moreData, isSelf, true);
        } catch (err) {
          showFeedback(err.message || 'Не удалось загрузить следующие работы', true);
        } finally {
          moreBtn.disabled = false;
        }
      });
      moreWrap.appendChild(moreBtn);
      container.appendChild(moreWrap);
    }

    var gridEl = el('publicProfileArtsGrid');
    if (gridEl) {
      gridEl.insertAdjacentHTML('beforeend', items.map(renderArtCard).join(''));
    }
    artsOffset += items.length;

    var wrapEl = el('publicProfileArtsMoreWrap');
    if (wrapEl) {
      wrapEl.hidden = artsOffset >= artsTotal;
    }
  }

  // --- Вкладка "Стикеры" ---
  function renderStickersTab(packs, isSelf, subscribedPacks) {
    var container = el('publicProfileMedia');
    container.replaceChildren();
    var createdPacks = Array.isArray(packs) ? packs : [];
    var statusLabels = { draft: 'Черновик', pending: 'На модерации', approved: 'Подтверждён', rejected: 'Отклонён' };

    if (!createdPacks.length && (!isSelf || !subscribedPacks || !subscribedPacks.length)) {
      container.appendChild(renderEmpty('fas fa-icons', isSelf
        ? 'Создать свой набор или добавить чужой можно во вкладке «Стикеры»'
        : 'Пользователь пока не создал и не подтвердил ни одного набора'));
      return;
    }

    if (createdPacks.length) {
      if (isSelf && subscribedPacks && subscribedPacks.length) {
        container.appendChild(make('h3', 'site-profile-subsection-title', 'Созданные наборы'));
      }
      var grid = make('div', 'site-profile-stickers-grid');
      createdPacks.forEach(function (pack) {
        var card = make('div', 'site-profile-sticker-card');
        card.tabIndex = 0;
        card.setAttribute('role', 'button');

        var thumbs = make('div', 'site-profile-sticker-thumbs');
        var preview = (pack.stickers || []).slice(0, 3);
        if (preview.length) {
          preview.forEach(function (s) {
            var thumb = make('div', 'site-profile-sticker-thumb');
            var img = document.createElement('img');
            img.src = s.fileUrl || s.url || '';
            img.alt = s.alias || '';
            img.loading = 'lazy';
            img.decoding = 'async';
            thumb.appendChild(img);
            thumbs.appendChild(thumb);
          });
        } else {
          thumbs.appendChild(make('span', 'site-profile-muted', 'Пусто'));
        }
        card.appendChild(thumbs);

        var info = make('div', 'site-profile-sticker-info');
        var nameRow = make('div', 'site-profile-sticker-name');
        nameRow.appendChild(document.createTextNode(pack.title || 'Набор'));
        if (isSelf && pack.status && pack.status !== 'approved') {
          nameRow.appendChild(document.createTextNode(' '));
          var badge = make('span', 'site-profile-badge', statusLabels[pack.status] || pack.status);
          nameRow.appendChild(badge);
        }
        info.appendChild(nameRow);

        var count = pack.stickersCount != null ? pack.stickersCount : preview.length;
        var meta = make('div', 'site-profile-sticker-meta', count + ' шт.' + (pack.isCoAuthor ? ' · соавтор' : ''));
        info.appendChild(meta);
        card.appendChild(info);

        card.addEventListener('click', function () {
          if (window.stickerPackView && typeof window.stickerPackView.open === 'function') {
            window.stickerPackView.open(pack.id);
          }
        });
        card.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (window.stickerPackView && typeof window.stickerPackView.open === 'function') {
              window.stickerPackView.open(pack.id);
            }
          }
        });
        grid.appendChild(card);
      });
      container.appendChild(grid);
    }

    if (isSelf && subscribedPacks && subscribedPacks.length) {
      var filteredSubscribed = subscribedPacks.filter(function (p) {
        return String(p.authorId) !== String(currentTargetId);
      });
      if (filteredSubscribed.length) {
        var addedWrap = make('div', 'site-profile-added-stickers');
        addedWrap.appendChild(make('h3', 'site-profile-subsection-title', 'Добавленные наборы'));
        var addedGrid = make('div', 'site-profile-stickers-grid');
        filteredSubscribed.forEach(function (pack) {
          var card = make('div', 'site-profile-sticker-card');
          card.tabIndex = 0;
          card.setAttribute('role', 'button');

          var removeBtn = make('button', 'site-profile-sticker-remove', '×');
          removeBtn.type = 'button';
          removeBtn.title = 'Убрать набор';
          removeBtn.setAttribute('aria-label', 'Убрать набор ' + (pack.title || ''));
          removeBtn.addEventListener('click', async function (e) {
            e.stopPropagation();
            try {
              await requestJson('/api/stickers/packs/' + encodeURIComponent(pack.id) + '/subscribe', { method: 'DELETE' });
              showFeedback('Набор стикеров убран.');
              loadMedia('stickers');
            } catch (err) {
              showFeedback(err.message || 'Не удалось убрать набор', true);
            }
          });
          card.appendChild(removeBtn);

          var thumbs = make('div', 'site-profile-sticker-thumbs');
          var preview = (pack.stickers || []).slice(0, 3);
          if (preview.length) {
            preview.forEach(function (s) {
              var thumb = make('div', 'site-profile-sticker-thumb');
              var img = document.createElement('img');
              img.src = s.fileUrl || s.url || '';
              img.alt = s.alias || '';
              img.loading = 'lazy';
              img.decoding = 'async';
              thumb.appendChild(img);
              thumbs.appendChild(thumb);
            });
          } else {
            thumbs.appendChild(make('span', 'site-profile-muted', 'Пусто'));
          }
          card.appendChild(thumbs);

          var info = make('div', 'site-profile-sticker-info');
          var nameRow = make('div', 'site-profile-sticker-name', pack.title || 'Набор');
          info.appendChild(nameRow);

          var metaText = (pack.authorName ? 'от ' + pack.authorName + ' · ' : '') + ((pack.stickers && pack.stickers.length) || preview.length) + ' шт.';
          var meta = make('div', 'site-profile-sticker-meta', metaText);
          info.appendChild(meta);
          card.appendChild(info);

          card.addEventListener('click', function () {
            if (window.stickerPackView && typeof window.stickerPackView.open === 'function') {
              window.stickerPackView.open(pack.id);
            }
          });
          card.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              if (window.stickerPackView && typeof window.stickerPackView.open === 'function') {
                window.stickerPackView.open(pack.id);
              }
            }
          });
          addedGrid.appendChild(card);
        });
        addedWrap.appendChild(addedGrid);
        container.appendChild(addedWrap);
      }
    }
  }

  // --- Вкладка "Закладки" ---
  function renderBookmarksTab(bookmarks) {
    var container = el('publicProfileMedia');
    container.replaceChildren();
    var list = Array.isArray(bookmarks) ? bookmarks : [];
    if (!list.length) {
      container.appendChild(renderEmpty('fas fa-bookmark', 'Пока нет ни одной закладки — откройте статью в Antropedia, выделите текст и добавьте закладку'));
      return;
    }

    var bySlug = new Map();
    list.forEach(function (b) {
      var slug = b.slug || 'unknown';
      if (!bySlug.has(slug)) {
        bySlug.set(slug, { title: b.title || slug, items: [] });
      }
      bySlug.get(slug).items.push(b);
    });

    bySlug.forEach(function (group, slug) {
      var groupEl = make('div', 'site-profile-bookmark-group');
      var head = make('a', 'site-profile-bookmark-head');
      head.href = '/antropedia/' + encodeURIComponent(slug);
      var headIcon = make('i', 'fas fa-file-alt');
      head.appendChild(headIcon);
      head.appendChild(document.createTextNode(' ' + group.title));
      groupEl.appendChild(head);

      var itemsList = make('div', 'site-profile-bookmark-list');
      group.items.forEach(function (b) {
        var item = make('a', 'site-profile-bookmark-item');
        var targetUrl = '/antropedia/' + encodeURIComponent(slug) + (b.blockId ? '#block-' + encodeURIComponent(b.blockId) : '');
        item.href = targetUrl;

        var dot = make('span', 'site-profile-bookmark-dot');
        dot.style.background = b.color || '#5865f2';
        item.appendChild(dot);

        var content = make('div', 'site-profile-bookmark-content');
        content.appendChild(make('div', 'site-profile-bookmark-name', b.name || 'Закладка'));
        if (b.quote) {
          content.appendChild(make('div', 'site-profile-bookmark-quote', b.quote));
        }
        item.appendChild(content);
        itemsList.appendChild(item);
      });
      groupEl.appendChild(itemsList);
      container.appendChild(groupEl);
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
      var me = window.authManager && window.authManager.getUser() || {};
      var isSelf = String(currentTargetId) === String(me.id);

      if (tab === 'articles') {
        var articles = await requestJson('/api/articles?author=' + encodeURIComponent(currentTargetId));
        if (requestId !== mediaRequestId || activeMediaTab !== tab) return;
        if (!Array.isArray(articles)) throw new Error('Сервер вернул неверный формат статей.');
        renderArticlesTab(articles, currentTargetId);
      } else if (tab === 'arts') {
        var artsData = await requestJson('/api/gallery/works?author=' + encodeURIComponent(currentTargetId) + '&sort=newest&limit=' + PROFILE_ARTS_PAGE + '&offset=0');
        if (requestId !== mediaRequestId || activeMediaTab !== tab) return;
        renderArtsTab(artsData, isSelf, false);
      } else if (tab === 'stickers') {
        var packs = await requestJson('/api/stickers/by-user/' + encodeURIComponent(currentTargetId));
        var subscribedPacks = null;
        if (isSelf) {
          try {
            subscribedPacks = await requestJson('/api/stickers/subscribed');
          } catch (err) {
            subscribedPacks = [];
          }
        }
        if (requestId !== mediaRequestId || activeMediaTab !== tab) return;
        if (!Array.isArray(packs)) throw new Error('Сервер вернул неверный формат наборов стикеров.');
        renderStickersTab(packs, isSelf, subscribedPacks);
      } else if (tab === 'bookmarks') {
        if (!isSelf) throw new Error('Закладки доступны только в собственном профиле.');
        var bookmarks = await requestJson('/api/bookmarks');
        if (requestId !== mediaRequestId || activeMediaTab !== tab) return;
        if (!Array.isArray(bookmarks)) throw new Error('Сервер вернул неверный формат закладок.');
        renderBookmarksTab(bookmarks);
      } else {
        throw new Error('Неизвестная вкладка профиля.');
      }

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
    var loginBtn = el('siteProfileLogin');
    if (loginBtn) {
      loginBtn.addEventListener('click', function () {
        if (typeof window.showModalLogin === 'function') window.showModalLogin('login');
      });
    }
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
