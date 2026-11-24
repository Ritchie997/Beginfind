// chip-field.js — единый "чиповый" мультивыбор для полей статьи: Доступ
// для (роли), Теги. Раньше у каждого поля была своя реализация
// (см. историю spa-router.js) с разным видом и отдельными багами — этот
// компонент их заменяет одной проверяемой реализацией.
//
// Два режима:
//  - список (options задан) — Роли: значения только из списка,
//    клик по варианту в выпадашке добавляет/убирает чип. Текст в поле — это
//    фильтр по списку, а не новый элемент.
//  - свободный ввод (freeText: true) — Теги: Enter/клик по "+" добавляет
//    введённый текст как чип.
//
// Ключевое отличие от старого кода: getValues() всегда "доливает" то, что
// напечатано в поле, но ещё не оформлено в чип — раньше набранный, но не
// подтверждённый явно текст молча терялся при сохранении статьи.

(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  class ChipField {
    /**
     * @param {HTMLElement} root — контейнер с разметкой .chip-field (см. articles.html)
     * @param {{options?: {value:string,label:string}[]|null, freeText?: boolean, placeholder?: string, emptyText?: string, onChange?: (values:string[])=>void}} opts
     */
    constructor(root, opts = {}) {
      this.root = root;
      this.options = opts.options || null;
      this.freeText = !!opts.freeText;
      this.emptyText = opts.emptyText || 'Ничего не найдено';
      this.onChange = opts.onChange || null;
      this.values = [];
      this._open = false; // раскрыта ли выпадашка сейчас — см. _renderDropdown

      this.chipsEl = root.querySelector('.chip-field-chips');
      this.inputEl = root.querySelector('.chip-field-input');
      this.dropdownEl = root.querySelector('.chip-field-dropdown');
      this.hiddenEl = root.querySelector('.chip-field-hidden');

      if (opts.placeholder && this.inputEl) this.inputEl.placeholder = opts.placeholder;

      this._bind();
    }

    _bind() {
      if (!this.inputEl) return;

      this.inputEl.addEventListener('input', () => this._renderDropdown());
      this.inputEl.addEventListener('focus', () => this._renderDropdown(true));

      this.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const active = this.dropdownEl?.querySelector('.chip-field-dropdown-item.is-active, .chip-field-dropdown-item:hover');
          if (active && active.dataset.value != null) {
            this.addValue(active.dataset.value);
          } else if (this.freeText) {
            this._commitTyped();
          } else {
            const first = this.dropdownEl?.querySelector('.chip-field-dropdown-item');
            if (first && first.dataset.value != null) this.addValue(first.dataset.value);
          }
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (!this._open) {
            this._renderDropdown(true);
            return;
          }
          const items = Array.from(this.dropdownEl?.querySelectorAll('.chip-field-dropdown-item') || []);
          if (!items.length) return;
          let idx = items.findIndex((it) => it.classList.contains('is-active') || it.classList.contains('eb-suggest-active'));
          if (idx !== -1) items[idx].classList.remove('is-active', 'eb-suggest-active');
          idx = (idx + 1) % items.length;
          items[idx].classList.add('is-active', 'eb-suggest-active');
          items[idx].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (!this._open) return;
          const items = Array.from(this.dropdownEl?.querySelectorAll('.chip-field-dropdown-item') || []);
          if (!items.length) return;
          let idx = items.findIndex((it) => it.classList.contains('is-active') || it.classList.contains('eb-suggest-active'));
          if (idx !== -1) items[idx].classList.remove('is-active', 'eb-suggest-active');
          idx = idx <= 0 ? items.length - 1 : idx - 1;
          items[idx].classList.add('is-active', 'eb-suggest-active');
          items[idx].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Backspace' && !this.inputEl.value && this.values.length) {
          this.removeValue(this.values[this.values.length - 1]);
        } else if (e.key === 'Escape') {
          this._closeDropdown();
          this.inputEl.blur();
        }
      });

      document.addEventListener('click', (e) => {
        if (!this.root.contains(e.target)) this._closeDropdown();
      });
    }

    /** Обновляет список вариантов для режима "список" (например, роли — при смене сервера). */
    setOptions(options) {
      this.options = options || null;
      this._renderDropdown();
    }

    /** Меняет плейсхолдер поля ввода (например, роли — "Сначала выберите сервер..." → "Выберите роли..."). */
    setPlaceholder(text) {
      if (this.inputEl) this.inputEl.placeholder = text;
    }

    setValues(values) {
      this.values = Array.isArray(values) ? values.map(String) : [];
      this._syncHidden();
      this._renderChips();
    }

    // Ключевой метод: перед возвратом значений сначала "доливает" то, что
    // напечатано в поле ввода, но не превращено в чип явным действием —
    // иначе при сохранении статьи такой текст молча пропадал (см. заголовок файла).
    getValues() {
      if (this.freeText) this._commitTyped(/* silent */ true);
      else this._commitTypedOption();
      return [...this.values];
    }

    // Режим "список": набранный текст, точно совпадающий с подписью варианта
    // (без учёта регистра), тоже считается выбором — иначе роль, напечатанная
    // в "Доступ для", но не выбранная кликом, молча терялась, и "закрытая"
    // статья сохранялась без ролей.
    _commitTypedOption() {
      const text = (this.inputEl?.value || '').trim().toLowerCase();
      if (!text || !this.options) return;
      const opt = this.options.find((o) => String(o.label).trim().toLowerCase() === text);
      if (!opt) return;
      this.inputEl.value = '';
      if (!this.values.includes(String(opt.value))) {
        this.values.push(String(opt.value));
        this._syncHidden();
        this._renderChips();
        this.onChange?.(this.values);
      }
    }

    addValue(value) {
      const v = String(value);
      if (this.values.includes(v)) return;
      this.values.push(v);
      this.inputEl.value = '';
      this._syncHidden();
      this._renderChips();
      this._renderDropdown();
      this.onChange?.(this.values);
    }

    removeValue(value) {
      const v = String(value);
      if (!this.values.includes(v)) return;
      this.values = this.values.filter((x) => x !== v);
      this._syncHidden();
      this._renderChips();
      this._renderDropdown();
      this.onChange?.(this.values);
    }

    // Публичный алиас для _commitTyped — используется, например, кнопкой "+"
    // рядом с полем тегов на мобильных, где Enter неудобен.
    commitTyped() {
      this._commitTyped();
    }

    _commitTyped(silent) {
      const raw = (this.inputEl.value || '').trim();
      const text = raw.replace(/^#+/, '').replace(/^\[+|\]+$/g, '').trim();
      this.inputEl.value = '';
      if (!text) { if (!silent) this._closeDropdown(); return; }
      if (!this.values.includes(text)) {
        this.values.push(text);
        this._syncHidden();
        this._renderChips();
        this.onChange?.(this.values);
      }
      if (!silent) this._closeDropdown();
    }

    _labelFor(value) {
      if (this.options) {
        const opt = this.options.find((o) => String(o.value) === String(value));
        if (opt) return opt.label;
      }
      return value;
    }

    _renderChips() {
      if (!this.chipsEl) return;
      this.chipsEl.innerHTML = '';
      this.values.forEach((v) => {
        const chip = document.createElement('span');
        chip.className = 'chip-field-chip';
        const cleanVal = String(v).replace(/^#+/, '').replace(/^\[+|\]+$/g, '');
        const color = (window.TagColors && window.TagColors.get(cleanVal)) || null;

        const label = document.createElement('span');
        label.className = 'chip-field-chip-label';
        const isTag = Boolean(this.freeText || color || (window.TagColors && window.TagColors.has(cleanVal)));
        const rawLabel = this._labelFor(v);
        label.textContent = isTag && !rawLabel.startsWith('#') ? '#' + rawLabel : rawLabel;

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'chip-field-chip-remove';
        remove.innerHTML = '&times;';
        remove.title = 'Убрать';
        remove.addEventListener('click', (e) => { e.stopPropagation(); this.removeValue(v); });

        if (color) {
          chip.style.backgroundColor = `${color}28`;
          chip.style.borderColor = `${color}66`;
          chip.style.color = color;
          chip.classList.add('has-tag-color');
          remove.style.color = color;
          remove.style.backgroundColor = `${color}33`;
        } else if (window.TagColors) {
          window.TagColors.paint(chip, cleanVal);
        }

        chip.append(label, remove);
        this.chipsEl.appendChild(chip);
      });
    }

    _renderDropdown(forceOpen) {
      if (!this.dropdownEl) return;
      if (!this.options) { this._closeDropdown(); return; } // свободный ввод без списка — подсказок нет
      // Без явного forceOpen (фокус/ввод) ничего не показываем — иначе
      // setOptions()/addValue()/removeValue(), вызванные пока поле не в
      // фокусе (например, подгрузка ролей при заходе на страницу, или
      // снятие чипа кликом по крестику), сами открывали бы выпадашку.
      if (!forceOpen && !this._open) return;
      this._open = true;

      const rawQuery = (this.inputEl?.value || '').trim().toLowerCase();
      const query = rawQuery.replace(/^#+/, '');
      const list = this.options.filter((o) => {
        if (this.values.includes(String(o.value))) return false;
        if (!query) return true;
        const optLabel = String(o.label || o.value).toLowerCase();
        const optClean = optLabel.replace(/^#+/, '');
        return optLabel.includes(rawQuery) || optClean.includes(query);
      });

      if (!list.length && !forceOpen && !query) { this._closeDropdown(); return; }

      const isTagField = Boolean(this.freeText || (this.options && this.options.some((o) => o.isTag || o.color)));
      if (isTagField) {
        this.dropdownEl.classList.add('eb-tag-suggest');
      } else {
        this.dropdownEl.classList.remove('eb-tag-suggest');
      }

      this.dropdownEl.innerHTML = '';
      if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'chip-field-dropdown-empty';
        empty.textContent = this.emptyText;
        this.dropdownEl.appendChild(empty);
      } else {
        const plural = (n, one, few, many) => {
          const m10 = n % 10;
          const m100 = n % 100;
          if (m10 === 1 && m100 !== 11) return one;
          if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
          return many;
        };

        list.forEach((o, i) => {
          const item = document.createElement('div');
          item.dataset.value = o.value;
          const cleanName = String(o.label || o.value).replace(/^#+/, '').replace(/^\[+|\]+$/g, '');
          const isTag = Boolean(o.isTag || this.freeText || o.color || (window.TagColors && window.TagColors.has(cleanName)));

          if (isTag) {
            item.className = 'chip-field-dropdown-item eb-suggest-tag-item' + (i === 0 ? ' is-active eb-suggest-active' : '');
            const color = o.color || (window.TagColors && window.TagColors.get(cleanName)) || '#5865f2';
            const count = o.count != null ? Number(o.count) : null;
            const countStr = count != null && count > 0 ? `${count} ${plural(count, 'статья', 'статьи', 'статей')}` : '';

            item.innerHTML = `
              <span class="eb-suggest-tag-icon" style="background:${color}26;color:${color}"><i class="fas fa-hashtag"></i></span>
              <span class="eb-suggest-tag-name">#${escapeHtml(cleanName)}</span>
              ${countStr ? `<span class="eb-suggest-tag-meta">${countStr}</span>` : ''}
            `;
          } else {
            item.className = 'chip-field-dropdown-item' + (i === 0 ? ' is-active' : '');
            item.textContent = o.label;
          }

          item.addEventListener('mouseenter', () => {
            this.dropdownEl?.querySelectorAll('.chip-field-dropdown-item.is-active, .chip-field-dropdown-item.eb-suggest-active')
              .forEach((el) => el.classList.remove('is-active', 'eb-suggest-active'));
            item.classList.add('is-active', 'eb-suggest-active');
          });

          item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            this.addValue(o.value);
          });
          this.dropdownEl.appendChild(item);
        });
      }
      this.dropdownEl.hidden = false;
      this.root?.classList.add('has-open-dropdown');
    }

    _closeDropdown() {
      this._open = false;
      if (this.dropdownEl) this.dropdownEl.hidden = true;
      this.root?.classList.remove('has-open-dropdown');
    }

    _syncHidden() {
      if (this.hiddenEl) this.hiddenEl.value = JSON.stringify(this.values);
    }
  }

  window.ChipField = ChipField;
})();
