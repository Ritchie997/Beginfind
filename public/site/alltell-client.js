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
          ${renderViewTabs(state.view)}
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
      <p class="alltell-create-note">Создаёте собственный мир? <a href="/admin-panel">Создайте франшизу в AllTell</a> — она появится в каталоге автоматически.</p>
    `;
  }

  function renderViewTabs(view) {
    return `<nav class="alltell-view-tabs" aria-label="Раздел AllTell">
      <button type="button" data-action="switch-view" data-view="feed" class="${view === 'feed' ? 'active' : ''}" aria-current="${view === 'feed' ? 'page' : 'false'}"><i class="fas fa-house" aria-hidden="true"></i> Лента</button>
      <button type="button" data-action="switch-view" data-view="catalog" class="${view === 'catalog' ? 'active' : ''}" aria-current="${view === 'catalog' ? 'page' : 'false'}"><i class="fas fa-compass" aria-hidden="true"></i> Каталог франшиз</button>
    </nav>`;
  }

  function renderFeed(root, state) {
    var feedPosts = state.feedPosts || [];
    var user = window.authManager && window.authManager.getUser();
    root.innerHTML = `
      <div class="alltell-toolbar">
        <div>
          ${renderViewTabs(state.view)}
          <h2><i class="fas fa-house" aria-hidden="true"></i> Лента подписок</h2>
          <p>Свежие публикации франшиз, на которые вы подписаны.</p>
        </div>
      </div>
      ${state.error ? `<div class="alltell-state alltell-error" role="alert">${escapeHtml(state.error)}</div>` : ''}
      ${!token()
        ? `<div class="alltell-state"><h3>Войдите, чтобы открыть свою ленту</h3><p>В ленте собраны новости франшиз, к которым вы присоединились.</p><button type="button" class="btn btn-primary" data-action="login">Войти</button></div>`
        : state.loading
          ? '<p class="alltell-state">Загружаем ленту…</p>'
          : !state.followedCount
            ? `<div class="alltell-state"><h3>Вы пока не подписаны на франшизы</h3><p>Откройте каталог, найдите интересные сообщества и присоединитесь к ним.</p><button type="button" class="btn btn-primary" data-action="switch-view" data-view="catalog">Открыть каталог франшиз</button></div>`
            : feedPosts.length
              ? `<div class="alltell-post-list">${feedPosts.map(function (post) {
                var postSocial = state.postSocial[postSocialKey(post.franchise_id, post.id)];
                return `<div class="alltell-feed-item">
                  <a class="alltell-feed-franchise" href="/alltell?franchise=${Number(post.franchise_id)}"><i class="fas fa-users" aria-hidden="true"></i> ${escapeHtml(post.franchise_name)}${post.hub_name ? ' · ' + escapeHtml(post.hub_name) : ''}</a>
                  ${renderPost(post, new Map(), false, postSocial, user && user.id, true, post.franchise_id)}
                </div>`;
              }).join('')}</div>`
              : '<div class="alltell-state"><h3>Лента пока пуста</h3><p>В подписанных франшизах ещё нет опубликованных записей.</p><button type="button" class="btn btn-secondary" data-action="switch-view" data-view="catalog">Посмотреть каталог</button></div>'}
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
    return `<article class="alltell-comment${replies ? ' alltell-comment-top' : ''}" data-comment-id="${Number(comment.id)}">
      <div class="alltell-comment-heading">${comment.authorAvatar ? `<img src="${escapeHtml(comment.authorAvatar)}" alt="">` : ''}<strong>${escapeHtml(comment.authorName)}</strong><time>${escapeHtml(dateLabel(comment.createdAt))}</time></div>
      <div class="alltell-comment-content">${renderStickerText(comment)}</div>
      <div class="alltell-comment-actions">${reactions}
        <button type="button" class="alltell-comment-reply" data-action="reply-comment" data-comment-id="${Number(comment.id)}" data-author="${escapeHtml(comment.authorName)}"><i class="far fa-message" aria-hidden="true"></i> Ответить</button>
        ${own || canManage ? `<button type="button" class="alltell-comment-delete" data-action="delete-comment" data-comment-id="${Number(comment.id)}">Удалить</button>` : ''}
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
          ${social.replyTo ? `<div class="alltell-replying">Ответ для ${escapeHtml(social.replyTo.authorName)} <button type="button" data-action="cancel-reply">Отмена</button></div>` : ''}
          <textarea name="content" rows="2" maxlength="2000" placeholder="Напишите комментарий…" required>${escapeHtml(social.replyTo
            ? `@${/\s/.test(social.replyTo.authorName) ? '[' + social.replyTo.authorName + ']' : social.replyTo.authorName} `
            : '')}</textarea>
          <div class="alltell-comment-form-actions">
            <button class="alltell-sticker-insert" type="button" data-action="open-sticker-picker" data-picker-mode="insert" data-target-type="comment" data-target-id="${Number(post.id)}"><i class="far fa-face-smile" aria-hidden="true"></i> Стикеры</button>
            <button class="btn btn-primary btn-sm" type="submit">${social.replyTo ? 'Ответить' : 'Отправить'}</button>
          </div>
        </form>`
      : (social.open ? '<p class="alltell-comment-login"><button type="button" data-action="login">Войдите, чтобы комментировать и ставить реакции</button></p>' : '');
    return `<div class="alltell-post-social" data-post-social="${postSocialKey(franchiseId, post.id)}" data-franchise-id="${Number(franchiseId)}" data-post-id="${Number(post.id)}">
      <div class="alltell-social-actions">
        <button type="button" class="alltell-like-button${social.liked ? ' active' : ''}" data-action="toggle-post-like" data-post-id="${Number(post.id)}"><i class="${social.liked ? 'fas' : 'far'} fa-heart" aria-hidden="true"></i> <span>${Number(social.likes || 0)}</span></button>
        <button type="button" class="alltell-comments-toggle" data-action="toggle-comments" data-post-id="${Number(post.id)}"><i class="far fa-comment" aria-hidden="true"></i> ${commentsLabel(Number(social.commentCount || 0))}</button>
      </div>
      ${renderReactionBar(social.reactions || [], 'franchise_post', post.id)}
      <section class="alltell-comments-panel" ${social.open ? '' : 'hidden'}>
        <div class="alltell-comments-list">${social.loaded
          ? (commentsHtml || '<p class="alltell-comments-empty">Комментариев пока нет.</p>')
          : (social.loading ? '<p class="alltell-comments-empty">Загружаем комментарии…</p>'
            : (social.loadError ? `<p class="alltell-comments-empty">${escapeHtml(social.loadError)} <button type="button" data-action="reload-comments" data-post-id="${Number(post.id)}">Повторить</button></p>`
              : (loggedIn ? '<p class="alltell-comments-empty">Загрузка комментариев…</p>' : '')))}</div>
        ${compose}
      </section>
      <div class="alltell-sticker-picker" data-sticker-picker hidden></div>
    </div>`;
  }

  function renderPost(post, hubMap, canManage, social, userId, loggedIn, franchiseId) {
    franchiseId = franchiseId || post.franchise_id;
    var hub = post.hub_id ? hubMap.get(String(post.hub_id)) : null;
    var canEdit = canManage || post.can_edit;
    var images = Array.isArray(post.images) && post.images.length
      ? post.images
      : (post.image_url ? [post.image_url] : []);
    var articleHref = post.article && (post.article.is_public
      ? '/antropedia/' + encodeURIComponent(post.article.slug)
      : '/admin-panel/antropedia/' + encodeURIComponent(post.article.slug));
    return `
      <article class="alltell-post-card">
        <div class="alltell-post-topline">
          <span class="alltell-post-type alltell-post-type-${escapeHtml(post.type)}">${escapeHtml(POST_TYPES[post.type] || 'Публикация')}</span>
          ${hub ? `<span class="alltell-post-hub"><i class="fas fa-layer-group" aria-hidden="true"></i> ${escapeHtml(hub.name)}</span>` : ''}
          ${post.hub_status ? `<span class="alltell-hub-status alltell-hub-status-${escapeHtml(post.hub_status)}">${escapeHtml(HUB_STATUSES[post.hub_status] || '')}</span>` : ''}
          ${post.approval_status !== 'published' ? `<span class="alltell-post-review alltell-post-review-${escapeHtml(post.approval_status)}">${escapeHtml(POST_STATUS_LABELS[post.approval_status] || '')}</span>` : ''}
        </div>
        <h3>${escapeHtml(post.title)}</h3>
        ${images.length ? `<div class="alltell-post-carousel" data-image-carousel>
          <div class="alltell-post-images" data-image-track>
            ${images.map(function (image, index) {
              return `<img class="alltell-post-image" src="${escapeHtml(image)}" alt="" loading="lazy" data-image-index="${index}">`;
            }).join('')}
          </div>
          ${images.length > 1 ? `<button class="alltell-image-arrow alltell-image-prev" type="button" data-image-step="-1" aria-label="Предыдущее изображение"><i class="fas fa-chevron-left" aria-hidden="true"></i></button>
          <button class="alltell-image-arrow alltell-image-next" type="button" data-image-step="1" aria-label="Следующее изображение"><i class="fas fa-chevron-right" aria-hidden="true"></i></button>
          <span class="alltell-image-count" data-image-count>1 / ${images.length}</span>` : ''}
        </div>` : ''}
        ${post.body ? `<p class="alltell-post-body">${escapeHtml(post.body)}</p>` : ''}
        ${post.article && articleHref ? `<a class="alltell-post-article" href="${escapeHtml(articleHref)}"><i class="fas fa-book-open" aria-hidden="true"></i> Статья: ${escapeHtml(post.article.title)}</a>` : ''}
        <div class="alltell-post-footer">
          <span>${escapeHtml(post.created_by_name)} · ${escapeHtml(dateLabel(post.created_at))}</span>
          ${canEdit || (canManage && post.approval_status === 'pending') ? `<div class="alltell-post-actions">
            ${canManage && post.approval_status === 'pending' ? `<button type="button" class="btn btn-primary btn-sm" data-action="approve-post" data-post-id="${Number(post.id)}">Подтвердить</button>
            <button type="button" class="btn btn-secondary btn-sm" data-action="reject-post" data-post-id="${Number(post.id)}">Отклонить</button>` : ''}
            ${canEdit ? `
            <button type="button" class="btn btn-secondary btn-sm" data-action="edit-post" data-post-id="${Number(post.id)}">Изменить</button>
            <button type="button" class="btn btn-secondary btn-sm" data-action="delete-post" data-post-id="${Number(post.id)}">Удалить</button>` : ''}
          </div>` : ''}
        </div>
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
      return `<article class="alltell-form-image-item${image.file ? ' is-pending' : ''}" data-post-image="${index}" ${disabled ? '' : 'draggable="true"'}>
        <img class="alltell-form-image-preview" src="${escapeHtml(image.preview || image.url)}" alt="${escapeHtml(image.file ? image.file.name : 'Изображение ' + (index + 1))}">
        ${image.file ? '<span class="alltell-image-pending">Ожидает загрузки</span>' : ''}
        <div class="alltell-form-image-actions">
          <button class="btn btn-secondary btn-sm" type="button" data-action="move-image" data-direction="-1" data-image-index="${index}" aria-label="Переместить влево" ${index === 0 || disabled ? 'disabled' : ''}><i class="fas fa-arrow-left" aria-hidden="true"></i></button>
          <button class="btn btn-secondary btn-sm" type="button" data-action="move-image" data-direction="1" data-image-index="${index}" aria-label="Переместить вправо" ${index === images.length - 1 || disabled ? 'disabled' : ''}><i class="fas fa-arrow-right" aria-hidden="true"></i></button>
          <button class="btn btn-secondary btn-sm" type="button" data-action="remove-image" data-image-index="${index}" ${disabled ? 'disabled' : ''}>Убрать</button>
        </div>
      </article>`;
    }).join('');
  }

  function renderPostForm(state, hubs, canManage) {
    var post = state.editingPost;
    var images = state.postImages || [];
    var hubOptions = hubs.map(function (hub) {
      return `<option value="${Number(hub.id)}" ${post && Number(post.hub_id) === Number(hub.id) ? 'selected' : ''}>${escapeHtml(hub.name)}</option>`;
    }).join('');
    var article = post && post.article;
    var articleTitle = article ? article.title : '';
    return `
      <form class="alltell-post-form" data-post-form>
        <h3>${post ? 'Редактировать публикацию' : (canManage ? 'Новая публикация' : 'Предложить публикацию')}</h3>
        <div class="alltell-form-row">
          <label>Тип
            <select name="type">
              ${Object.keys(POST_TYPES).map(function (type) {
                var selected = post ? post.type === type : type === 'news';
                return `<option value="${type}" ${selected ? 'selected' : ''}>${POST_TYPES[type]}</option>`;
              }).join('')}
            </select>
          </label>
          <label>Хаб
            <select name="hub_id">
              <option value="">Вся франшиза</option>${hubOptions}
            </select>
          </label>
        </div>
        <label data-hub-status-field ${post && post.hub_id ? '' : 'hidden'}>Статус хаба
          <select name="hub_status" ${post && post.hub_id ? '' : 'disabled'}>
            <option value="">Выберите статус</option>
            ${Object.keys(HUB_STATUSES).map(function (status) {
              return `<option value="${status}" ${post && post.hub_status === status ? 'selected' : ''}>${HUB_STATUSES[status]}</option>`;
            }).join('')}
          </select>
        </label>
        <label>Заголовок<input name="title" maxlength="160" required value="${escapeHtml(post ? post.title : '')}"></label>
        <label>Текст<textarea name="body" maxlength="10000" rows="5">${escapeHtml(post ? post.body : '')}</textarea></label>
        <div class="alltell-form-row">
          <label>Статья
            <input name="article_search" type="search" autocomplete="off" value="${escapeHtml(articleTitle)}" placeholder="Начните вводить название статьи…" data-article-search>
            <input name="article_slug" type="hidden" value="${escapeHtml(article ? article.slug : '')}" data-article-slug>
            <div class="alltell-article-options" data-article-options hidden></div>
          </label>
          <div class="alltell-post-image-editor" data-image-drop>
            <div class="alltell-image-editor-heading">
              <strong>Изображения</strong>
              <span data-image-selection>${images.length ? images.length + ' добавлено' : 'Можно добавить любое количество'}</span>
            </div>
            <label class="alltell-image-dropzone">
                <input name="images" type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple hidden ${state.uploadingImages ? 'disabled' : ''}>
              <i class="fas fa-cloud-arrow-up" aria-hidden="true"></i>
              <span><strong>Добавить изображения</strong><small>Выберите несколько файлов или перетащите их сюда</small></span>
            </label>
            <div class="alltell-form-images" data-post-image-grid>${renderPostImageItems(images, state.uploadingImages)}</div>
            <div class="alltell-upload-progress" data-image-progress hidden>
              <div><span data-image-progress-label>Загрузка изображений…</span><span data-image-progress-count></span></div>
              <progress max="100" value="0" data-image-progress-bar></progress>
            </div>
          </div>
        </div>
        <p class="alltell-form-hint">${canManage
          ? 'Запись датируется автоматически. Для публикации в чужой франшизе отправьте предложение создателю.'
          : 'Запись датируется автоматически и появится в ленте после подтверждения создателем франшизы.'}</p>
        <div class="alltell-post-form-actions">
          <button class="btn btn-primary" type="submit">${post ? 'Сохранить' : (canManage ? 'Опубликовать' : 'Отправить на подтверждение')}</button>
          ${post ? '<button class="btn btn-secondary" type="button" data-action="cancel-edit">Отмена</button>' : ''}
        </div>
      </form>`;
  }

  function renderDetail(root, state) {
    var data = state.detail;
    var franchise = data.franchise;
    var member = data.is_member;
    var canManage = data.can_manage;
    var currentUser = window.authManager && window.authManager.getUser();
    var userId = currentUser && currentUser.id;
    var hubMap = new Map(data.hubs.map(function (hub) { return [String(hub.id), hub]; }));
    var posts = data.posts.filter(function (post) { return post.approval_status === 'published'; });
    var suggestions = data.posts.filter(function (post) { return post.approval_status !== 'published'; });
    root.innerHTML = `
      <a class="alltell-back-link" href="/alltell?view=catalog"><i class="fas fa-arrow-left" aria-hidden="true"></i> К каталогу</a>
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
      <section class="alltell-live-section alltell-feed-section">
        <div class="alltell-live-section-heading">
          <h2><i class="fas fa-bullhorn" aria-hidden="true"></i> Новости и события</h2>
          <span>${posts.length} публикаций</span>
        </div>
        ${canManage || token() ? renderPostForm(state, data.hubs, canManage) : '<div class="alltell-state"><p><button class="btn btn-secondary" type="button" data-action="login">Войдите, чтобы предложить публикацию</button></p></div>'}
        ${suggestions.length ? `<div class="alltell-live-section-heading"><h3>${canManage ? 'Предложения и модерация' : 'Мои предложения'}</h3><span>${canManage
          ? suggestions.filter(function (post) { return post.approval_status === 'pending'; }).length + ' ожидают решения'
          : suggestions.length + ' предложений'}</span></div>
          <div class="alltell-post-list">${suggestions.map(function (post) { return renderPost(post, hubMap, canManage, null, userId, !!token(), franchise.id); }).join('')}</div>` : ''}
        ${posts.length ? `<div class="alltell-post-list">${posts.map(function (post) {
          var postSocial = state.postSocial[postSocialKey(franchise.id, post.id)];
          return renderPost(post, hubMap, canManage, postSocial, userId, !!token(), franchise.id);
        }).join('')}</div>` : `<div class="alltell-state"><p>${canManage ? 'Добавьте первую новость, объявление или событие.' : 'Публикаций пока нет.'}</p></div>`}
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
      view: new URLSearchParams(window.location.search).get('view') === 'catalog' ? 'catalog' : 'feed',
      feedPosts: [],
      followedCount: 0,
      editingPost: null,
      postSocial: {},
      stickerPacks: null,
      favoriteStickers: null,
      postImages: [],
      uploadingImages: false,
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
    }

    function setPostImages(post) {
      releasePostImages();
      var images = Array.isArray(post && post.images) && post.images.length
        ? post.images
        : (post && post.image_url ? [post.image_url] : []);
      state.postImages = images.map(function (url) {
        return { url: url, preview: url, file: null };
      });
    }

    function renderPostImageQueue() {
      var form = root.querySelector('[data-post-form]');
      if (!form) return;
      var grid = form.querySelector('[data-post-image-grid]');
      grid.innerHTML = renderPostImageItems(state.postImages, state.uploadingImages);
      form.querySelector('[data-image-selection]').textContent = state.postImages.length
        ? state.postImages.length + ' изображений · добавляйте ещё или изменяйте порядок'
        : 'Можно добавить любое количество изображений';
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
        state.postImages.push({ file: file, preview: URL.createObjectURL(file), url: null });
      });
      renderPostImageQueue();
    }

    function updateImageProgress(done, total, currentName) {
      var form = root.querySelector('[data-post-form]');
      if (!form) return;
      var progress = form.querySelector('[data-image-progress]');
      progress.hidden = false;
      form.querySelector('[data-image-progress-label]').textContent = currentName
        ? 'Загружаем ' + currentName
        : 'Загрузка изображений…';
      form.querySelector('[data-image-progress-count]').textContent = done + ' / ' + total;
      form.querySelector('[data-image-progress-bar]').value = total ? Math.round(done / total * 100) : 0;
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

    async function loadStickerPickerData() {
      if (state.stickerPacks && state.favoriteStickers) return;
      var results = await Promise.all([
        request('/api/stickers/subscribed'),
        request('/api/stickers/favorites')
      ]);
      state.stickerPacks = results[0];
      state.favoriteStickers = results[1];
    }

    function stickerPickerMarkup() {
      if (!state.stickerPacks) return '<div class="alltell-sticker-picker-heading"><strong>Стикеры</strong><button type="button" data-action="close-sticker-picker" aria-label="Закрыть">×</button></div><p class="alltell-picker-empty">Загружаем наборы…</p>';
      var favorites = (state.favoriteStickers || []).map(function (sticker) {
        return Object.assign({ packSlug: sticker.packSlug }, sticker);
      });
      var favoriteGroup = favorites.length
        ? `<div class="alltell-sticker-picker-group"><strong>Избранное</strong><div>${favorites.map(renderPickerSticker).join('')}</div></div>`
        : '';
      var packGroups = state.stickerPacks.map(function (pack) {
        return `<div class="alltell-sticker-picker-group"><strong>${escapeHtml(pack.title)}</strong><div>${(pack.stickers || []).map(function (sticker) {
          return renderPickerSticker(Object.assign({ packSlug: pack.slug, packId: pack.id }, sticker));
        }).join('')}</div></div>`;
      }).join('');
      return `<div class="alltell-sticker-picker-heading"><strong>Стикеры</strong><button type="button" data-action="close-sticker-picker" aria-label="Закрыть">×</button></div>${favoriteGroup + packGroups || '<p class="alltell-picker-empty">Добавьте наборы в разделе «Стикеры», чтобы использовать их здесь.</p>'}`;
    }

    function renderPickerSticker(sticker) {
      var code = ':' + sticker.packSlug + ':' + sticker.alias + ':';
      return `<button type="button" class="alltell-picker-sticker" data-action="select-sticker" data-shortcode="${escapeHtml(code)}" title="${escapeHtml(sticker.alias)}">
        <img src="${escapeHtml(sticker.fileUrl)}" alt="${escapeHtml(sticker.alias)}">
      </button>`;
    }

    async function openPostStickerPicker(button) {
      var postRoot = button.closest('[data-post-social]');
      var postId = postRoot.dataset.postId;
      var franchiseId = postRoot.dataset.franchiseId;
      var social = getPostSocial(postId, franchiseId);
      social.pickerTarget = {
        mode: button.dataset.pickerMode,
        type: button.dataset.targetType,
        id: button.dataset.targetId
      };
      try {
        await loadStickerPickerData();
        var panel = postRoot.querySelector('[data-sticker-picker]');
        if (!panel) return;
        panel.innerHTML = stickerPickerMarkup();
        panel.hidden = false;
      } catch (error) {
        notifyError(error.message);
      }
    }

    async function selectPostSticker(button) {
      var panel = button.closest('[data-post-social]');
      var postId = panel.dataset.postId;
      var franchiseId = panel.dataset.franchiseId;
      var social = getPostSocial(postId, franchiseId);
      var target = social.pickerTarget;
      if (!target) return;
      var shortcode = button.dataset.shortcode;
      if (target.mode === 'insert') {
        var textarea = panel.querySelector('[data-comment-form] textarea[name="content"]');
        if (!textarea) return;
        var start = textarea.selectionStart;
        var end = textarea.selectionEnd;
        textarea.setRangeText(shortcode, start, end, 'end');
        textarea.focus();
        panel.querySelector('[data-sticker-picker]').hidden = true;
        return;
      }
      var endpoint = '/api/franchises/' + franchiseId + '/posts/' + postId;
      if (target.type === 'franchise_post_comment') endpoint += '/comments/' + target.id;
      endpoint += '/reactions/toggle';
      try {
        var result = await request(endpoint, 'POST', { shortcode: shortcode.replace(/^:+|:+$/g, '') });
        if (target.type === 'franchise_post') {
          social.reactions = result.reactions || [];
          renderSocialPanel(postId, franchiseId);
        } else {
          social.comments = await request('/api/franchises/' + franchiseId + '/posts/' + postId + '/comments');
          renderSocialPanel(postId, franchiseId);
        }
      } catch (error) {
        notifyError(error.message);
      }
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

    async function loadFeed() {
      state.view = 'feed';
      state.postSocial = {};
      state.loading = true;
      state.error = '';
      renderFeed(root, state);
      if (!token()) {
        state.feedPosts = [];
        state.followedCount = 0;
        state.loading = false;
        renderFeed(root, state);
        return;
      }
      try {
        var result = await request('/api/franchises/feed');
        if (state.disposed) return;
        state.feedPosts = result.posts || [];
        state.followedCount = Number(result.followed_count || 0);
        state.loading = false;
        renderFeed(root, state);
        if (state.followedCount) {
          request('/api/franchises/feed/read', 'POST', {}).catch(function (error) {
            notifyError(error.message);
          });
        }
      } catch (error) {
        if (state.disposed) return;
        state.loading = false;
        state.error = error.message;
        renderFeed(root, state);
      }
    }

    async function loadDetail(franchiseId) {
      state.detail = null;
      state.postSocial = {};
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
      state.view = new URLSearchParams(window.location.search).get('view') === 'catalog' ? 'catalog' : 'feed';
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

    async function savePost(form, formData) {
      var pendingImages = state.postImages.filter(function (image) { return image.file && !image.url; });
      var done = 0;
      for (var i = 0; i < pendingImages.length; i += IMAGE_UPLOAD_CHUNK) {
        var chunk = pendingImages.slice(i, i + IMAGE_UPLOAD_CHUNK);
        updateImageProgress(done, pendingImages.length, chunk.length === 1
          ? chunk[0].file.name
          : `Пачка ${i + 1}–${i + chunk.length} из ${pendingImages.length}`);
        var uploadData = new FormData();
        chunk.forEach(function (image) { uploadData.append('images', image.file); });
        var uploadResponse = await fetch('/api/upload-images', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token() },
          credentials: 'same-origin',
          body: uploadData
        });
        var uploadResult = {};
        try { uploadResult = await uploadResponse.json(); } catch (error) { /* Report the HTTP failure below. */ }
        if (!uploadResponse.ok || !Array.isArray(uploadResult.urls) || uploadResult.urls.length !== chunk.length) {
          throw new Error(uploadResult.error || 'Не удалось загрузить изображения');
        }
        chunk.forEach(function (image, index) {
          image.url = uploadResult.urls[index];
          image.file = null;
          if (image.preview && image.preview.startsWith('blob:')) URL.revokeObjectURL(image.preview);
          image.preview = image.url;
        });
        done += chunk.length;
        updateImageProgress(done, pendingImages.length);
        renderPostImageQueue();
      }
      var imageUrls = state.postImages.map(function (image) { return image.url; }).filter(Boolean);
      var payload = {
        type: formData.get('type'),
        hub_id: formData.get('hub_id'),
        hub_status: formData.get('hub_id') ? formData.get('hub_status') : '',
        title: formData.get('title'),
        body: formData.get('body'),
        article_slug: formData.get('article_slug'),
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
      releasePostImages();
      renderDetail(root, state);
      showToast(post.approval_status === 'pending'
        ? 'Предложение отправлено создателю франшизы'
        : (postId ? 'Публикация обновлена' : 'Публикация добавлена'));
    }

    function renderArticleOptions(input) {
      var form = input.closest('[data-post-form]');
      if (!form) return;
      var options = form.querySelector('[data-article-options]');
      var slugInput = form.querySelector('[data-article-slug]');
      var query = input.value.trim().toLocaleLowerCase();
      if (!query) {
        options.hidden = true;
        options.replaceChildren();
        slugInput.value = '';
        return;
      }
      slugInput.value = '';
      var matches = state.articleIndex.filter(function (article) {
        return (article.title + ' ' + article.slug).toLocaleLowerCase().includes(query);
      }).slice(0, 15);
      if (!matches.length) {
        options.innerHTML = state.articleIndexError
          ? `<span class="alltell-article-option-empty">Не удалось загрузить список статей: ${escapeHtml(state.articleIndexError)}</span>`
          : '<span class="alltell-article-option-empty">Доступные статьи не найдены</span>';
      } else {
        options.innerHTML = matches.map(function (article) {
          return `<button type="button" data-article-choice data-article-slug="${escapeHtml(article.slug)}" data-article-title="${escapeHtml(article.title)}">${escapeHtml(article.title)}</button>`;
        }).join('');
      }
      options.hidden = false;
    }

    function onClick(event) {
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
        var articleForm = articleChoice.closest('[data-post-form]');
        articleForm.querySelector('[data-article-search]').value = articleChoice.dataset.articleTitle;
        articleForm.querySelector('[data-article-slug]').value = articleChoice.dataset.articleSlug;
        articleForm.querySelector('[data-article-options]').hidden = true;
        return;
      }
      var button = event.target.closest('[data-action]');
      if (!button) return;
      var action = button.dataset.action;
      if (action === 'switch-view') {
        switchView(button.dataset.view);
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
        if (!window.confirm('Удалить комментарий вместе с ответами?')) return;
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
      } else if (action === 'select-sticker') {
        selectPostSticker(button);
      } else if (action === 'close-sticker-picker') {
        var pickerPanel = button.closest('[data-sticker-picker]');
        if (pickerPanel) pickerPanel.hidden = true;
      } else if (action === 'login') {
        if (typeof window.showModalLogin === 'function') window.showModalLogin('login');
        else window.location.href = '/admin-panel';
      } else if (action === 'join') {
        button.disabled = true;
        joinFranchise().catch(function (error) {
          notifyError(error.message);
        });
      } else if (action === 'edit-post') {
        state.editingPost = state.detail.posts.find(function (post) {
          return String(post.id) === button.dataset.postId;
        }) || null;
        setPostImages(state.editingPost);
        renderDetail(root, state);
        root.querySelector('[data-post-form]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (action === 'cancel-edit') {
        state.editingPost = null;
        releasePostImages();
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
            notifyError(error.message);
          });
      }
    }

    function onInput(event) {
      if (event.target.matches('[data-article-search]')) renderArticleOptions(event.target);
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
        if (state.uploadingImages) return;
        var formData = new FormData(event.target);
        state.uploadingImages = true;
        event.target.querySelectorAll('input, select, textarea, button').forEach(function (control) {
          control.disabled = true;
        });
        renderPostImageQueue();
        savePost(event.target, formData).catch(function (error) {
          notifyError(error.message);
          state.uploadingImages = false;
          var progress = root.querySelector('[data-image-progress]');
          if (progress) progress.hidden = true;
          renderPostImageQueue();
          var activeForm = root.querySelector('[data-post-form]');
          if (activeForm) {
            activeForm.querySelectorAll('input, select, textarea, button').forEach(function (control) {
              control.disabled = false;
            });
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

    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('scroll', onScroll, true);
    root.addEventListener('change', onChange);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('dragleave', onDragLeave);
    root.addEventListener('drop', onDrop);
    root.addEventListener('dragstart', onImageDragStart);
    root.addEventListener('dragend', onImageDragEnd);
    root.addEventListener('submit', onSubmit);
    window.addEventListener('authChanged', onAuthChanged);
    await loadArticleIndex();
    await refreshCurrentView();
    return function () {
      state.disposed = true;
      root.removeEventListener('click', onClick);
      root.removeEventListener('input', onInput);
      root.removeEventListener('scroll', onScroll, true);
      root.removeEventListener('change', onChange);
      root.removeEventListener('dragover', onDragOver);
      root.removeEventListener('dragleave', onDragLeave);
      root.removeEventListener('drop', onDrop);
      root.removeEventListener('dragstart', onImageDragStart);
      root.removeEventListener('dragend', onImageDragEnd);
      root.removeEventListener('submit', onSubmit);
      window.removeEventListener('authChanged', onAuthChanged);
      window.clearTimeout(state.toastTimer);
      releasePostImages();
      document.querySelector('.alltell-toast')?.remove();
    };
  }

  window.AllTellClient = { init: init };
})();
