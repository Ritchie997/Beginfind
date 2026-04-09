// backup-ui.js - Клиентский код для управления бэкапами
console.log('[Backup] backup-ui.js загружен');

async function loadBackupsList() {
    try {
        const token = authManager.getToken();
        console.log('[Backup] Загрузка списка бэкапов, token:', token ? 'есть' : 'нет');
        
        const response = await fetch('/api/backups', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        console.log('[Backup] Ответ:', response.status);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();
        console.log('[Backup] Результат:', result);

        if (!result.success) {
            throw new Error(result.error);
        }

        const backups = result.data;
        const container = document.getElementById('backups-list');

        if (!container) {
            console.warn('[Backup] Контейнер backups-list не найден');
            return;
        }

        if (backups.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-database"></i>
                    <p>Бэкапов пока нет</p>
                    <p style="font-size: 12px; margin-top: 10px;">Создайте первый бэкап, нажав кнопку выше</p>
                </div>
            `;
            return;
        }

        container.innerHTML = `
            <table class="backup-table">
                <thead>
                    <tr>
                        <th>Имя файла</th>
                        <th>Размер</th>
                        <th>Создан</th>
                        <th>Действия</th>
                    </tr>
                </thead>
                <tbody>
                    ${backups.map(backup => `
                        <tr>
                            <td>${backup.fileName}</td>
                            <td>${backup.sizeFormatted}</td>
                            <td>${backup.createdFormatted}</td>
                            <td>
                                <div class="backup-actions">
                                    <button class="btn btn-primary btn-sm" onclick="downloadBackup('${backup.fileName}')">
                                        <i class="fas fa-download"></i>
                                    </button>
                                    <button class="btn btn-warning btn-sm" onclick="restoreBackup('${backup.fileName}')">
                                        <i class="fas fa-undo"></i>
                                    </button>
                                    <button class="btn btn-danger btn-sm" onclick="deleteBackup('${backup.fileName}')">
                                        <i class="fas fa-trash"></i>
                                    </button>
                                </div>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        console.log('[Backup] Список бэкапов загружен:', backups.length);
    } catch (error) {
        console.error('[Backup] Ошибка загрузки списка:', error);
        const container = document.getElementById('backups-list');
        if (container) {
            container.innerHTML = `
                <div style="color: var(--red); padding: 15px;">
                    Ошибка загрузки списка бэкапов: ${error.message}
                </div>
            `;
        }
    }
}

async function loadAutoBackupInfo() {
    try {
        const response = await fetch('/api/backups/auto/settings', {
            headers: {
                'Authorization': `Bearer ${authManager.getToken()}`
            }
        });

        const result = await response.json();

        if (!result.success) {
            throw new Error(result.error);
        }

        const settings = result.data;
        
        const enabledCheckbox = document.getElementById('autoBackupEnabled');
        const intervalInput = document.getElementById('autoBackupInterval');
        const lastBackupInfo = document.getElementById('lastBackupInfo');

        if (enabledCheckbox) {
            enabledCheckbox.checked = settings.enabled;
        }

        if (intervalInput) {
            intervalInput.value = settings.intervalHours || 12;
        }

        if (lastBackupInfo) {
            if (settings.lastBackup) {
                const date = new Date(settings.lastBackup);
                lastBackupInfo.textContent = date.toLocaleString('ru-RU');
            } else {
                lastBackupInfo.textContent = 'Бэкапы еще не создавались';
            }
        }
    } catch (error) {
        console.error('[Backup] Ошибка загрузки настроек:', error);
    }
}

async function createBackup() {
    try {
        console.log('[Backup] Создание бэкапа...');
        showBackupNotification('Создание бэкапа...', 'info');
        
        const response = await fetch('/api/backups/create', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authManager.getToken()}`
            },
            body: JSON.stringify({})
        });

        console.log('[Backup] Ответ сервера:', response.status);
        const result = await response.json();
        console.log('[Backup] Результат:', result);

        if (!result.success) {
            throw new Error(result.error);
        }

        showBackupNotification(`Бэкап создан: ${result.data.fileName}`, 'success');
        loadBackupsList();
        loadAutoBackupInfo();
    } catch (error) {
        console.error('[Backup] Ошибка создания бэкапа:', error);
        showBackupNotification(`Ошибка: ${error.message}`, 'error');
    }
}

async function uploadBackup(file) {
    try {
        showBackupNotification('Загрузка бэкапа...', 'info');

        const formData = new FormData();
        formData.append('backup', file);

        const response = await fetch('/api/backups/upload', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authManager.getToken()}`
            },
            body: formData
        });

        const result = await response.json();

        if (!result.success) {
            throw new Error(result.error);
        }

        showBackupNotification(`Бэкап загружен: ${result.data.fileName}`, 'success');
        loadBackupsList();
    } catch (error) {
        console.error('[Backup] Ошибка загрузки:', error);
        showBackupNotification(`Ошибка: ${error.message}`, 'error');
    }
}

async function downloadBackup(fileName) {
    try {
        const response = await fetch(`/api/backups/download/${fileName}`, {
            headers: {
                'Authorization': `Bearer ${authManager.getToken()}`
            }
        });

        if (!response.ok) {
            throw new Error('Ошибка при скачивании');
        }

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

        showBackupNotification('Бэкап скачан', 'success');
    } catch (error) {
        console.error('[Backup] Ошибка скачивания:', error);
        showBackupNotification(`Ошибка: ${error.message}`, 'error');
    }
}

async function restoreBackup(fileName) {
    if (!confirm(`Вы уверены, что хотите восстановить базы данных из бэкапа "${fileName}"?\n\nЭто действие перезапишет текущие данные!`)) {
        return;
    }

    try {
        showBackupNotification('Восстановление из бэкапа...', 'info');

        const response = await fetch(`/api/backups/restore/${fileName}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authManager.getToken()}`
            }
        });

        const result = await response.json();

        if (!result.success) {
            throw new Error(result.error);
        }

        showBackupNotification(`Восстановлено ${result.data.restored.length} файл(ов)`, 'success');
        loadBackupsList();
    } catch (error) {
        console.error('[Backup] Ошибка восстановления:', error);
        showBackupNotification(`Ошибка: ${error.message}`, 'error');
    }
}

async function deleteBackup(fileName) {
    if (!confirm(`Вы уверены, что хотите удалить бэкап "${fileName}"?`)) {
        return;
    }

    try {
        const response = await fetch(`/api/backups/${fileName}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${authManager.getToken()}`
            }
        });

        const result = await response.json();

        if (!result.success) {
            throw new Error(result.error);
        }

        showBackupNotification('Бэкап удален', 'success');
        loadBackupsList();
    } catch (error) {
        console.error('[Backup] Ошибка удаления:', error);
        showBackupNotification(`Ошибка: ${error.message}`, 'error');
    }
}

async function saveAutoBackupSettings() {
    try {
        const enabledCheckbox = document.getElementById('autoBackupEnabled');
        const intervalInput = document.getElementById('autoBackupInterval');

        const enabled = enabledCheckbox?.checked || false;
        const intervalHours = parseInt(intervalInput?.value || 12);

        if (intervalHours < 1 || intervalHours > 168) {
            showBackupNotification('Интервал должен быть от 1 до 168 часов', 'error');
            return;
        }

        const response = await fetch('/api/backups/auto/settings', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authManager.getToken()}`
            },
            body: JSON.stringify({ enabled, intervalHours })
        });

        const result = await response.json();

        if (result.success) {
            showBackupNotification('Настройки автоматического бэкапа сохранены!', 'success');
            await loadAutoBackupInfo();
        } else {
            showBackupNotification(`Ошибка: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('[Backup] Ошибка сохранения настроек:', error);
        showBackupNotification(`Ошибка при сохранении: ${error.message}`, 'error');
    }
}

function showBackupNotification(message, type = 'info') {
    const notification = document.getElementById('backup-notification');
    const messageEl = document.getElementById('backup-notification-message');

    if (!notification || !messageEl) {
        console.warn('[Backup] Элементы уведомления не найдены');
        return;
    }

    messageEl.textContent = message;

    const colors = {
        success: { bg: 'rgba(59, 165, 93, 0.2)', border: 'var(--green)', text: 'var(--green)' },
        error: { bg: 'rgba(237, 66, 69, 0.2)', border: 'var(--red)', text: 'var(--red)' },
        info: { bg: 'rgba(88, 101, 242, 0.2)', border: 'var(--blurple)', text: 'var(--blurple)' }
    };

    const color = colors[type] || colors.info;
    notification.style.background = color.bg;
    notification.style.borderColor = color.border;
    notification.style.color = color.text;
    notification.style.display = 'block';

    setTimeout(() => {
        notification.style.display = 'none';
    }, 3000);
}

function initBackupPage() {
    console.log('[Backup] initBackupPage вызван');
    
    const createBtn = document.getElementById('create-backup-btn') || document.getElementById('run-backup-now-btn');
    const refreshBtn = document.getElementById('refresh-backups-btn');
    const uploadBtn = document.getElementById('upload-backup-btn');
    const fileInput = document.getElementById('backup-file-input');
    
    console.log('[Backup] Кнопки:', {
        createBtn: !!createBtn,
        refreshBtn: !!refreshBtn,
        uploadBtn: !!uploadBtn,
        fileInput: !!fileInput
    });
    
    if (createBtn) {
        createBtn.onclick = () => {
            console.log('[Backup] Клик на создать бэкап');
            createBackup();
        };
    }
    
    if (refreshBtn) {
        refreshBtn.onclick = loadBackupsList;
    }
    
    if (uploadBtn) {
        uploadBtn.onclick = () => {
            fileInput.click();
        };
    }

    if (fileInput) {
        fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
                uploadBackup(file);
                e.target.value = '';
            }
        };
    }

    loadBackupsList();
    loadAutoBackupInfo();
}
