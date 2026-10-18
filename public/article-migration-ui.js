// article-migration-ui.js — клиентский код блока "Настройки" → "Формат статей"
// (owner-only, см. auth.checkRoot на /api/articles-migration/* в
// article-migration.routes.js). Та же схема, что у cleanup-ui.js:
// initArticleMigrationPage() вызывается из spa-router.js::initSettingsPage()
// после того, как разметка settings.html вставлена в DOM.
console.log('[ArticleMigration] article-migration-ui.js загружен');

function escapeMigrationHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

function showMigrationNotification(message, type = 'info') {
    // Одна плашка уведомлений на всю страницу настроек (см. backup-ui.js).
    if (typeof showBackupNotification === 'function') {
        showBackupNotification(message, type);
    } else {
        console.log(`[ArticleMigration] ${message}`);
    }
}

function migrationOptions() {
    return { inheritLayerCover: !!document.getElementById('migrationInheritLayerCover')?.checked };
}

function renderMigrationReport(report) {
    const container = document.getElementById('migration-report');
    if (!container) return;

    const failures = (report.failures || []).map((f) =>
        `<li><span>${escapeMigrationHtml(f.slug)}</span><span>${escapeMigrationHtml(f.error)}</span></li>`
    ).join('');

    if (report.items.length === 0 && report.failed === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-circle-check"></i>
                <p>Все статьи (${report.total}) уже в актуальном формате</p>
            </div>
        `;
        return;
    }

    const rows = report.items.map((item) => {
        const changes = item.changes.map((c) => `<li><span>${escapeMigrationHtml(c)}</span></li>`).join('');
        const warnings = item.warnings.map((w) => `<li><span>⚠ ${escapeMigrationHtml(w)}</span></li>`).join('');
        return `
            <details class="cleanup-category">
                <summary>${escapeMigrationHtml(item.title)} <small style="color: var(--text-muted);">(${escapeMigrationHtml(item.slug)})</small> — изменений: ${item.changes.length}${item.warnings.length ? `, предупреждений: ${item.warnings.length}` : ''}</summary>
                <ul class="cleanup-file-list">${changes}${warnings}</ul>
            </details>
        `;
    }).join('');

    container.innerHTML = `
        <div style="margin-bottom: 10px; color: var(--text-normal);">
            ${report.dryRun ? 'Будет обновлено' : 'Обновлено'}: <strong>${report.changed}</strong> из ${report.total},
            без изменений: ${report.unchanged}${report.failed ? `, ошибок: <strong>${report.failed}</strong>` : ''}
            ${report.backupDir ? `<div class="form-hint">Оригиналы сохранены в ${escapeMigrationHtml(report.backupDir)}</div>` : ''}
        </div>
        ${rows}
        ${failures ? `<details class="cleanup-category" open><summary>Ошибки (${report.failed})</summary><ul class="cleanup-file-list">${failures}</ul></details>` : ''}
    `;
}

async function previewArticleMigration() {
    try {
        showMigrationNotification('Проверяю статьи...', 'info');
        const query = new URLSearchParams({ inheritLayerCover: String(migrationOptions().inheritLayerCover) });
        const response = await fetch(`/api/articles-migration/preview?${query}`, {
            headers: { 'Authorization': `Bearer ${authManager.getToken()}` }
        });
        const result = await response.json();
        if (!result.success) throw new Error(result.error);

        renderMigrationReport(result.data);
        showMigrationNotification(`Нужно обновить статей: ${result.data.changed}`, 'success');
    } catch (error) {
        console.error('[ArticleMigration] Ошибка предпросмотра:', error);
        showMigrationNotification(`Ошибка: ${error.message}`, 'error');
    }
}

async function runArticleMigration() {
    // Сначала предпросмотр: владелец видит, сколько статей будет переписано,
    // прежде чем подтвердить.
    let preview;
    try {
        const query = new URLSearchParams({ inheritLayerCover: String(migrationOptions().inheritLayerCover) });
        const response = await fetch(`/api/articles-migration/preview?${query}`, {
            headers: { 'Authorization': `Bearer ${authManager.getToken()}` }
        });
        const result = await response.json();
        if (!result.success) throw new Error(result.error);
        preview = result.data;
        renderMigrationReport(preview);
    } catch (error) {
        showMigrationNotification(`Ошибка предпросмотра: ${error.message}`, 'error');
        return;
    }

    if (preview.changed === 0) {
        showMigrationNotification('Все статьи уже в актуальном формате', 'info');
        return;
    }

    const confirmed = confirm(
        `Будет переписано статей: ${preview.changed} из ${preview.total}.\n` +
        'Оригиналы сохранятся в backups/articles-migration/.\n\nПродолжить?'
    );
    if (!confirmed) return;

    try {
        showMigrationNotification('Обновляю статьи...', 'info');
        const response = await fetch('/api/articles-migration/run', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authManager.getToken()}`
            },
            body: JSON.stringify(migrationOptions())
        });
        const result = await response.json();
        if (!result.success) throw new Error(result.error);

        renderMigrationReport(result.data);
        showMigrationNotification(`Обновлено статей: ${result.data.changed}`, 'success');
    } catch (error) {
        console.error('[ArticleMigration] Ошибка миграции:', error);
        showMigrationNotification(`Ошибка: ${error.message}`, 'error');
    }
}

function initArticleMigrationPage() {
    document.getElementById('migration-preview-btn')?.addEventListener('click', previewArticleMigration);
    document.getElementById('migration-run-btn')?.addEventListener('click', runArticleMigration);
}
