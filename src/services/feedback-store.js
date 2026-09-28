// feedback-store.js — обращения пользователей (багрепорты и предложения) и
// трёхлинейная модерация над ними.
//
// Жизненный цикл:
//   1. Любой одобренный пользователь отправляет обращение по шаблону
//      (createReport) — оно получает ID и статус 'new'.
//   2. Первая линия (право feedback_triage) очищает поток: 'accepted' —
//      обращение адекватное, идёт дальше; 'rejected' — спам/нерелевант, с
//      причиной, которую видит автор. Отклонённые не удаляются — вторая
//      линия может выборочно проверить их и вернуть в 'new' (restoreReport).
//   3. Вторая линия (feedback_cases) объединяет принятые обращения в кейсы:
//      одно обращение — не более одного кейса, тип кейса совпадает с типом
//      обращений. Внутри кейса ведутся факты (feedback_case_facts), у каждого
//      — список обращений-источников. Приоритет считается из критичности и
//      числа РАЗНЫХ пользователей (см. computePriority). Готовый кейс
//      передаётся на третью линию ('escalated'); критичность 4 передаёт его
//      туда сразу.
//   4. Третья линия (feedback_decide) принимает решение ('resolved' +
//      decision accepted/declined) или возвращает кейс на доработку ('open').
//   5. Решённый кейс архивируется ('archived').
//
// Как не потерять информацию при объединении: текст обращений после
// отправки не редактируется и при объединении не копируется — кейс только
// ссылается на обращения (case_id). Факты не делятся вручную на "от
// большинства" и "от некоторых": это вычисляется по доле источников среди
// обращений кейса (MAJORITY_SHARE), поэтому при добавлении/отвязке
// обращений классификация пересчитывается сама. Любое обращение можно
// отвязать обратно; всё пишется в журнал feedback_events.

const { feedbackDb } = require('../db/connections');

const TYPES = ['bug', 'idea'];
const FREQUENCIES = ['always', 'often', 'sometimes', 'once'];
const FACT_KINDS = ['info', 'contradiction'];
const DECISIONS = ['accepted', 'declined'];

// Вес критичности: 1 — косметика, 2 — мешает, 3 — ломает функцию,
// 4 — потеря данных/безопасность. Каждая ступень вдвое важнее предыдущей,
// а число пользователей входит логарифмом — так 40 жалоб на косметику не
// перевешивают двух на потерю данных.
const SEVERITY_WEIGHTS = { 1: 1, 2: 2, 3: 4, 4: 8 };
const CRITICAL_SEVERITY = 4;
// Факт считается "от большинства", если его подтверждает не меньше этой
// доли обращений кейса.
const MAJORITY_SHARE = 0.6;
// Сколько необработанных (status = 'new') обращений может одновременно
// висеть у одного пользователя — простая защита первой линии от флуда.
const MAX_PENDING_PER_USER = 5;
const MAX_ATTACHMENTS = 10;

const LIMITS = {
  title: 150,
  description: 5000,
  steps: 5000,
  expected: 2000,
  actual: 2000,
  version: 50,
  platform: 100,
  comment: 2000,
  reason: 500,
  summary: 5000,
  fact: 2000,
  decision: 5000
};

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    feedbackDb.run(sql, params, function (err) {
      if (err) reject(err); else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    feedbackDb.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    feedbackDb.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

// Ошибка, которую роут отдаёт клиенту с конкретным HTTP-статусом (по
// умолчанию роуты отвечают 400 на любую ошибку store).
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function cleanText(value, max) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, max);
}

function requireText(value, max, label) {
  const text = cleanText(value, max);
  if (!text) throw httpError(400, `Заполните поле «${label}»`);
  return text;
}

function parseJsonArray(json) {
  try {
    const parsed = JSON.parse(json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// Доказательства: загруженные через /api/upload-image файлы (/uploads/x —
// только плоская папка, как их находит cleanup.js) или внешние ссылки
// (видео, логи на сторонних сервисах).
function cleanAttachments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach((item) => {
    const url = String(item || '').trim();
    if (/^\/uploads\/[^\/?#\s]+$/.test(url) || /^https?:\/\/\S+$/i.test(url)) {
      if (!out.includes(url)) out.push(url.slice(0, 500));
    }
  });
  return out.slice(0, MAX_ATTACHMENTS);
}

function toId(value) {
  const id = parseInt(value, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function actorName(user) {
  return user.display_name || user.username;
}

async function logEvent(actor, action, { caseId = null, reportId = null, details = null } = {}) {
  await run(
    'INSERT INTO feedback_events (case_id, report_id, actor_id, actor_name, action, details) VALUES (?, ?, ?, ?, ?, ?)',
    [caseId, reportId, actor ? actor.id : null, actor ? actorName(actor) : null, action, details]
  );
}

function computePriority(severity, usersCount) {
  const weight = SEVERITY_WEIGHTS[severity] || SEVERITY_WEIGHTS[2];
  const users = Math.max(1, usersCount || 0);
  return Math.round(weight * (1 + Math.log2(users)) * 10) / 10;
}

function mapReport(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    steps: row.steps,
    expected: row.expected,
    actual: row.actual,
    version: row.version,
    platform: row.platform,
    frequency: row.frequency,
    comment: row.comment,
    attachments: parseJsonArray(row.attachments),
    authorId: row.author_id,
    authorName: row.author_name,
    status: row.status,
    rejectReason: row.reject_reason,
    triagedBy: row.triaged_by,
    triagedAt: row.triaged_at,
    caseId: row.case_id,
    createdAt: row.created_at
  };
}

function mapCase(row, stats) {
  if (!row) return null;
  const reportsCount = stats ? stats.reports_count : 0;
  const usersCount = stats ? stats.users_count : 0;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    severity: row.severity,
    status: row.status,
    decision: row.decision,
    decisionText: row.decision_text,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    escalatedAt: row.escalated_at,
    archivedAt: row.archived_at,
    reportsCount,
    usersCount,
    // Дубли — все обращения кейса сверх первого: без кейса каждое из них
    // третьей линии пришлось бы разбирать отдельно.
    duplicatesCount: Math.max(0, reportsCount - 1),
    priority: computePriority(row.severity, usersCount)
  };
}

// ---------- Обращения: пользователь ----------

async function createReport(user, input) {
  const type = TYPES.includes(input.type) ? input.type : null;
  if (!type) throw httpError(400, 'Укажите тип обращения: баг или предложение');

  const pending = await get("SELECT COUNT(*) as cnt FROM feedback_reports WHERE author_id = ? AND status = 'new'", [user.id]);
  if (pending && pending.cnt >= MAX_PENDING_PER_USER) {
    throw httpError(429, `У вас уже ${pending.cnt} обращений ждут проверки — дождитесь, пока модераторы их разберут`);
  }

  const isBug = type === 'bug';
  const report = {
    title: requireText(input.title, LIMITS.title, 'Краткое название'),
    description: requireText(input.description, LIMITS.description, isBug ? 'Описание проблемы' : 'Описание идеи'),
    // Шаги воспроизведения и ожидаемое/фактическое — только для багов.
    steps: isBug ? requireText(input.steps, LIMITS.steps, 'Шаги воспроизведения') : null,
    expected: isBug ? cleanText(input.expected, LIMITS.expected) : null,
    actual: isBug ? cleanText(input.actual, LIMITS.actual) : null,
    version: cleanText(input.version, LIMITS.version),
    platform: cleanText(input.platform, LIMITS.platform),
    frequency: isBug && FREQUENCIES.includes(input.frequency) ? input.frequency : null,
    comment: cleanText(input.comment, LIMITS.comment),
    attachments: cleanAttachments(input.attachments)
  };

  const result = await run(
    `INSERT INTO feedback_reports
      (type, title, description, steps, expected, actual, version, platform, frequency, comment, attachments, author_id, author_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [type, report.title, report.description, report.steps, report.expected, report.actual, report.version,
      report.platform, report.frequency, report.comment, JSON.stringify(report.attachments), user.id, actorName(user)]
  );
  await logEvent(user, 'report_created', { reportId: result.lastID });
  return getReport(result.lastID);
}

async function getReport(reportId) {
  return mapReport(await get('SELECT * FROM feedback_reports WHERE id = ?', [reportId]));
}

// Свои обращения вместе с публичной частью кейса (статус и решение) —
// автор видит, что происходит с его обращением, и не отправляет его заново.
async function listMyReports(userId) {
  const rows = await all(
    `SELECT r.*, c.status as case_status, c.decision as case_decision, c.decision_text as case_decision_text
     FROM feedback_reports r LEFT JOIN feedback_cases c ON c.id = r.case_id
     WHERE r.author_id = ? ORDER BY r.created_at DESC, r.id DESC`,
    [userId]
  );
  return rows.map((row) => ({
    ...mapReport(row),
    caseStatus: row.case_status || null,
    caseDecision: row.case_decision || null,
    caseDecisionText: row.case_decision_text || null
  }));
}

// ---------- Первая линия ----------

async function listReportsByStatus(status) {
  const rows = await all('SELECT * FROM feedback_reports WHERE status = ? ORDER BY created_at ASC, id ASC', [status]);
  return rows.map(mapReport);
}

// Принятые, но ещё не объединённые ни в один кейс — очередь второй линии.
async function listUnassignedAccepted() {
  const rows = await all("SELECT * FROM feedback_reports WHERE status = 'accepted' AND case_id IS NULL ORDER BY created_at ASC, id ASC");
  return rows.map(mapReport);
}

async function assertTriagable(actor, reportId) {
  const report = await getReport(reportId);
  if (!report) throw httpError(404, 'Обращение не найдено');
  if (report.status !== 'new') throw httpError(409, 'Обращение уже обработано');
  if (report.authorId === actor.id && !actor.is_root) {
    throw httpError(403, 'Своё обращение должен проверить другой модератор');
  }
  return report;
}

async function acceptReport(actor, reportId) {
  await assertTriagable(actor, reportId);
  await run(
    "UPDATE feedback_reports SET status = 'accepted', reject_reason = NULL, triaged_by = ?, triaged_at = CURRENT_TIMESTAMP WHERE id = ?",
    [actorName(actor), reportId]
  );
  await logEvent(actor, 'report_accepted', { reportId });
  return getReport(reportId);
}

async function rejectReport(actor, reportId, reason) {
  await assertTriagable(actor, reportId);
  const text = requireText(reason, LIMITS.reason, 'Причина');
  await run(
    "UPDATE feedback_reports SET status = 'rejected', reject_reason = ?, triaged_by = ?, triaged_at = CURRENT_TIMESTAMP WHERE id = ?",
    [text, actorName(actor), reportId]
  );
  await logEvent(actor, 'report_rejected', { reportId, details: text });
  return getReport(reportId);
}

// Выборочная проверка первой линии: вернуть ошибочно отклонённое обращение
// обратно в очередь.
async function restoreReport(actor, reportId) {
  const report = await getReport(reportId);
  if (!report) throw httpError(404, 'Обращение не найдено');
  if (report.status !== 'rejected') throw httpError(409, 'Вернуть можно только отклонённое обращение');
  await run("UPDATE feedback_reports SET status = 'new', reject_reason = NULL, triaged_by = NULL, triaged_at = NULL WHERE id = ?", [reportId]);
  await logEvent(actor, 'report_restored', { reportId, details: report.rejectReason });
  return getReport(reportId);
}

// ---------- Вторая линия: кейсы ----------

async function caseStats(caseIds) {
  if (!caseIds.length) return new Map();
  const placeholders = caseIds.map(() => '?').join(',');
  const rows = await all(
    `SELECT case_id, COUNT(*) as reports_count, COUNT(DISTINCT author_id) as users_count
     FROM feedback_reports WHERE case_id IN (${placeholders}) GROUP BY case_id`,
    caseIds
  );
  return new Map(rows.map((r) => [r.case_id, r]));
}

async function listCases(statuses) {
  const list = (statuses || []).filter(Boolean);
  const rows = list.length
    ? await all(`SELECT * FROM feedback_cases WHERE status IN (${list.map(() => '?').join(',')})`, list)
    : await all('SELECT * FROM feedback_cases');
  const stats = await caseStats(rows.map((r) => r.id));
  return rows
    .map((row) => mapCase(row, stats.get(row.id)))
    .sort((a, b) => b.priority - a.priority || a.id - b.id);
}

async function getCaseRow(caseId) {
  const row = await get('SELECT * FROM feedback_cases WHERE id = ?', [caseId]);
  if (!row) throw httpError(404, 'Кейс не найден');
  return row;
}

// Полная карточка кейса: обращения, факты с долей подтверждения, журнал.
async function getCaseDetails(caseId) {
  const row = await getCaseRow(caseId);
  const reports = (await all('SELECT * FROM feedback_reports WHERE case_id = ? ORDER BY created_at ASC, id ASC', [caseId])).map(mapReport);
  const stats = { reports_count: reports.length, users_count: new Set(reports.map((r) => r.authorId)).size };
  const reportIds = new Set(reports.map((r) => r.id));

  const facts = (await all('SELECT * FROM feedback_case_facts WHERE case_id = ? ORDER BY id ASC', [caseId])).map((f) => {
    const sources = parseJsonArray(f.source_report_ids).filter((id) => reportIds.has(id));
    const share = reports.length ? sources.length / reports.length : 0;
    return {
      id: f.id,
      kind: f.kind,
      text: f.text,
      sourceReportIds: sources,
      share,
      // 'majority' | 'some' — только для kind = 'info'
      group: f.kind === 'info' ? (share >= MAJORITY_SHARE ? 'majority' : 'some') : null,
      createdBy: f.created_by,
      createdAt: f.created_at
    };
  });

  const events = await all('SELECT * FROM feedback_events WHERE case_id = ? ORDER BY id DESC LIMIT 200', [caseId]);

  return {
    ...mapCase(row, stats),
    reports,
    facts,
    majorityShare: MAJORITY_SHARE,
    events: events.map((e) => ({
      id: e.id,
      action: e.action,
      actorName: e.actor_name,
      reportId: e.report_id,
      details: e.details,
      createdAt: e.created_at
    }))
  };
}

function cleanSeverity(value) {
  const severity = parseInt(value, 10);
  return SEVERITY_WEIGHTS[severity] ? severity : null;
}

async function assertCaseEditable(caseId) {
  const row = await getCaseRow(caseId);
  if (row.status !== 'open') throw httpError(409, 'Кейс уже передан дальше — вторая линия может править только открытые кейсы');
  return row;
}

// Обращение можно добавить в кейс, только если оно прошло первую линию, ещё
// не лежит в другом кейсе и того же типа.
async function loadAttachableReports(reportIds, type) {
  const ids = [...new Set((reportIds || []).map(toId).filter(Boolean))];
  if (!ids.length) throw httpError(400, 'Выберите хотя бы одно обращение');
  const rows = await all(`SELECT * FROM feedback_reports WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  if (rows.length !== ids.length) throw httpError(404, 'Часть обращений не найдена');
  rows.forEach((r) => {
    if (r.status !== 'accepted') throw httpError(409, `Обращение #${r.id} ещё не прошло первую линию`);
    if (r.case_id) throw httpError(409, `Обращение #${r.id} уже входит в кейс #${r.case_id}`);
    if (type && r.type !== type) throw httpError(409, `Обращение #${r.id} другого типа — в одном кейсе только баги или только предложения`);
  });
  const types = new Set(rows.map((r) => r.type));
  if (types.size > 1) throw httpError(409, 'Нельзя объединить баги и предложения в один кейс');
  return rows;
}

async function escalateIfCritical(actor, caseId, severity) {
  if (severity !== CRITICAL_SEVERITY) return;
  await run("UPDATE feedback_cases SET status = 'escalated', escalated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'open'", [caseId]);
  await logEvent(actor, 'case_escalated', { caseId, details: 'Автоматически: критичность 4' });
}

async function createCase(actor, input) {
  const rows = await loadAttachableReports(input.reportIds);
  const type = rows[0].type;
  const title = cleanText(input.title, LIMITS.title) || rows[0].title;
  const severity = cleanSeverity(input.severity) || 2;
  const summary = cleanText(input.summary, LIMITS.summary);

  const result = await run(
    'INSERT INTO feedback_cases (type, title, summary, severity, created_by) VALUES (?, ?, ?, ?, ?)',
    [type, title, summary, severity, actorName(actor)]
  );
  const caseId = result.lastID;
  const ids = rows.map((r) => r.id);
  await run(`UPDATE feedback_reports SET case_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [caseId, ...ids]);
  await logEvent(actor, 'case_created', { caseId, details: `Обращения: ${ids.map((id) => '#' + id).join(', ')}` });
  await escalateIfCritical(actor, caseId, severity);
  return getCaseDetails(caseId);
}

async function updateCase(actor, caseId, input) {
  const row = await assertCaseEditable(caseId);
  const title = input.title !== undefined ? requireText(input.title, LIMITS.title, 'Название кейса') : row.title;
  const summary = input.summary !== undefined ? cleanText(input.summary, LIMITS.summary) : row.summary;
  const severity = input.severity !== undefined ? (cleanSeverity(input.severity) || row.severity) : row.severity;

  await run(
    'UPDATE feedback_cases SET title = ?, summary = ?, severity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [title, summary, severity, caseId]
  );
  const changes = [];
  if (title !== row.title) changes.push('название');
  if ((summary || '') !== (row.summary || '')) changes.push('суть');
  if (severity !== row.severity) changes.push(`критичность ${row.severity} → ${severity}`);
  if (changes.length) await logEvent(actor, 'case_updated', { caseId, details: changes.join(', ') });
  if (severity !== row.severity) await escalateIfCritical(actor, caseId, severity);
  return getCaseDetails(caseId);
}

async function attachReports(actor, caseId, reportIds) {
  const row = await assertCaseEditable(caseId);
  const rows = await loadAttachableReports(reportIds, row.type);
  const ids = rows.map((r) => r.id);
  await run(`UPDATE feedback_reports SET case_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [caseId, ...ids]);
  await run('UPDATE feedback_cases SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [caseId]);
  for (const id of ids) await logEvent(actor, 'report_attached', { caseId, reportId: id });
  return getCaseDetails(caseId);
}

// Отвязать ошибочно объединённое обращение — оно возвращается в очередь
// второй линии, а из источников фактов кейса вычищается.
async function detachReport(actor, caseId, reportId) {
  await assertCaseEditable(caseId);
  const report = await getReport(reportId);
  if (!report || report.caseId !== Number(caseId)) throw httpError(404, 'Обращение не входит в этот кейс');
  const count = await get('SELECT COUNT(*) as cnt FROM feedback_reports WHERE case_id = ?', [caseId]);
  if (count.cnt <= 1) throw httpError(409, 'Это последнее обращение кейса — кейс без обращений не имеет смысла');

  await run('UPDATE feedback_reports SET case_id = NULL WHERE id = ?', [reportId]);
  const facts = await all('SELECT id, source_report_ids FROM feedback_case_facts WHERE case_id = ?', [caseId]);
  for (const fact of facts) {
    const sources = parseJsonArray(fact.source_report_ids);
    if (sources.includes(report.id)) {
      await run('UPDATE feedback_case_facts SET source_report_ids = ? WHERE id = ?', [JSON.stringify(sources.filter((id) => id !== report.id)), fact.id]);
    }
  }
  await run('UPDATE feedback_cases SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [caseId]);
  await logEvent(actor, 'report_detached', { caseId, reportId: report.id });
  return getCaseDetails(caseId);
}

async function cleanFactSources(caseId, sourceReportIds) {
  const ids = [...new Set((sourceReportIds || []).map(toId).filter(Boolean))];
  if (!ids.length) throw httpError(400, 'Отметьте, из каких обращений взят факт');
  const rows = await all(`SELECT id FROM feedback_reports WHERE case_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [caseId, ...ids]);
  if (rows.length !== ids.length) throw httpError(400, 'Источниками факта могут быть только обращения этого кейса');
  return ids.sort((a, b) => a - b);
}

async function addFact(actor, caseId, input) {
  await assertCaseEditable(caseId);
  const kind = FACT_KINDS.includes(input.kind) ? input.kind : 'info';
  const text = requireText(input.text, LIMITS.fact, 'Факт');
  const sources = await cleanFactSources(caseId, input.sourceReportIds);
  const result = await run(
    'INSERT INTO feedback_case_facts (case_id, kind, text, source_report_ids, created_by) VALUES (?, ?, ?, ?, ?)',
    [caseId, kind, text, JSON.stringify(sources), actorName(actor)]
  );
  await run('UPDATE feedback_cases SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [caseId]);
  await logEvent(actor, 'fact_added', { caseId, details: `#${result.lastID}: ${text.slice(0, 200)}` });
  return getCaseDetails(caseId);
}

async function getFactRow(caseId, factId) {
  const fact = await get('SELECT * FROM feedback_case_facts WHERE id = ? AND case_id = ?', [factId, caseId]);
  if (!fact) throw httpError(404, 'Факт не найден');
  return fact;
}

async function updateFact(actor, caseId, factId, input) {
  await assertCaseEditable(caseId);
  const fact = await getFactRow(caseId, factId);
  const kind = FACT_KINDS.includes(input.kind) ? input.kind : fact.kind;
  const text = input.text !== undefined ? requireText(input.text, LIMITS.fact, 'Факт') : fact.text;
  const sources = input.sourceReportIds !== undefined
    ? await cleanFactSources(caseId, input.sourceReportIds)
    : parseJsonArray(fact.source_report_ids);
  await run('UPDATE feedback_case_facts SET kind = ?, text = ?, source_report_ids = ? WHERE id = ?', [kind, text, JSON.stringify(sources), fact.id]);
  await run('UPDATE feedback_cases SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [caseId]);
  // Старый текст — в журнал, чтобы правка факта не стирала информацию.
  await logEvent(actor, 'fact_updated', { caseId, details: `#${fact.id}, было: ${fact.text.slice(0, 200)}` });
  return getCaseDetails(caseId);
}

async function deleteFact(actor, caseId, factId) {
  await assertCaseEditable(caseId);
  const fact = await getFactRow(caseId, factId);
  await run('DELETE FROM feedback_case_facts WHERE id = ?', [fact.id]);
  await logEvent(actor, 'fact_deleted', { caseId, details: `#${fact.id}: ${fact.text.slice(0, 200)}` });
  return getCaseDetails(caseId);
}

async function escalateCase(actor, caseId) {
  await assertCaseEditable(caseId);
  await run("UPDATE feedback_cases SET status = 'escalated', escalated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [caseId]);
  await logEvent(actor, 'case_escalated', { caseId });
  return getCaseDetails(caseId);
}

async function archiveCase(actor, caseId) {
  const row = await getCaseRow(caseId);
  if (row.status !== 'resolved') throw httpError(409, 'В архив можно отправить только кейс с решением третьей линии');
  await run("UPDATE feedback_cases SET status = 'archived', archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [caseId]);
  await logEvent(actor, 'case_archived', { caseId });
  return getCaseDetails(caseId);
}

// ---------- Третья линия ----------

async function decideCase(actor, caseId, input) {
  const row = await getCaseRow(caseId);
  if (row.status !== 'escalated') throw httpError(409, 'Решение принимается только по кейсу, переданному на третью линию');
  const decision = DECISIONS.includes(input.decision) ? input.decision : null;
  if (!decision) throw httpError(400, 'Укажите решение: принять или отклонить');
  const text = requireText(input.text, LIMITS.decision, 'Пояснение решения');
  await run(
    `UPDATE feedback_cases SET status = 'resolved', decision = ?, decision_text = ?, decided_by = ?,
       decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [decision, text, actorName(actor), caseId]
  );
  await logEvent(actor, 'case_decided', { caseId, details: `${decision === 'accepted' ? 'Принято' : 'Отклонено'}: ${text.slice(0, 300)}` });
  return getCaseDetails(caseId);
}

async function returnCase(actor, caseId, comment) {
  const row = await getCaseRow(caseId);
  if (row.status !== 'escalated') throw httpError(409, 'Вернуть на доработку можно только кейс, переданный на третью линию');
  const text = requireText(comment, LIMITS.reason, 'Что доработать');
  await run("UPDATE feedback_cases SET status = 'open', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [caseId]);
  await logEvent(actor, 'case_returned', { caseId, details: text });
  return getCaseDetails(caseId);
}

// ---------- Счётчики для бейджей и ссылки для очистки uploads ----------

async function countQueues() {
  const row = await get(
    `SELECT
       (SELECT COUNT(*) FROM feedback_reports WHERE status = 'new') as triage,
       (SELECT COUNT(*) FROM feedback_reports WHERE status = 'accepted' AND case_id IS NULL) as unassigned,
       (SELECT COUNT(*) FROM feedback_cases WHERE status = 'escalated') as escalated`
  );
  return row || { triage: 0, unassigned: 0, escalated: 0 };
}

// Все ссылки на доказательства — чтобы cleanup.js не счёл загруженные к
// обращениям скриншоты "сиротами".
async function listAttachmentUrls() {
  const rows = await all("SELECT attachments FROM feedback_reports WHERE attachments != '[]'");
  const urls = [];
  rows.forEach((r) => parseJsonArray(r.attachments).forEach((u) => urls.push(u)));
  return urls;
}

module.exports = {
  SEVERITY_WEIGHTS,
  MAJORITY_SHARE,
  createReport,
  getReport,
  listMyReports,
  listReportsByStatus,
  listUnassignedAccepted,
  acceptReport,
  rejectReport,
  restoreReport,
  listCases,
  getCaseDetails,
  createCase,
  updateCase,
  attachReports,
  detachReport,
  addFact,
  updateFact,
  deleteFact,
  escalateCase,
  archiveCase,
  decideCase,
  returnCase,
  countQueues,
  listAttachmentUrls
};
