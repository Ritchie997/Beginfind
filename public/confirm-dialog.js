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
      this._hist = null; // id записи в window.modalHistory, пока окно открыто
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

      // fromHistory — окно закрыто кнопкой «Назад» (запись истории уже
      // снята) или уходом со страницы (записи сбрасывает сам роутер).
      // Иначе сначала снимаем свою запись и только потом отдаём ответ:
      // вызывающий код часто сразу переходит на другую страницу.
      const finish = async (result, { fromHistory = false } = {}) => {
        overlay.hidden = true;
        const resolve = this._resolve;
        this._resolve = null;
        const hist = this._hist;
        this._hist = null;
        if (hist && !fromHistory && window.modalHistory) await window.modalHistory.close(hist);
        resolve?.(result);
      };

      // Отмена (крестик, фон, Esc, «Назад») — false у open() и null у choose().
      const cancel = (opts) => finish(this._mode === 'choose' ? null : false, opts);
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
        finish,
        cancel
      };
      return this._els;
    }

    // Показать окно и завести ему запись истории: «Назад» (в том числе
    // системная на телефоне) закрывает окно, а не уводит на прошлую
    // страницу, оставив его висеть поверх неё.
    _show() {
      const els = this._els;
      els.overlay.hidden = false;
      if (!this._hist && window.modalHistory) {
        this._hist = window.modalHistory.open(() => els.cancel({ fromHistory: true }));
      }
      return new Promise((resolve) => { this._resolve = resolve; });
    }

    // Окно открывают поверх ещё не закрытого — прошлый вызов получает
    // отмену, а запись истории остаётся за окном (оно же и дальше открыто).
    _resolvePrevious() {
      const resolve = this._resolve;
      this._resolve = null;
      resolve?.(this._mode === 'choose' ? null : false);
    }

    // Закрыть как отмену, не трогая историю — роутер при уходе со страницы.
    dismiss() {
      if (!this._els || this._els.overlay.hidden) return;
      this._els.cancel({ fromHistory: true });
    }

    // Выбор из нескольких вариантов (например «Сохранить» / «Не сохранять»)
    // вместо цепочки window.confirm(). buttons — [{ label, value, variant }],
    // variant: 'primary' | 'danger' | 'secondary'. Кнопка «Отмена» всегда
    // есть; отмена (и Esc, и клик мимо окна) — null.
    choose({ title = 'Подтверждение', message = '', buttons = [] } = {}) {
      const els = this.ensureModal();
      this._resolvePrevious();
      this._mode = 'choose';
      els.title.textContent = title;
      els.message.textContent = message;
      // style, а не hidden: у .btn свой display, он перебивает [hidden].
      els.confirmBtn.style.display = 'none';
      els.cancelBtn.textContent = 'Отмена';
      els.footer.querySelectorAll('[data-choice]').forEach((b) => b.remove());
      buttons.forEach((b) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn btn-${b.variant || 'secondary'}`;
        btn.dataset.choice = b.value;
        btn.textContent = b.label;
        els.footer.appendChild(btn);
      });
      return this._show();
    }

    // { title, message, confirmLabel, cancelLabel, danger } — danger (по
    // умолчанию true) красит кнопку подтверждения в btn-danger, как и было у
    // window.confirm() для необратимых удалений; danger:false — обычная
    // btn-primary для менее критичных подтверждений.
    open({ title = 'Подтверждение', message = '', confirmLabel = 'Удалить', cancelLabel = 'Отмена', danger = true } = {}) {
      const els = this.ensureModal();
      // Предыдущий open(), если он ещё не закрыт (не должно случаться при
      // нормальном использовании — модалка модальна), разрешаем как false,
      // чтобы не оставить "зависший" Promise.
      this._resolvePrevious();
      this._mode = 'confirm';
      els.footer.querySelectorAll('[data-choice]').forEach((b) => b.remove());
      els.confirmBtn.style.display = '';

      els.title.textContent = title;
      els.message.textContent = message;
      els.confirmBtn.textContent = confirmLabel;
      els.cancelBtn.textContent = cancelLabel;
      els.confirmBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;

      return this._show();
    }
  }

  window.confirmDialog = new ConfirmDialog();
})();
