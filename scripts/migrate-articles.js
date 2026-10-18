// Полная перезапись статей в актуальном формате (то же, что кнопка
// "Обновить формат статей" в настройках). Идемпотентно: файлы, которые уже
// в актуальном формате, не трогаются.
//
// Запуск:  node scripts/migrate-articles.js --dry      (только показать, что изменится)
//          node scripts/migrate-articles.js            (применить; оригиналы — в backups/articles-migration/)
//          node scripts/migrate-articles.js --inherit-layer-cover      (записать обложку статьи в слои без обложки)
//          node scripts/migrate-articles.js some-slug other-slug       (только указанные статьи)

const { runMigration } = require('../src/services/article-migrate');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const inheritLayerCover = args.includes('--inherit-layer-cover');
const slugs = args.filter((a) => !a.startsWith('--'));

const report = runMigration({ dryRun, inheritLayerCover, slugs: slugs.length ? slugs : null });

for (const item of report.items) {
  console.log(`\n${item.slug} — ${item.title}`);
  item.changes.forEach((c) => console.log(`  ${dryRun ? '[dry] ' : ''}• ${c}`));
  item.warnings.forEach((w) => console.log(`  ! ${w}`));
}
for (const f of report.failures) console.error(`\nОшибка в ${f.slug}: ${f.error}`);

console.log(`\n${dryRun ? 'Нужно обновить' : 'Обновлено'}: ${report.changed} из ${report.total}, без изменений: ${report.unchanged}, ошибок: ${report.failed}`);
if (report.backupDir) console.log(`Оригиналы сохранены в ${report.backupDir}`);
process.exit(report.failed ? 1 : 0);
