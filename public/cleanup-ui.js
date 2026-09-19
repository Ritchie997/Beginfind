// cleanup-ui.js — клиентский код вкладки "Настройки" → "Очистка мусора"
// (owner-only, см. auth.checkRoot на /api/cleanup/* в cleanup.routes.js).
// Та же структура, что и backup-ui.js: initCleanupPage() вызывается из
// spa-router.js::initSettingsPage() после того, как разметка settings.html
// вставлена в DOM.
console.log('[Cleanup] cleanup-ui.js загружен');

const CLEANUP_CATEGORY_LABELS = {
    trash: 'Старые статьи из корзины',
    uploads: 'Неиспользуемые картинки статей/сообщений',
    stickers: 'Файлы стикеров-сирот'
};

function formatCleanupBytes(bytes) {
    if (!bytes) return '0 Б';
    const units = ['Б', 'КБ', 'МБ', 'ГБ'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

function showCleanupNotification(message, type = 'info') {
    // Переиспользуем ту же плашку уведомлений, что и бэкапы — на странице
    // настроек она одна на всю вкладку (см. #backup-notification в settings.html).
    if (typeof showBackupNotification === 'function') {
        showBackupNotification(message, type);
    } else {
        console.log(`[Cleanup] ${message}`);
    }
}

async function loadCleanupSettings() {
    try {
        const response = await fetch('/api/cleanup/settings', {
            headers: { 'Authorization': `Bearer ${authManager.getToken()}` }
        });
        const result = await response.json();
        if (!result.success) throw new Error(result.error);

        const s = result.data;
        const setChecked = (id, value) => { const el = document.getElementById(id); if (el) el.checked = !!value; };
        const setValue = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };

        setChecked('cleanupEnabled', s.enabled);
        setValue('cleanupIntervalHours', s.intervalHours);
        setValue('cleanupMinOrphanAgeHours', s.minOrphanAgeHours);
        setValue('cleanupTrashRetentionDays', s.trashRetentionDays);
        setChecked('cleanupTrashedArticles', s.cleanTrashedArticles);
        setChecked('cleanupOrphanUploads', s.cleanOrphanUploads);
        setChecked('cleanupOrphanStickers', s.cleanOrphanStickers);

        renderCleanupLastRun(s.lastReport, s.lastRun);
    } catch (error) {
        console.error('[Cleanup] Ошибка загрузки настроек:', error);
    }
}

function renderCleanupLastRun(lastReport, lastRun) {
    const el = document.getElementById('cleanup-last-run-info');
    if (!el) return;

    if (!lastRun && !lastReport) {
        el.textContent = 'Очистка ещё не запускалась';
        return;
    }

    const when = new Date(lastReport?.at || lastRun).toLocaleString('ru-RU');
    if (lastReport) {
        el.textContent = `Последний запуск: ${when} — удалено ${lastReport.totalCount} файл(ов), освобождено ${formatCleanupBytes(lastReport.totalBytes)}`;
    } else {
        el.textContent = `Последний запуск: ${when}`;
    }
}

async function saveCleanupSettings() {
    try {
        const getChecked = (id) => document.getElementById(id)?.checked || false;
        const getInt = (id, fallback) => parseInt(document.getElementById(id)?.value, 10) || fallback;

        const payload = {
            enabled: getChecked('cleanupEnabled'),
            intervalHours: getInt('cleanupIntervalHours', 24),
            minOrphanAgeHours: getInt('cleanupMinOrphanAgeHours', 48),
            trashRetentionDays: getInt('cleanupTrashRetentionDays', 30),
            cleanTrashedArticles: getChecked('cleanupTrashedArticles'),
            cleanOrphanUploads: getChecked('cleanupOrphanUploads'),
            cleanOrphanStickers: getChecked('cleanupOrphanStickers')
        };

        const response = await fetch('/api/cleanup/settings', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authManager.getToken()}`
            },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (!result.success) throw new Error(result.error);

        showCleanupNotification('Настройки очистки сохранены', 'success');
    } catch (error) {
        console.error('[Cleanup] Ошибка сохранения настроек:', error);
        showCleanupNotification(`Ошибка: ${error.message}`, 'error');
    }
}

// Рендерит отчёт (предпросмотр ИЛИ результат реального запуска — одна и та
// же форма ответа, см. runCleanup() в src/services/cleanup.js) в #cleanup-report.
function renderCleanupReport(report, { dryRun }) {
    const container = document.getElementById('cleanup-report');
    if (!container) return;

    if (report.totalCount === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-broom"></i>
                <p>${dryRun ? 'Мусора не найдено' : 'Удалять было нечего'}</p>
            </div>
        `;
        return;
    }

    const categories = ['trash', 'uploads', 'stickers'];
    const summaryCards = categories.map((cat) => `
        <div class="cleanup-summary-card">
            <div class="count">${report.items[cat].length}</div>
            <div class="label">${CLEANUP_CATEGORY_LABELS[cat]}</div>
        </div>
    `).join('');

    const detailSections = categories
        .filter((cat) => report.items[cat].length > 0)
        .map((cat) => {
            const rows = report.items[cat].map((item) => `
                <li>
                    <span>${escapeCleanupHtml(item.name)}</span>
                    <span>${formatCleanupBytes(item.size)}</span>
                </li>
            `).join('');
            return `
                <details class="cleanup-category">
                    <summary>${CLEANUP_CATEGORY_LABELS[cat]} (${report.items[cat].length})</summary>
                    <ul class="cleanup-file-list">${rows}</ul>
                </details>
            `;
        }).join('');

    container.innerHTML = `
        <div style="margin-bottom: 10px; color: var(--text-normal);">
            ${dryRun ? 'Будет удалено' : 'Удалено'}: <strong>${report.totalCount}</strong> файл(ов),
            ${dryRun ? 'освободится' : 'освобождено'} <strong>${formatCleanupBytes(report.totalBytes)}</strong>
        </div>
        <div class="cleanup-summary">${summaryCards}</div>
        ${detailSections}
    `;
}

function escapeCleanupHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

async function previewCleanup() {
    try {
        showCleanupNotification('Считаю мусор...', 'info');
        const response = await fetch('/api/cleanup/preview', {
            headers: { 'Authorization': `Bearer ${authManager.getToken()}` }
        });
        const result = await response.json();
        if (!result.success) throw new Error(result.error);

        renderCleanupReport(result.data, { dryRun: true });
        showCleanupNotification(`Найдено ${result.data.totalCount} файл(ов) мусора`, 'success');
    } catch (error) {
        console.error('[Cleanup] Ошибка предпросмотра:', error);
        showCleanupNotification(`Ошибка: ${error.message}`, 'error');
    }
}

async function runCleanupNow() {
    // Предпросмотр перед подтверждением — владелец должен видеть, сколько
    // именно файлов (и откуда) собирается снести кнопка, прежде чем на неё
    // соглашаться: удаление безвозвратное.
    let preview;
    try {
        const previewResponse = await fetch('/api/cleanup/preview', {
            headers: { 'Authorization': `Bearer ${authManager.getToken()}` }
        });
        const previewResult = await previewResponse.json();
        if (!previewResult.success) throw new Error(previewResult.error);
        preview = previewResult.data;
        renderCleanupReport(preview, { dryRun: true });
    } catch (error) {
        showCleanupNotification(`Ошибка предпросмотра: ${error.message}`, 'error');
        return;
    }

    if (preview.totalCount === 0) {
        showCleanupNotification('Мусора не найдено — удалять нечего', 'info');
        return;
    }

    const confirmed = confirm(
        `Будет безвозвратно удалено ${preview.totalCount} файл(ов) ` +
        `(${formatCleanupBytes(preview.totalBytes)}).\n\nПродолжить?`
    );
    if (!confirmed) return;

    try {
        showCleanupNotification('Удаляю...', 'info');
        const response = await fetch('/api/cleanup/run', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authManager.getToken()}` }
        });
        const result = await response.json();
        if (!result.success) throw new Error(result.error);

        renderCleanupReport(result.data, { dryRun: false });
        renderCleanupLastRun({
            totalCount: result.data.totalCount,
            totalBytes: result.data.totalBytes,
            at: result.data.at
        }, result.data.at);
        showCleanupNotification(`Удалено ${result.data.totalCount} файл(ов)`, 'success');
    } catch (error) {
        console.error('[Cleanup] Ошибка очистки:', error);
        showCleanupNotification(`Ошибка: ${error.message}`, 'error');
    }
}

function initCleanupPage() {
    console.log('[Cleanup] initCleanupPage вызван');

    document.getElementById('save-cleanup-settings-btn')?.addEventListener('click', saveCleanupSettings);
    document.getElementById('cleanup-preview-btn')?.addEventListener('click', previewCleanup);
    document.getElementById('cleanup-run-btn')?.addEventListener('click', runCleanupNow);

    loadCleanupSettings();
}
