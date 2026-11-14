require('../config/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Socket } = require('node:net');
const express = require('express');
const uploadsRoutes = require('./uploads.routes');
const settingsRoutes = require('./settings.routes');
const { readSettings, writeSettings } = require('../services/system-settings');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', uploadsRoutes);
  app.use('/api', settingsRoutes);
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

test('upload limits and public system settings reflect dynamic maxFileSize configuration', async () => {
  const initialSettings = readSettings();
  const app = createApp();

  try {
    // 1. Устанавливаем 5 МБ
    writeSettings({ maxFileSize: 5 });

    let resUpload = await callApi(app, 'GET', '/api/upload-limits');
    assert.equal(resUpload.status, 200);
    assert.equal(resUpload.body.maxFileSize, 5);
    assert.equal(resUpload.body.maxImageSizeMb, 5);
    assert.equal(resUpload.body.maxImageSizeBytes, 5 * 1024 * 1024);

    let resPublic = await callApi(app, 'GET', '/api/system-settings/public');
    assert.equal(resPublic.status, 200);
    assert.equal(resPublic.body.maxFileSize, 5);
    assert.equal(resPublic.body.maxFileSizeBytes, 5 * 1024 * 1024);

    // 2. Меняем в админ-панели лимит на 20 МБ
    writeSettings({ maxFileSize: 20 });

    resUpload = await callApi(app, 'GET', '/api/upload-limits');
    assert.equal(resUpload.status, 200);
    assert.equal(resUpload.body.maxFileSize, 20);
    assert.equal(resUpload.body.maxImageSizeMb, 20);
    assert.equal(resUpload.body.maxImageSizeBytes, 20 * 1024 * 1024);

    resPublic = await callApi(app, 'GET', '/api/system-settings/public');
    assert.equal(resPublic.status, 200);
    assert.equal(resPublic.body.maxFileSize, 20);
    assert.equal(resPublic.body.maxFileSizeBytes, 20 * 1024 * 1024);
  } finally {
    writeSettings(initialSettings);
  }
});
