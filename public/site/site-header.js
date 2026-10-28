// site-header.js — Единый объект верхней панели (шапки) сайта AllTell.
// Инкапсулирует разметку, синхронизацию навигации, иконку админ-панели (fa-shield-halved),
// поиск, меню пользователя и мобильный бургер для всех разделов SPA.

(function () {
  'use strict';

  var HEADER_INNER_HTML = `
    <div class="site-header-inner">
      <button class="site-burger" id="siteBurger" aria-label="Открыть меню"><span></span><span></span><span></span></button>
      <a href="/" class="site-logo"><span class="site-logo-mark">✶</span> AllTell</a>
      <nav class="site-nav" id="siteNav">
        <a href="/" class="site-nav-link" data-page="home">Главная</a>
        <a href="/antropedia" class="site-nav-link" data-page="antropedia">Antropedia</a>
        <a href="/alltell?view=feed" class="site-nav-link" data-page="alltell">AllTell</a>
        <a href="/site/gallery.html" class="site-nav-link" data-page="gallery">Галерея</a>
      </nav>
      <div class="site-header-actions">
        <div class="site-search"><i class="fas fa-search" aria-hidden="true"></i><input id="siteSearchInput" type="text" placeholder="Поиск по сайту..." aria-label="Поиск по сайту"></div>
        <a href="/admin-panel" class="site-admin-toggle" title="Переключиться в админ-панель"><i class="fas fa-shield-halved"></i><span>Админ-панель</span></a>
        <div class="site-user" id="siteUserMenu" hidden>
          <button type="button" class="site-user-trigger" id="siteUserTrigger" aria-haspopup="true" aria-expanded="false" aria-controls="siteUserDropdown">
            <span class="site-user-avatar" id="siteUserAvatar"></span>
            <span class="site-user-name" id="siteUserName"></span>
            <i class="fas fa-chevron-down site-user-chevron" aria-hidden="true"></i>
          </button>
          <div class="site-user-dropdown" id="siteUserDropdown" role="menu">
            <a href="/profile" role="menuitem"><i class="fas fa-user"></i> Профиль</a>
            <button type="button" id="siteLogout" role="menuitem"><i class="fas fa-right-from-bracket"></i> Выход</button>
          </div>
        </div>
        <div class="site-auth-actions" id="siteGuestActions">
          <button type="button" class="site-auth-button" data-auth-tab="login">Войти</button>
        </div>
      </div>
    </div>
  `.trim();

  function safeImageUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    var src = value.trim();
    if (src.startsWith('/uploads/')) return src;
    try {
      var url = new URL(src, window.location.origin);
      return (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : '';
    } catch (error) {
      return '';
    }
  }

  function avatarSrcSet(value) {
    var match = String(value || '').match(/^(\/uploads\/avatar\/[1-9][0-9]*\/)\d+\.webp(\?.*)?$/);
    if (!match) return '';
    return [104, 208, 312].map(function (size, index) {
      return match[1] + size + '.webp' + (match[2] || '') + ' ' + (index + 1) + 'x';
    }).join(', ');
  }

  var SiteHeader = {
    el: null,
    nav: null,
    burger: null,
    overlay: null,
    adminToggle: null,
    searchInput: null,
    userMenu: null,
    guestActions: null,
    userTrigger: null,
    userAvatar: null,
    userName: null,
    userDropdown: null,
    isInitialized: false,

    getMarkup: function () {
      return HEADER_INNER_HTML;
    },

    render: function (container) {
      var header = container || document.querySelector('.site-header');
      if (!header) return null;
      this.el = header;
      if (!header.querySelector('.site-header-inner')) {
        header.innerHTML = HEADER_INNER_HTML;
      }
      this.ensureAdminToggleMarkup();
      return header;
    },

    ensureAdminToggleMarkup: function () {
      if (!this.el) this.el = document.querySelector('.site-header');
      if (!this.el) return;
      var toggle = this.el.querySelector('.site-admin-toggle');
      if (!toggle) return;
      this.adminToggle = toggle;
      var icon = toggle.querySelector('i');
      var span = toggle.querySelector('span');
      if (!icon || !icon.classList.contains('fa-shield-halved')) {
        toggle.innerHTML = '<i class="fas fa-shield-halved"></i><span>Админ-панель</span>';
      } else if (!span || span.textContent.trim() !== 'Админ-панель') {
        toggle.innerHTML = '<i class="fas fa-shield-halved"></i><span>Админ-панель</span>';
      }
      toggle.title = 'Переключиться в админ-панель';
    },

    init: function () {
      if (this.isInitialized) {
        this.syncFromDom();
        return;
      }

      this.render();
      if (!this.el) return;

      this.nav = document.getElementById('siteNav') || this.el.querySelector('.site-nav');
      this.burger = document.getElementById('siteBurger') || this.el.querySelector('.site-burger');
      this.overlay = document.getElementById('siteNavOverlay') || document.querySelector('.site-nav-overlay');
      this.adminToggle = this.el.querySelector('.site-admin-toggle');
      this.searchInput = document.getElementById('siteSearchInput') || this.el.querySelector('.site-search input');
      this.userMenu = document.getElementById('siteUserMenu');
      this.guestActions = document.getElementById('siteGuestActions');
      this.userTrigger = document.getElementById('siteUserTrigger');
      this.userAvatar = document.getElementById('siteUserAvatar');
      this.userName = document.getElementById('siteUserName');
      this.userDropdown = document.getElementById('siteUserDropdown');

      this.bindBurger();
      this.bindUserMenu();
      this.bindSearch();

      this.isInitialized = true;
      this.syncFromDom();
    },

    bindBurger: function () {
      var self = this;
      if (this.burger && this.nav) {
        this.burger.addEventListener('click', function () {
          var isOpen = self.nav.classList.toggle('open');
          if (self.overlay) self.overlay.classList.toggle('show', isOpen);
        });
      }
      if (this.overlay) {
        this.overlay.addEventListener('click', function () {
          self.closeMobileNav();
        });
      }
      if (this.nav) {
        this.nav.querySelectorAll('a').forEach(function (link) {
          link.addEventListener('click', function () {
            self.closeMobileNav();
          });
        });
      }
    },

    closeMobileNav: function () {
      if (this.nav) this.nav.classList.remove('open');
      if (this.overlay) this.overlay.classList.remove('show');
    },

    bindUserMenu: function () {
      var self = this;
      var trigger = this.userTrigger;
      var dropdown = this.userDropdown;
      if (!trigger || !dropdown) return;

      function closeDropdown() {
        if (dropdown) dropdown.classList.remove('show');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
      }

      trigger.addEventListener('click', function (event) {
        event.stopPropagation();
        var isOpen = dropdown.classList.toggle('show');
        trigger.setAttribute('aria-expanded', String(isOpen));
      });

      document.addEventListener('click', closeDropdown);
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && dropdown.classList.contains('show')) {
          closeDropdown();
          trigger.focus();
        }
      });

      if (this.guestActions) {
        this.guestActions.querySelectorAll('[data-auth-tab]').forEach(function (button) {
          button.addEventListener('click', function () {
            if (typeof window.showModalLogin === 'function') {
              window.showModalLogin(button.dataset.authTab);
            } else {
              window.location.href = '/admin-panel';
            }
          });
        });
      }

      var logoutBtn = document.getElementById('siteLogout');
      if (logoutBtn) {
        logoutBtn.addEventListener('click', function () {
          closeDropdown();
          if (window.authManager) window.authManager.logout();
          self.renderUser(null);
          window.location.reload();
        });
      }

      if (window.authManager) {
        window.addEventListener('authChanged', function () {
          self.refreshUser();
        });
        window.addEventListener('storage', function (event) {
          var auth = window.authManager;
          if (auth && (event.key === auth.tokenKey || event.key === auth.userKey)) {
            self.refreshUser();
          }
        });
      }

      this.refreshUser();
    },

    renderUser: function (user) {
      var auth = window.authManager;
      var isLoggedIn = !!(auth && user && auth.isAuthenticated());
      if (this.userMenu) this.userMenu.hidden = !isLoggedIn;
      if (this.guestActions) this.guestActions.hidden = isLoggedIn;
      if (this.userDropdown) this.userDropdown.classList.remove('show');
      if (this.userTrigger) this.userTrigger.setAttribute('aria-expanded', 'false');
      if (!isLoggedIn) return;

      var displayName = user.display_name || user.username || 'Пользователь';
      if (this.userName) this.userName.textContent = displayName;
      if (this.userAvatar) {
        this.userAvatar.replaceChildren();
        var avatarUrl = safeImageUrl(user.avatar);
        if (avatarUrl) {
          var image = document.createElement('img');
          image.src = avatarUrl;
          image.srcset = avatarSrcSet(avatarUrl);
          image.alt = '';
          image.onerror = function () {
            this.userAvatar.classList.remove('has-image');
            this.userAvatar.textContent = displayName.trim().charAt(0).toUpperCase() || '?';
          }.bind(this);
          this.userAvatar.classList.add('has-image');
          this.userAvatar.appendChild(image);
        } else {
          this.userAvatar.classList.remove('has-image');
          this.userAvatar.textContent = displayName.trim().charAt(0).toUpperCase() || '?';
        }
      }
    },

    refreshUser: function () {
      var auth = window.authManager;
      if (!auth || !auth.getToken()) {
        this.renderUser(null);
        return;
      }
      this.renderUser(auth.getCurrentUser());
      var self = this;
      auth.validateToken().then(function (isValid) {
        self.renderUser(isValid || auth.isAuthenticated() ? auth.getUser() : null);
      }).catch(function (error) {
        console.error('[SiteHeader] Ошибка валидации профиля:', error);
      });
    },

    bindSearch: function () {
      var input = this.searchInput;
      if (!input) return;
      input.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        var query = input.value.trim();
        var page = document.body.dataset.page;
        // Если на странице галереи или антропедии — пусть локальный поиск подхватит
        if (page === 'gallery' || page === 'antropedia') return;
        if (query) {
          if (window.PublicSite) window.PublicSite.navigateTo('/antropedia?q=' + encodeURIComponent(query));
          else window.location.href = '/antropedia?q=' + encodeURIComponent(query);
        }
      });
    },

    update: function (options) {
      options = options || {};
      var page = options.page || document.body.dataset.page || '';
      var slug = options.slug !== undefined ? options.slug : null;

      this.setActivePage(page);
      this.updateAdminLink(slug);
      if (options.searchPlaceholder && this.searchInput) {
        this.searchInput.placeholder = options.searchPlaceholder;
      }
      this.closeMobileNav();
      this.refreshUser();
    },

    setActivePage: function (page) {
      if (!this.nav) this.nav = document.getElementById('siteNav') || document.querySelector('.site-nav');
      if (!this.nav) return;
      var activePage = page || document.body.dataset.page || '';
      this.nav.querySelectorAll('.site-nav-link[data-page]').forEach(function (link) {
        link.classList.toggle('active', link.dataset.page === activePage);
      });
    },

    updateAdminLink: function (slug) {
      this.ensureAdminToggleMarkup();
      var toggle = this.adminToggle || document.querySelector('.site-admin-toggle');
      if (!toggle) return;
      var destination = slug ? '/admin-panel?editArticle=' + encodeURIComponent(slug) : '/admin-panel';
      toggle.href = destination;
    },

    syncFromDom: function () {
      var page = document.body.dataset.page || '';
      var articleMatch = page === 'antropedia' && window.location.pathname.match(/^\/antropedia\/([^/]+)\/?$/);
      var articleSlug = null;
      if (articleMatch) {
        try { articleSlug = decodeURIComponent(articleMatch[1]); }
        catch (e) { articleSlug = articleMatch[1]; }
      }
      this.update({ page: page, slug: articleSlug });
    }
  };

  window.SiteHeader = SiteHeader;

  if (document.readyState !== 'loading') {
    SiteHeader.init();
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      SiteHeader.init();
    });
  }
})();
