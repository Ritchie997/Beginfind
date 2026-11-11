// stickers-client.js — клиентский контроллер публичной витрины стикеров AllTell (/stickers).

(function () {
  'use strict';

  function getToken() {
    try {
      return (window.authManager && typeof window.authManager.getToken === 'function')
        ? (window.authManager.getToken() || '')
        : (localStorage.getItem('alltell_auth_token') || '');
    } catch (_) {
      return '';
    }
  }

  var SiteStickers = {
    init: function () {
      if (!window.stickerStore) return function () {};

      var searchEl = document.getElementById('stickersSearch');
      var grid = document.getElementById('stickersGrid');
      var emptyEl = document.getElementById('stickersEmpty');
      var countEl = document.getElementById('stickersCountBadge');
      var filterChips = document.querySelectorAll('.stickers-filter-chip');

      function onChipClick(e) {
        var chip = e.currentTarget;
        var filter = chip.dataset.filter || 'all';

        if ((filter === 'subscribed' || filter === 'own') && !getToken()) {
          if (typeof window.showModalLogin === 'function') window.showModalLogin('login');
          else window.location.href = '/admin-panel';
          return;
        }

        filterChips.forEach(function (c) {
          c.classList.toggle('active', c === chip);
        });
        window.stickerStore.setFilter(filter);
      }

      filterChips.forEach(function (chip) {
        chip.addEventListener('click', onChipClick);
      });

      var createBtn = document.getElementById('stickersHeroCreateBtn');
      var onCreateClick = function (e) {
        e.preventDefault();
        var token = getToken();
        if (!token) {
          if (typeof window.showModalLogin === 'function') window.showModalLogin('login');
          else window.location.href = '/admin-panel';
          return;
        }
        window.location.href = '/admin-panel';
      };
      if (createBtn) createBtn.addEventListener('click', onCreateClick);

      window.stickerStore.mountPage({
        grid: grid,
        searchEl: searchEl,
        emptyEl: emptyEl,
        countEl: countEl,
        filter: 'all'
      });

      var onAuthChanged = function () {
        if (window.stickerStore && typeof window.stickerStore.refresh === 'function') {
          window.stickerStore.refresh();
        }
      };
      window.addEventListener('authChanged', onAuthChanged);
      window.addEventListener('storage', function (e) {
        if (e.key === 'alltell_auth_token') onAuthChanged();
      });

      return function cleanup() {
        filterChips.forEach(function (chip) {
          chip.removeEventListener('click', onChipClick);
        });
        if (createBtn) createBtn.removeEventListener('click', onCreateClick);
        window.removeEventListener('authChanged', onAuthChanged);
      };
    }
  };

  window.SiteStickers = SiteStickers;

  if (document.readyState !== 'loading') {
    if (document.body.dataset.page === 'stickers') {
      SiteStickers.init();
    }
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      if (document.body.dataset.page === 'stickers') {
        SiteStickers.init();
      }
    });
  }
})();
