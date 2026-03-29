const https = require('https');
const http = require('http');
require('dotenv').config();

const token = process.env.DUCKDNS_TOKEN;
const domain = 'beginfind';

if (!token) {
  console.error('Ошибка: Отсутствует токен DuckDNS в файле .env');
  console.error('Добавьте DUCKDNS_TOKEN=ваш_токен_в .env файл');
  process.exit(1);
}

// Функция для получения текущего IP
function getCurrentIP() {
  return new Promise((resolve, reject) => {
    https.get('https://api.ipify.org', (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve(data.trim());
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

function updateDuckDNS() {
  const url = `https://www.duckdns.org/update?domains=${domain}&token=${token}&ip=`;
  
  https.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', async () => {
      console.log(`[${new Date().toISOString()}] DuckDNS update response:`, data.trim());
      
      // Выводим текущий IP для сравнения
      try {
        const currentIP = await getCurrentIP();
        console.log(`[${new Date().toISOString()}] Current external IP:`, currentIP);
        
        // Если обновление не прошло успешно (не OK), пытаемся снова
        if (data.trim() !== 'OK') {
          console.log(`[${new Date().toISOString()}] Update failed, will retry in 10 seconds`);
          setTimeout(updateDuckDNS, 10000);
        }
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Error getting current IP:`, err.message);
      }
    });
  }).on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Error updating DuckDNS:`, err.message);
  });
}

// Обновляем IP при запуске и каждые 1 минуту (так как IP меняется часто)
console.log(`[${new Date().toISOString()}] Запуск обновления IP-адреса DuckDNS для ${domain}.duckdns.org...`);
updateDuckDNS();
setInterval(updateDuckDNS, 60 * 1000); // Обновление каждую минуту