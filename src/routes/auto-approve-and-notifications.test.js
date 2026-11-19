// src/routes/auto-approve-and-notifications.test.js
require('../config/env');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../middleware/auth');
const userNotifications = require('../services/user-notifications');
const { readSettings, writeSettings } = require('../services/system-settings');
const search = require('../services/article-search');

describe('Auto-approve registration, user join log, admin notifications, and exact search', () => {
  let initialSettings;

  before(() => {
    initialSettings = readSettings();
  });

  after(() => {
    if (initialSettings) {
      writeSettings(initialSettings);
    }
  });

  test('autoApproveRegistration setting is persisted in system-settings', () => {
    writeSettings({ autoApproveRegistration: true });
    assert.equal(readSettings().autoApproveRegistration, true);

    writeSettings({ autoApproveRegistration: false });
    assert.equal(readSettings().autoApproveRegistration, false);
  });

  test('registration with autoApproveRegistration=true creates approved user and logs into user_join_log', async () => {
    writeSettings({ autoApproveRegistration: true });
    const suffix = Date.now().toString().slice(-6);
    const unique = `u_auto_${suffix}`;
    const regResult = await auth.register(unique, `Auto ${suffix}`, 'password123', { autoApprove: true });

    assert.equal(regResult.status, 'approved');
    assert.equal(regResult.username, unique);

    // Can log in right away
    const loginUser = await auth.login(unique, 'password123');
    assert.equal(loginUser.status, 'approved');

    // Check join log
    const log = await auth.getUserJoinLog(20);
    const logEntry = log.find((item) => item.username === unique);
    assert.ok(logEntry, 'User must be present in user_join_log');
    assert.equal(logEntry.auto_approved, 1);
  });

  test('manual approval records entry in user_join_log with auto_approved=0', async () => {
    const suffix = (Date.now() + 1).toString().slice(-6);
    const unique = `u_man_${suffix}`;
    const regResult = await auth.register(unique, `Manual ${suffix}`, 'password123', { autoApprove: false });
    assert.equal(regResult.status, 'pending');

    await auth.approveUser(regResult.id, 'admin_tester');

    const log = await auth.getUserJoinLog(20);
    const logEntry = log.find((item) => item.username === unique);
    assert.ok(logEntry, 'Approved user must be present in user_join_log');
    assert.equal(logEntry.auto_approved, 0);
  });

  test('admin notification for pending registration is created and clears after reading', async () => {
    const rootUser = (await auth.getAllUsers()).find((u) => u.is_root);
    assert.ok(rootUser, 'Root user must exist');

    const unreadBefore = await userNotifications.countUnread(rootUser.id);

    await auth.notifyAdminsWithPermission('manage_pending_users', {
      type: 'admin_pending_user',
      actorId: 99999,
      actorName: 'Заявитель',
      targetType: 'pending_user',
      targetId: '99999',
      targetTitle: 'applicant_login',
      excerpt: 'Новая заявка на регистрацию'
    });

    const unreadAfter = await userNotifications.countUnread(rootUser.id);
    assert.equal(unreadAfter, unreadBefore + 1, 'Unread count should increase by 1');

    const list = await userNotifications.list(rootUser.id, 10);
    const notif = list.find((n) => n.type === 'admin_pending_user' && n.targetId === '99999');
    assert.ok(notif, 'Notification should be in user notifications list');
    assert.equal(notif.read, false);

    // Mark read
    await userNotifications.markRead(rootUser.id, [notif.id]);
    const unreadFinal = await userNotifications.countUnread(rootUser.id);
    assert.equal(unreadFinal, unreadBefore, 'Unread count should decrease back after reading');
  });

  test('admin notification for feedback report is created and clears after reading', async () => {
    const rootUser = (await auth.getAllUsers()).find((u) => u.is_root);
    assert.ok(rootUser, 'Root user must exist');

    const unreadBefore = await userNotifications.countUnread(rootUser.id);

    await auth.notifyAdminsWithPermission(['feedback_triage', 'feedback_cases', 'feedback_decide'], {
      type: 'admin_feedback',
      actorId: 88888,
      actorName: 'Пользователь',
      targetType: 'feedback',
      targetId: '88888',
      targetTitle: 'Баг в интерфейсе',
      excerpt: 'Кнопка не нажимается'
    });

    const unreadAfter = await userNotifications.countUnread(rootUser.id);
    assert.equal(unreadAfter, unreadBefore + 1, 'Unread count should increase by 1');

    const list = await userNotifications.list(rootUser.id, 10);
    const notif = list.find((n) => n.type === 'admin_feedback' && n.targetId === '88888');
    assert.ok(notif, 'Notification should be in user notifications list');
    assert.equal(notif.read, false);

    // Mark all read
    await userNotifications.markRead(rootUser.id, 'all');
    const unreadFinal = await userNotifications.countUnread(rootUser.id);
    assert.equal(unreadFinal, 0, 'Unread count should be 0 after marking all read');
  });

  test('exact search with «Поэт» or "Поэт" strictly excludes "поэтому"', () => {
    for (const q of ['«Поэт»', '"Поэт"', '“Поэт”']) {
      const parsed = search.parseSearchQuery(q);
      assert.deepEqual(parsed.exactPhrases, ['поэт']);

      // Title or content with "поэтому" should NOT match
      const score1 = search.scoreArticleText('Поэтому солнце всходит на востоке', 'Какой-то текст...', parsed);
      const score2 = search.scoreArticleText('Научная статья', 'И поэтому эксперимент завершился успехом.', parsed);
      assert.equal(score1, 0);
      assert.equal(score2, 0);

      // Title or content with "Поэт" SHOULD match
      const score3 = search.scoreArticleText('Поэт серебряного века', 'Текст...', parsed);
      const score4 = search.scoreArticleText('Биография', 'Великий поэт написал эту оду.', parsed);
      assert.ok(score3 > 0);
      assert.ok(score4 > 0);
    }
  });
});
