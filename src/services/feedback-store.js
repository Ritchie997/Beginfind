// feedback-store.js — обращения пользователей (багрепорты и предложения) и
// трёхлинейная модерация над ними.
//
// Жизненный цикл:
//   1. Любой одобренный пользователь отправляет обращение по шаблону
//      (createReport) — оно получает ID и статус 'new'. Жалоба на статью
//      Ибрипедии (type 'article') — такое же обращение, отправляется со
//      страницы статьи (createArticleReport).
//   2. Первая линия (право feedback_triage) очищает поток: 'accepted' —
//      обращение адекватное, идёт дальше; 'rejected' — спам/нерелевант, с
//      причиной, которую видит автор. Отклонённые не удаляются — вторая
//      линия может выборочно проверить их и вернуть в 'new' (restoreReport).
//   3. Вторая линия (feedback_cases) объединяет принятые обращения в кейсы:
//      одно обращение — не более одного кейса, тип кейса совпадает с типом
//      обращений. Собранный кейс сразу уходит на третью линию ('escalated') —
//      отдельного шага «передать» нет. Кейс — это суть проблемы, по желанию
//      комментарий второй линии и критичность. Пока решения нет, вторая линия
//      может дополнять кейс новыми дублями и править его. Приоритет
//      считается из критичности и числа РАЗНЫХ пользователей (computePriority).
//   4. Третья линия (feedback_decide) принимает кейс в работу ('accepted',
//      decision = 'accepted'), отклоняет его ('resolved', decision =
//      'declined') или возвращает на доработку ('open'); доработанный кейс
//      вторая линия передаёт обратно (escalateCase).
//   5. Принятый кейс, когда всё сделано, третья линия завершает
//      (completeCase → 'resolved').
//   6. Решённый кейс архивируется ('archived').
//
// Автор может править своё обращение, пока по нему нет решения
// (updateOwnReport); прежний текст уходит в журнал feedback_events, так что
// правка не стирает то, на чём модераторы строили кейс. Отклонённое
// обращение после правки возвращается в очередь первой линии.
//
// Как не потерять информацию при объединении: текст обращений при
// объединении не копируется — кейс только ссылается на обращения (case_id).
// Любое обращение можно отвязать обратно; всё пишется в журнал.
// (Раньше в кейсах вели «факты» — таблица feedback_case_facts осталась в БД
// со старыми записями, но больше не используется.)

const { feedbackDb } = require('../db/connections');
const articlesStore = require('./articles-store');
const articleLayers = require('./article-layers');

// 'article' — жалоба на статью Ибрипедии: проходит те же три линии, что и
// баги/предложения, но в кейс объединяются только жалобы на одну статью.
const TYPES = ['bug', 'idea', 'article'];
const ARTICLE_REASONS = {
  inaccurate: 'Недостоверная информация',
  outdated: 'Устарело',
  offensive: 'Оскорбления / нарушение правил',
  plagiarism: 'Плагиат',
  spam: 'Спам / реклама',
  other: 'Другое'
};
const DECISIONS = ['accepted', 'declined'];

// Вес критичности: 1 — косметика, 2 — мешает, 3 — ломает функцию,
// 4 — потеря данных/безопасность. Каждая ступень вдвое важнее предыдущей,
// а число пользователей входит логарифмом — так 40 жалоб на косметику не
// перевешивают двух на потерю данных.
const SEVERITY_WEIGHTS = { 1: 1, 2: 2, 3: 4, 4: 8 };
const CRITICAL_SEVERITY = 4;
// Сколько необработанных (status = 'new') обращений может одновременно
// висеть у одного пользователя — простая защита первой линии от флуда.
const MAX_PENDING_PER_USER = 5;
const MAX_ATTACHMENTS = 10;
// Баг/идея: название, описание и по желанию скриншоты — не больше.
const MAX_SCREENSHOTS = 5;
// Кейс, по которому ещё нет решения: его обращения автор может править.
const UNDECIDED_CASE_STATUSES = ['open', 'escalated'];

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

// Скриншоты бага/идеи — только загруженные картинки.
function cleanScreenshots(list) {
  return cleanAttachments(list).filter((url) => url.startsWith('/uploads/')).slice(0, MAX_SCREENSHOTS);
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
    articleSlug: row.article_slug || null,
    articleTitle: row.article_title || null,
    articleReason: row.article_reason || null,
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
    comment: row.comment || null,
    severity: row.severity,
    status: row.status,
    decision: row.decision,
    decisionText: row.decision_text,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    completedBy: row.completed_by || null,
    completedAt: row.completed_at || null,
    completionText: row.completion_text || null,
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

// Статья, на которую жалуются, — только та, которую пользователь сам может
// прочитать: иначе через жалобу можно было бы узнать название закрытой.
async function resolveReportedArticle(user, slug) {
  const article = slug ? articlesStore.getArticle(String(slug)) : null;
  if (!article || !(await articleLayers.hasArticleAccess(article, user))) {
    throw httpError(404, 'Статья не найдена');
  }
  return article;
}

async function assertNoPending(user) {
  const pending = await get("SELECT COUNT(*) as cnt FROM feedback_reports WHERE author_id = ? AND status = 'new'", [user.id]);
  if (pending && pending.cnt >= MAX_PENDING_PER_USER) {
    throw httpError(429, `У вас уже ${pending.cnt} обращений ждут проверки — дождитесь, пока модераторы их разберут`);
  }
}

async function createArticleReport(user, input) {
  const article = await resolveReportedArticle(user, input.articleSlug);
  const reason = Object.prototype.hasOwnProperty.call(ARTICLE_REASONS, input.articleReason) ? input.articleReason : null;
  if (!reason) throw httpError(400, 'Выберите причину жалобы');

  // Повторная жалоба на ту же статью, пока первая не разобрана, ничего не
  // добавляет — только нагружает первую линию.
  const duplicate = await get(
    "SELECT id FROM feedback_reports WHERE author_id = ? AND type = 'article' AND article_slug = ? AND status = 'new'",
    [user.id, article.slug]
  );
  if (duplicate) throw httpError(409, `Ваша жалоба на эту статью (#${duplicate.id}) уже ждёт проверки`);
  await assertNoPending(user);

  const articleTitle = String(article.title || article.slug).slice(0, LIMITS.title);
  const title = `${ARTICLE_REASONS[reason]}: ${articleTitle}`.slice(0, LIMITS.title);
  const description = requireText(input.description, LIMITS.description, 'Что не так со статьёй');
  const comment = cleanText(input.comment, LIMITS.comment);
  const attachments = cleanAttachments(input.attachments);

  const result = await run(
    `INSERT INTO feedback_reports
      (type, title, description, comment, attachments, article_slug, article_title, article_reason, author_id, author_name)
     VALUES ('article', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [title, description, comment, JSON.stringify(attachments), article.slug, articleTitle, reason, user.id, actorName(user)]
  );
  await logEvent(user, 'report_created', { reportId: result.lastID });
  return getReport(result.lastID);
}

async function createReport(user, input) {
  const type = TYPES.includes(input.type) ? input.type : null;
  if (!type) throw httpError(400, 'Укажите тип обращения: баг, предложение или жалоба на статью');
  if (type === 'article') return createArticleReport(user, input);

  await assertNoPending(user);

  const report = cleanReportInput(type, input);
  const result = await run(
    'INSERT INTO feedback_reports (type, title, description, attachments, author_id, author_name) VALUES (?, ?, ?, ?, ?, ?)',
    [type, report.title, report.description, JSON.stringify(report.attachments), user.id, actorName(user)]
  );
  await logEvent(user, 'report_created', { reportId: result.lastID });
  return getReport(result.lastID);
}

// Баг: название + описание проблемы; идея: название + предложение. Плюс
// по желанию скриншоты. Старые поля (шаги, версия, платформа…) у прежних
// обращений остаются в БД и показываются, но новых больше не принимаем.
function cleanReportInput(type, input) {
  const isBug = type === 'bug';
  return {
    title: requireText(input.title, LIMITS.title, isBug ? 'Название проблемы' : 'Название идеи'),
    description: requireText(input.description, LIMITS.description, isBug ? 'Описание проблемы' : 'Предложение'),
    attachments: cleanScreenshots(input.attachments)
  };
}

// Правка своего обращения автором — пока по нему нет решения. Прежний
// текст — в журнал (и в журнал кейса, если обращение уже в кейсе), чтобы
// модераторы видели, что поменялось. Отклонённое после правки снова идёт
// на первую линию.
async function updateOwnReport(user, reportId, input) {
  const row = await get(
    `SELECT r.*, c.status as case_status FROM feedback_reports r
     LEFT JOIN feedback_cases c ON c.id = r.case_id WHERE r.id = ?`,
    [reportId]
  );
  if (!row || row.author_id !== user.id) throw httpError(404, 'Обращение не найдено');
  if (!canAuthorEdit(row)) throw httpError(409, 'По обращению уже принято решение — править его нельзя');

  let title;
  let description;
  let attachments;
  if (row.type === 'article') {
    // Название жалобы собирается из причины и статьи — правится только суть.
    title = row.title;
    description = requireText(input.description, LIMITS.description, 'Что не так со статьёй');
    attachments = input.attachments !== undefined ? cleanAttachments(input.attachments) : parseJsonArray(row.attachments);
  } else {
    ({ title, description, attachments } = cleanReportInput(row.type, input));
  }

  const resubmit = row.status === 'rejected';
  if (resubmit) await assertNoPending(user);

  const changed = title !== row.title || description !== row.description
    || JSON.stringify(attachments) !== JSON.stringify(parseJsonArray(row.attachments));
  if (!changed && !resubmit) return getReport(reportId);

  await run(
    `UPDATE feedback_reports SET title = ?, description = ?, attachments = ?
       ${resubmit ? ", status = 'new', reject_reason = NULL, triaged_by = NULL, triaged_at = NULL" : ''}
     WHERE id = ?`,
    [title, description, JSON.stringify(attachments), reportId]
  );
  if (changed) {
    const was = `было: «${row.title}» — ${String(row.description || '').slice(0, 1000)}`;
    await logEvent(user, 'report_edited', { caseId: row.case_id, reportId: row.id, details: was });
  }
  if (resubmit) await logEvent(user, 'report_resubmitted', { reportId: row.id });
  if (row.case_id) await run('UPDATE feedback_cases SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [row.case_id]);
  return getReport(reportId);
}

function canAuthorEdit(row) {
  if (!['new', 'accepted', 'rejected'].includes(row.status)) return false;
  return !row.case_id || UNDECIDED_CASE_STATUSES.includes(row.case_status);
}

async function getReport(reportId) {
  return mapReport(await get('SELECT * FROM feedback_reports WHERE id = ?', [reportId]));
}

// Свои обращения вместе с публичной частью кейса (статус и решение) —
// автор видит, что происходит с его обращением, и не отправляет его заново.
async function listMyReports(userId) {
  const rows = await all(
    `SELECT r.*, c.status as case_status, c.decision as case_decision, c.decision_text as case_decision_text,
       c.completion_text as case_completion_text
     FROM feedback_reports r LEFT JOIN feedback_cases c ON c.id = r.case_id
     WHERE r.author_id = ? ORDER BY r.created_at DESC, r.id DESC`,
    [userId]
  );
  return rows.map((row) => ({
    ...mapReport(row),
    caseStatus: row.case_status || null,
    caseDecision: row.case_decision || null,
    caseDecisionText: row.case_decision_text || null,
    caseCompletionText: row.case_completion_text || null,
    canEdit: canAuthorEdit(row)
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
  // Своё обращение по умолчанию проверяет другой модератор; право
  // feedback_self (выдаётся роли, например кураторам) снимает это ограничение.
  const canSelf = actor.is_root || !!(actor.permissions && actor.permissions.feedback_self);
  if (report.authorId === actor.id && !canSelf) {
    throw httpError(403, 'Своё обращение должен проверить другой модератор');
  }
  return report;
}

// "AND status = 'new'" + проверка changes: два модератора жмут одновременно —
// второй получает 409, а не перезаписывает решение первого.
async function triageUpdate(sql, params) {
  const result = await run(`${sql} AND status = 'new'`, params);
  if (!result.changes) throw httpError(409, 'Обращение уже обработано');
}

async function acceptReport(actor, reportId) {
  await assertTriagable(actor, reportId);
  await triageUpdate(
    "UPDATE feedback_reports SET status = 'accepted', reject_reason = NULL, triaged_by = ?, triaged_at = CURRENT_TIMESTAMP WHERE id = ?",
    [actorName(actor), reportId]
  );
  await logEvent(actor, 'report_accepted', { reportId });
  return getReport(reportId);
}

async function rejectReport(actor, reportId, reason) {
  await assertTriagable(actor, reportId);
  const text = requireText(reason, LIMITS.reason, 'Причина');
  await triageUpdate(
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

// Полная карточка кейса: обращения и журнал.
async function getCaseDetails(caseId) {
  const row = await getCaseRow(caseId);
  const reports = (await all('SELECT * FROM feedback_reports WHERE case_id = ? ORDER BY created_at ASC, id ASC', [caseId])).map(mapReport);
  const stats = { reports_count: reports.length, users_count: new Set(reports.map((r) => r.authorId)).size };
  const events = await all('SELECT * FROM feedback_events WHERE case_id = ? ORDER BY id DESC LIMIT 200', [caseId]);

  return {
    ...mapCase(row, stats),
    reports,
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

// Вторая линия дополняет кейс, пока по нему нет решения — и на доработке,
// и уже на третьей линии (новые дубли, факты, уточнения).
async function assertCaseEditable(caseId) {
  const row = await getCaseRow(caseId);
  if (!UNDECIDED_CASE_STATUSES.includes(row.status)) throw httpError(409, 'По кейсу уже принято решение — менять его нельзя');
  return row;
}

// Привязать обращения к кейсу только если они всё ещё свободны: второй
// модератор, успевший раньше, не теряет свою привязку.
async function linkReports(caseId, ids) {
  const result = await run(
    `UPDATE feedback_reports SET case_id = ?
     WHERE id IN (${ids.map(() => '?').join(',')}) AND case_id IS NULL AND status = 'accepted'`,
    [caseId, ...ids]
  );
  return result.changes === ids.length;
}

// Обращение можно добавить в кейс, только если оно прошло первую линию, ещё
// не лежит в другом кейсе и того же типа; жалобы на статьи — ещё и только
// на одну и ту же статью (articleSlug — статья кейса, если он уже есть).
async function loadAttachableReports(reportIds, type, articleSlug) {
  const ids = [...new Set((reportIds || []).map(toId).filter(Boolean))];
  if (!ids.length) throw httpError(400, 'Выберите хотя бы одно обращение');
  const rows = await all(`SELECT * FROM feedback_reports WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  if (rows.length !== ids.length) throw httpError(404, 'Часть обращений не найдена');
  rows.forEach((r) => {
    if (r.status !== 'accepted') throw httpError(409, `Обращение #${r.id} ещё не прошло первую линию`);
    if (r.case_id) throw httpError(409, `Обращение #${r.id} уже входит в кейс #${r.case_id}`);
    if (type && r.type !== type) throw httpError(409, `Обращение #${r.id} другого типа — в одном кейсе обращения только одного типа`);
    if (articleSlug && r.article_slug !== articleSlug) throw httpError(409, `Жалоба #${r.id} на другую статью — в одном кейсе жалобы только на одну статью`);
  });
  const types = new Set(rows.map((r) => r.type));
  if (types.size > 1) throw httpError(409, 'Нельзя объединить в один кейс обращения разных типов');
  if (rows[0].type === 'article' && new Set(rows.map((r) => r.article_slug)).size > 1) {
    throw httpError(409, 'Нельзя объединить в один кейс жалобы на разные статьи');
  }
  return rows;
}

// Статья кейса жалоб — берётся из любого его обращения (все они на одну статью).
async function caseArticleSlug(caseId) {
  const row = await get('SELECT article_slug FROM feedback_reports WHERE case_id = ? AND article_slug IS NOT NULL LIMIT 1', [caseId]);
  return row ? row.article_slug : null;
}

async function escalateIfCritical(actor, caseId, severity) {
  if (severity !== CRITICAL_SEVERITY) return;
  const result = await run("UPDATE feedback_cases SET status = 'escalated', escalated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'open'", [caseId]);
  if (result.changes) await logEvent(actor, 'case_escalated', { caseId, details: 'Автоматически: критичность 4' });
}

// Собранный кейс сразу уходит на третью линию.
async function createCase(actor, input) {
  const rows = await loadAttachableReports(input.reportIds);
  const type = rows[0].type;
  const title = cleanText(input.title, LIMITS.title) || rows[0].title;
  const severity = cleanSeverity(input.severity) || 2;
  const summary = requireText(input.summary, LIMITS.summary, 'Суть проблемы');
  const comment = cleanText(input.comment, LIMITS.comment);

  const result = await run(
    `INSERT INTO feedback_cases (type, title, summary, comment, severity, status, escalated_at, created_by)
     VALUES (?, ?, ?, ?, ?, 'escalated', CURRENT_TIMESTAMP, ?)`,
    [type, title, summary, comment, severity, actorName(actor)]
  );
  const caseId = result.lastID;
  const ids = rows.map((r) => r.id);
  if (!(await linkReports(caseId, ids))) {
    await run('UPDATE feedback_reports SET case_id = NULL WHERE case_id = ?', [caseId]);
    await run('DELETE FROM feedback_cases WHERE id = ?', [caseId]);
    throw httpError(409, 'Часть обращений только что забрал в кейс другой модератор — обновите очередь');
  }
  await logEvent(actor, 'case_created', { caseId, details: `Обращения: ${ids.map((id) => '#' + id).join(', ')}` });
  await logEvent(actor, 'case_escalated', { caseId });
  return getCaseDetails(caseId);
}

async function updateCase(actor, caseId, input) {
  const row = await assertCaseEditable(caseId);
  const title = input.title !== undefined ? requireText(input.title, LIMITS.title, 'Название кейса') : row.title;
  const summary = input.summary !== undefined ? requireText(input.summary, LIMITS.summary, 'Суть проблемы') : row.summary;
  const comment = input.comment !== undefined ? cleanText(input.comment, LIMITS.comment) : row.comment;
  const severity = input.severity !== undefined ? (cleanSeverity(input.severity) || row.severity) : row.severity;

  await run(
    'UPDATE feedback_cases SET title = ?, summary = ?, comment = ?, severity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [title, summary, comment, severity, caseId]
  );
  const changes = [];
  if (title !== row.title) changes.push('название');
  if ((summary || '') !== (row.summary || '')) changes.push('суть');
  if ((comment || '') !== (row.comment || '')) changes.push('комментарий');
  if (severity !== row.severity) changes.push(`критичность ${row.severity} → ${severity}`);
  if (changes.length) await logEvent(actor, 'case_updated', { caseId, details: changes.join(', ') });
  if (severity !== row.severity) await escalateIfCritical(actor, caseId, severity);
  return getCaseDetails(caseId);
}

async function attachReports(actor, caseId, reportIds) {
  const row = await assertCaseEditable(caseId);
  const articleSlug = row.type === 'article' ? await caseArticleSlug(caseId) : null;
  const rows = await loadAttachableReports(reportIds, row.type, articleSlug);
  const ids = rows.map((r) => r.id);
  // Частичную привязку при гонке оставляем: каждое привязанное — в журнал.
  const complete = await linkReports(caseId, ids);
  const linked = (await all(`SELECT id FROM feedback_reports WHERE case_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [caseId, ...ids])).map((r) => r.id);
  await run('UPDATE feedback_cases SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [caseId]);
  for (const id of linked) await logEvent(actor, 'report_attached', { caseId, reportId: id });
  if (!complete) throw httpError(409, 'Часть обращений только что забрал в кейс другой модератор — обновите очередь');
  return getCaseDetails(caseId);
}

// Отвязать ошибочно объединённое обращение — оно возвращается в очередь
// второй линии.
async function detachReport(actor, caseId, reportId) {
  await assertCaseEditable(caseId);
  const report = await getReport(reportId);
  if (!report || report.caseId !== Number(caseId)) throw httpError(404, 'Обращение не входит в этот кейс');
  const count = await get('SELECT COUNT(*) as cnt FROM feedback_reports WHERE case_id = ?', [caseId]);
  if (count.cnt <= 1) throw httpError(409, 'Это последнее обращение кейса — кейс без обращений не имеет смысла');

  await run('UPDATE feedback_reports SET case_id = NULL WHERE id = ?', [reportId]);
  await run('UPDATE feedback_cases SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [caseId]);
  await logEvent(actor, 'report_detached', { caseId, reportId: report.id });
  return getCaseDetails(caseId);
}

// Доработанный (возвращённый третьей линией) кейс — обратно на решение.
async function escalateCase(actor, caseId) {
  const row = await getCaseRow(caseId);
  if (row.status !== 'open') throw httpError(409, 'Кейс уже на третьей линии или решён');
  const result = await run("UPDATE feedback_cases SET status = 'escalated', escalated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'open'", [caseId]);
  if (!result.changes) throw httpError(409, 'Кейс уже на третьей линии или решён');
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
  // Принятый кейс ещё не выполнен — он «в работе», пока его не завершат
  // (completeCase). Отклонённый решён сразу.
  const status = decision === 'accepted' ? 'accepted' : 'resolved';
  const result = await run(
    `UPDATE feedback_cases SET status = ?, decision = ?, decision_text = ?, decided_by = ?,
       decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'escalated'`,
    [status, decision, text, actorName(actor), caseId]
  );
  if (!result.changes) throw httpError(409, 'Кейс уже решён или возвращён на доработку');
  await logEvent(actor, 'case_decided', { caseId, details: `${decision === 'accepted' ? 'Принято' : 'Отклонено'}: ${text.slice(0, 300)}` });
  return getCaseDetails(caseId);
}

// Принятый кейс сделан — завершить. comment (по желанию) увидят авторы.
async function completeCase(actor, caseId, comment) {
  const row = await getCaseRow(caseId);
  if (row.status !== 'accepted') throw httpError(409, 'Завершить можно только принятый кейс, который ещё в работе');
  const text = cleanText(comment, LIMITS.decision);
  const result = await run(
    `UPDATE feedback_cases SET status = 'resolved', completion_text = ?, completed_by = ?,
       completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'accepted'`,
    [text, actorName(actor), caseId]
  );
  if (!result.changes) throw httpError(409, 'Кейс уже завершён');
  await logEvent(actor, 'case_completed', { caseId, details: text ? text.slice(0, 300) : null });
  return getCaseDetails(caseId);
}

async function returnCase(actor, caseId, comment) {
  const row = await getCaseRow(caseId);
  if (row.status !== 'escalated') throw httpError(409, 'Вернуть на доработку можно только кейс, переданный на третью линию');
  const text = requireText(comment, LIMITS.reason, 'Что доработать');
  const result = await run("UPDATE feedback_cases SET status = 'open', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'escalated'", [caseId]);
  if (!result.changes) throw httpError(409, 'Кейс уже решён или возвращён на доработку');
  await logEvent(actor, 'case_returned', { caseId, details: text });
  return getCaseDetails(caseId);
}

// ---------- Счётчики для бейджей и ссылки для очистки uploads ----------

async function countQueues() {
  const row = await get(
    `SELECT
       (SELECT COUNT(*) FROM feedback_reports WHERE status = 'new') as triage,
       (SELECT COUNT(*) FROM feedback_reports WHERE status = 'accepted' AND case_id IS NULL) as unassigned,
       (SELECT COUNT(*) FROM feedback_cases WHERE status = 'escalated') as escalated,
       (SELECT COUNT(*) FROM feedback_cases WHERE status = 'open') as returned`
  );
  return row || { triage: 0, unassigned: 0, escalated: 0, returned: 0 };
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
  createReport,
  getReport,
  updateOwnReport,
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
  escalateCase,
  archiveCase,
  decideCase,
  completeCase,
  returnCase,
  countQueues,
  listAttachmentUrls
};
