// confirm-dialog.js — Единая система модальных диалогов (подтверждение, ввод,
// выбор, предупреждения) и всплывающих уведомлений (toast) для всего сайта
// AllTell (SPA, Antropedia, AllTell, Галерея, Профиль).

(function () {
  'use strict';

  // ========================================================
  // 1. ВСПЛЫВАЮЩИЕ УВЕДОМЛЕНИЯ (TOAST MANAGER)
  // ========================================================

  class ToastManager {
    constructor() {
      this._container = null;
    }

    ensureContainer() {
      if (this._container && document.body.contains(this._container)) {
        return this._container;
      }
      let container = document.getElementById('global-toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'global-toast-container';
        container.className = 'toast-container';
        container.setAttribute('aria-live', 'polite');
        container.setAttribute('role', 'region');
        container.setAttribute('aria-label', 'Всплывающие уведомления');
        document.body.appendChild(container);
      }
      this._container = container;
      return container;
    }

    show(text, type = 'info', duration = 4000) {
      if (text == null || text === '') return () => {};
      const container = this.ensureContainer();

      const toast = document.createElement('div');
      const normalizedType = ['error', 'success', 'warning', 'info'].includes(type) ? type : 'info';
      toast.className = `toast toast-${normalizedType}`;
      toast.setAttribute('role', normalizedType === 'error' ? 'alert' : 'status');

      const iconClass = {
        success: 'fa-circle-check',
        error: 'fa-circle-exclamation',
        warning: 'fa-triangle-exclamation',
        info: 'fa-circle-info'
      }[normalizedType] || 'fa-circle-info';

      const icon = document.createElement('i');
      icon.className = `fas ${iconClass}`;
      icon.setAttribute('aria-hidden', 'true');
      icon.style.cssText = 'flex-shrink: 0; font-size: 16px;';

      const msgSpan = document.createElement('span');
      msgSpan.style.cssText = 'flex: 1; line-height: 1.4; word-break: break-word;';
      msgSpan.textContent = String(text);

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', 'Закрыть');
      closeBtn.style.cssText = 'background:none;border:none;color:currentColor;opacity:0.65;cursor:pointer;font-size:18px;line-height:1;padding:0 0 0 8px;margin-left:auto;display:flex;align-items:center;';
      closeBtn.innerHTML = '&times;';

      toast.appendChild(icon);
      toast.appendChild(msgSpan);
      toast.appendChild(closeBtn);

      let timer = null;
      let dismissed = false;

      const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        if (timer) clearTimeout(timer);
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-6px)';
        toast.style.transition = 'opacity 0.22s ease, transform 0.22s ease';
        setTimeout(() => toast.remove(), 240);
      };

      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dismiss();
      });

      toast.addEventListener('click', dismiss);

      container.appendChild(toast);

      if (duration && duration > 0) {
        timer = setTimeout(dismiss, duration);
      }

      return dismiss;
    }

    success(text, duration) { return this.show(text, 'success', duration); }
    error(text, duration) { return this.show(text, 'error', duration); }
    warning(text, duration) { return this.show(text, 'warning', duration); }
    info(text, duration) { return this.show(text, 'info', duration); }
  }

  // ========================================================
  // 2. МОДАЛЬНЫЙ ДИАЛОГ (CONFIRM / ALERT / PROMPT / CHOOSE)
  // ========================================================

  class ConfirmDialog {
    constructor() {
      this._els = null;
      this._resolve = null;
      this._hist = null;
      this._mode = 'confirm';
    }

    ensureModal() {
      if (this._els) return this._els;

      if (!document.getElementById('confirmDialogStyles')) {
        const style = document.createElement('style');
        style.id = 'confirmDialogStyles';
        style.textContent = `
          #confirmDialogModal { z-index: 2100; }
          #confirmDialogModal .modal-body { word-break: break-word; }
          #confirmDialogModal .modal-footer { gap: 10px; }
        `;
        document.head.appendChild(style);
      }

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.id = 'confirmDialogModal';
      overlay.hidden = true;
      overlay.innerHTML = `
        <div class="modal-box">
          <div class="modal-header">
            <h3 id="confirmDialogTitle">Подтверждение</h3>
            <button type="button" class="modal-close" id="confirmDialogCloseBtn" aria-label="Закрыть">&times;</button>
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

      const finish = async (result, { fromHistory = false } = {}) => {
        let finalVal = result;
        if (this._mode === 'prompt') {
          if (result === null || result === false) {
            finalVal = null;
          } else if (typeof result === 'string') {
            finalVal = result;
          } else {
            const input = overlay.querySelector('.modal-prompt-input');
            finalVal = input ? input.value.trim() : '';
          }
        } else if (this._mode === 'choose') {
          finalVal = result;
        } else if (this._mode === 'alert') {
          finalVal = undefined;
        } else {
          finalVal = !!result;
        }

        overlay.hidden = true;
        const resolve = this._resolve;
        this._resolve = null;
        const hist = this._hist;
        this._hist = null;
        if (hist && !fromHistory && window.modalHistory) await window.modalHistory.close(hist);
        resolve?.(finalVal);
      };

      const cancel = (opts) => finish(this._mode === 'choose' || this._mode === 'prompt' ? null : false, opts);

      overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });
      overlay.querySelector('#confirmDialogCloseBtn').addEventListener('click', cancel);
      overlay.querySelector('#confirmDialogCancelBtn').addEventListener('click', cancel);
      overlay.querySelector('#confirmDialogConfirmBtn').addEventListener('click', () => {
        if (this._mode === 'prompt') {
          const input = overlay.querySelector('.modal-prompt-input');
          finish(input ? input.value.trim() : '');
        } else {
          finish(true);
        }
      });
      overlay.querySelector('.modal-footer').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-choice]');
        if (btn) finish(btn.dataset.choice);
      });
      document.addEventListener('keydown', (e) => {
        if (!overlay.hidden) {
          if (e.key === 'Escape') {
            e.stopPropagation();
            cancel();
          } else if (e.key === 'Enter' && this._mode === 'alert') {
            e.stopPropagation();
            finish();
          }
        }
      }, true);

      this._els = {
        overlay,
        title: overlay.querySelector('#confirmDialogTitle'),
        message: overlay.querySelector('#confirmDialogMessage'),
        body: overlay.querySelector('.modal-body'),
        footer: overlay.querySelector('.modal-footer'),
        cancelBtn: overlay.querySelector('#confirmDialogCancelBtn'),
        confirmBtn: overlay.querySelector('#confirmDialogConfirmBtn'),
        finish,
        cancel
      };
      return this._els;
    }

    _show() {
      const els = this.ensureModal();
      els.overlay.hidden = false;
      if (!this._hist && window.modalHistory) {
        this._hist = window.modalHistory.open(() => els.cancel({ fromHistory: true }));
      }
      return new Promise((resolve) => { this._resolve = resolve; });
    }

    _resolvePrevious() {
      const resolve = this._resolve;
      this._resolve = null;
      resolve?.(this._mode === 'choose' || this._mode === 'prompt' ? null : false);
    }

    dismiss() {
      if (!this._els || this._els.overlay.hidden) return;
      this._els.cancel({ fromHistory: true });
    }

    choose({ title = 'Подтверждение', message = '', buttons = [] } = {}) {
      const els = this.ensureModal();
      this._resolvePrevious();
      this._mode = 'choose';
      els.title.textContent = title;
      els.message.textContent = message;

      const input = els.body.querySelector('.modal-prompt-input');
      if (input) input.style.display = 'none';

      els.confirmBtn.style.display = 'none';
      els.cancelBtn.style.display = '';
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

    open({ title = 'Подтверждение', message = '', confirmLabel = 'Подтвердить', cancelLabel = 'Отмена', danger = true } = {}) {
      const els = this.ensureModal();
      this._resolvePrevious();
      this._mode = 'confirm';
      els.footer.querySelectorAll('[data-choice]').forEach((b) => b.remove());
      els.confirmBtn.style.display = '';
      els.cancelBtn.style.display = '';

      const input = els.body.querySelector('.modal-prompt-input');
      if (input) input.style.display = 'none';

      els.title.textContent = title;
      els.message.textContent = message;
      els.confirmBtn.textContent = confirmLabel;
      els.cancelBtn.textContent = cancelLabel;
      els.confirmBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;

      return this._show();
    }

    prompt({
      title = 'Ввод данных',
      message = '',
      defaultValue = '',
      placeholder = '',
      confirmLabel = 'Подтвердить',
      cancelLabel = 'Отмена',
      danger = false,
      inputType = 'text'
    } = {}) {
      const els = this.ensureModal();
      this._resolvePrevious();
      this._mode = 'prompt';
      els.footer.querySelectorAll('[data-choice]').forEach((b) => b.remove());
      els.confirmBtn.style.display = '';
      els.cancelBtn.style.display = '';

      els.title.textContent = title;
      els.message.textContent = message;
      els.confirmBtn.textContent = confirmLabel;
      els.cancelBtn.textContent = cancelLabel;
      els.confirmBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;

      let input = els.body.querySelector('.modal-prompt-input');
      if (!input) {
        input = document.createElement('input');
        input.className = 'form-input modal-prompt-input';
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            els.finish(input.value.trim());
          }
        });
        els.body.appendChild(input);
      }
      input.type = inputType;
      input.placeholder = placeholder;
      input.value = defaultValue || '';
      input.style.display = '';

      setTimeout(() => {
        input.focus();
        input.select();
      }, 50);

      return this._show();
    }

    alert({
      title = 'Уведомление',
      message = '',
      confirmLabel = 'Понятно',
      variant = 'primary'
    } = {}) {
      const els = this.ensureModal();
      this._resolvePrevious();
      this._mode = 'alert';
      els.footer.querySelectorAll('[data-choice]').forEach((b) => b.remove());
      els.confirmBtn.style.display = '';
      els.cancelBtn.style.display = 'none';

      const input = els.body.querySelector('.modal-prompt-input');
      if (input) input.style.display = 'none';

      els.title.textContent = title;
      els.message.textContent = message;
      els.confirmBtn.textContent = confirmLabel;
      els.confirmBtn.className = `btn btn-${variant}`;

      return this._show().then(() => {});
    }
  }

  // ========================================================
  // 3. ИНИЦИАЛИЗАЦИЯ И ГЛОБАЛЬНЫЙ API
  // ========================================================

  window.toast = new ToastManager();
  window.showMessage = function (text, type = 'info', duration = 4000) {
    return window.toast.show(text, type, duration);
  };
  window.showToast = function (text, typeOrIsError = 'info', duration = 4000) {
    const type = typeof typeOrIsError === 'boolean'
      ? (typeOrIsError ? 'error' : 'success')
      : (typeOrIsError || 'info');
    return window.toast.show(text, type, duration);
  };

  window.confirmDialog = new ConfirmDialog();

  window.showConfirm = function (optsOrMessage, extraOpts) {
    if (typeof optsOrMessage === 'string') {
      return window.confirmDialog.open({ message: optsOrMessage, ...(extraOpts || {}) });
    }
    return window.confirmDialog.open(optsOrMessage);
  };

  window.showPrompt = function (optsOrMessage, defaultValue, extraOpts) {
    if (typeof optsOrMessage === 'string') {
      return window.confirmDialog.prompt({ message: optsOrMessage, defaultValue: defaultValue || '', ...(extraOpts || {}) });
    }
    return window.confirmDialog.prompt(optsOrMessage);
  };

  window.showAlert = function (optsOrMessage, extraOpts) {
    if (typeof optsOrMessage === 'string') {
      return window.confirmDialog.alert({ message: optsOrMessage, ...(extraOpts || {}) });
    }
    return window.confirmDialog.alert(optsOrMessage);
  };

  // Перехват window.alert: заменяем нативное блокирующее белое окно ОС на красивую модалку AllTell
  const _nativeAlert = window.alert;
  window.alert = function (message) {
    if (window.confirmDialog) {
      window.confirmDialog.alert({
        title: 'Уведомление',
        message: String(message ?? ''),
        confirmLabel: 'Понятно',
        variant: 'primary'
      });
    } else {
      _nativeAlert?.call(window, message);
    }
  };
})();
