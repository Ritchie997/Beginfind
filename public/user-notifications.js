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
    return n.type === 'reply'
      ? `<b>${escapeHtml(n.actorName)}</b> — ответ на ваш комментарий${title}`
      : `<b>${escapeHtml(n.actorName)}</b> упоминает вас в комментарии${title}`;
  }

  function api(path, method, body) {
    return window.apiClient.makeAuthenticatedRequest(path, method, body);
  }

  // Переход к комментарию: статья — в Ibripedia, работа — просмотр галереи.
  async function openNotification(n) {
    if (n.targetType === 'gallery') {
      await window.galleryViewer?.openWork(n.targetId);
      if (n.commentId) window.galleryViewer?.focusComment(n.commentId);
    } else {
      await window.spaRouter?.openIbripediaArticle(n.targetId, { jumpToComments: true });
      if (n.commentId) window.ibripediaManager?.focusComment(n.commentId);
    }
  }

  const ui = {
    el: null,
    open: false,
    unread: 0,
    items: [],

    init() {
      this.el = document.getElementById('notif-bell');
      if (!this.el || this._bound) return;
      this._bound = true;
      this.btn = this.el.querySelector('.notif-bell-btn');
      this.countEl = this.el.querySelector('.notif-bell-count');
      this.dropdown = this.el.querySelector('.notif-bell-dropdown');
      this.listEl = this.el.querySelector('.notif-bell-list');

      this.btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.open) this.close(); else this.show();
      });
      this.el.querySelector('[data-notif="read-all"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        const res = await api('/api/notifications/read', 'POST', { all: true });
        if (res.success) this.setUnread(res.data.unread);
        this.items.forEach((n) => { n.read = true; });
        this.render();
      });
      this.listEl.addEventListener('click', async (e) => {
        const row = e.target.closest('[data-notif-id]');
        if (!row) return;
        const n = this.items.find((x) => String(x.id) === row.dataset.notifId);
        if (!n) return;
        this.close();
        if (!n.read) {
          n.read = true;
          api('/api/notifications/read', 'POST', { ids: [n.id] }).then((res) => { if (res.success) this.setUnread(res.data.unread); });
        }
        openNotification(n);
      });
      document.addEventListener('click', (e) => {
        if (this.open && !this.el.contains(e.target)) this.close();
      });
    },

    setUnread(count) {
      this.unread = count || 0;
      if (!this.countEl) return;
      this.countEl.hidden = !this.unread;
      this.countEl.textContent = this.unread > 99 ? '99+' : String(this.unread);
    },

    async show() {
      this.open = true;
      this.dropdown.hidden = false;
      this.listEl.innerHTML = '<div class="notif-bell-empty">Загрузка…</div>';
      const res = await api('/api/notifications');
      if (!this.open) return;
      this.items = res.success ? res.data.items : [];
      if (res.success) this.setUnread(res.data.unread);
      this.render();
    },

    close() {
      this.open = false;
      if (this.dropdown) this.dropdown.hidden = true;
    },

    render() {
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
        api('/api/notifications/read', 'POST', { ids: [n.id] }).then((res) => { if (res.success) this.setUnread(res.data.unread); });
        openNotification(n);
      });
      stack.appendChild(el);
      setTimeout(() => el.remove(), 9000);
    }
  };

  window.userNotificationsUI = ui;
})();
