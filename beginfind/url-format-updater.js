// Скрипт для обновления функции форматирования URL
const fs = require('fs');
const path = require('path');

// Читаем файл index.js
const indexPath = path.join(__dirname, 'index.js');
let content = fs.readFileSync(indexPath, 'utf8');

// Обновляем функцию форматирования URL для лучшей поддержки доменов
const updatedContent = content.replace(
  /function formatImageUrl\(imagePath, req = null\) \{[\s\S]*?return baseUrl \+ normalizedPath;[\s\S]*?\n\}/,
  `function formatImageUrl(imagePath, req = null) {
    if (!imagePath) return null;
    
    // Если это уже полный URL (внешнее изображение), возвращаем как есть
    if (imagePath.startsWith('http')) {
      return imagePath;
    }
    
    // Убедимся, что путь начинается с '/', иначе добавляем
    let normalizedPath = imagePath;
    if (!imagePath.startsWith('/')) {
      normalizedPath = '/' + imagePath;
    }
    
    // Проверяем, есть ли заголовок X-Forwarded-Host (может использоваться с обратным прокси)
    if (req && req.get('X-Forwarded-Host')) {
      const protocol = req.get('X-Forwarded-Proto') || 'http';
      return \`\${protocol}://\${req.get('X-Forwarded-Host')}\${normalizedPath}\`;
    }
    
    // Для доступа через DuckDNS используем внешний домен
    // Получаем внешний хост из запроса, если доступен
    if (req && req.get('Host')) {
      const host = req.get('Host');
      if (host.includes('duckdns.org')) {
        return \`http://\${host}\${normalizedPath}\`;
      }
    }
    
    // Получаем IP-адрес сервера для формирования корректного URL
    // при доступе с разных устройств в сети
    const serverIP = getServerIP();
    const baseUrl = \`http://\${serverIP}:\${PORT}\`;
    return baseUrl + normalizedPath;
  }`
);

// Записываем обновленный файл
fs.writeFileSync(indexPath, updatedContent);
console.log('Файл index.js обновлен с улучшенной поддержкой доменов');