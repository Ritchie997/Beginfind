// feedback-manager.js — раздел "Обращения": пользователь отправляет
// багрепорты/предложения по шаблону и видит их статус; модераторы работают в
// своих линиях — очистка (feedback_triage), кейсы (feedback_cases), решение
// (feedback_decide). Логика и статусы — см. src/services/feedback-store.js.
// Вкладки по правам здесь — только подсказка интерфейса, сервер проверяет
// каждое действие заново.

(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // SQLite CURRENT_TIMESTAMP — UTC без зоны ("2026-09-28 10:00:00").
  function formatDate(value) {
    if (!value) return '—';
    const d = new Date(String(value).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? '' : 'Z'));
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  const TYPE_LABELS = { bug: 'Проблема', idea: 'Идея', article: 'Статья' };
  const MAX_SCREENSHOTS = 5; // как MAX_SCREENSHOTS в feedback-store.js
  // Сколько ждём загрузку одного скриншота. У fetch своего таймаута нет:
  // на телефоне с плохой связью запрос мог висеть бесконечно, и всё это
  // время «Отправить» оставалась заблокированной.
  const UPLOAD_TIMEOUT_MS = 60 * 1000;
  // Совпадает с ARTICLE_REASONS в feedback-store.js.
  const ARTICLE_REASON_LABELS = {
    inaccurate: 'Недостоверная информация',
    outdated: 'Устарело',
    offensive: 'Оскорбления / нарушение правил',
    plagiarism: 'Плагиат',
    spam: 'Спам / реклама',
    other: 'Другое'
  };
  const FREQUENCY_LABELS = { always: 'Всегда', often: 'Часто', sometimes: 'Иногда', once: 'Один раз' };
  // Критичность — число 1–4 (по нему сервер считает приоритет, а 4 сразу
  // отправляет кейс на третью линию — см. feedback-store.js), но смысл
  // ступеней у проблемы, идеи и жалобы на статью разный: "потеря данных"
  // для идеи звучала бы нелепо. short — для чипа на карточке кейса.
  const SEVERITY_SCALES = {
    bug: {
      1: { short: 'Косметика', full: '1 — Косметика: выглядит не так, но работает' },
      2: { short: 'Мешает', full: '2 — Мешает: неудобно, но есть обходной путь' },
      3: { short: 'Ломает функцию', full: '3 — Ломает функцию: обхода нет' },
      4: { short: 'Критично', full: '4 — Критично: потеря данных или безопасность' }
    },
    idea: {
      1: { short: 'Мелочь', full: '1 — Мелочь: приятно, но можно и без этого' },
      2: { short: 'Полезно', full: '2 — Полезно: заметно улучшит удобство' },
      3: { short: 'Важно', full: '3 — Важно: нужно многим или давно просят' },
      4: { short: 'Срочно', full: '4 — Срочно: без этого не работает важный сценарий' }
    },
    article: {
      1: { short: 'Мелочь', full: '1 — Мелочь: опечатки, оформление' },
      2: { short: 'Неточность', full: '2 — Неточность: ошибки в деталях' },
      3: { short: 'Серьёзная ошибка', full: '3 — Серьёзная ошибка: неверные факты, вводит в заблуждение' },
      4: { short: 'Срочно', full: '4 — Срочно: нарушение правил, оскорбления, вред' }
    }
  };
  function severityInfo(type, sev) {
    const scale = SEVERITY_SCALES[type] || SEVERITY_SCALES.bug;
    return scale[sev] || { short: String(sev), full: String(sev) };
  }
  function severityOptions(type, selected) {
    return [1, 2, 3, 4].map((sev) => `<option value="${sev}" ${sev === selected ? 'selected' : ''}>${escapeHtml(severityInfo(type, sev).full)}</option>`).join('');
  }
  const SUMMARY_LABELS = { bug: 'Суть проблемы', idea: 'Суть идеи', article: 'Суть жалобы' };
  const CASE_STATUS_LABELS = { open: 'На доработке', escalated: 'На третьей линии', accepted: 'Принят, в работе', resolved: 'Решён', archived: 'Архив' };
  const EVENT_LABELS = {
    report_created: 'обращение создано',
    report_accepted: 'обращение принято',
    report_rejected: 'обращение отклонено',
    report_restored: 'обращение возвращено в очередь',
    report_edited: 'автор изменил обращение',
    report_resubmitted: 'автор исправил и отправил заново',
    report_withdrawn: 'автор отозвал обращение',
    case_created: 'кейс создан',
    case_updated: 'кейс изменён',
    report_attached: 'обращение добавлено',
    report_detached: 'обращение отвязано',
    fact_added: 'факт добавлен',
    fact_updated: 'факт изменён',
    fact_deleted: 'факт удалён',
    case_escalated: 'передан на третью линию',
    case_returned: 'возвращён на доработку',
    case_decided: 'решение принято',
    case_completed: 'кейс завершён',
    case_archived: 'отправлен в архив'
  };

  function typeChip(type) {
    const cls = type === 'bug' ? 'bug' : type === 'article' ? 'article' : 'idea';
    return `<span class="feedback-chip ${cls}">${TYPE_LABELS[type] || type}</span>`;
  }

  // Статус обращения глазами его автора: обращение само по себе проходит
  // только первую линию, дальше его судьбу определяет кейс.
  function authorStatus(report) {
    if (report.status === 'new') return { chip: 'pending', text: 'На проверке' };
    if (report.status === 'rejected') return { chip: 'bad', text: 'Отклонено модератором' };
    if (report.status === 'withdrawn') return { chip: '', text: 'Отозвано' };
    if (!report.caseId) return { chip: 'pending', text: 'Принято, ждёт разбора' };
    if (report.caseStatus === 'open') return { chip: 'pending', text: 'В работе' };
    if (report.caseStatus === 'escalated') return { chip: 'pending', text: 'Передано на решение' };
    if (report.caseStatus === 'accepted') {
      const text = { bug: 'Подтверждено — исправляем', article: 'Жалоба подтверждена — исправляем' }[report.type] || 'Принято — в работе';
      return { chip: 'pending', text };
    }
    if (report.caseDecision === 'accepted') {
      const text = { bug: 'Исправлено', article: 'Статья исправлена' }[report.type] || 'Реализовано';
      return { chip: 'ok', text };
    }
    if (report.caseDecision === 'declined') return { chip: 'bad', text: 'Отклонено' };
    return { chip: '', text: CASE_STATUS_LABELS[report.caseStatus] || '—' };
  }

  function renderAttachments(urls, removable) {
    return (urls || []).map((url, index) => {
      const remove = removable ? `<button type="button" class="feedback-attachment-remove" data-remove-attachment="${index}" title="Убрать">&times;</button>` : '';
      if (url.startsWith('/uploads/')) {
        // data-shot — открыть во встроенном просмотрщике (см. openLightbox);
        // href остаётся — средней кнопкой/Ctrl+клик откроется оригинал.
        return `<span class="feedback-attachment"><a href="${escapeHtml(url)}" target="_blank" rel="noopener" data-shot="${escapeHtml(url)}"><img src="${escapeHtml(url)}" alt="" loading="lazy"></a>${remove}</span>`;
      }
      return `<span class="feedback-attachment is-link"><a class="feedback-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>${remove}</span>`;
    }).join('');
  }

  function field(label, value) {
    if (!value) return '';
    return `<div><div class="feedback-field-label">${escapeHtml(label)}</div><div class="feedback-field-value">${escapeHtml(value)}</div></div>`;
  }

  // Полное содержимое обращения — в разворачиваемом блоке, чтобы список
  // оставался компактным.
  // Ссылка на статью жалобы — кнопка, а не <a>: переход внутри SPA (см.
  // обработчик [data-open-article] в bindEvents).
  function articleLink(report) {
    if (!report.articleSlug) return '';
    return `<button type="button" class="feedback-article-link" data-open-article="${escapeHtml(report.articleSlug)}"><i class="fas fa-book-open"></i> ${escapeHtml(report.articleTitle || report.articleSlug)}</button>`;
  }

  function renderReportFields(report) {
    const env = [report.version && `версия ${report.version}`, report.platform, report.frequency && FREQUENCY_LABELS[report.frequency]]
      .filter(Boolean).join(' · ');
    const descriptionLabel = { bug: 'Описание проблемы', article: 'Что не так со статьёй' }[report.type] || 'Предложение';
    const article = report.type === 'article'
      ? `<div><div class="feedback-field-label">Статья</div><div>${articleLink(report)}</div></div>
         ${field('Причина', ARTICLE_REASON_LABELS[report.articleReason] || report.articleReason)}`
      : '';
    return `
      <div class="feedback-fields">
        ${article}
        ${field(descriptionLabel, report.description)}
        ${field('Шаги воспроизведения', report.steps)}
        ${field('Ожидаемое поведение', report.expected)}
        ${field('Фактическое поведение', report.actual)}
        ${field('Версия · платформа · частота', env)}
        ${field('Комментарий', report.comment)}
      </div>`;
  }

  // Скриншоты обращения — отдельно от текстовых полей: их видно сразу, без
  // "Подробнее" (смотреть приходится часто, а раскрывать каждое — долго).
  function renderReportShots(report) {
    const shots = (report.attachments || []).filter((u) => u.startsWith('/uploads/'));
    const links = (report.attachments || []).filter((u) => !u.startsWith('/uploads/'));
    if (!shots.length && !links.length) return '';
    return `<div class="feedback-attachments feedback-shots">${renderAttachments([...shots, ...links], false)}</div>`;
  }

  class FeedbackManager {
    constructor() {
      this.currentTab = 'mine';
      this.perms = { triage: false, cases: false, decide: false };
      this.triageView = 'new';
      this.reportType = 'bug';
      this.attachments = [];
      this.queueSelected = new Set();
      this.openCases = [];
      this.currentCase = null;
      this._textModalResolve = null;
      this.editingReport = null; // своё обращение в форме правки (null — новое)
      this.myReports = new Map();
      this.queueReports = new Map();
      this.triageReports = new Map();
      this.newCaseIds = [];
      this._lightbox = null;
      this.uploading = 0;
      this.formSession = 0; // номер открытия формы — см. openCreateModal/uploadFiles
    }

    async api(endpoint, method = 'GET', data = null) {
      const result = await window.apiClient.makeAuthenticatedRequest(endpoint, method, data);
      if (!result.success) {
        const message = (result.data && result.data.error) || result.error || 'Ошибка запроса';
        throw new Error(message);
      }
      return result.data;
    }

    async init() {
      this.root = document.querySelector('.feedback-page');
      if (!this.root) return; // партиал ещё не в DOM
      // Менеджер один на всё приложение и переживает уход со страницы:
      // загрузки, начатые в прошлый заход, к новой форме отношения не имеют.
      this.formSession++;
      this.uploading = 0;

      const user = (window.authManager && authManager.getUser()) || {};
      const has = (key) => !!(user.is_root || (user.permissions && user.permissions[key]));
      this.perms = { triage: has('feedback_triage'), cases: has('feedback_cases'), decide: has('feedback_decide') };
      this.triageView = 'new';
      this.root.querySelector('[data-feedback-tab="triage"]').hidden = !this.perms.triage;
      this.root.querySelector('[data-feedback-tab="cases"]').hidden = !this.perms.cases;
      this.root.querySelector('[data-feedback-tab="decide"]').hidden = !this.perms.decide;
      // Отклонённые обращения видит и вторая линия (для выборочной проверки
      // первой), даже без права очистки — но тогда только их.
      if (this.perms.cases && !this.perms.triage) {
        this.root.querySelector('[data-feedback-tab="triage"]').hidden = false;
        this.root.querySelector('[data-triage-view="new"]').hidden = true;
        this.triageView = 'rejected';
      }

      this.bindEvents();
      this.switchTab('mine');
      this.refreshBadges();
    }

    bindEvents() {
      const root = this.root;

      root.querySelector('#feedbackTabs').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-feedback-tab]');
        if (btn) this.switchTab(btn.dataset.feedbackTab);
      });

      root.querySelectorAll('[data-close-modal]').forEach((btn) => {
        btn.addEventListener('click', () => this.closeModal(btn.dataset.closeModal));
      });
      // Формы с набранным текстом (обращение, сборка кейса) по клику мимо
      // окна не закрываются — иначе случайный клик стирал бы написанное.
      root.querySelectorAll('.modal-overlay:not(#feedbackCreateModal):not(#feedbackNewCaseModal)').forEach((overlay) => {
        overlay.addEventListener('click', (e) => { if (e.target === overlay) this.closeModal(overlay.id); });
      });

      // --- Создание обращения ---
      root.querySelector('#feedbackCreateBtn').addEventListener('click', () => this.openCreateModal());
      root.querySelector('#feedbackTypeSwitch').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-report-type]');
        if (btn) this.setReportType(btn.dataset.reportType);
      });
      root.querySelector('#feedbackPickFileBtn').addEventListener('click', () => root.querySelector('#feedbackFileInput').click());
      root.querySelector('#feedbackFileInput').addEventListener('change', (e) => this.uploadFiles(e.target));
      root.querySelector('#feedbackAttachments').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-remove-attachment]');
        if (!btn) return;
        this.attachments.splice(Number(btn.dataset.removeAttachment), 1);
        this.renderFormAttachments();
      });
      root.querySelector('#feedbackSubmitBtn').addEventListener('click', (e) => runExclusive(e.currentTarget, () => this.submitReport()));
      root.querySelector('#feedbackMineList').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-edit-report]');
        if (btn) this.openCreateModal(this.myReports.get(Number(btn.dataset.editReport)));
        const withdrawBtn = e.target.closest('[data-withdraw-report]');
        if (withdrawBtn) runExclusive(withdrawBtn, () => this.withdrawReport(Number(withdrawBtn.dataset.withdrawReport)));
      });

      // --- Первая линия ---
      root.querySelectorAll('[data-triage-view]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.triageView = btn.dataset.triageView;
          this.loadTriage();
        });
      });
      root.querySelector('#feedbackTriageList').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-report-action]');
        if (btn) runExclusive(btn, () => this.triageAction(btn.dataset.reportAction, btn.dataset.id));
      });

      // --- Вторая линия ---
      // Выбор — только кнопкой-галочкой слева (раньше вся шапка карточки была
      // <label>, и клик по заголовку незаметно ставил галочку). Одиночная
      // передача на третью линию — кнопкой прямо на карточке.
      root.querySelector('#feedbackQueueList').addEventListener('click', (e) => {
        const toggle = e.target.closest('[data-queue-select]');
        if (toggle) {
          const id = Number(toggle.dataset.queueSelect);
          if (this.queueSelected.has(id)) this.queueSelected.delete(id);
          else this.queueSelected.add(id);
          this.syncQueueSelection();
          return;
        }
        const single = e.target.closest('[data-queue-escalate]');
        if (single) this.openNewCaseModal([Number(single.dataset.queueEscalate)], this.queueReports);
      });
      root.querySelector('#feedbackQueueCreateBtn').addEventListener('click', () => this.openNewCaseModal(Array.from(this.queueSelected), this.queueReports));
      root.querySelector('#feedbackQueueClearBtn').addEventListener('click', () => {
        this.queueSelected.clear();
        this.syncQueueSelection();
      });
      root.querySelector('#feedbackNewCaseConfirm').addEventListener('click', (e) => runExclusive(e.currentTarget, () => this.createCaseFromQueue()));
      root.querySelector('#feedbackQueueAttachBtn').addEventListener('click', (e) => runExclusive(e.currentTarget, () => this.attachQueueToCase()));
      root.querySelector('#feedbackCasesFilter').addEventListener('change', () => this.loadCasesList());

      ['#feedbackCasesList', '#feedbackDecideList', '#feedbackWorkList'].forEach((sel) => {
        root.querySelector(sel).addEventListener('click', (e) => {
          const card = e.target.closest('[data-open-case]');
          if (card) this.openCase(card.dataset.openCase);
        });
      });

      // --- Карточка кейса (перерисовывается целиком, поэтому делегирование) ---
      root.querySelector('#feedbackCaseBody').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-case-action]');
        if (btn) runExclusive(btn, () => this.caseAction(btn.dataset.caseAction, btn.dataset));
      });

      root.querySelector('#feedbackTextModalConfirm').addEventListener('click', () => this.resolveTextModal(true));

      // Скриншоты — во встроенном просмотрщике, листаются в пределах своей
      // группы (обращение или лента скриншотов кейса). Ctrl/Cmd/средняя кнопка
      // — как обычная ссылка, в новой вкладке.
      root.addEventListener('click', (e) => {
        const shot = e.target.closest('[data-shot]');
        if (!shot || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const group = shot.closest('.feedback-attachments') || shot.parentElement;
        const urls = Array.from(group.querySelectorAll('[data-shot]')).map((a) => a.dataset.shot);
        this.openLightbox(urls, Math.max(0, urls.indexOf(shot.dataset.shot)));
      });

      // Ссылки на статьи в жалобах — во всех списках и в карточке кейса.
      root.addEventListener('click', (e) => {
        const link = e.target.closest('[data-open-article]');
        if (!link) return;
        e.preventDefault();
        e.stopPropagation();
        window.spaRouter?.openIbripediaArticle(link.dataset.openArticle);
      });
    }

    switchTab(tab) {
      const btn = this.root.querySelector(`[data-feedback-tab="${tab}"]`);
      if (!btn || btn.hidden) tab = 'mine';
      this.currentTab = tab;
      this.root.querySelectorAll('[data-feedback-tab]').forEach((b) => b.classList.toggle('active', b.dataset.feedbackTab === tab));
      this.root.querySelector('#feedbackPanelMine').hidden = tab !== 'mine';
      this.root.querySelector('#feedbackPanelTriage').hidden = tab !== 'triage';
      this.root.querySelector('#feedbackPanelCases').hidden = tab !== 'cases';
      this.root.querySelector('#feedbackPanelDecide').hidden = tab !== 'decide';
      this.refreshCurrentTab();
    }

    async refreshCurrentTab() {
      if (this.currentTab === 'mine') await this.loadMine();
      else if (this.currentTab === 'triage') await this.loadTriage();
      else if (this.currentTab === 'cases') await Promise.all([this.loadQueue(), this.loadCasesList()]);
      else if (this.currentTab === 'decide') await this.loadDecide();
    }

    async refreshBadges() {
      try {
        const summary = await this.api('/api/notifications/summary');
        const set = (key, count) => {
          const badge = this.root.querySelector(`[data-feedback-badge="${key}"]`);
          if (!badge) return;
          badge.hidden = !count;
          badge.textContent = count > 99 ? '99+' : String(count || 0);
        };
        set('triage', summary.feedbackTriage);
        set('cases', summary.feedbackUnassigned);
        set('decide', summary.feedbackEscalated);
      } catch (e) {
        console.error('Error refreshing feedback badges:', e);
      }
      window.refreshNotificationBadges?.();
    }

    // Общий каркас загрузки списка: "Загрузка..." → пусто/список.
    async loadList({ loading, empty, list }, fetcher, render) {
      const loadingEl = this.root.querySelector(loading);
      const emptyEl = this.root.querySelector(empty);
      const listEl = this.root.querySelector(list);
      loadingEl.style.display = 'block';
      emptyEl.hidden = true;
      try {
        const items = await fetcher();
        loadingEl.style.display = 'none';
        emptyEl.hidden = items.length > 0;
        listEl.innerHTML = items.map(render).join('');
        return items;
      } catch (err) {
        loadingEl.style.display = 'none';
        listEl.innerHTML = '';
        showMessage(err.message, 'error');
        return [];
      }
    }

    // ---------- Мои обращения ----------

    async loadMine() {
      await this.loadList(
        { loading: '#feedbackMineLoading', empty: '#feedbackMineEmpty', list: '#feedbackMineList' },
        async () => {
          const list = await this.api('/api/feedback/reports/mine');
          this.myReports = new Map(list.map((r) => [r.id, r]));
          return list;
        },
        (r) => {
          const st = authorStatus(r);
          const resend = r.status === 'rejected' || r.status === 'withdrawn';
          const buttons = [
            r.canEdit ? `<button type="button" class="btn btn-secondary btn-sm" data-edit-report="${r.id}"><i class="fas fa-pen"></i> ${resend ? 'Исправить и отправить заново' : 'Изменить'}</button>` : '',
            r.canWithdraw ? `<button type="button" class="btn btn-secondary btn-sm" data-withdraw-report="${r.id}"><i class="fas fa-rotate-left"></i> Отозвать</button>` : ''
          ].join('');
          const edit = buttons ? `<div class="feedback-card-actions btns-compact">${buttons}</div>` : '';
          let note = '';
          if (r.status === 'rejected' && r.rejectReason) note = `<div class="feedback-note bad">Причина: ${escapeHtml(r.rejectReason)}</div>`;
          else if (r.caseDecisionText && ['accepted', 'resolved', 'archived'].includes(r.caseStatus)) {
            note = `<div class="feedback-note ${r.caseDecision === 'accepted' ? 'ok' : 'bad'}">${escapeHtml(r.caseDecisionText)}</div>`;
            if (r.caseCompletionText) note += `<div class="feedback-note ok">${escapeHtml(r.caseCompletionText)}</div>`;
          }
          return `
            <div class="feedback-card">
              <div class="feedback-card-head"><div class="feedback-card-title">#${r.id} · ${escapeHtml(r.title)}</div></div>
              <div class="feedback-card-meta">${typeChip(r.type)}<span class="feedback-chip ${st.chip}">${escapeHtml(st.text)}</span><span>${formatDate(r.createdAt)}</span></div>
              ${note}
              <details class="feedback-details"><summary>Подробнее</summary>${renderReportFields(r)}</details>
              ${edit}
            </div>`;
        }
      );
    }

    // Отзыв своего обращения — пока по нему нет решения (см.
    // withdrawOwnReport в feedback-store.js). Отозванное остаётся в списке,
    // его можно поправить и отправить заново.
    async withdrawReport(id) {
      const ok = await window.confirmDialog.open({
        title: 'Отозвать обращение',
        message: `Отозвать обращение #${id}? Модераторы перестанут его рассматривать. Позже его можно будет исправить и отправить заново.`,
        confirmLabel: 'Отозвать'
      });
      if (!ok) return;
      try {
        await this.api(`/api/feedback/reports/${id}/withdraw`, 'POST');
        showMessage(`Обращение #${id} отозвано`, 'success');
        await this.loadMine();
        this.refreshBadges();
      } catch (err) {
        showMessage(err.message, 'error');
      }
    }

    // ---------- Новое обращение ----------

    // report — своё обращение для правки; без него — новое.
    openCreateModal(report = null) {
      // Новая форма — новый сеанс: незавершённые загрузки прошлой формы
      // больше не блокируют «Отправить» и не подкидывают сюда свои скриншоты.
      this.formSession++;
      this.uploading = 0;
      this.editingReport = report;
      const isArticle = !!(report && report.type === 'article');
      this.root.querySelector('#feedbackFormTitle').textContent = report ? `Обращение #${report.id}` : 'Новое обращение';
      const submitBtn = this.root.querySelector('#feedbackSubmitBtn');
      submitBtn.textContent = !report ? 'Отправить'
        : ['rejected', 'withdrawn'].includes(report.status) ? 'Отправить заново' : 'Сохранить';
      submitBtn.dataset.label = submitBtn.textContent;
      submitBtn.disabled = false;
      // Тип у отправленного не меняется; у жалобы на статью название
      // собирается само, а доказательства могут быть ссылками — правится
      // только описание.
      this.root.querySelector('#feedbackTypeSwitch').hidden = !!report;
      this.root.querySelector('#feedbackTitleGroup').hidden = isArticle;
      this.root.querySelector('#feedbackScreenshotGroup').hidden = isArticle;
      this.root.querySelector('#feedbackTitle').value = report ? report.title : '';
      this.root.querySelector('#feedbackDescription').value = report ? report.description : '';
      this.attachments = report && !isArticle ? (report.attachments || []).filter((u) => u.startsWith('/uploads/')) : [];
      this.renderFormAttachments();
      this.setReportType(report ? report.type : 'bug');
      this.root.querySelector('#feedbackCreateModal').hidden = false;
      this.root.querySelector(isArticle ? '#feedbackDescription' : '#feedbackTitle').focus();
    }

    setReportType(type) {
      this.reportType = type;
      this.root.querySelectorAll('[data-report-type]').forEach((b) => b.classList.toggle('active', b.dataset.reportType === type));
      const isBug = type === 'bug';
      this.root.querySelector('#feedbackTitleLabel').textContent = isBug ? 'Название проблемы *' : 'Название идеи *';
      this.root.querySelector('#feedbackTitle').placeholder = isBug ? 'Например: не сохраняется черновик статьи' : 'Например: тёмная тема для редактора';
      this.root.querySelector('#feedbackDescriptionLabel').textContent = type === 'article' ? 'Что не так со статьёй *'
        : isBug ? 'Описание проблемы *' : 'Предложение *';
      this.root.querySelector('#feedbackDescription').placeholder = isBug
        ? 'Что пошло не так и как это получилось?'
        : 'Что предлагаете и какую проблему это решит?';
    }

    renderFormAttachments() {
      this.root.querySelector('#feedbackAttachments').innerHTML = renderAttachments(this.attachments, true);
      this.root.querySelector('#feedbackPickFileBtn').disabled = this.attachments.length >= MAX_SCREENSHOTS;
    }

    // Пока скриншот грузится, «Отправить» заблокирована — иначе обращение
    // ушло бы без него. Надпись на кнопке объясняет, почему она неактивна.
    setUploading(delta) {
      this.uploading = Math.max(0, this.uploading + delta);
      const btn = this.root.querySelector('#feedbackSubmitBtn');
      btn.disabled = this.uploading > 0;
      if (!btn.dataset.label) btn.dataset.label = btn.textContent;
      btn.textContent = this.uploading > 0 ? 'Загрузка скриншота…' : btn.dataset.label;
    }

    async uploadFiles(input) {
      const files = Array.from(input.files || []);
      input.value = '';
      if (!files.length) return;
      const session = this.formSession;
      this.setUploading(1);
      try {
        for (const file of files) {
          if (this.attachments.length >= MAX_SCREENSHOTS) {
            showMessage(`Не больше ${MAX_SCREENSHOTS} скриншотов в одном обращении`, 'error');
            break;
          }
          let timer;
          const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve({ success: false, error: 'сервер слишком долго не отвечает' }), UPLOAD_TIMEOUT_MS);
          });
          const result = await Promise.race([window.apiClient.uploadImage(file), timeout]);
          clearTimeout(timer);
          // Форму за это время закрыли/открыли заново — результат не для неё.
          if (session !== this.formSession) return;
          if (result.success && result.data && result.data.url) {
            this.attachments.push(result.data.url);
            this.renderFormAttachments();
          } else {
            showMessage(`Не удалось загрузить ${file.name}: ${result.error || 'ошибка'}`, 'error');
          }
        }
      } finally {
        if (session === this.formSession) this.setUploading(-1);
      }
    }

    async submitReport() {
      if (this.uploading) {
        showMessage('Дождитесь окончания загрузки скриншота', 'warning');
        return;
      }
      const val = (sel) => this.root.querySelector(sel).value;
      const editing = this.editingReport;
      const payload = { title: val('#feedbackTitle'), description: val('#feedbackDescription') };
      if (!editing || editing.type !== 'article') payload.attachments = this.attachments;
      try {
        if (editing) {
          const report = await this.api(`/api/feedback/reports/${editing.id}`, 'PUT', payload);
          showMessage(['rejected', 'withdrawn'].includes(editing.status)
            ? `Обращение #${report.id} исправлено и снова отправлено на проверку`
            : `Обращение #${report.id} сохранено`, 'success');
        } else {
          const report = await this.api('/api/feedback/reports', 'POST', { type: this.reportType, ...payload });
          showMessage(`Обращение #${report.id} отправлено на проверку`, 'success');
        }
        this.editingReport = null;
        this.closeModal('feedbackCreateModal');
        this.switchTab('mine');
        this.refreshBadges();
      } catch (err) {
        showMessage(err.message, 'error');
      }
    }

    // ---------- Первая линия ----------

    async loadTriage() {
      const view = this.triageView;
      this.root.querySelectorAll('[data-triage-view]').forEach((b) => b.classList.toggle('active', b.dataset.triageView === view));
      this.root.querySelector('#feedbackTriageExplain').textContent = view === 'new'
        ? 'Уберите спам, бред и нерелевантное. Всё адекватное — «Принять», дальше им займётся вторая линия.'
        : 'Выборочная проверка первой линии: ошибочно отклонённое обращение можно вернуть в очередь.';
      this.root.querySelector('#feedbackTriageEmpty').textContent = view === 'new' ? 'Очередь пуста.' : 'Отклонённых обращений нет.';

      await this.loadList(
        { loading: '#feedbackTriageLoading', empty: '#feedbackTriageEmpty', list: '#feedbackTriageList' },
        async () => {
          const list = await this.api(`/api/feedback/reports?status=${view}`);
          this.triageReports = new Map(list.map((r) => [r.id, r]));
          return list;
        },
        (r) => {
          let actions = '';
          if (view === 'new') {
            // С правом второй линии — сразу и кейс на третью линию, без
            // захода во вкладку «Кейсы» ради одного обращения.
            actions = `
              <button class="btn btn-success btn-sm" data-report-action="accept" data-id="${r.id}"><i class="fas fa-check"></i> Принять</button>
              ${this.perms.cases ? `<button class="btn btn-primary btn-sm" data-report-action="accept-escalate" data-id="${r.id}"><i class="fas fa-arrow-up"></i> Принять и на третью линию</button>` : ''}
              <button class="btn btn-danger btn-sm" data-report-action="reject" data-id="${r.id}"><i class="fas fa-xmark"></i> Отклонить</button>`;
          } else if (this.perms.cases) {
            actions = `<button class="btn btn-secondary btn-sm" data-report-action="restore" data-id="${r.id}"><i class="fas fa-rotate-left"></i> Вернуть в очередь</button>`;
          }
          const rejected = view === 'rejected'
            ? `<div class="feedback-note bad">${escapeHtml(r.triagedBy || '—')}: ${escapeHtml(r.rejectReason || '')}</div>` : '';
          return `
            <div class="feedback-card">
              <div class="feedback-card-head"><div class="feedback-card-title">#${r.id} · ${escapeHtml(r.title)}</div></div>
              <div class="feedback-card-meta">${typeChip(r.type)}<span>${escapeHtml(r.authorName)}</span><span>${formatDate(r.createdAt)}</span></div>
              ${rejected}
              ${renderReportFields(r)}
              ${renderReportShots(r)}
              <div class="feedback-card-actions btns-compact">${actions}</div>
            </div>`;
        }
      );
    }

    async triageAction(action, id) {
      try {
        if (action === 'accept') {
          await this.api(`/api/feedback/reports/${id}/accept`, 'POST');
        } else if (action === 'accept-escalate') {
          // Принимаем сразу — окно кейса можно и закрыть, тогда обращение
          // просто останется в очереди второй линии.
          await this.api(`/api/feedback/reports/${id}/accept`, 'POST');
          this.openNewCaseModal([Number(id)], this.triageReports);
        } else if (action === 'reject') {
          const reason = await this.askText({ title: `Отклонить обращение #${id}`, label: 'Причина (её увидит автор)', confirm: 'Отклонить' });
          if (reason == null) return;
          await this.api(`/api/feedback/reports/${id}/reject`, 'POST', { reason });
        } else if (action === 'restore') {
          await this.api(`/api/feedback/reports/${id}/restore`, 'POST');
          showMessage(`Обращение #${id} возвращено в очередь первой линии`, 'success');
        }
        await this.loadTriage();
        this.refreshBadges();
      } catch (err) {
        showMessage(err.message, 'error');
      }
    }

    // ---------- Вторая линия ----------

    async loadQueue() {
      await this.loadList(
        { loading: '#feedbackQueueLoading', empty: '#feedbackQueueEmpty', list: '#feedbackQueueList' },
        async () => {
          const list = await this.api('/api/feedback/queue');
          this.queueReports = new Map(list.map((r) => [r.id, r]));
          // Отметки на оставшихся в очереди сохраняем (отправили одно
          // обращение — выбор остальных не сбрасывается); ушедшие — снимаем.
          this.queueSelected.forEach((id) => { if (!this.queueReports.has(id)) this.queueSelected.delete(id); });
          return list;
        },
        (r) => `
          <div class="feedback-card feedback-queue-card" data-queue-card="${r.id}">
            <div class="feedback-card-head">
              <button type="button" class="feedback-select" data-queue-select="${r.id}" title="Выбрать — чтобы собрать несколько одинаковых обращений в один кейс" aria-pressed="false"><i class="fas fa-check"></i></button>
              <div class="feedback-card-title">#${r.id} · ${escapeHtml(r.title)}</div>
              <button type="button" class="btn btn-primary btn-sm feedback-queue-escalate" data-queue-escalate="${r.id}" title="Передать одно это обращение на третью линию"><i class="fas fa-arrow-up"></i> <span>На третью линию</span></button>
            </div>
            <div class="feedback-card-meta">${typeChip(r.type)}<span>${escapeHtml(r.authorName)}</span><span>${formatDate(r.createdAt)}</span></div>
            ${renderReportShots(r)}
            <details class="feedback-details"><summary>Подробнее</summary>${renderReportFields(r)}</details>
          </div>`
      );
      this.syncQueueSelection();
    }

    // Подсветка выбранных карточек + панель действий с выбранными (прилипает
    // к низу экрана — видна, где бы в списке ни была отмеченная карточка).
    syncQueueSelection() {
      this.root.querySelectorAll('[data-queue-card]').forEach((card) => {
        const on = this.queueSelected.has(Number(card.dataset.queueCard));
        card.classList.toggle('is-selected', on);
        card.querySelector('[data-queue-select]')?.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      this.updateQueueActions();
    }

    updateQueueActions() {
      const count = this.queueSelected.size;
      this.root.querySelector('#feedbackQueueActions').hidden = count === 0;
      this.root.querySelector('#feedbackQueueSelected').textContent = `Выбрано: ${count}`;
      this.root.querySelector('#feedbackQueueCreateBtn').innerHTML = count > 1
        ? `<i class="fas fa-layer-group"></i> Собрать кейс из ${count} и на третью линию`
        : '<i class="fas fa-arrow-up"></i> На третью линию';
      const select = this.root.querySelector('#feedbackQueueCaseSelect');
      select.innerHTML = this.openCases.length
        ? this.openCases.map((c) => `<option value="${c.id}">#${c.id} · ${escapeHtml(TYPE_LABELS[c.type])} · ${escapeHtml(c.title)}</option>`).join('')
        : '<option value="">Нет кейсов без решения</option>';
      this.root.querySelector('#feedbackQueueAttachBtn').disabled = !this.openCases.length;
    }

    // ids — обращения будущего кейса (одно — одиночная передача на третью
    // линию, несколько — сборка дублей); reports — откуда взять их тексты.
    openNewCaseModal(ids, reports) {
      if (!ids || !ids.length) return;
      this.newCaseIds = ids.slice();
      const first = reports && reports.get(ids[0]);
      const type = first ? first.type : 'bug';
      const single = ids.length === 1;
      const modal = this.root.querySelector('#feedbackNewCaseModal');
      modal.querySelector('#feedbackNewCaseHeading').textContent = single ? `Обращение #${ids[0]} — на третью линию` : `Кейс из ${ids.length} обращений`;
      modal.querySelector('#feedbackNewCaseInfo').innerHTML = single
        ? (first ? `${typeChip(type)} ${escapeHtml(first.title)}` : '')
        : `Обращения: ${ids.map((id) => '#' + id).join(', ')}`;
      modal.querySelector('#feedbackNewCaseSummaryLabel').textContent = `${SUMMARY_LABELS[type] || SUMMARY_LABELS.bug} *`;
      modal.querySelector('#feedbackNewCaseSummary').value = first ? first.description : '';
      modal.querySelector('#feedbackNewCaseComment').value = '';
      modal.querySelector('#feedbackNewCaseSeverity').innerHTML = severityOptions(type, 2);
      modal.hidden = false;
      modal.querySelector('#feedbackNewCaseSummary').focus();
    }

    async createCaseFromQueue() {
      const modal = this.root.querySelector('#feedbackNewCaseModal');
      try {
        const created = await this.api('/api/feedback/cases', 'POST', {
          reportIds: this.newCaseIds,
          summary: modal.querySelector('#feedbackNewCaseSummary').value,
          comment: modal.querySelector('#feedbackNewCaseComment').value,
          severity: modal.querySelector('#feedbackNewCaseSeverity').value
        });
        modal.hidden = true;
        showMessage(`Кейс #${created.id} передан на третью линию`, 'success');
        await this.refreshCurrentTab();
        this.refreshBadges();
        this.showCase(created);
      } catch (err) {
        showMessage(err.message, 'error');
      }
    }

    async attachQueueToCase() {
      const caseId = this.root.querySelector('#feedbackQueueCaseSelect').value;
      if (!caseId) return;
      try {
        const updated = await this.api(`/api/feedback/cases/${caseId}/reports`, 'POST', { reportIds: Array.from(this.queueSelected) });
        showMessage(`Добавлено в кейс #${updated.id}`, 'success');
        await Promise.all([this.loadQueue(), this.loadCasesList()]);
        this.refreshBadges();
      } catch (err) {
        showMessage(err.message, 'error');
      }
    }

    renderCaseCard(c) {
      const decision = c.decision
        ? `<span class="feedback-chip ${c.decision === 'accepted' ? 'ok' : 'bad'}">${c.decision === 'accepted' ? 'Принят' : 'Отклонён'}</span>` : '';
      return `
        <div class="feedback-card is-clickable" data-open-case="${c.id}">
          <div class="feedback-card-head"><div class="feedback-card-title">Кейс #${c.id} · ${escapeHtml(c.title)}</div></div>
          <div class="feedback-card-meta">
            ${typeChip(c.type)}
            <span class="feedback-chip sev-${c.severity}" title="${escapeHtml(severityInfo(c.type, c.severity).full)}">${c.severity} · ${escapeHtml(severityInfo(c.type, c.severity).short)}</span>
            <span class="feedback-chip">приоритет ${c.priority}</span>
            <span>${c.usersCount} польз. · ${c.reportsCount} обращ.</span>
            ${decision}
          </div>
        </div>`;
    }

    async loadCasesList() {
      const status = this.root.querySelector('#feedbackCasesFilter').value;
      // Для "Добавить в кейс" в очереди — все кейсы без решения (и на
      // третьей линии, и на доработке).
      await Promise.all([
        this.loadList(
          { loading: '#feedbackCasesLoading', empty: '#feedbackCasesEmpty', list: '#feedbackCasesList' },
          () => this.api(`/api/feedback/cases?status=${status}`),
          (c) => this.renderCaseCard(c)
        ),
        this.api('/api/feedback/cases?status=open,escalated').then((list) => { this.openCases = list; }).catch(() => {})
      ]);
      this.updateQueueActions();
    }

    // ---------- Третья линия ----------

    async loadDecide() {
      await Promise.all([
        this.loadList(
          { loading: '#feedbackDecideLoading', empty: '#feedbackDecideEmpty', list: '#feedbackDecideList' },
          () => this.api('/api/feedback/cases?status=escalated'),
          (c) => this.renderCaseCard(c)
        ),
        this.loadList(
          { loading: '#feedbackWorkLoading', empty: '#feedbackWorkEmpty', list: '#feedbackWorkList' },
          () => this.api('/api/feedback/cases?status=accepted'),
          (c) => this.renderCaseCard(c)
        )
      ]);
    }

    // ---------- Карточка кейса ----------

    async openCase(caseId) {
      try {
        this.showCase(await this.api(`/api/feedback/cases/${caseId}`));
      } catch (err) {
        showMessage(err.message, 'error');
      }
    }

    showCase(data) {
      this.currentCase = data;
      this.renderCase();
      this.root.querySelector('#feedbackCaseModal').hidden = false;
    }

    renderCase() {
      const c = this.currentCase;
      // Вторая линия дополняет кейс, пока по нему нет решения.
      const editable = this.perms.cases && (c.status === 'open' || c.status === 'escalated');
      this.root.querySelector('#feedbackCaseModalTitle').textContent = `Кейс #${c.id}`;

      let decisionBlock = '';
      if (c.decision) {
        const verdict = c.decision === 'declined' ? 'Отклонено' : c.status === 'accepted' ? 'Принято — в работе' : 'Принято';
        const completion = c.completedAt
          ? `<div class="feedback-note ok"><b>Завершено</b> · ${escapeHtml(c.completedBy || '')} · ${formatDate(c.completedAt)}${c.completionText ? '\n' + escapeHtml(c.completionText) : ''}</div>` : '';
        decisionBlock = `
          <div class="feedback-case-section">
            <h4>Решение третьей линии</h4>
            <div class="feedback-note ${c.decision === 'accepted' ? 'ok' : 'bad'}"><b>${verdict}</b> · ${escapeHtml(c.decidedBy || '')} · ${formatDate(c.decidedAt)}\n${escapeHtml(c.decisionText || '')}</div>
            ${completion}
          </div>`;
      }

      const actions = [];
      if (this.perms.cases && c.status === 'open') actions.push('<button class="btn btn-primary btn-sm" data-case-action="escalate"><i class="fas fa-arrow-up"></i> Передать на третью линию</button>');
      if (this.perms.decide && c.status === 'escalated') {
        actions.push('<button class="btn btn-success btn-sm" data-case-action="decide" data-decision="accepted"><i class="fas fa-check"></i> Принять</button>');
        actions.push('<button class="btn btn-danger btn-sm" data-case-action="decide" data-decision="declined"><i class="fas fa-xmark"></i> Отклонить</button>');
        actions.push('<button class="btn btn-secondary btn-sm" data-case-action="return"><i class="fas fa-rotate-left"></i> Вернуть на доработку</button>');
      }
      if (this.perms.decide && c.status === 'accepted') actions.push('<button class="btn btn-success btn-sm" data-case-action="complete"><i class="fas fa-flag-checkered"></i> Завершить</button>');
      if (this.perms.cases && c.status === 'resolved') actions.push('<button class="btn btn-secondary btn-sm" data-case-action="archive"><i class="fas fa-box-archive"></i> В архив</button>');

      const header = editable
        ? `
          <div class="feedback-card-title">${escapeHtml(c.title)}</div>
          <div class="form-group"><label class="form-label">${SUMMARY_LABELS[c.type] || SUMMARY_LABELS.bug} *</label><textarea class="form-textarea" id="feedbackCaseSummary" maxlength="5000">${escapeHtml(c.summary || '')}</textarea></div>
          <div class="form-group"><label class="form-label">Комментарий (по желанию)</label><textarea class="form-textarea" id="feedbackCaseComment" maxlength="2000">${escapeHtml(c.comment || '')}</textarea></div>
          <div class="form-group"><label class="form-label">Критичность</label>
            <select class="form-select" id="feedbackCaseSeverity">${severityOptions(c.type, c.severity)}</select>
          </div>
          ${c.status === 'open' ? '<p class="modal-hint"><i class="fas fa-circle-info"></i> Кейс возвращён на доработку. Критичность 4 сразу передаёт его обратно на третью линию.</p>' : ''}
          <div class="btns-compact"><button class="btn btn-secondary btn-sm" data-case-action="save-case">Сохранить</button></div>`
        : `
          <div class="feedback-card-title">${escapeHtml(c.title)}</div>
          ${field(SUMMARY_LABELS[c.type] || SUMMARY_LABELS.bug, c.summary)}
          ${field('Комментарий', c.comment)}
          <div class="feedback-card-meta"><span>Критичность: ${escapeHtml(severityInfo(c.type, c.severity).full)}</span></div>`;

      this.root.querySelector('#feedbackCaseBody').innerHTML = `
        <div class="feedback-card-meta">${typeChip(c.type)}<span class="feedback-chip">${CASE_STATUS_LABELS[c.status] || c.status}</span><span>создан ${formatDate(c.createdAt)}${c.createdBy ? ' · ' + escapeHtml(c.createdBy) : ''}</span></div>
        <div class="feedback-case-stats">
          <div class="feedback-stat"><div class="feedback-stat-value">${c.priority}</div><div class="feedback-stat-label">приоритет</div></div>
          <div class="feedback-stat"><div class="feedback-stat-value">${c.usersCount}</div><div class="feedback-stat-label">пользователей</div></div>
          <div class="feedback-stat"><div class="feedback-stat-value">${c.reportsCount}</div><div class="feedback-stat-label">обращений</div></div>
          <div class="feedback-stat"><div class="feedback-stat-value">${c.duplicatesCount}</div><div class="feedback-stat-label">дублей</div></div>
        </div>
        ${c.type === 'article' && c.reports.length ? `<div><div class="feedback-field-label">Статья</div>${articleLink(c.reports[0])}</div>` : ''}
        ${header}
        ${this.renderCaseShots(c)}
        ${decisionBlock}
        ${actions.length ? `<div class="feedback-card-actions btns-compact">${actions.join('')}</div>` : ''}
        <div class="feedback-case-section">
          <h4>Обращения (${c.reports.length})</h4>
          ${c.reports.map((r) => `
            <div class="feedback-card">
              <div class="feedback-card-head"><div class="feedback-card-title">#${r.id} · ${escapeHtml(r.title)}</div></div>
              <div class="feedback-card-meta"><span>${escapeHtml(r.authorName)}</span><span>${formatDate(r.createdAt)}</span>
                ${editable && c.reports.length > 1 ? `<button class="btn btn-secondary btn-sm" data-case-action="detach" data-report-id="${r.id}">Отвязать</button>` : ''}</div>
              ${renderReportShots(r)}
              <details class="feedback-details"><summary>Подробнее</summary>${renderReportFields(r)}</details>
            </div>`).join('')}
        </div>
        <div class="feedback-case-section">
          <details class="feedback-details"><summary>Журнал (${c.events.length})</summary>
            <div class="feedback-events" style="margin-top:8px">
              ${c.events.map((e) => `<div>${formatDate(e.createdAt)} · <b>${escapeHtml(e.actorName || '—')}</b>: ${escapeHtml(EVENT_LABELS[e.action] || e.action)}${e.reportId ? ` #${e.reportId}` : ''}${e.details ? ` — ${escapeHtml(e.details)}` : ''}</div>`).join('')}
            </div>
          </details>
        </div>`;
    }

    // Все скриншоты всех обращений кейса — одной лентой, листаются подряд.
    renderCaseShots(c) {
      const shots = [];
      c.reports.forEach((r) => (r.attachments || []).forEach((url) => {
        if (url.startsWith('/uploads/') && !shots.some((s) => s.url === url)) shots.push({ url, reportId: r.id });
      }));
      if (!shots.length) return '';
      return `
        <div class="feedback-case-section">
          <h4>Скриншоты (${shots.length})</h4>
          <div class="feedback-attachments feedback-case-shots">
            ${shots.map((s) => `<span class="feedback-attachment"><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" data-shot="${escapeHtml(s.url)}" title="Из обращения #${s.reportId}"><img src="${escapeHtml(s.url)}" alt="" loading="lazy"><span class="feedback-shot-label">#${s.reportId}</span></a></span>`).join('')}
          </div>
        </div>`;
    }

    // ---------- Просмотр скриншотов ----------

    ensureLightbox() {
      if (this._lightbox) return this._lightbox;
      const el = document.createElement('div');
      el.className = 'feedback-lightbox';
      el.hidden = true;
      el.innerHTML = `
        <div class="feedback-lightbox-top">
          <span class="feedback-lightbox-counter"></span>
          <a class="feedback-lightbox-btn" data-lb="original" target="_blank" rel="noopener" title="Открыть оригинал в новой вкладке"><i class="fas fa-up-right-from-square"></i></a>
          <button type="button" class="feedback-lightbox-btn" data-lb="close" title="Закрыть (Esc)"><i class="fas fa-xmark"></i></button>
        </div>
        <button type="button" class="feedback-lightbox-nav prev" data-lb="prev" title="Назад (←)"><i class="fas fa-chevron-left"></i></button>
        <img class="feedback-lightbox-img" alt="">
        <button type="button" class="feedback-lightbox-nav next" data-lb="next" title="Вперёд (→)"><i class="fas fa-chevron-right"></i></button>`;
      document.body.appendChild(el);
      const lb = { el, img: el.querySelector('img'), urls: [], index: 0, hist: null };
      this._lightbox = lb;

      el.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-lb]');
        if (btn && btn.dataset.lb === 'prev') this.lightboxStep(-1);
        else if (btn && btn.dataset.lb === 'next') this.lightboxStep(1);
        else if (btn && btn.dataset.lb === 'close') this.closeLightbox();
        else if (e.target === el) this.closeLightbox(); // клик мимо картинки
      });
      document.addEventListener('keydown', (e) => {
        if (el.hidden) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeLightbox(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); this.lightboxStep(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); this.lightboxStep(1); }
      }, true);
      // Свайп на телефоне: справа налево — следующий скриншот.
      let x0 = null;
      el.addEventListener('touchstart', (e) => { x0 = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
      el.addEventListener('touchend', (e) => {
        if (x0 === null) return;
        const dx = e.changedTouches[0].clientX - x0;
        x0 = null;
        if (Math.abs(dx) > 50) this.lightboxStep(dx < 0 ? 1 : -1);
      });
      return lb;
    }

    openLightbox(urls, index) {
      if (!urls.length) return;
      const lb = this.ensureLightbox();
      lb.urls = urls;
      const wasHidden = lb.el.hidden;
      lb.el.hidden = false;
      this.showLightboxImage(index);
      if (wasHidden && window.modalHistory) lb.hist = window.modalHistory.open(() => this.closeLightbox({ fromHistory: true }));
    }

    showLightboxImage(index) {
      const lb = this._lightbox;
      lb.index = (index + lb.urls.length) % lb.urls.length;
      const url = lb.urls[lb.index];
      lb.img.src = url;
      lb.el.querySelector('[data-lb="original"]').href = url;
      const many = lb.urls.length > 1;
      lb.el.querySelector('.feedback-lightbox-counter').textContent = many ? `${lb.index + 1} / ${lb.urls.length}` : '';
      lb.el.querySelectorAll('.feedback-lightbox-nav').forEach((b) => { b.hidden = !many; });
    }

    lightboxStep(delta) {
      const lb = this._lightbox;
      if (lb && lb.urls.length > 1) this.showLightboxImage(lb.index + delta);
    }

    closeLightbox({ fromHistory = false } = {}) {
      const lb = this._lightbox;
      if (!lb || lb.el.hidden) return;
      lb.el.hidden = true;
      lb.img.removeAttribute('src');
      const hist = lb.hist;
      lb.hist = null;
      if (hist && !fromHistory && window.modalHistory) window.modalHistory.close(hist);
    }

    async caseAction(action, dataset) {
      const c = this.currentCase;
      const body = this.root.querySelector('#feedbackCaseBody');
      const base = `/api/feedback/cases/${c.id}`;
      let updated = null;
      try {
        if (action === 'save-case') {
          updated = await this.api(base, 'PUT', {
            summary: body.querySelector('#feedbackCaseSummary').value,
            comment: body.querySelector('#feedbackCaseComment').value,
            severity: body.querySelector('#feedbackCaseSeverity').value
          });
          showMessage(updated.status === 'escalated' ? 'Сохранено — критичный кейс передан на третью линию' : 'Сохранено', 'success');
        } else if (action === 'detach') {
          const ok = await window.confirmDialog.open({ message: `Отвязать обращение #${dataset.reportId}? Оно вернётся в очередь второй линии.`, confirmLabel: 'Отвязать' });
          if (!ok) return;
          updated = await this.api(`${base}/reports/${dataset.reportId}`, 'DELETE');
        } else if (action === 'escalate') {
          updated = await this.api(`${base}/escalate`, 'POST');
          showMessage('Кейс передан на третью линию', 'success');
        } else if (action === 'decide') {
          const accepted = dataset.decision === 'accepted';
          const text = await this.askText({
            title: accepted ? `Принять кейс #${c.id} в работу` : `Отклонить кейс #${c.id}`,
            label: accepted
              ? 'Что будет сделано (увидят авторы обращений). Когда всё будет готово — завершите кейс.'
              : 'Почему отклонено (увидят авторы обращений)',
            confirm: accepted ? 'Принять' : 'Отклонить'
          });
          if (text == null) return;
          updated = await this.api(`${base}/decide`, 'POST', { decision: dataset.decision, text });
          if (accepted) showMessage(`Кейс #${c.id} принят и ждёт завершения во вкладке «Решение»`, 'success');
        } else if (action === 'complete') {
          const comment = await this.askText({
            title: `Завершить кейс #${c.id}`,
            label: 'Что сделано (по желанию, увидят авторы обращений)',
            confirm: 'Завершить',
            optional: true
          });
          if (comment == null) return;
          updated = await this.api(`${base}/complete`, 'POST', { comment });
          showMessage(`Кейс #${c.id} завершён`, 'success');
        } else if (action === 'return') {
          const comment = await this.askText({ title: `Вернуть кейс #${c.id}`, label: 'Что нужно доработать', confirm: 'Вернуть' });
          if (comment == null) return;
          updated = await this.api(`${base}/return`, 'POST', { comment });
        } else if (action === 'archive') {
          updated = await this.api(`${base}/archive`, 'POST');
        }
      } catch (err) {
        showMessage(err.message, 'error');
        return;
      }
      if (updated) {
        this.showCase(updated);
        this.refreshCurrentTab();
        this.refreshBadges();
      }
    }

    // ---------- Модалки ----------

    closeModal(id) {
      const modal = this.root.querySelector(`#${id}`);
      if (modal) modal.hidden = true;
      if (id === 'feedbackTextModal') this.resolveTextModal(false);
    }

    // Модалка с одним текстовым полем (причина отклонения, решение,
    // комментарий к возврату). Возвращает текст или null при отмене.
    askText({ title, label, confirm, optional = false }) {
      this._textModalOptional = optional;
      this.resolveTextModal(false);
      const modal = this.root.querySelector('#feedbackTextModal');
      modal.querySelector('#feedbackTextModalTitle').textContent = title;
      modal.querySelector('#feedbackTextModalLabel').textContent = label;
      modal.querySelector('#feedbackTextModalConfirm').textContent = confirm;
      const input = modal.querySelector('#feedbackTextModalInput');
      input.value = '';
      modal.hidden = false;
      input.focus();
      return new Promise((resolve) => { this._textModalResolve = resolve; });
    }

    resolveTextModal(confirmed) {
      const resolve = this._textModalResolve;
      if (!resolve) return;
      const input = this.root.querySelector('#feedbackTextModalInput');
      const text = input ? input.value.trim() : '';
      if (confirmed && !text && !this._textModalOptional) {
        showMessage('Заполните поле', 'error');
        return;
      }
      this._textModalResolve = null;
      this.root.querySelector('#feedbackTextModal').hidden = true;
      resolve(confirmed ? text : null);
    }
  }

  window.feedbackManager = new FeedbackManager();
})();
