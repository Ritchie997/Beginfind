// Разовая (идемпотентная) правка: заменяет в content/*.json и content/.trash/*.json
// абсолютные адреса картинок со своего /uploads/ ("http://старый-хост/uploads/x.png")
// на относительные ("/uploads/x.png"). Файлы без таких адресов не трогаются.
//
// Запуск:  node scripts/normalize-image-urls.js          (применить)
//          node scripts/normalize-image-urls.js --dry    (только показать)

const fs = require('fs');
const path = require('path');
const { CONTENT_DIR } = require('../src/config/paths');
const blocks = require('../src/services/blocks');

const dry = process.argv.includes('--dry');
const rel = blocks.toRelativeUploadPath;

function fixDoc(doc) {
  if (!doc || !Array.isArray(doc.blocks)) return doc;
  return blocks.mapImages(doc, rel);
}

function processFile(filePath) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(`Пропущен (не читается): ${filePath}: ${e.message}`);
    return false;
  }
  if (!data || typeof data !== 'object') return false;

  const before = JSON.stringify(data);

  if (data.image) data.image = rel(data.image);
  if (data.content) data.content = fixDoc(data.content);
  if (Array.isArray(data.layers)) {
    data.layers = data.layers.map((l) => (l && typeof l === 'object'
      ? { ...l, image: l.image ? rel(l.image) : l.image, content: fixDoc(l.content) }
      : l));
  }

  if (JSON.stringify(data) === before) return false;
  if (!dry) fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return true;
}

let changed = 0;
for (const dir of [CONTENT_DIR, path.join(CONTENT_DIR, '.trash')]) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    if (processFile(full)) {
      changed++;
      console.log(`${dry ? '[dry] ' : ''}исправлено: ${path.relative(CONTENT_DIR, full)}`);
    }
  }
}
console.log(`${dry ? 'Нужно исправить' : 'Исправлено'} файлов: ${changed}`);
