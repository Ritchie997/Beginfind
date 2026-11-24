// tag-colors.js — клиентский реестр цветов тегов во всей системе (админ-панель,
// статьи, лента постов AllTell, витрина Antropedia).
//
// Синхронизируется с базой tag_colors (через /api/tags и /api/public/tags).
// При смене цвета тега в админке или подгрузке тегов с сервера мгновенно
// перекрашивает все теги и хэштеги, уже показанные на странице.

(function () {
  'use strict';

  function normalizeTagKey(tag) {
    return String(tag == null ? '' : tag)
      .trim()
      .replace(/^#+/, '')
      .replace(/^\[+|\]+$/g, '')
      .trim()
      .toLowerCase();
  }

  const tagColorMap = new Map();
  let loadingPromise = null;

  const TagColors = {
    normalizeKey: normalizeTagKey,

    get(tag) {
      if (!tag) return null;
      return tagColorMap.get(normalizeTagKey(tag)) || null;
    },

    set(tag, color) {
      const k = normalizeTagKey(tag);
      if (!k || !color) return;
      const normalizedColor = String(color).toLowerCase();
      tagColorMap.set(k, normalizedColor);
      if (typeof document !== 'undefined') {
        this.repaintTag(k);
      }
    },

    has(tag) {
      return tagColorMap.has(normalizeTagKey(tag));
    },

    registerAll(items) {
      if (!Array.isArray(items) || !items.length) return;
      let changed = false;
      items.forEach((it) => {
        if (!it) return;
        const tag = it.tag || it.name || it.key;
        const color = it.color;
        if (tag && color) {
          const k = normalizeTagKey(tag);
          const hex = String(color).toLowerCase();
          if (tagColorMap.get(k) !== hex) {
            tagColorMap.set(k, hex);
            changed = true;
          }
        }
      });
      if (changed && typeof document !== 'undefined') {
        this.repaintAll();
      }
    },

    getMap() {
      return tagColorMap;
    },

    paint(el, tag, options = {}) {
      if (!el || typeof el.getAttribute !== 'function') return;
      const raw = tag || el.dataset?.tag || el.dataset?.value || el.textContent;
      const color = this.get(raw);
      if (!color) return;

      const isActive = el.classList.contains('active');
      const alphaBg = options.alphaBg || (isActive ? '40' : '20');
      const alphaBorder = options.alphaBorder || (isActive ? 'ff' : '4d');

      if (el.classList.contains('chip-field-chip')) {
        el.style.backgroundColor = `${color}28`;
        el.style.color = color;
        el.style.border = `1px solid ${color}55`;
        const removeBtn = el.querySelector('.chip-field-chip-remove');
        if (removeBtn) {
          removeBtn.style.color = color;
          removeBtn.style.background = `${color}33`;
        }
      } else {
        const isMetadataPill = el.classList.contains('wiki-tag') ||
          el.classList.contains('antropedia-tag-pill') ||
          el.classList.contains('antropedia-view-tag') ||
          el.classList.contains('antropedia-tag-chip');

        if (isMetadataPill || options.keepTextColor) {
          el.style.color = (isActive || options.textColor === '#ffffff') ? '#ffffff' : 'var(--text-normal, #dbdee1)';
        } else {
          el.style.color = isActive ? '#ffffff' : color;
        }
        el.style.backgroundColor = `${color}${alphaBg}`;
        el.style.borderColor = `${color}${alphaBorder}`;
      }
      el.classList.add('has-tag-color');
    },

    paintAll(root) {
      if (!root) return;
      const target = (root.nodeType === 1 || root.nodeType === 9 || root.nodeType === 11) ? root : document;
      if (typeof target.querySelectorAll !== 'function') return;
      const elements = target.querySelectorAll(
        '.hashtag, .wiki-tag, .antropedia-tag-pill, .antropedia-tag-chip, .chip-field-chip'
      );
      elements.forEach((el) => this.paint(el));
    },

    repaintTag(normalizedKey) {
      if (typeof document === 'undefined') return;
      const color = tagColorMap.get(normalizedKey);
      if (!color) return;

      const elements = document.querySelectorAll(
        `.hashtag[data-tag="${normalizedKey}"], [data-tag="${normalizedKey}"], [data-value="${normalizedKey}"]`
      );
      elements.forEach((el) => this.paint(el, normalizedKey));

      document.querySelectorAll('.hashtag, .wiki-tag, .antropedia-tag-pill, .antropedia-tag-chip, .chip-field-chip').forEach((el) => {
        const raw = el.dataset?.tag || el.dataset?.value || el.textContent;
        if (normalizeTagKey(raw) === normalizedKey) {
          this.paint(el, raw);
        }
      });
    },

    repaintAll() {
      if (typeof document === 'undefined') return;
      this.paintAll(document);
    },

    async ensureLoaded() {
      if (tagColorMap.size > 0) return tagColorMap;
      if (loadingPromise) return loadingPromise;

      loadingPromise = (async () => {
        try {
          let list = null;
          if (window.apiClient && typeof window.apiClient.getTags === 'function') {
            const res = await window.apiClient.getTags();
            if (res && res.success && Array.isArray(res.data)) list = res.data;
          }
          if (!list) {
            const token = (window.authSystem && typeof window.authSystem.getToken === 'function')
              ? window.authSystem.getToken()
              : (window.apiClient && window.apiClient.token);
            const url = token ? '/api/tags' : '/api/public/tags';
            const headers = token ? { Authorization: `Bearer ${token}` } : {};
            const res = await fetch(url, { headers, credentials: 'omit' });
            if (res.ok) {
              const data = await res.json();
              list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
            }
          }
          if (Array.isArray(list)) {
            this.registerAll(list);
          }
        } catch (e) {
          // ignore network failure
        } finally {
          loadingPromise = null;
        }
        return tagColorMap;
      })();

      return loadingPromise;
    }
  };

  if (typeof window !== 'undefined') {
    window.TagColors = TagColors;
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => TagColors.ensureLoaded());
      } else {
        setTimeout(() => TagColors.ensureLoaded(), 0);
      }
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TagColors;
  }
})();
