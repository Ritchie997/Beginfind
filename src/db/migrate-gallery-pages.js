// migrate-gallery-pages.js — первая версия Галереи хранила "вариации" на
// уровне работы (gallery_variants), а страницы — внутри вариации. Теперь
// наоборот: страницы работы (gallery_pages), у страницы — вариации
// (gallery_images.page_id/name/roles). Перенос: i-я картинка каждой старой
// вариации становится вариацией i-й страницы с именем старой вариации.
// id картинок сохраняются — на них ссылаются арты, пересланные в статьи.
//
// Вызывается из src/db/connections.js, только если найдена старая схема
// (gallery_images с колонкой variant_id переименована в gallery_images_legacy).

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (err) {
    if (err) reject(err);
    else resolve({ lastID: this.lastID });
  }));
}

async function migrateGalleryToPages(db) {
  const variants = await all(db, 'SELECT * FROM gallery_variants ORDER BY work_id, position, id');
  const images = await all(db, 'SELECT * FROM gallery_images_legacy ORDER BY position, id');
  const imagesByVariant = new Map();
  images.forEach((img) => {
    if (!imagesByVariant.has(img.variant_id)) imagesByVariant.set(img.variant_id, []);
    imagesByVariant.get(img.variant_id).push(img);
  });
  const variantsByWork = new Map();
  variants.forEach((v) => {
    if (!variantsByWork.has(v.work_id)) variantsByWork.set(v.work_id, []);
    variantsByWork.get(v.work_id).push(v);
  });

  await run(db, 'BEGIN');
  try {
    for (const [workId, workVariants] of variantsByWork) {
      const lists = workVariants.map((v) => ({ name: v.name, images: imagesByVariant.get(v.id) || [] }));
      const pagesCount = Math.max(0, ...lists.map((l) => l.images.length));
      for (let i = 0; i < pagesCount; i++) {
        const { lastID: pageId } = await run(db, 'INSERT INTO gallery_pages (work_id, position) VALUES (?, ?)', [workId, i]);
        let position = 0;
        for (const list of lists) {
          const img = list.images[i];
          if (!img) continue;
          await run(db,
            `INSERT INTO gallery_images (id, work_id, page_id, name, roles, file_url, thumb_url, width, height, is_animated, position, created_at)
             VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?)`,
            [img.id, workId, pageId, list.name || '', img.file_url, img.thumb_url, img.width, img.height, img.is_animated, position++, img.created_at]
          );
        }
      }
    }
    await run(db, 'DROP TABLE gallery_images_legacy');
    await run(db, 'DROP TABLE gallery_variants');
    await run(db, 'COMMIT');
  } catch (err) {
    await run(db, 'ROLLBACK').catch(() => {});
    throw err;
  }
}

module.exports = { migrateGalleryToPages };
