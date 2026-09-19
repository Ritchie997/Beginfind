// migrate-users-schema.js — идемпотентная миграция БД для системы
// владелец/роли админов/иерархия/мут (см. src/middleware/auth.js и
// scripts/make-owner.js).
//
// Столбцы users:
//   admin_level INTEGER DEFAULT 0 — кэш уровня иерархии (см. ниже), 0 =
//     обычный пользователь. Владелец (is_root=1) стоит вне этой шкалы и
//     всегда выше любого админа независимо от admin_level.
//   admin_role_id INTEGER — ссылка на admin_roles.id, какая именно роль
//     назначена пользователю (задаёт и уровень, и права). admin_level —
//     ДЕНОРМАЛИЗОВАННЫЙ кэш admin_roles.level этой роли, чтобы сравнения
//     иерархии (удаление статей, мут и т.д.) не требовали JOIN на каждый
//     запрос; синхронизируется при назначении роли пользователю и при
//     редактировании level самой роли — см. auth.syncAdminLevelForRole.
//   is_role_manager INTEGER DEFAULT 0 — «доверенный админ»: помимо
//     владельца, единственный (!) пользователь, которому разрешено
//     редактировать сам каталог ролей (создавать/переименовывать/удалять
//     роли, включать/выключать им права). Не даёт сам по себе никаких
//     операционных прав — это отдельная ось от admin_role_id.
//   muted_until DATETIME — временный мут (не путать с блокировкой):
//     до этого момента пользователь не может писать сообщения и
//     создавать/редактировать статьи (см. mute_reason).
//   mute_reason TEXT — причина мута.
//   bio TEXT — публичное описание пользователя в его профиле (страница
//     /profile/:id), пишет сам пользователь о себе, видно всем.
//   admin_note TEXT — приватная заметка админ-панели о пользователе (не
//     путать с bio!): видна и редактируется только теми, у кого есть право
//     view_users_tab, или владельцем — сам пользователь её не видит.
//
// Роль "заблокирован" отдельного столбца не получает — переиспользуется уже
// существующий users.status ('pending' | 'approved' | 'rejected' | 'blocked'),
// вместе с rejection_reason как причиной блокировки.
//
// Таблица admin_roles — гибкий конструктор именованных ролей админов
// (владелец и is_role_manager могут создавать любое количество ролей, не
// только три "стартовых"):
//   id, name (уникальное отображаемое имя, его же можно переименовывать),
//   level (число — чем больше, тем выше в иерархии), permissions (JSON:
//   см. PERMISSION_KEYS ниже — какие операции доступны обладателю роли).
//
// Безопасно вызывать при каждом старте сервера и из отдельных CLI-скриптов —
// перед ALTER TABLE проверяется текущий список столбцов через PRAGMA
// table_info, поэтому повторный вызов ничего не делает.

// Атомарные права, которые можно независимо включать/выключать у роли.
// is_root (владелец) имеет их все всегда, независимо от какой-либо роли.
// Доступ к самой странице "Настройки" сюда намеренно не входит — она
// закрыта на уровне auth.checkRoot и не выдаётся ни одной роли.
const PERMISSION_KEYS = [
  'view_users_tab',      // видеть вкладку "Пользователи" вообще
  'manage_pending_users', // одобрять/отклонять заявки на регистрацию
  'manage_admin_roles',  // назначать/менять/снимать роль у ДРУГИХ пользователей
  'block_users',         // блокировать/разблокировать аккаунты
  'rename_users',        // переименовывать других пользователей
  'mute_users',          // временно мутить пользователей ниже по рангу
  'moderate_stickers'    // подтверждать/отклонять наборы стикеров перед тем, как их можно использовать (см. src/services/stickers-store.js)
];

const DEFAULT_ROLES = [
  {
    name: 'Старший админ',
    level: 30,
    permissions: {
      view_users_tab: true,
      manage_pending_users: true,
      manage_admin_roles: true,
      block_users: true,
      rename_users: true,
      mute_users: true,
      moderate_stickers: true
    }
  },
  {
    name: 'Средний админ',
    level: 20,
    permissions: {
      view_users_tab: true,
      manage_pending_users: false,
      manage_admin_roles: false,
      block_users: false,
      rename_users: false,
      mute_users: true,
      moderate_stickers: false
    }
  },
  {
    name: 'Младший админ',
    level: 10,
    permissions: {
      view_users_tab: false,
      manage_pending_users: false,
      manage_admin_roles: false,
      block_users: false,
      rename_users: false,
      mute_users: false,
      moderate_stickers: false
    }
  }
];

function run(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => (err ? reject(err) : resolve()));
  });
}

// До введения каталога admin_roles права админа выдавались как голое число
// в users.admin_level (см. историю auth.setAdminLevel). Если к моменту этой
// миграции у кого-то уже стоит admin_level > 0, а admin_role_id ещё не
// назначен — это именно такой "старый" админ, и его нельзя молча превратить
// в обычного пользователя (вся остальная система прав/иерархии теперь
// смотрит только на admin_role_id). Для каждого встреченного уровня
// заводим отдельную роль-заглушку "Мигрированный ранг N" без единого
// включённого права (безопасный дефолт) и назначаем её — владелец увидит
// эти роли во вкладке "Роли" и сможет переименовать/перенастроить/объединить
// их с обычными ролями.
function migrateLegacyAdminLevels(db) {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT id, admin_level FROM users WHERE is_root = 0 AND admin_role_id IS NULL AND admin_level > 0',
      [],
      (err, rows) => {
        if (err) { reject(err); return; }
        if (!rows.length) { resolve(); return; }

        const levels = [...new Set(rows.map((r) => r.admin_level))];
        const emptyPermissions = {};
        PERMISSION_KEYS.forEach((key) => { emptyPermissions[key] = false; });

        const ensureRoleForLevel = (level) =>
          new Promise((res2, rej2) => {
            const roleName = `Мигрированный ранг ${level}`;
            db.get('SELECT id FROM admin_roles WHERE name = ?', [roleName], (getErr, existing) => {
              if (getErr) { rej2(getErr); return; }
              if (existing) { res2(existing.id); return; }
              db.run(
                'INSERT INTO admin_roles (name, level, permissions) VALUES (?, ?, ?)',
                [roleName, level, JSON.stringify(emptyPermissions)],
                function (insertErr) {
                  if (insertErr) rej2(insertErr);
                  else res2(this.lastID);
                }
              );
            });
          });

        Promise.all(levels.map((level) => ensureRoleForLevel(level)))
          .then((roleIds) => {
            const levelToRoleId = new Map(levels.map((level, i) => [level, roleIds[i]]));
            const updates = rows.map(
              (row) =>
                new Promise((res2, rej2) => {
                  db.run(
                    'UPDATE users SET admin_role_id = ? WHERE id = ?',
                    [levelToRoleId.get(row.admin_level), row.id],
                    (updateErr) => (updateErr ? rej2(updateErr) : res2())
                  );
                })
            );
            return Promise.all(updates);
          })
          .then(() => resolve())
          .catch(reject);
      }
    );
  });
}

function ensureUserSchema(db) {
  return new Promise((resolve, reject) => {
    db.all('PRAGMA table_info(users)', [], (err, columns) => {
      if (err) {
        reject(err);
        return;
      }

      const hasColumn = (name) => columns.some((c) => c.name === name);
      const statements = [];

      if (!hasColumn('admin_level')) {
        statements.push('ALTER TABLE users ADD COLUMN admin_level INTEGER DEFAULT 0');
      }
      if (!hasColumn('admin_role_id')) {
        statements.push('ALTER TABLE users ADD COLUMN admin_role_id INTEGER');
      }
      if (!hasColumn('is_role_manager')) {
        statements.push('ALTER TABLE users ADD COLUMN is_role_manager INTEGER DEFAULT 0');
      }
      if (!hasColumn('muted_until')) {
        statements.push('ALTER TABLE users ADD COLUMN muted_until DATETIME');
      }
      if (!hasColumn('mute_reason')) {
        statements.push('ALTER TABLE users ADD COLUMN mute_reason TEXT');
      }
      if (!hasColumn('bio')) {
        statements.push('ALTER TABLE users ADD COLUMN bio TEXT');
      }
      if (!hasColumn('admin_note')) {
        statements.push('ALTER TABLE users ADD COLUMN admin_note TEXT');
      }

      const applyStatements = () =>
        new Promise((res2, rej2) => {
          if (statements.length === 0) {
            res2();
            return;
          }
          db.serialize(() => {
            let pending = statements.length;
            let failed = null;
            statements.forEach((sql) => {
              db.run(sql, (runErr) => {
                if (runErr) failed = runErr;
                pending -= 1;
                if (pending === 0) {
                  if (failed) rej2(failed);
                  else res2();
                }
              });
            });
          });
        });

      applyStatements()
        .then(() =>
          run(
            db,
            `CREATE TABLE IF NOT EXISTS admin_roles (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT UNIQUE NOT NULL,
              level INTEGER NOT NULL,
              permissions TEXT NOT NULL,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
          )
        )
        .then(
          () =>
            new Promise((res2, rej2) => {
              db.get('SELECT COUNT(*) as cnt FROM admin_roles', [], (seedErr, row) => {
                if (seedErr) {
                  rej2(seedErr);
                  return;
                }
                if (row && row.cnt > 0) {
                  res2();
                  return;
                }
                // Таблица только что создана/пуста — сеем стартовые три роли.
                // Дальше владелец/доверенный админ может переименовывать их,
                // менять права и создавать любые другие роли.
                db.serialize(() => {
                  const stmt = db.prepare('INSERT INTO admin_roles (name, level, permissions) VALUES (?, ?, ?)');
                  DEFAULT_ROLES.forEach((role) => {
                    stmt.run(role.name, role.level, JSON.stringify(role.permissions));
                  });
                  stmt.finalize((finalizeErr) => {
                    if (finalizeErr) rej2(finalizeErr);
                    else res2();
                  });
                });
              });
            })
        )
        .then(() => migrateLegacyAdminLevels(db))
        .then(resolve)
        .catch(reject);
    });
  });
}

module.exports = { ensureUserSchema, PERMISSION_KEYS, DEFAULT_ROLES };
