// env.js — загружает .env из корня проекта и отдаёт настройки сервера.
const path = require('path');
const { ROOT_DIR } = require('./paths');

require('dotenv').config({ path: path.join(ROOT_DIR, '.env') });

module.exports = {
  PORT: process.env.PORT || 3002,
  HOST: process.env.HOST || '0.0.0.0'
};
