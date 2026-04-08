const https = require('https');
require('dotenv').config();

// Ваши данные DuckDNS
const token = process.env.DUCKDNS_TOKEN; // ваш токен будет в .env файле
const domain = 'beginfind'; // ваш поддомен DuckDNS

if (!token) {
  console.error('Ошибка: Отсутствует токен DuckDNS в файле .env');
  console.error('Добавьте DUCKDNS_TOKEN=ваш_токен_в .env файл');
  process.exit(1);
}

const url = `https://www.duckdns.org/update?domains=${domain}&token=${token}&ip=`;

function updateDuckDNS() {
  https.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      console.log(`[${new Date().toISOString()}] DuckDNS update response:`, data.trim());
    });
  }).on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Error updating DuckDNS:`, err.message);
  });
}

// Обновляем IP при запуске и каждые 5 минут
console.log(`[${new Date().toISOString()}] Запуск обновления IP-адреса DuckDNS для ${domain}.duckdns.org...`);
updateDuckDNS();
setInterval(updateDuckDNS, 5 * 60 * 1000); // Обновление каждые 5 минут

module.exports = { updateDuckDNS };