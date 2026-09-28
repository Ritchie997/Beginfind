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

  const TYPE_LABELS = { bug: 'Баг', idea: 'Предложение', article: 'Статья' };
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
  const SEVERITY_LABELS = { 1: '1 — косметика', 2: '2 — мешает', 3: '3 — ломает функцию', 4: '4 — потеря данных / безопасность' };
  const CASE_STATUS_LABELS = { open: 'В обработке', escalated: 'На решении', resolved: 'Решён', archived: 'Архив' };
  const EVENT_LABELS = {
    report_created: 'обращение создано',
    report_accepted: 'обращение принято',
    report_rejected: 'обращение отклонено',
    report_restored: 'обращение возвращено в очередь',
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
    if (!report.caseId) return { chip: 'pending', text: 'Принято, ждёт разбора' };
    if (report.caseStatus === 'open') return { chip: 'pending', text: 'В работе' };
    if (report.caseStatus === 'escalated') return { chip: 'pending', text: 'Передано на решение' };
    if (report.caseDecision === 'accepted') {
      const text = { bug: 'Подтверждено — будет исправлено', article: 'Жалоба подтверждена' }[report.type] || 'Принято';
      return { chip: 'ok', text };
    }
    if (report.caseDecision === 'declined') return { chip: 'bad', text: 'Отклонено' };
    return { chip: '', text: CASE_STATUS_LABELS[report.caseStatus] || '—' };
  }

  function renderAttachments(urls, removable) {
    return (urls || []).map((url, index) => {
      const remove = removable ? `<button type="button" class="feedback-attachment-remove" data-remove-attachment="${index}" title="Убрать">&times;</button>` : '';
      if (url.startsWith('/uploads/')) {
        return `<span class="feedback-attachment"><a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img src="${escapeHtml(url)}" alt=""></a>${remove}</span>`;
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
    const descriptionLabel = { bug: 'Описание проблемы', article: 'Что не так со статьёй' }[report.type] || 'Описание идеи';
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
        ${report.attachments && report.attachments.length ? `<div><div class="feedback-field-label">Доказательства</div><div class="feedback-attachments">${renderAttachments(report.attachments, false)}</div></div>` : ''}
        ${field('Комментарий', report.comment)}
      </div>`;
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
      this.editingFactId = null;
      this._textModalResolve = null;
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
      root.querySelectorAll('.modal-overlay').forEach((overlay) => {
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
      root.querySelector('#feedbackAddLinkBtn').addEventListener('click', () => this.addLink());
      root.querySelector('#feedbackLinkInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.addLink(); });
      root.querySelector('#feedbackAttachments').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-remove-attachment]');
        if (!btn) return;
        this.attachments.splice(Number(btn.dataset.removeAttachment), 1);
        this.renderFormAttachments();
      });
      root.querySelector('#feedbackSubmitBtn').addEventListener('click', (e) => runExclusive(e.currentTarget, () => this.submitReport()));

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
      root.querySelector('#feedbackQueueList').addEventListener('change', (e) => {
        const box = e.target.closest('[data-queue-select]');
        if (!box) return;
        if (box.checked) this.queueSelected.add(Number(box.dataset.queueSelect));
        else this.queueSelected.delete(Number(box.dataset.queueSelect));
        this.updateQueueActions();
      });
      root.querySelector('#feedbackQueueCreateBtn').addEventListener('click', (e) => runExclusive(e.currentTarget, () => this.createCaseFromQueue()));
      root.querySelector('#feedbackQueueAttachBtn').addEventListener('click', (e) => runExclusive(e.currentTarget, () => this.attachQueueToCase()));
      root.querySelector('#feedbackCasesFilter').addEventListener('change', () => this.loadCasesList());

      ['#feedbackCasesList', '#feedbackDecideList'].forEach((sel) => {
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
        () => this.api('/api/feedback/reports/mine'),
        (r) => {
          const st = authorStatus(r);
          let note = '';
          if (r.status === 'rejected' && r.rejectReason) note = `<div class="feedback-note bad">Причина: ${escapeHtml(r.rejectReason)}</div>`;
          else if (r.caseDecisionText && (r.caseStatus === 'resolved' || r.caseStatus === 'archived')) {
            note = `<div class="feedback-note ${r.caseDecision === 'accepted' ? 'ok' : 'bad'}">${escapeHtml(r.caseDecisionText)}</div>`;
          }
          return `
            <div class="feedback-card">
              <div class="feedback-card-head"><div class="feedback-card-title">#${r.id} · ${escapeHtml(r.title)}</div></div>
              <div class="feedback-card-meta">${typeChip(r.type)}<span class="feedback-chip ${st.chip}">${escapeHtml(st.text)}</span><span>${formatDate(r.createdAt)}</span></div>
              ${note}
              <details class="feedback-details"><summary>Подробнее</summary>${renderReportFields(r)}</details>
            </div>`;
        }
      );
    }

    // ---------- Новое обращение ----------

    openCreateModal() {
      ['#feedbackTitle', '#feedbackDescription', '#feedbackSteps', '#feedbackExpected', '#feedbackActual',
        '#feedbackVersion', '#feedbackPlatform', '#feedbackComment', '#feedbackLinkInput'].forEach((sel) => {
        this.root.querySelector(sel).value = '';
      });
      this.root.querySelector('#feedbackFrequency').value = '';
      this.attachments = [];
      this.renderFormAttachments();
      this.setReportType('bug');
      this.root.querySelector('#feedbackCreateModal').hidden = false;
      this.root.querySelector('#feedbackTitle').focus();
    }

    setReportType(type) {
      this.reportType = type;
      this.root.querySelectorAll('[data-report-type]').forEach((b) => b.classList.toggle('active', b.dataset.reportType === type));
      this.root.querySelectorAll('#feedbackCreateModal [data-bug-only]').forEach((el) => { el.hidden = type !== 'bug'; });
      const isBug = type === 'bug';
      this.root.querySelector('#feedbackDescriptionLabel').textContent = isBug ? 'Описание проблемы *' : 'Описание идеи *';
      this.root.querySelector('#feedbackDescription').placeholder = isBug
        ? 'Что пошло не так?'
        : 'Что предлагаете и какую проблему это решит?';
    }

    renderFormAttachments() {
      this.root.querySelector('#feedbackAttachments').innerHTML = renderAttachments(this.attachments, true);
    }

    async uploadFiles(input) {
      const files = Array.from(input.files || []);
      input.value = '';
      for (const file of files) {
        if (this.attachments.length >= 10) {
          showMessage('Не больше 10 доказательств в одном обращении', 'error');
          break;
        }
        const result = await window.apiClient.uploadImage(file);
        if (result.success && result.data && result.data.url) {
          this.attachments.push(result.data.url);
          this.renderFormAttachments();
        } else {
          showMessage(`Не удалось загрузить ${file.name}: ${result.error || 'ошибка'}`, 'error');
        }
      }
    }

    addLink() {
      const input = this.root.querySelector('#feedbackLinkInput');
      const url = input.value.trim();
      if (!url) return;
      if (!/^https?:\/\/\S+$/i.test(url)) {
        showMessage('Ссылка должна начинаться с http:// или https://', 'error');
        return;
      }
      if (this.attachments.length >= 10) {
        showMessage('Не больше 10 доказательств в одном обращении', 'error');
        return;
      }
      if (!this.attachments.includes(url)) this.attachments.push(url);
      input.value = '';
      this.renderFormAttachments();
    }

    async submitReport() {
      const val = (sel) => this.root.querySelector(sel).value;
      try {
        const report = await this.api('/api/feedback/reports', 'POST', {
          type: this.reportType,
          title: val('#feedbackTitle'),
          description: val('#feedbackDescription'),
          steps: val('#feedbackSteps'),
          expected: val('#feedbackExpected'),
          actual: val('#feedbackActual'),
          version: val('#feedbackVersion'),
          platform: val('#feedbackPlatform'),
          frequency: val('#feedbackFrequency'),
          comment: val('#feedbackComment'),
          attachments: this.attachments
        });
        this.closeModal('feedbackCreateModal');
        showMessage(`Обращение #${report.id} отправлено на проверку`, 'success');
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
        () => this.api(`/api/feedback/reports?status=${view}`),
        (r) => {
          let actions = '';
          if (view === 'new') {
            actions = `
              <button class="btn btn-success btn-sm" data-report-action="accept" data-id="${r.id}"><i class="fas fa-check"></i> Принять</button>
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
              <div class="feedback-card-actions btns-compact">${actions}</div>
            </div>`;
        }
      );
    }

    async triageAction(action, id) {
      try {
        if (action === 'accept') {
          await this.api(`/api/feedback/reports/${id}/accept`, 'POST');
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
      this.queueSelected.clear();
      await this.loadList(
        { loading: '#feedbackQueueLoading', empty: '#feedbackQueueEmpty', list: '#feedbackQueueList' },
        () => this.api('/api/feedback/queue'),
        (r) => `
          <div class="feedback-card">
            <label class="feedback-card-head">
              <input type="checkbox" data-queue-select="${r.id}">
              <span class="feedback-card-title">#${r.id} · ${escapeHtml(r.title)}</span>
            </label>
            <div class="feedback-card-meta">${typeChip(r.type)}<span>${escapeHtml(r.authorName)}</span><span>${formatDate(r.createdAt)}</span></div>
            <details class="feedback-details"><summary>Подробнее</summary>${renderReportFields(r)}</details>
          </div>`
      );
      this.updateQueueActions();
    }

    updateQueueActions() {
      const count = this.queueSelected.size;
      this.root.querySelector('#feedbackQueueActions').hidden = count === 0;
      this.root.querySelector('#feedbackQueueSelected').textContent = `Выбрано: ${count}`;
      const select = this.root.querySelector('#feedbackQueueCaseSelect');
      select.innerHTML = this.openCases.length
        ? this.openCases.map((c) => `<option value="${c.id}">#${c.id} · ${escapeHtml(TYPE_LABELS[c.type])} · ${escapeHtml(c.title)}</option>`).join('')
        : '<option value="">Нет открытых кейсов</option>';
      this.root.querySelector('#feedbackQueueAttachBtn').disabled = !this.openCases.length;
    }

    async createCaseFromQueue() {
      try {
        const created = await this.api('/api/feedback/cases', 'POST', { reportIds: Array.from(this.queueSelected) });
        showMessage(`Кейс #${created.id} создан`, 'success');
        await Promise.all([this.loadQueue(), this.loadCasesList()]);
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
            <span class="feedback-chip sev-${c.severity}">критичность ${c.severity}</span>
            <span class="feedback-chip">приоритет ${c.priority}</span>
            <span>${c.usersCount} польз. · ${c.reportsCount} обращ.</span>
            ${decision}
          </div>
        </div>`;
    }

    async loadCasesList() {
      const status = this.root.querySelector('#feedbackCasesFilter').value;
      // Список открытых кейсов нужен ещё и для "Добавить в кейс" в очереди.
      const [items] = await Promise.all([
        this.loadList(
          { loading: '#feedbackCasesLoading', empty: '#feedbackCasesEmpty', list: '#feedbackCasesList' },
          () => this.api(`/api/feedback/cases?status=${status}`),
          (c) => this.renderCaseCard(c)
        ),
        status === 'open' ? null : this.api('/api/feedback/cases?status=open').then((list) => { this.openCases = list; }).catch(() => {})
      ]);
      if (status === 'open') this.openCases = items;
      this.updateQueueActions();
    }

    // ---------- Третья линия ----------

    async loadDecide() {
      await this.loadList(
        { loading: '#feedbackDecideLoading', empty: '#feedbackDecideEmpty', list: '#feedbackDecideList' },
        () => this.api('/api/feedback/cases?status=escalated'),
        (c) => this.renderCaseCard(c)
      );
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
      this.editingFactId = null;
      this.renderCase();
      this.root.querySelector('#feedbackCaseModal').hidden = false;
    }

    renderFact(fact, c, editable) {
      const total = c.reports.length;
      const sources = fact.sourceReportIds.map((id) => `#${id}`).join(', ') || 'нет источников';
      const actions = editable
        ? `<button class="btn btn-secondary btn-sm" data-case-action="edit-fact" data-fact-id="${fact.id}">Изменить</button>
           <button class="btn btn-danger btn-sm" data-case-action="delete-fact" data-fact-id="${fact.id}">Удалить</button>` : '';
      return `
        <div class="feedback-fact">
          <div class="feedback-fact-text">${escapeHtml(fact.text)}</div>
          <div class="feedback-fact-meta"><span>${fact.sourceReportIds.length}/${total} · ${escapeHtml(sources)}</span>${actions}</div>
        </div>`;
    }

    renderFactForm(c) {
      const fact = this.editingFactId ? c.facts.find((f) => f.id === this.editingFactId) : null;
      const sources = new Set(fact ? fact.sourceReportIds : []);
      return `
        <div class="feedback-fact-form">
          <div class="feedback-form-row">
            <select class="form-select" id="feedbackFactKind">
              <option value="info" ${!fact || fact.kind === 'info' ? 'selected' : ''}>Сведения о проблеме</option>
              <option value="contradiction" ${fact && fact.kind === 'contradiction' ? 'selected' : ''}>Противоречие / уточнение</option>
            </select>
          </div>
          <textarea class="form-textarea" id="feedbackFactText" maxlength="2000" placeholder="Один факт — одна мысль. Например: «воспроизводится только в Firefox»">${escapeHtml(fact ? fact.text : '')}</textarea>
          <div class="feedback-field-label">Из каких обращений взят факт</div>
          <div class="feedback-source-list">
            ${c.reports.map((r) => `<label><input type="checkbox" data-fact-source="${r.id}" ${sources.has(r.id) ? 'checked' : ''}> #${r.id} ${escapeHtml(r.authorName)}</label>`).join('')}
          </div>
          <div class="feedback-card-actions btns-compact">
            <button class="btn btn-primary btn-sm" data-case-action="save-fact">${fact ? 'Сохранить факт' : 'Добавить факт'}</button>
            ${fact ? '<button class="btn btn-secondary btn-sm" data-case-action="cancel-fact">Отмена</button>' : ''}
          </div>
        </div>`;
    }

    renderCase() {
      const c = this.currentCase;
      const editable = this.perms.cases && c.status === 'open';
      const majorityPct = Math.round(c.majorityShare * 100);
      this.root.querySelector('#feedbackCaseModalTitle').textContent = `Кейс #${c.id}`;

      const majority = c.facts.filter((f) => f.group === 'majority');
      const some = c.facts.filter((f) => f.group === 'some');
      const contradictions = c.facts.filter((f) => f.kind === 'contradiction');
      const factsBlock = (title, list, hint) => `
        <div class="feedback-case-section">
          <h4>${title}</h4>
          ${hint ? `<p class="feedback-explain" style="margin:0">${hint}</p>` : ''}
          ${list.length ? list.map((f) => this.renderFact(f, c, editable)).join('') : '<div class="feedback-empty" style="padding:0">—</div>'}
        </div>`;

      let decisionBlock = '';
      if (c.decision) {
        decisionBlock = `
          <div class="feedback-case-section">
            <h4>Решение третьей линии</h4>
            <div class="feedback-note ${c.decision === 'accepted' ? 'ok' : 'bad'}"><b>${c.decision === 'accepted' ? 'Принято' : 'Отклонено'}</b> · ${escapeHtml(c.decidedBy || '')} · ${formatDate(c.decidedAt)}\n${escapeHtml(c.decisionText || '')}</div>
          </div>`;
      }

      const actions = [];
      if (editable) actions.push('<button class="btn btn-primary btn-sm" data-case-action="escalate"><i class="fas fa-arrow-up"></i> Передать на третью линию</button>');
      if (this.perms.decide && c.status === 'escalated') {
        actions.push('<button class="btn btn-success btn-sm" data-case-action="decide" data-decision="accepted"><i class="fas fa-check"></i> Принять</button>');
        actions.push('<button class="btn btn-danger btn-sm" data-case-action="decide" data-decision="declined"><i class="fas fa-xmark"></i> Отклонить</button>');
        actions.push('<button class="btn btn-secondary btn-sm" data-case-action="return"><i class="fas fa-rotate-left"></i> Вернуть на доработку</button>');
      }
      if (this.perms.cases && c.status === 'resolved') actions.push('<button class="btn btn-secondary btn-sm" data-case-action="archive"><i class="fas fa-box-archive"></i> В архив</button>');

      const header = editable
        ? `
          <div class="form-group"><label class="form-label">Название кейса</label><input type="text" class="form-input" id="feedbackCaseTitle" maxlength="150" value="${escapeHtml(c.title)}"></div>
          <div class="form-group"><label class="form-label">Суть проблемы</label><textarea class="form-textarea" id="feedbackCaseSummary" maxlength="5000">${escapeHtml(c.summary || '')}</textarea></div>
          <div class="form-group"><label class="form-label">Критичность</label>
            <select class="form-select" id="feedbackCaseSeverity">${[1, 2, 3, 4].map((s) => `<option value="${s}" ${s === c.severity ? 'selected' : ''}>${SEVERITY_LABELS[s]}</option>`).join('')}</select>
          </div>
          <p class="modal-hint"><i class="fas fa-circle-info"></i> Критичность 4 сразу передаёт кейс на третью линию.</p>
          <div class="btns-compact"><button class="btn btn-secondary btn-sm" data-case-action="save-case">Сохранить</button></div>`
        : `
          <div class="feedback-card-title">${escapeHtml(c.title)}</div>
          ${field('Суть проблемы', c.summary)}
          <div class="feedback-card-meta"><span>Критичность: ${escapeHtml(SEVERITY_LABELS[c.severity] || c.severity)}</span></div>`;

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
        ${decisionBlock}
        ${actions.length ? `<div class="feedback-card-actions btns-compact">${actions.join('')}</div>` : ''}
        ${factsBlock('Информация от большинства', majority, `Факты, которые подтверждают не меньше ${majorityPct}% обращений кейса.`)}
        ${factsBlock('Дополнительно от некоторых', some, '')}
        ${factsBlock('Противоречия и уточнения', contradictions, '')}
        ${editable ? `<div class="feedback-case-section"><h4>${this.editingFactId ? 'Изменить факт' : 'Новый факт'}</h4>${this.renderFactForm(c)}</div>` : ''}
        <div class="feedback-case-section">
          <h4>Обращения (${c.reports.length})</h4>
          ${c.reports.map((r) => `
            <div class="feedback-card">
              <div class="feedback-card-head"><div class="feedback-card-title">#${r.id} · ${escapeHtml(r.title)}</div></div>
              <div class="feedback-card-meta"><span>${escapeHtml(r.authorName)}</span><span>${formatDate(r.createdAt)}</span>
                ${editable && c.reports.length > 1 ? `<button class="btn btn-secondary btn-sm" data-case-action="detach" data-report-id="${r.id}">Отвязать</button>` : ''}</div>
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

    async caseAction(action, dataset) {
      const c = this.currentCase;
      const body = this.root.querySelector('#feedbackCaseBody');
      const base = `/api/feedback/cases/${c.id}`;
      let updated = null;
      try {
        if (action === 'save-case') {
          updated = await this.api(base, 'PUT', {
            title: body.querySelector('#feedbackCaseTitle').value,
            summary: body.querySelector('#feedbackCaseSummary').value,
            severity: body.querySelector('#feedbackCaseSeverity').value
          });
          showMessage(updated.status === 'escalated' ? 'Сохранено — критичный кейс передан на третью линию' : 'Сохранено', 'success');
        } else if (action === 'edit-fact') {
          this.editingFactId = Number(dataset.factId);
          this.renderCase();
          body.querySelector('#feedbackFactText')?.focus();
          return;
        } else if (action === 'cancel-fact') {
          this.editingFactId = null;
          this.renderCase();
          return;
        } else if (action === 'save-fact') {
          const payload = {
            kind: body.querySelector('#feedbackFactKind').value,
            text: body.querySelector('#feedbackFactText').value,
            sourceReportIds: Array.from(body.querySelectorAll('[data-fact-source]:checked')).map((el) => Number(el.dataset.factSource))
          };
          updated = this.editingFactId
            ? await this.api(`${base}/facts/${this.editingFactId}`, 'PUT', payload)
            : await this.api(`${base}/facts`, 'POST', payload);
        } else if (action === 'delete-fact') {
          const ok = await window.confirmDialog.open({ message: 'Удалить факт? Его текст останется в журнале кейса.' });
          if (!ok) return;
          updated = await this.api(`${base}/facts/${dataset.factId}`, 'DELETE');
        } else if (action === 'detach') {
          const ok = await window.confirmDialog.open({ message: `Отвязать обращение #${dataset.reportId}? Оно вернётся в очередь второй линии.` });
          if (!ok) return;
          updated = await this.api(`${base}/reports/${dataset.reportId}`, 'DELETE');
        } else if (action === 'escalate') {
          if (!c.facts.length) {
            const ok = await window.confirmDialog.open({ message: 'В кейсе нет ни одного факта. Всё равно передать на третью линию?' });
            if (!ok) return;
          }
          updated = await this.api(`${base}/escalate`, 'POST');
          showMessage('Кейс передан на третью линию', 'success');
        } else if (action === 'decide') {
          const accepted = dataset.decision === 'accepted';
          const text = await this.askText({
            title: accepted ? `Принять кейс #${c.id}` : `Отклонить кейс #${c.id}`,
            label: 'Пояснение решения (его увидят авторы обращений)',
            confirm: accepted ? 'Принять' : 'Отклонить'
          });
          if (text == null) return;
          updated = await this.api(`${base}/decide`, 'POST', { decision: dataset.decision, text });
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
    askText({ title, label, confirm }) {
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
      if (confirmed && !text) {
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
