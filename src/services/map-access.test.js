require('../config/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const access = require('./map-access');

test('canDeleteMap permits root and author, denies random user', async () => {
  const map = { id: 'm_test_123', author_id: 42, serverId: 999999 };

  const rootUser = { id: 1, is_root: true };
  const authorUser = { id: 42, is_root: false };
  const randomUser = { id: 99, is_root: false };

  assert.equal(await access.canDeleteMap(rootUser, map), true);
  assert.equal(await access.canDeleteMap(authorUser, map), true);
  assert.equal(await access.canDeleteMap(randomUser, map), false);
});
