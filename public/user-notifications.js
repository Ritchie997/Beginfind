// user-notifications.js — колокольчик в шапке: личные уведомления (ответ на
// ваш комментарий, @упоминание) — см. src/services/user-notifications.js.
//
// Число непрочитанных и новые уведомления приходят вместе с общей сводкой
// /api/notifications/summary (её раз в 2 минуты опрашивает app.js —
// refreshNotificationBadges вызывает applySummary). Новое уведомление один
// раз всплывает тостом (сервер отдаёт его в personalFresh только однажды),
// а в колокольчике остаётся, пока его не откроют.

(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // SQLite CURRENT_TIMESTAMP — UTC без зоны.
  function timeAgo(value) {
    const d = new Date(String(value).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? '' : 'Z'));
    const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (sec < 60) return 'только что';
    if (sec < 3600) return `${Math.floor(sec / 60)} мин назад`;
    if (sec < 86400) return `${Math.floor(sec / 3600)} ч назад`;
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
  }

  // Формулировки без рода — имя автора может быть любым.
  function headline(n) {
    const where = n.targetType === 'gallery' ? 'к работе' : 'к статье';
    const title = n.targetTitle ? ` ${where} «${escapeHtml(n.targetTitle)}»` : '';
    if (n.type === 'collab_request') {
      return `<b>${escapeHtml(n.actorName)}</b> предложил правку и соавторство${title}`;
    }
    if (n.type === 'collab_approved') {
      return `<b>${escapeHtml(n.actorName)}</b> одобрил вашу правку и добавил в соавторы${title}`;
    }
    if (n.type === 'collab_declined') {
      return `<b>${escapeHtml(n.actorName)}</b> отклонил вашу предложенную правку${title}`;
    }
    return n.type === 'reply'
      ? `<b>${escapeHtml(n.actorName)}</b> — ответ на ваш комментарий${title}`
      : `<b>${escapeHtml(n.actorName)}</b> упоминает вас в комментарии${title}`;
  }

  async function api(path, method = 'GET', body = null) {
    if (window.apiClient && typeof window.apiClient.makeAuthenticatedRequest === 'function') {
      return window.apiClient.makeAuthenticatedRequest(path, method, body);
    }
    const auth = window.authManager;
    const token = auth && typeof auth.getToken === 'function' ? auth.getToken() : null;
    if (!token) {
      return { success: false, data: { items: [], unread: 0 }, error: 'Требуется авторизация' };
    }
    const headers = {
      'Authorization': `Bearer ${token}`
    };
    const options = {
      method: method || 'GET',
      headers: headers
    };
    if (body !== undefined && body !== null && (options.method === 'POST' || options.method === 'PUT' || options.method === 'PATCH')) {
      headers['Content-Type'] = 'application/json';
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    try {
      const response = await fetch(path, options);
      if (response.status === 401) {
        if (auth && typeof auth.logout === 'function') {
          auth.logout();
        }
        return { success: false, data: { items: [], unread: 0 }, error: 'Требуется авторизация' };
      }
      const data = await response.json().catch(() => null);
      return {
        success: response.ok,
        status: response.status,
        data: data,
        error: data && data.error ? data.error : (response.ok ? null : `HTTP ${response.status}`)
      };
    } catch (err) {
      return { success: false, data: { items: [], unread: 0 }, error: err.message };
    }
  }

  // Переход: соавторство / комментарий в Antropedia / работа в галерее.
  async function openNotification(n) {
    if (n.type === 'collab_request' || n.type === 'collab_approved' || n.type === 'collab_declined') {
      if (window.PublicSite && typeof window.PublicSite.navigateTo === 'function') {
        window.PublicSite.navigateTo('/antropedia/' + encodeURIComponent(n.targetId));
      } else {
        window.location.href = '/antropedia/' + encodeURIComponent(n.targetId);
      }
      return;
    }
    if (n.targetType === 'gallery') {
      if (window.galleryViewer && typeof window.galleryViewer.openWork === 'function') {
        await window.galleryViewer.openWork(n.targetId);
        if (n.commentId && typeof window.galleryViewer.focusComment === 'function') {
          window.galleryViewer.focusComment(n.commentId);
        }
      } else if (window.PublicSite && typeof window.PublicSite.navigateTo === 'function') {
        window.PublicSite.navigateTo('/site/gallery.html?work=' + encodeURIComponent(n.targetId));
      } else {
        window.location.href = '/site/gallery.html?work=' + encodeURIComponent(n.targetId);
      }
    } else {
      if (window.spaRouter && typeof window.spaRouter.openAntropediaArticle === 'function') {
        await window.spaRouter.openAntropediaArticle(n.targetId, { jumpToComments: true });
        if (n.commentId && window.antropediaManager && typeof window.antropediaManager.focusComment === 'function') {
          window.antropediaManager.focusComment(n.commentId);
        }
      } else if (window.PublicSite && typeof window.PublicSite.navigateTo === 'function') {
        window.PublicSite.navigateTo('/antropedia/' + encodeURIComponent(n.targetId) + (n.commentId ? '#comment-' + encodeURIComponent(n.commentId) : ''));
      } else {
        window.location.href = '/antropedia/' + encodeURIComponent(n.targetId) + (n.commentId ? '#comment-' + encodeURIComponent(n.commentId) : '');
      }
    }
  }

  const ui = {
    el: null,
    open: false,
    unread: 0,
    items: [],

    init() {
      const currentEl = document.getElementById('notif-bell');
      if (!currentEl) return;
      if (this.el === currentEl && this._bound) return;
      this.el = currentEl;
      this._bound = true;
      this.btn = this.el.querySelector('.notif-bell-btn');
      this.countEl = this.el.querySelector('.notif-bell-count');
      this.dropdown = this.el.querySelector('.notif-bell-dropdown');
      this.listEl = this.el.querySelector('.notif-bell-list');

      this.setUnread(this.unread);

      if (this.btn) {
        this.btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.open) this.close(); else this.show();
        });
      }
      const readAllBtn = this.el.querySelector('[data-notif="read-all"]');
      if (readAllBtn) {
        readAllBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const res = await api('/api/notifications/read', 'POST', { all: true });
          if (res && res.success && res.data && typeof res.data.unread === 'number') {
            this.setUnread(res.data.unread);
          }
          this.items.forEach((n) => { n.read = true; });
          this.render();
        });
      }
      if (this.listEl) {
        this.listEl.addEventListener('click', async (e) => {
          const row = e.target.closest('[data-notif-id]');
          if (!row) return;
          const n = this.items.find((x) => String(x.id) === row.dataset.notifId);
          if (!n) return;
          this.close();
          if (!n.read) {
            n.read = true;
            api('/api/notifications/read', 'POST', { ids: [n.id] }).then((res) => {
              if (res && res.success && res.data && typeof res.data.unread === 'number') {
                this.setUnread(res.data.unread);
              }
            });
          }
          openNotification(n);
        });
      }
      if (!this._docBound) {
        this._docBound = true;
        document.addEventListener('click', (e) => {
          if (this.open && this.el && !this.el.contains(e.target)) this.close();
        });
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && this.open) {
            this.close();
            if (this.btn) this.btn.focus();
          }
        });
      }

      if (window.authManager && typeof window.authManager.isAuthenticated === 'function' && window.authManager.isAuthenticated()) {
        this.checkUnread();
      }
    },

    async checkUnread() {
      const auth = window.authManager;
      const token = auth && typeof auth.getToken === 'function' ? auth.getToken() : null;
      if (!token) {
        this.setUnread(0);
        return;
      }
      const res = await api('/api/notifications');
      if (res && res.success && res.data) {
        this.items = Array.isArray(res.data.items) ? res.data.items : [];
        if (typeof res.data.unread === 'number') {
          this.setUnread(res.data.unread);
        }
      }
    },

    setUnread(count) {
      this.unread = count || 0;
      if (!this.countEl) return;
      this.countEl.hidden = !this.unread;
      this.countEl.textContent = this.unread > 99 ? '99+' : String(this.unread);
    },

    async show() {
      this.open = true;
      if (this.dropdown) this.dropdown.hidden = false;
      if (this.listEl) this.listEl.innerHTML = '<div class="notif-bell-empty">Загрузка…</div>';
      const res = await api('/api/notifications');
      if (!this.open) return;
      this.items = (res && res.success && res.data && Array.isArray(res.data.items)) ? res.data.items : [];
      if (res && res.success && res.data && typeof res.data.unread === 'number') {
        this.setUnread(res.data.unread);
      }
      this.render();
    },

    close() {
      this.open = false;
      if (this.dropdown) this.dropdown.hidden = true;
    },

    render() {
      if (!this.listEl) return;
      const auth = window.authManager;
      const isLoggedIn = !!(auth && (typeof auth.isAuthenticated === 'function' ? auth.isAuthenticated() : auth.getToken()));
      if (!isLoggedIn) {
        this.listEl.innerHTML = '<div class="notif-bell-empty">Войдите, чтобы просматривать уведомления.</div>';
        return;
      }
      this.listEl.innerHTML = this.items.length
        ? this.items.map((n) => `
            <button type="button" class="notif-item${n.read ? '' : ' is-unread'}" data-notif-id="${n.id}">
              <span class="notif-item-icon">${n.type === 'reply' ? '<i class="fas fa-reply"></i>' : '<i class="fas fa-at"></i>'}</span>
              <span class="notif-item-body">
                <span class="notif-item-title">${headline(n)}</span>
                ${n.excerpt ? `<span class="notif-item-excerpt">${escapeHtml(n.excerpt)}</span>` : ''}
                <span class="notif-item-time">${timeAgo(n.createdAt)}</span>
              </span>
            </button>`).join('')
        : '<div class="notif-bell-empty">Здесь появятся ответы на ваши комментарии и упоминания @вас.</div>';
    },

    // Из общей сводки (app.js::refreshNotificationBadges).
    applySummary(summary) {
      this.init();
      if (typeof summary.personalUnread === 'number') this.setUnread(summary.personalUnread);
      (summary.personalFresh || []).forEach((n) => this.toast(n));
      if (this.open && (summary.personalFresh || []).length) this.show();
    },

    // Всплывающее уведомление — по клику ведёт к комментарию.
    toast(n) {
      let stack = document.getElementById('notif-toasts');
      if (!stack) {
        stack = document.createElement('div');
        stack.id = 'notif-toasts';
        stack.className = 'notif-toasts';
        document.body.appendChild(stack);
      }
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'toast toast-info notif-toast';
      el.innerHTML = `<span>${headline(n)}</span>${n.excerpt ? `<span class="notif-item-excerpt">${escapeHtml(n.excerpt)}</span>` : ''}`;
      el.addEventListener('click', () => {
        el.remove();
        api('/api/notifications/read', 'POST', { ids: [n.id] }).then((res) => {
          if (res && res.success && res.data && typeof res.data.unread === 'number') {
            this.setUnread(res.data.unread);
          }
        });
        openNotification(n);
      });
      stack.appendChild(el);
      setTimeout(() => el.remove(), 9000);
    }
  };

  window.userNotificationsUI = ui;

  if (document.readyState !== 'loading') {
    ui.init();
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      ui.init();
    });
  }
})();
