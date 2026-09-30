// confirm-dialog.js — общая модалка подтверждения ("Удалить?") вместо
// браузерного window.confirm(): тот же неблокирующий, стилизованный под
// приложение попап, что и остальные модалки (.modal-overlay/.modal-box —
// см. global-styles.css), лениво создаётся при первом open() и
// переиспользуется дальше с любой страницы (см. sticker-pack-view.js —
// тот же приём).
//
// Использование: const ok = await window.confirmDialog.open({ message: '...' });
// if (!ok) return;

(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  class ConfirmDialog {
    constructor() {
      this._els = null;
      this._resolve = null;
    }

    ensureModal() {
      if (this._els) return this._els;

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.id = 'confirmDialogModal';
      overlay.hidden = true;
      overlay.innerHTML = `
        <div class="modal-box">
          <div class="modal-header">
            <h3 id="confirmDialogTitle">Подтверждение</h3>
            <button class="modal-close" id="confirmDialogCloseBtn">&times;</button>
          </div>
          <div class="modal-body">
            <p id="confirmDialogMessage" style="margin: 0; color: var(--text-normal); line-height: 1.5;"></p>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" id="confirmDialogCancelBtn">Отмена</button>
            <button type="button" class="btn btn-danger" id="confirmDialogConfirmBtn">Удалить</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const finish = (result) => {
        overlay.hidden = true;
        const resolve = this._resolve;
        this._resolve = null;
        resolve?.(result);
      };

      // Отмена (крестик, фон, Esc) — false у open() и null у choose().
      const cancel = () => finish(this._mode === 'choose' ? null : false);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });
      overlay.querySelector('#confirmDialogCloseBtn').addEventListener('click', cancel);
      overlay.querySelector('#confirmDialogCancelBtn').addEventListener('click', cancel);
      overlay.querySelector('#confirmDialogConfirmBtn').addEventListener('click', () => finish(true));
      overlay.querySelector('.modal-footer').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-choice]');
        if (btn) finish(btn.dataset.choice);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !overlay.hidden) { e.stopPropagation(); cancel(); }
      }, true);

      this._els = {
        overlay,
        title: overlay.querySelector('#confirmDialogTitle'),
        message: overlay.querySelector('#confirmDialogMessage'),
        footer: overlay.querySelector('.modal-footer'),
        cancelBtn: overlay.querySelector('#confirmDialogCancelBtn'),
        confirmBtn: overlay.querySelector('#confirmDialogConfirmBtn'),
        finish
      };
      return this._els;
    }

    // Выбор из нескольких вариантов (например «Сохранить» / «Не сохранять»)
    // вместо цепочки window.confirm(). buttons — [{ label, value, variant }],
    // variant: 'primary' | 'danger' | 'secondary'. Кнопка «Отмена» всегда
    // есть; отмена (и Esc, и клик мимо окна) — null.
    choose({ title = 'Подтверждение', message = '', buttons = [] } = {}) {
      const els = this.ensureModal();
      if (this._resolve) els.finish(this._mode === 'choose' ? null : false);
      this._mode = 'choose';
      els.title.textContent = title;
      els.message.textContent = message;
      // style, а не hidden: у .btn свой display, он перебивает [hidden].
      els.confirmBtn.style.display = 'none';
      els.footer.querySelectorAll('[data-choice]').forEach((b) => b.remove());
      buttons.forEach((b) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn btn-${b.variant || 'secondary'}`;
        btn.dataset.choice = b.value;
        btn.textContent = b.label;
        els.footer.appendChild(btn);
      });
      els.overlay.hidden = false;
      return new Promise((resolve) => { this._resolve = resolve; });
    }

    // { title, message, confirmLabel, danger } — danger (по умолчанию true)
    // красит кнопку подтверждения в btn-danger, как и было у window.confirm()
    // для необратимых удалений; danger:false — обычная btn-primary для менее
    // критичных подтверждений.
    open({ title = 'Подтверждение', message = '', confirmLabel = 'Удалить', danger = true } = {}) {
      const els = this.ensureModal();
      // Предыдущий open(), если он ещё не закрыт (не должно случаться при
      // нормальном использовании — модалка модальна), разрешаем как false,
      // чтобы не оставить "зависший" Promise.
      if (this._resolve) els.finish(this._mode === 'choose' ? null : false);
      this._mode = 'confirm';
      els.footer.querySelectorAll('[data-choice]').forEach((b) => b.remove());
      els.confirmBtn.style.display = '';

      els.title.textContent = title;
      els.message.textContent = message;
      els.confirmBtn.textContent = confirmLabel;
      els.confirmBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;

      els.overlay.hidden = false;
      return new Promise((resolve) => { this._resolve = resolve; });
    }
  }

  window.confirmDialog = new ConfirmDialog();
})();
