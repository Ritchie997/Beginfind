// feedback.routes.js — обращения (багрепорты/предложения) и три линии их
// модерации: feedback_triage (очистка), feedback_cases (кейсы),
// feedback_decide (решение). Жизненный цикл — см. начало
// src/services/feedback-store.js.

const express = require('express');
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

// --- Пользователь ---

router.post('/feedback/reports', ...base, handle((req) => store.createReport(req.user, req.body || {})));

router.get('/feedback/reports/mine', ...base, handle((req) => store.listMyReports(req.user.id)));

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

router.post('/feedback/cases/:id/facts', ...cases, handle((req) => store.addFact(req.user, req.params.id, req.body || {})));

router.put('/feedback/cases/:id/facts/:factId', ...cases, handle((req) => store.updateFact(req.user, req.params.id, req.params.factId, req.body || {})));

router.delete('/feedback/cases/:id/facts/:factId', ...cases, handle((req) => store.deleteFact(req.user, req.params.id, req.params.factId)));

router.post('/feedback/cases/:id/escalate', ...cases, handle((req) => store.escalateCase(req.user, req.params.id)));

router.post('/feedback/cases/:id/archive', ...cases, handle((req) => store.archiveCase(req.user, req.params.id)));

// --- Третья линия ---

router.post('/feedback/cases/:id/decide', ...decide, handle((req) => store.decideCase(req.user, req.params.id, req.body || {})));

router.post('/feedback/cases/:id/return', ...decide, handle((req) => store.returnCase(req.user, req.params.id, (req.body || {}).comment)));

module.exports = router;
