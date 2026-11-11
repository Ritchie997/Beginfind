// feedback.routes.js — обращения (багрепорты/предложения) и три линии их
// модерации: feedback_triage (очистка), feedback_cases (кейсы),
// feedback_decide (решение). Жизненный цикл — см. начало
// src/services/feedback-store.js.

const express = require('express');
const jwt = require('jsonwebtoken');
const auth = require('../middleware/auth');
const store = require('../services/feedback-store');

const router = express.Router();

function hasPerm(user, key) {
  return !!(user.is_root || (user.permissions && user.permissions[key]));
}

// Карточку кейса видят и вторая линия (ведёт её), и третья (решает по ней).
function checkAnyPermission(...keys) {
  return (req, res, next) => {
    if (keys.some((key) => hasPerm(req.user, key))) return next();
    return res.status(403).json({ error: 'Недостаточно прав для этого действия' });
  };
}

function handle(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  };
}

const base = [auth.authenticateToken, auth.checkApproved];
const triage = [...base, auth.checkPermission('feedback_triage')];
const cases = [...base, auth.checkPermission('feedback_cases')];
const decide = [...base, auth.checkPermission('feedback_decide')];
const caseViewers = [...base, checkAnyPermission('feedback_cases', 'feedback_decide')];

function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    req.user = null;
    return next();
  }
  jwt.verify(token, auth.JWT_SECRET, (err, user) => {
    if (err || !user) {
      req.user = null;
      return next();
    }
    req.user = user;
    auth.checkApproved(req, res, (apprErr) => {
      if (apprErr) return next(apprErr);
      next();
    });
  });
}

// --- Пользователь ---

router.post('/feedback/reports', ...base, handle((req) => store.createReport(req.user, req.body || {})));

// Упрощённый эндпоинт отправки обращений и жалоб на статьи
router.post('/feedback', optionalAuth, handle(async (req) => {
  const body = req.body || {};
  const isArticle = body.target_type === 'article' || body.type === 'article' ||
    (body.category === 'complaint' && (body.target_slug || body.articleSlug || body.slug));

  if (isArticle) {
    if (!req.user) {
      const err = new Error('Для подачи жалобы на статью необходимо авторизоваться');
      err.status = 401;
      throw err;
    }
    const articleSlug = body.target_slug || body.articleSlug || body.slug;
    if (!articleSlug) {
      const err = new Error('Укажите slug статьи');
      err.status = 400;
      throw err;
    }
    const report = await store.createReport(req.user, {
      type: 'article',
      articleSlug,
      articleReason: body.reason || body.articleReason || 'other',
      description: body.text || body.description || 'Жалоба на статью',
      comment: body.comment || ''
    });
    return { success: true, id: report.id, report };
  }

  // Общее обращение в техподдержку (модалка из футера)
  const categoryMap = {
    bug: { type: 'bug', label: 'Ошибка' },
    error: { type: 'bug', label: 'Ошибка' },
    'ошибка': { type: 'bug', label: 'Ошибка' },
    idea: { type: 'idea', label: 'Идея' },
    'идея': { type: 'idea', label: 'Идея' },
    complaint: { type: 'bug', label: 'Жалоба' },
    'жалоба': { type: 'bug', label: 'Жалоба' },
    question: { type: 'idea', label: 'Вопрос' },
    'вопрос': { type: 'idea', label: 'Вопрос' }
  };

  const categoryKey = String(body.category || 'bug').toLowerCase().trim();
  const categoryInfo = categoryMap[categoryKey] || { type: 'bug', label: 'Обращение' };
  const type = categoryInfo.type;
  const label = categoryInfo.label;

  const rawText = String(body.text || body.description || '').trim();
  if (!rawText) {
    const err = new Error('Заполните текст обращения');
    err.status = 400;
    throw err;
  }

  const contact = String(body.contact || body.email || '').trim();

  let user = req.user;
  if (!user) {
    if (!contact) {
      const err = new Error('Укажите контакт или email для обратной связи');
      err.status = 400;
      throw err;
    }
    user = {
      id: 0,
      username: contact.slice(0, 50),
      display_name: `Гость (${contact.slice(0, 50)})`
    };
  }

  let description = rawText;
  if (contact) {
    description += `\n\nКонтакт для связи: ${contact}`;
  }

  const snippet = rawText.replace(/\s+/g, ' ').slice(0, 80);
  const title = (body.title || `[${label}] ${snippet || 'Обращение в поддержку'}`).slice(0, 150);

  const report = await store.createReport(user, {
    type,
    title,
    description,
    attachments: body.attachments || []
  });
  return { success: true, id: report.id, report };
}));

router.get('/feedback/reports/mine', ...base, handle((req) => store.listMyReports(req.user.id)));

router.get('/feedback/reports/:id/comments', ...base, handle((req) => store.listOwnReportComments(req.user, req.params.id)));
router.post('/feedback/reports/:id/comments', ...base, handle((req) => store.createOwnReportComment(req.user, req.params.id, req.body || {})));
router.delete('/feedback/reports/:id/comments/:commentId', ...base, handle((req) => store.deleteOwnReportComment(req.user, req.params.id, req.params.commentId)));

// Правка своего обращения (пока по нему нет решения) — см. updateOwnReport.
router.put('/feedback/reports/:id', ...base, handle((req) => store.updateOwnReport(req.user, req.params.id, req.body || {})));

// Отзыв своего обращения (пока по нему нет решения) — см. withdrawOwnReport.
router.post('/feedback/reports/:id/withdraw', ...base, handle((req) => store.withdrawOwnReport(req.user, req.params.id)));

// --- Первая линия ---

// ?status=new (очередь) | rejected (отклонённые — для выборочной проверки,
// их видит и вторая линия, которая может вернуть обращение в очередь).
router.get('/feedback/reports', ...base, handle(async (req) => {
  const status = req.query.status === 'rejected' ? 'rejected' : 'new';
  const allowed = status === 'new'
    ? hasPerm(req.user, 'feedback_triage')
    : hasPerm(req.user, 'feedback_triage') || hasPerm(req.user, 'feedback_cases');
  if (!allowed) {
    const err = new Error('Недостаточно прав для этого действия');
    err.status = 403;
    throw err;
  }
  return store.listReportsByStatus(status);
}));

router.post('/feedback/reports/:id/accept', ...triage, handle((req) => store.acceptReport(req.user, req.params.id)));

router.post('/feedback/reports/:id/reject', ...triage, handle((req) => store.rejectReport(req.user, req.params.id, (req.body || {}).reason)));

router.post('/feedback/reports/:id/restore', ...cases, handle((req) => store.restoreReport(req.user, req.params.id)));

// --- Вторая линия ---

router.get('/feedback/queue', ...cases, handle(() => store.listUnassignedAccepted()));

// ?status=open,escalated — через запятую; без параметра — все кейсы.
router.get('/feedback/cases', ...caseViewers, handle((req) => {
  const statuses = String(req.query.status || '').split(',').map((s) => s.trim()).filter(Boolean);
  return store.listCases(statuses);
}));

router.get('/feedback/cases/:id', ...caseViewers, handle((req) => store.getCaseDetails(req.params.id)));

router.post('/feedback/cases', ...cases, handle((req) => store.createCase(req.user, req.body || {})));

router.put('/feedback/cases/:id', ...cases, handle((req) => store.updateCase(req.user, req.params.id, req.body || {})));

router.post('/feedback/cases/:id/reports', ...cases, handle((req) => store.attachReports(req.user, req.params.id, (req.body || {}).reportIds)));

router.delete('/feedback/cases/:id/reports/:reportId', ...cases, handle((req) => store.detachReport(req.user, req.params.id, req.params.reportId)));

router.post('/feedback/cases/:id/escalate', ...cases, handle((req) => store.escalateCase(req.user, req.params.id)));

router.post('/feedback/cases/:id/archive', ...cases, handle((req) => store.archiveCase(req.user, req.params.id)));

// --- Третья линия ---

router.post('/feedback/cases/:id/decide', ...decide, handle((req) => store.decideCase(req.user, req.params.id, req.body || {})));

router.post('/feedback/cases/:id/complete', ...decide, handle((req) => store.completeCase(req.user, req.params.id, (req.body || {}).comment)));

router.post('/feedback/cases/:id/return', ...decide, handle((req) => store.returnCase(req.user, req.params.id, (req.body || {}).comment)));

module.exports = router;
