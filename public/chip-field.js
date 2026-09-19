// chip-field.js — единый "чиповый" мультивыбор для полей статьи: Категория,
// Доступ для (роли), Теги. Раньше у каждого поля была своя реализация
// (см. историю spa-router.js) с разным видом и отдельными багами — этот
// компонент их заменяет одной проверяемой реализацией.
//
// Два режима:
//  - список (options задан) — Категория/Роли: значения только из списка,
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
          if (this.freeText) {
            this._commitTyped();
          } else {
            const first = this.dropdownEl?.querySelector('.chip-field-dropdown-item');
            if (first) first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          }
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
      return [...this.values];
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
      const text = this.inputEl.value.trim();
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

        const label = document.createElement('span');
        label.className = 'chip-field-chip-label';
        label.textContent = this._labelFor(v);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'chip-field-chip-remove';
        remove.innerHTML = '&times;';
        remove.title = 'Убрать';
        remove.addEventListener('click', (e) => { e.stopPropagation(); this.removeValue(v); });

        chip.append(label, remove);
        this.chipsEl.appendChild(chip);
      });
    }

    _renderDropdown(forceOpen) {
      if (!this.dropdownEl) return;
      if (!this.options) { this._closeDropdown(); return; } // свободный ввод без списка — подсказок нет
      // Без явного forceOpen (фокус/ввод) ничего не показываем — иначе
      // setOptions()/addValue()/removeValue(), вызванные пока поле не в
      // фокусе (например, подгрузка категорий при заходе на страницу, или
      // снятие чипа кликом по крестику), сами открывали бы выпадашку.
      if (!forceOpen && !this._open) return;
      this._open = true;

      const query = (this.inputEl?.value || '').trim().toLowerCase();
      const list = this.options.filter((o) =>
        !this.values.includes(String(o.value)) &&
        (!query || o.label.toLowerCase().includes(query))
      );

      if (!list.length && !forceOpen && !query) { this._closeDropdown(); return; }

      this.dropdownEl.innerHTML = '';
      if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'chip-field-dropdown-empty';
        empty.textContent = this.emptyText;
        this.dropdownEl.appendChild(empty);
      } else {
        list.forEach((o) => {
          const item = document.createElement('div');
          item.className = 'chip-field-dropdown-item';
          item.textContent = o.label;
          item.addEventListener('mousedown', (e) => { e.preventDefault(); this.addValue(o.value); });
          this.dropdownEl.appendChild(item);
        });
      }
      this.dropdownEl.hidden = false;
    }

    _closeDropdown() {
      this._open = false;
      if (this.dropdownEl) this.dropdownEl.hidden = true;
    }

    _syncHidden() {
      if (this.hiddenEl) this.hiddenEl.value = JSON.stringify(this.values);
    }
  }

  window.ChipField = ChipField;
})();
