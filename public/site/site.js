// site.js — только визуальное поведение публичного макета Beginfind.
// Никаких запросов к API: это кликабельный, но не функциональный макет.
// Реальные системы лайков/комментариев/фильтров уже есть в админ-панели
// (ibripedia.js и т.д.) — здесь только имитация отклика интерфейса.

(function () {
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    // --- Мобильное меню ---
    var burger = document.getElementById('siteBurger');
    var nav = document.getElementById('siteNav');
    var overlay = document.getElementById('siteNavOverlay');

    function closeNav() {
      if (nav) nav.classList.remove('open');
      if (overlay) overlay.classList.remove('show');
    }

    if (burger && nav) {
      burger.addEventListener('click', function () {
        nav.classList.toggle('open');
        if (overlay) overlay.classList.toggle('show', nav.classList.contains('open'));
      });
    }
    if (overlay) overlay.addEventListener('click', closeNav);
    if (nav) {
      nav.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', closeNav);
      });
    }

    // --- Дропдаун профиля ---
    var userBtn = document.getElementById('siteUser');
    var userDropdown = document.getElementById('siteUserDropdown');
    if (userBtn && userDropdown) {
      userBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        userDropdown.classList.toggle('show');
      });
      document.addEventListener('click', function () {
        userDropdown.classList.remove('show');
      });
    }

    // --- Подсветка активного пункта меню по текущему файлу ---
    var page = document.body.getAttribute('data-page');
    if (page) {
      document.querySelectorAll('.site-nav-link[data-page="' + page + '"]').forEach(function (el) {
        el.classList.add('active');
      });
    }

    // --- Чипы-фильтры: чисто визуальное переключение active ---
    document.querySelectorAll('.chip-row').forEach(function (row) {
      row.addEventListener('click', function (e) {
        var chip = e.target.closest('.filter-chip');
        if (!chip) return;
        row.querySelectorAll('.filter-chip').forEach(function (c) { c.classList.remove('active'); });
        chip.classList.add('active');
      });
    });

    // --- Лайк: локальный визуальный тоггл, без сохранения и запросов ---
    document.querySelectorAll('.engage-item.is-like').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var icon = btn.querySelector('i');
        var countEl = btn.querySelector('span');
        var active = btn.classList.toggle('active');
        if (icon) {
          icon.classList.toggle('fas', active);
          icon.classList.toggle('far', !active);
        }
        if (countEl) {
          var n = parseInt(countEl.textContent, 10) || 0;
          countEl.textContent = active ? n + 1 : n - 1;
        }
      });
    });

    // --- Сохранить (галерея): визуальный тоггл кнопки ---
    document.querySelectorAll('.pin-save').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var saved = btn.classList.toggle('is-saved');
        btn.textContent = saved ? 'Сохранено' : 'Сохранить';
      });
    });

    // --- "Загрузить ещё": просто показывает, что кнопка кликабельна ---
    document.querySelectorAll('[data-fake-load-more]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        btn.innerHTML = '<i class="fas fa-check"></i> Это демо-макет — здесь пока нечего подгружать';
        btn.disabled = true;
      });
    });
  });
})();
