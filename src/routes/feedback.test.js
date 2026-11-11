require('../config/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Socket } = require('node:net');
const express = require('express');
const feedbackRoutes = require('./feedback.routes');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', feedbackRoutes);
  return app;
}

function callApi(app, method, url, body, customHeaders = {}) {
  return new Promise((resolve) => {
    const payload = body !== undefined ? JSON.stringify(body) : '';
    const socket = new Socket();
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = url;
    req.headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      ...customHeaders
    };
    const res = new http.ServerResponse(req);
    let resBody = '';
    res.write = (chunk) => { if (chunk) resBody += chunk; };
    res.end = (chunk) => {
      if (chunk) resBody += chunk;
      socket.destroy();
      let parsed = {};
      try { parsed = JSON.parse(resBody); } catch (_) {}
      resolve({ status: res.statusCode, body: parsed, rawBody: resBody });
    };
    app(req, res);
    if (payload) req.push(payload);
    req.push(null);
  });
}

test('POST /api/feedback creates ticket for bug as guest', async () => {
  const app = createApp();
  const res = await callApi(app, 'POST', '/api/feedback', {
    category: 'bug',
    text: 'Кнопка не нажимается на главной странице',
    contact: 'guest@example.com'
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.id > 0);
  assert.equal(res.body.report.type, 'bug');
  assert.ok(res.body.report.title.includes('[Ошибка]'));
  assert.ok(res.body.report.description.includes('guest@example.com'));
});

test('POST /api/feedback creates ticket for general complaint without requiring article slug', async () => {
  const app = createApp();
  const res = await callApi(app, 'POST', '/api/feedback', {
    category: 'complaint',
    text: 'Очень медленно загружается страница галереи',
    contact: 'user@test.org'
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.id > 0);
  assert.equal(res.body.report.type, 'bug');
  assert.ok(res.body.report.title.includes('[Жалоба]'));
});

test('POST /api/feedback creates ticket for idea and question', async () => {
  const app = createApp();

  const resIdea = await callApi(app, 'POST', '/api/feedback', {
    category: 'idea',
    text: 'Добавьте темную тему в редактор',
    contact: 'idea@test.org'
  });
  assert.equal(resIdea.status, 200);
  assert.equal(resIdea.body.report.type, 'idea');
  assert.ok(resIdea.body.report.title.includes('[Идея]'));

  const resQ = await callApi(app, 'POST', '/api/feedback', {
    category: 'question',
    text: 'Как опубликовать свою статью?',
    contact: 'question@test.org'
  });
  assert.equal(resQ.status, 200);
  assert.equal(resQ.body.report.type, 'idea');
  assert.ok(resQ.body.report.title.includes('[Вопрос]'));
});

test('POST /api/feedback validates required fields', async () => {
  const app = createApp();

  // Missing text
  const resNoText = await callApi(app, 'POST', '/api/feedback', {
    category: 'bug',
    text: '   ',
    contact: 'test@test.org'
  });
  assert.equal(resNoText.status, 400);

  // Guest without contact
  const resNoContact = await callApi(app, 'POST', '/api/feedback', {
    category: 'bug',
    text: 'Некоторый текст'
  });
  assert.equal(resNoContact.status, 400);
});
