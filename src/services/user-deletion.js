const fs = require('fs');
const path = require('path');
const articleStore = require('./articles-store');
const galleryStore = require('./gallery-store');
const mapsStore = require('./maps-store');
const stickersStore = require('./stickers-store');
const {
  messengerDb,
  serversDb,
  bookmarksDb,
  draftsDb,
  socialDb,
  stickersDb,
  feedbackDb,
  galleryDb
} = require('../db/connections');
const { UPLOADS_DIR } = require('../config/paths');

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

function uploadPathsIn(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const found = new Set();
  const pattern = /(?:^|[^A-Za-z0-9+.-])(\/uploads\/[A-Za-z0-9._/-]+)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const relative = match[1].slice('/uploads/'.length).split('/').filter(Boolean);
    if (!relative.length || relative.some((part) => part === '.' || part === '..')) continue;
    if (['gallery', 'maps', 'stickers', 'avatar'].includes(relative[0])) continue;
    const filePath = path.resolve(UPLOADS_DIR, ...relative);
    const root = path.resolve(UPLOADS_DIR) + path.sep;
    if (filePath.startsWith(root)) found.add(filePath);
  }
  return found;
}

async function deleteAllUserData(user, actingUserId, otherUsers) {
  const userId = Number(user.id);
  const sameNameAccounts = otherUsers.filter((item) =>
    Number(item.id) !== userId && item.display_name === user.display_name
  );
  const legacyNames = new Set([user.username]);
  if (!sameNameAccounts.length) legacyNames.add(user.display_name);
  const articles = articleStore.listArticles();
  const ownedArticles = articles.filter((article) =>
    Number(article.author_id) === userId ||
    legacyNames.has(article.legacyAuthorName)
  );
  const ownedSlugs = ownedArticles.map((article) => article.slug);
  const articleUploadPaths = new Set(ownedArticles.flatMap((article) => [...uploadPathsIn(article)]));
  const retainedUploadPaths = new Set(
    articles
      .filter((article) => !ownedSlugs.includes(article.slug))
      .flatMap((article) => [...uploadPathsIn(article)])
  );
  const commentRows = ownedSlugs.length
    ? await all(
      socialDb,
      `SELECT id FROM article_comments WHERE user_id = ? OR article_slug IN (${ownedSlugs.map(() => '?').join(',')})
       OR parent_id IN (SELECT id FROM article_comments WHERE user_id = ?)`,
      [userId, ...ownedSlugs, userId]
    )
    : await all(
      socialDb,
      'SELECT id FROM article_comments WHERE user_id = ? OR parent_id IN (SELECT id FROM article_comments WHERE user_id = ?)',
      [userId, userId]
    );
  const commentIds = commentRows.map((row) => String(row.id));
  const workRows = await all(galleryDb, 'SELECT id FROM gallery_works WHERE author_id = ?', [userId]);
  const workIds = workRows.map((row) => row.id);
  const galleryCommentRows = workIds.length
    ? await all(
      galleryDb,
      `SELECT id FROM gallery_comments WHERE user_id = ? OR work_id IN (${workIds.map(() => '?').join(',')})
       OR parent_id IN (SELECT id FROM gallery_comments WHERE user_id = ?)`,
      [userId, ...workIds, userId]
    )
    : await all(
      galleryDb,
      'SELECT id FROM gallery_comments WHERE user_id = ? OR parent_id IN (SELECT id FROM gallery_comments WHERE user_id = ?)',
      [userId, userId]
    );
  const galleryCommentIds = galleryCommentRows.map((row) => String(row.id));
  const reports = await all(feedbackDb, 'SELECT id, attachments FROM feedback_reports WHERE author_id = ?', [userId]);
  const reportIds = reports.map((row) => row.id);
  const otherReports = await all(feedbackDb, 'SELECT attachments FROM feedback_reports WHERE author_id != ?', [userId]);
  const reportUploadPaths = new Set(reports.flatMap((report) => [...uploadPathsIn(report.attachments)]));
  const retainedReportUploadPaths = new Set(otherReports.flatMap((report) => [...uploadPathsIn(report.attachments)]));
  retainedReportUploadPaths.forEach((filePath) => retainedUploadPaths.add(filePath));
  reportUploadPaths.forEach((filePath) => articleUploadPaths.add(filePath));
  const packs = await stickersStore.listPacksByAuthor(userId, true);
  const maps = mapsStore.listMaps();
  const ownedMaps = maps.filter((map) => Number(map.author_id) === userId);

  for (const article of ownedArticles) articleStore.permanentlyDeleteArticle(article.slug);
  for (const filePath of articleUploadPaths) {
    if (retainedUploadPaths.has(filePath)) continue;
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const article of articles) {
    if (ownedSlugs.includes(article.slug) || !article.co_author_ids.includes(userId)) continue;
    articleStore.updateArticle(article.slug, {
      co_author_ids: article.co_author_ids.filter((id) => id !== userId)
    });
  }
  for (const row of workRows) await galleryStore.deleteWork(row.id);
  if (ownedSlugs.length) {
    const remainingWorks = await all(galleryDb, 'SELECT id, article_slugs FROM gallery_works');
    for (const work of remainingWorks) {
      let slugs;
      try { slugs = JSON.parse(work.article_slugs || '[]'); } catch (error) { continue; }
      if (!Array.isArray(slugs) || !slugs.some((slug) => ownedSlugs.includes(slug))) continue;
      await run(galleryDb, 'UPDATE gallery_works SET article_slugs = ? WHERE id = ?', [
        JSON.stringify(slugs.filter((slug) => !ownedSlugs.includes(slug))),
        work.id
      ]);
    }
  }
  for (const map of ownedMaps) mapsStore.deleteMap(map.id);
  for (const map of maps) {
    if (ownedMaps.some((owned) => String(owned.id) === String(map.id)) || !map.co_author_ids.includes(userId)) continue;
    await mapsStore.updateMap(map.id, (current) => ({
      ...current,
      co_author_ids: current.co_author_ids.filter((id) => id !== userId)
    }));
  }
  for (const pack of packs) await stickersStore.deletePack(pack.id);

  if (ownedSlugs.length) {
    const marks = ownedSlugs.map(() => '?').join(',');
    await run(socialDb, `DELETE FROM article_likes WHERE article_slug IN (${marks})`, ownedSlugs);
    await run(socialDb, `DELETE FROM article_views WHERE article_slug IN (${marks})`, ownedSlugs);
    await run(socialDb, `DELETE FROM article_comments WHERE article_slug IN (${marks})`, ownedSlugs);
    await run(socialDb, `DELETE FROM reactions WHERE target_type = 'article' AND target_id IN (${marks})`, ownedSlugs);
    await run(socialDb, `DELETE FROM user_notifications WHERE target_type = 'article' AND target_id IN (${marks})`, ownedSlugs);
  }
  if (commentIds.length) {
    const marks = commentIds.map(() => '?').join(',');
    await run(socialDb, `DELETE FROM reactions WHERE target_type = 'comment' AND target_id IN (${marks})`, commentIds);
    await run(
      socialDb,
      `DELETE FROM user_notifications WHERE target_type = 'article' AND comment_id IN (${marks})`,
      commentIds
    );
  }
  await run(socialDb, 'DELETE FROM article_likes WHERE user_id = ?', [userId]);
  await run(socialDb, 'DELETE FROM article_views WHERE user_id = ?', [userId]);
  await run(
    socialDb,
    'DELETE FROM article_comments WHERE user_id = ? OR parent_id IN (SELECT id FROM article_comments WHERE user_id = ?)',
    [userId, userId]
  );
  await run(socialDb, 'DELETE FROM reactions WHERE user_id = ?', [userId]);
  await run(socialDb, 'DELETE FROM notification_seen WHERE user_id = ?', [userId]);
  await run(socialDb, 'DELETE FROM user_notifications WHERE user_id = ? OR actor_id = ?', [userId, userId]);

  if (workIds.length) {
    const marks = workIds.map(() => '?').join(',');
    await run(galleryDb, `DELETE FROM gallery_comments WHERE work_id IN (${marks})`, workIds);
    await run(galleryDb, `DELETE FROM gallery_likes WHERE work_id IN (${marks})`, workIds);
    await run(galleryDb, `DELETE FROM gallery_views WHERE work_id IN (${marks})`, workIds);
    await run(socialDb, `DELETE FROM reactions WHERE target_type = 'gallery' AND target_id IN (${marks})`, workIds.map(String));
    await run(socialDb, `DELETE FROM user_notifications WHERE target_type = 'gallery' AND target_id IN (${marks})`, workIds.map(String));
  }
  if (galleryCommentIds.length) {
    const marks = galleryCommentIds.map(() => '?').join(',');
    await run(socialDb, `DELETE FROM reactions WHERE target_type = 'gallery_comment' AND target_id IN (${marks})`, galleryCommentIds);
    await run(
      socialDb,
      `DELETE FROM user_notifications WHERE target_type = 'gallery' AND comment_id IN (${marks})`,
      galleryCommentIds
    );
  }
  await run(galleryDb, 'DELETE FROM gallery_likes WHERE user_id = ?', [userId]);
  await run(galleryDb, 'DELETE FROM gallery_views WHERE user_id = ?', [userId]);
  await run(
    galleryDb,
    'DELETE FROM gallery_comments WHERE user_id = ? OR parent_id IN (SELECT id FROM gallery_comments WHERE user_id = ?)',
    [userId, userId]
  );

  await run(bookmarksDb, 'DELETE FROM bookmarks WHERE user_id = ?', [userId]);
  await run(draftsDb, 'DELETE FROM drafts WHERE user_id = ?', [userId]);
  await run(draftsDb, 'DELETE FROM draft_folders WHERE user_id = ?', [userId]);

  if (reportIds.length) {
    const marks = reportIds.map(() => '?').join(',');
    const facts = await all(feedbackDb, 'SELECT id, source_report_ids FROM feedback_case_facts');
    for (const fact of facts) {
      let sources;
      try { sources = JSON.parse(fact.source_report_ids || '[]'); } catch (error) { continue; }
      if (!Array.isArray(sources)) continue;
      const remaining = sources.filter((id) => !reportIds.includes(Number(id)));
      if (remaining.length === sources.length) continue;
      if (remaining.length) {
        await run(feedbackDb, 'UPDATE feedback_case_facts SET source_report_ids = ? WHERE id = ?', [JSON.stringify(remaining), fact.id]);
      } else {
        await run(feedbackDb, 'DELETE FROM feedback_case_facts WHERE id = ?', [fact.id]);
      }
    }
    await run(feedbackDb, `DELETE FROM feedback_comments WHERE report_id IN (${marks})`, reportIds);
    await run(feedbackDb, `DELETE FROM feedback_events WHERE report_id IN (${marks})`, reportIds);
    await run(feedbackDb, `DELETE FROM feedback_reports WHERE id IN (${marks})`, reportIds);
  }
  await run(feedbackDb, 'DELETE FROM feedback_comments WHERE author_id = ?', [userId]);
  await run(feedbackDb, 'DELETE FROM feedback_events WHERE actor_id = ?', [userId]);

  await run(stickersDb, 'DELETE FROM sticker_favorites WHERE user_id = ?', [userId]);
  await run(stickersDb, 'DELETE FROM sticker_subscriptions WHERE user_id = ?', [userId]);
  await run(stickersDb, 'DELETE FROM sticker_pack_coauthors WHERE user_id = ?', [userId]);
  await stickersStore.deleteCollabsByProposer(userId);

  await run(serversDb, 'UPDATE servers SET owner_id = ? WHERE owner_id = ?', [actingUserId, userId]);
  await run(serversDb, 'DELETE FROM user_server_role_assignments WHERE user_id = ?', [userId]);
  await run(serversDb, 'DELETE FROM user_server_memberships WHERE user_id = ?', [userId]);
  await run(serversDb, 'DELETE FROM server_audit_log WHERE actor_id = ?', [userId]);

  const warnings = [];
  if (sameNameAccounts.length) {
    warnings.push('Некоторые исторические записи с совпадающим отображаемым именем невозможно однозначно приписать аккаунту.');
  }
  let messagesDeleted = 0;
  if (sameNameAccounts.length) {
    warnings.push('Сообщения не удалены: отображаемое имя совпадает с именем другого пользователя.');
  } else {
    messagesDeleted = await run(messengerDb, 'DELETE FROM messages WHERE sender = ?', [user.display_name || user.username]);
    warnings.push('Сообщения с прежними отображаемыми именами нельзя сопоставить с аккаунтом.');
  }
  return {
    deletedArticles: ownedArticles.length,
    deletedGalleryWorks: workRows.length,
    deletedMessages: messagesDeleted,
    deletedMaps: ownedMaps.length,
    deletedStickerPacks: packs.length,
    warnings
  };
}

async function transferPreservedContent(sourceId, sourceNames, targetUser) {
  const legacyNames = new Set(sourceNames.filter(Boolean));
  const articles = articleStore.listArticles();
  let transferredArticles = 0;
  for (const article of articles) {
    const owns = Number(article.author_id) === Number(sourceId) || legacyNames.has(article.legacyAuthorName);
    const coAuthors = article.co_author_ids || [];
    if (!owns && !coAuthors.includes(Number(sourceId))) continue;

    let nextCoAuthors = coAuthors.filter((id) => id !== Number(sourceId));
    if (owns) nextCoAuthors = nextCoAuthors.filter((id) => id !== Number(targetUser.id));
    if (!owns && Number(article.author_id) !== Number(targetUser.id) && !nextCoAuthors.includes(Number(targetUser.id))) {
      nextCoAuthors.push(Number(targetUser.id));
    }
    if (!owns && Number(article.author_id) === Number(targetUser.id)) {
      nextCoAuthors = nextCoAuthors.filter((id) => id !== Number(targetUser.id));
    }
    articleStore.updateArticle(article.slug, {
      author_id: owns ? Number(targetUser.id) : article.author_id,
      co_author_ids: nextCoAuthors
    });
    transferredArticles += 1;
  }
  const transferredWorks = await galleryStore.transferWorksByAuthor(
    Number(sourceId),
    Number(targetUser.id),
    targetUser.display_name || targetUser.username
  );
  return { transferredArticles, transferredWorks };
}

module.exports = { deleteAllUserData, transferPreservedContent };
