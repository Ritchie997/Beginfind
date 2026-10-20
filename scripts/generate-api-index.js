const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const routesDir = path.join(root, 'src', 'routes');
const outputFile = path.join(root, 'docs', 'agent-context', 'API_INDEX.md');
const routeFiles = fs.readdirSync(routesDir)
  .filter((name) => name.endsWith('.routes.js') && name !== 'pages.routes.js')
  .sort();
const routePattern = /\brouter\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;

const lines = [
  '# Индекс API',
  '',
  'Пути указаны относительно `/api`: все перечисленные router-модули монтируются',
  'в `src/server.js` под этим префиксом. Это индекс объявленных маршрутов, а не',
  'спецификация запросов, ответов или доступа.',
  '',
  'Параметры `:id`, `:slug` и т. п. — path parameters. Авторизация и права',
  'проверяются на уровне отдельных обработчиков: перед изменением endpoint',
  'прочитайте middleware и handler в указанном файле, не делайте вывод по',
  'соседнему маршруту.',
  '',
  'Сгенерировано из строковых `router.get/post/put/patch/delete` объявлений',
  'командой `npm run docs:api-index`. `pages.routes.js` исключён: он обслуживает',
  'страницы SPA и fallback, а не API. Маршруты, заданные динамически, необходимо',
  'документировать отдельно.',
  ''
];

let count = 0;
for (const file of routeFiles) {
  const source = fs.readFileSync(path.join(routesDir, file), 'utf8');
  const entries = [...source.matchAll(routePattern)]
    .map(([, method, , route]) => `- \`${method.toUpperCase()} ${route}\``);
  if (!entries.length) continue;
  lines.push(`## \`${file}\``, '', ...entries, '');
  count += entries.length;
}

if (!count) throw new Error('No API route declarations found; refusing to write an empty index.');
fs.writeFileSync(outputFile, `${lines.join('\n').trimEnd()}\n`);
console.log(`Wrote ${count} routes to ${path.relative(root, outputFile)}.`);
