# Инструкции Copilot для AllTell

Применяйте корневой [`AGENTS.md`](../AGENTS.md) как краткий контракт для работы
с репозиторием.

Перед задачей откройте [`docs/agent-context/README.md`](../docs/agent-context/README.md),
затем загрузите только необходимый доменный справочник:

- [`DOMAINS.md`](../docs/agent-context/DOMAINS.md) — владельцы функций;
- [`API_INDEX.md`](../docs/agent-context/API_INDEX.md) — HTTP маршруты;
- [`DATA_AND_FLOWS.md`](../docs/agent-context/DATA_AND_FLOWS.md) — форматы и сохранение;
- [`FRONTEND.md`](../docs/agent-context/FRONTEND.md) — браузерные модули.

Документация — карта, не авторитетное описание текущего поведения. Проверяйте
исходники маршрутов, сервисов, экранов и хранилищ. Не трогайте пользовательские
данные, не коммитьте секреты, а после изменения запускайте применимые проверки.
