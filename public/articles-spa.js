/**
 * Articles SPA Module - Complete implementation with proper encapsulation
 */

export const ArticlesModule = {
    tags: [],

    render() {
        return `
        <div class="articles-spa-container">
            <div class="form-container">
                <h2 class="form-title">Создать новую статью</h2>

                <div class="form-grid-compact">
                    <div class="form-group">
                        <label class="form-label">Заголовок</label>
                        <input type="text" id="articleTitle" class="form-input" placeholder="Введите заголовок">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Автор</label>
                        <input type="text" id="articleAuthor" class="form-input" placeholder="Имя автора">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Категория</label>
                        <div class="input-with-action">
                            <select id="articleCategory" class="form-select">
                                <option value="">Выберите...</option>
                            </select>
                            <button type="button" class="btn btn-outline-secondary btn-plus-action"
                                    onclick="window.spaRouter.createCategoryFromArticles()">
                                <i class="fas fa-plus"></i>
                            </button>
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Сервер</label>
                        <select id="articleServer" class="form-select">
                            <option value="">Выберите сервер</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Доступ</label>
                        <select id="articleLocked" class="form-select">
                            <option value="false">🔓 Открытая</option>
                            <option value="true">🔒 Закрытая</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Роль</label>
                        <select id="articleRole" class="form-select">
                            <option value="">Всем доступно</option>
                        </select>
                    </div>
                </div>

                <div class="form-group full-width">
                    <label class="form-label">Теги</label>
                    <div class="input-with-action">
                        <input type="text" id="articleTags" class="form-control" placeholder="Теги...">
                        <button type="button" class="btn btn-primary btn-plus-action" id="add-tag-mobile-btn">
                            <i class="fas fa-plus"></i>
                        </button>
                    </div>
                    <div id="tagsContainer" class="mt-2"></div>
                </div>

                <div class="form-group full-width">
                    <label class="form-label">Содержание</label>
                    <div class="editor-wrapper">
                        <div id="toolbar" class="editor-toolbar-sticky">
                            <button type="button" class="toolbar-button" data-command="bold" title="Жирный"><i class="fas fa-bold"></i></button>
                            <button type="button" class="toolbar-button" data-command="italic" title="Курсив"><i class="fas fa-italic"></i></button>
                            <button type="button" class="toolbar-button" data-command="underline" title="Подчеркнутый"><i class="fas fa-underline"></i></button>
                            <button type="button" class="toolbar-button" data-command="strikeThrough" title="Зачеркнутый"><i class="fas fa-strikethrough"></i></button>
                            <div class="toolbar-separator"></div>
                            <button type="button" class="toolbar-button" data-command="formatBlock" data-value="blockquote" title="Цитата"><i class="fas fa-quote-right"></i></button>
                            <button type="button" class="toolbar-button" id="btn-spoiler" title="Спойлер (скрытый текст)"><i class="fas fa-eye-slash"></i></button>
                            <div class="toolbar-separator"></div>
                            <button type="button" class="toolbar-button" id="insert-image-file-btn" title="Вставить изображение"><i class="fas fa-image"></i></button>
                            <button type="button" class="toolbar-button" data-command="removeFormat" title="Очистить оформление"><i class="fas fa-eraser"></i></button>
                        </div>
                        <div id="articleContent" class="editor-content" contenteditable="true"></div>
                    </div>
                </div>

                <div class="button-group">
                    <button id="saveArticleBtn" class="btn btn-primary">Опубликовать</button>
                    <button id="previewArticleBtn" class="btn btn-warning">Предпросмотр</button>
                </div>
            </div>
        </div>

        <style>
            .articles-spa-container { padding: 20px; color: var(--text-normal); }
            /* Стили для компактной сетки форм */
            .form-grid-compact {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                gap: 12px;
                margin-bottom: 15px;
            }
            .full-width { grid-column: 1 / -1; margin-top: 15px; }

            /* Кнопка-плюсик */
            .btn-plus-action {
                flex: 0 0 38px;
                width: 38px;
                height: 38px;
                padding: 0 !important;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 4px;
                transition: all 0.2s;
            }

            /* Теги */
            .tags-display { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
            .tag-item { background: var(--blurple); padding: 4px 10px; border-radius: 15px; font-size: 0.85em; display: flex; align-items: center; gap: 5px; }
            .tag-remove { cursor: pointer; opacity: 0.7; }
            #articleTags { border: 1px solid var(--background-accent); background: var(--background-tertiary); color: var(--text-normal); width: 100%; outline: none; padding: 8px 10px; border-radius: 4px; }

            /* Редактор */
            .editor-wrapper { border: 1px solid var(--background-accent); border-radius: 8px; background: var(--background-tertiary); overflow: hidden; }
            .editor-toolbar-sticky { background: var(--background-secondary); padding: 8px; display: flex; gap: 5px; border-bottom: 1px solid var(--background-accent); position: sticky; top: 0; }
            .toolbar-button {
                background: none !important;
                border: none !important;
                color: var(--header-secondary) !important;
                padding: 8px 12px !important;
                cursor: pointer !important;
                border-radius: 4px !important;
                transition: 0.2s !important;
                box-sizing: border-box !important;
            }
            .toolbar-button:hover {
                background: var(--background-accent) !important;
                color: white !important;
            }
            .toolbar-button.active {
                background: var(--blurple) !important;
                color: white !important;
                font-weight: bold !important;
                box-shadow: inset 0 0 0 2px rgba(114, 137, 218, 0.5) !important;
            }
            .toolbar-separator { width: 1px; background: var(--background-accent); margin: 0 5px; }
            .editor-content { min-height: 250px; padding: 15px; outline: none; line-height: 1.6; }

            /* Новый стандарт спойлера */
            mark[data-type="spoiler"] {
                background-color: #1e1f22 !important;
                color: transparent !important;
                border: none !important;
                border-radius: 3px;
                padding: 0 3px;
                cursor: pointer;
            }

            mark[data-type="spoiler"].revealed {
                background-color: rgba(255, 255, 255, 0.1) !important;
                color: #dcddde !important;
            }

            /* Запрет фонов для всего остального текста */
            #articleContent *:not(mark) {
                background-color: transparent !important;
                color: #dcddde !important; /* Твой базовый цвет текста */
            }

            /* Добавляем функциональность для спойлеров */
            mark[data-type="spoiler"] {
                cursor: pointer;
            }
        </style>
        `;
    },

    init(container) {
        this.container = container;
        this.tags = [];
        container.innerHTML = this.render();

        // Убедимся, что все элементы созданы
        setTimeout(() => {
            console.log('Кнопки после рендеринга:');
            console.log('Bold button:', this.container.querySelector('#btn-bold'));
            console.log('Italic button:', this.container.querySelector('#btn-italic'));
            console.log('Underline button:', this.container.querySelector('#btn-underline'));
        }, 100);

        this.setupEditor();
        this.setupTags();
        this.setupFormEvents();
        this.loadData();

        // Стандартные команды (включая зачеркивание)
        this.container.querySelectorAll('.toolbar-button[data-command]').forEach(btn => {
            btn.onmousedown = (e) => {
                e.preventDefault(); // Это критично, чтобы не терять выделение!
                const cmd = btn.dataset.command;
                const val = btn.dataset.value || null;
                document.execCommand(cmd, false, val);
            };
        });

        // Обработка фото
        const imgBtn = document.getElementById('insert-image-file-btn');
        if (imgBtn) {
            imgBtn.onclick = () => {
                if (window.editorManager) {
                    window.editorManager.insertImageFromPC();
                } else {
                    // Резервный вариант, если editorManager недоступен
                    const url = prompt("Введите URL изображения:");
                    if(url) {
                        const img = document.createElement('img');
                        img.src = url;
                        img.style.maxWidth = '100%';
                        img.style.borderRadius = '4px';
                        img.style.margin = '10px 0';

                        const editor = document.querySelector('#articleContent');
                        const selection = window.getSelection();
                        if (selection.rangeCount > 0) {
                            const range = selection.getRangeAt(0);
                            range.deleteContents();
                            range.insertNode(img);
                        } else {
                            editor.appendChild(img);
                        }
                        if (editor) editor.focus();
                    }
                }
            };
        }

        // Кастомный спойлер
        const spoilerBtn = document.getElementById('btn-spoiler');
        if (spoilerBtn) {
            spoilerBtn.onmousedown = (e) => {
                e.preventDefault();
                if (window.editorManager) {
                    window.editorManager.applyClassToSelection('spoiler-text');
                }
            };
        }

        // Добавляем функциональность для спойлеров в редакторе
        const editor = this.container.querySelector('#articleContent');
        if (editor) {
            editor.addEventListener('click', (e) => {
                if (e.target.tagName === 'MARK' && e.target.hasAttribute('data-type') && e.target.getAttribute('data-type') === 'spoiler') {
                    e.target.classList.toggle('revealed');
                }
            });
        }
    },

    setupEditor() {
        const editor = this.container.querySelector('#articleContent');
        const toolbar = this.container.querySelector('#toolbar');

        // Состояния форматирования
        const formattingState = {
            bold: false,
            italic: false,
            underline: false,
            strikethrough: false,
            list: false,
            num: false
        };

        const updateButtons = () => {
            // Используем container.querySelector для поиска кнопок, чтобы быть уверенным в контексте
            const boldBtn = this.container.querySelector('[data-command="bold"]');
            const italicBtn = this.container.querySelector('[data-command="italic"]');
            const underlineBtn = this.container.querySelector('[data-command="underline"]');
            const strikeBtn = this.container.querySelector('[data-command="strikeThrough"]');

            if (boldBtn) {
                boldBtn.classList.toggle('active', formattingState.bold);
                // Принудительно обновляем отображение
                if (formattingState.bold) {
                    boldBtn.style.setProperty('background', 'var(--blurple)', 'important');
                    boldBtn.style.setProperty('color', 'white', 'important');
                    boldBtn.style.setProperty('font-weight', 'bold', 'important');
                } else {
                    boldBtn.style.removeProperty('background');
                    boldBtn.style.removeProperty('color');
                    boldBtn.style.removeProperty('font-weight');
                }
            }
            if (italicBtn) {
                italicBtn.classList.toggle('active', formattingState.italic);
                if (formattingState.italic) {
                    italicBtn.style.setProperty('background', 'var(--blurple)', 'important');
                    italicBtn.style.setProperty('color', 'white', 'important');
                    italicBtn.style.setProperty('font-weight', 'bold', 'important');
                } else {
                    italicBtn.style.removeProperty('background');
                    italicBtn.style.removeProperty('color');
                    italicBtn.style.removeProperty('font-weight');
                }
            }
            if (underlineBtn) {
                underlineBtn.classList.toggle('active', formattingState.underline);
                if (formattingState.underline) {
                    underlineBtn.style.setProperty('background', 'var(--blurple)', 'important');
                    underlineBtn.style.setProperty('color', 'white', 'important');
                    underlineBtn.style.setProperty('font-weight', 'bold', 'important');
                } else {
                    underlineBtn.style.removeProperty('background');
                    underlineBtn.style.removeProperty('color');
                    underlineBtn.style.removeProperty('font-weight');
                }
            }
            if (strikeBtn) {
                strikeBtn.classList.toggle('active', formattingState.strikethrough);
                if (formattingState.strikethrough) {
                    strikeBtn.style.setProperty('background', 'var(--blurple)', 'important');
                    strikeBtn.style.setProperty('color', 'white', 'important');
                    strikeBtn.style.setProperty('font-weight', 'bold', 'important');
                } else {
                    strikeBtn.style.removeProperty('background');
                    strikeBtn.style.removeProperty('color');
                    strikeBtn.style.removeProperty('font-weight');
                }
            }
        };

        // Функция для проверки текущего состояния форматирования в позиции курсора
        const checkCurrentFormatting = () => {
            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0) return;

            // Получаем текущее состояние форматирования с помощью queryCommandState
            formattingState.bold = document.queryCommandState('bold');
            formattingState.italic = document.queryCommandState('italic');
            formattingState.underline = document.queryCommandState('underline');
            formattingState.strikethrough = document.queryCommandState('strikeThrough');
            formattingState.list = document.queryCommandState('insertUnorderedList');
            formattingState.num = document.queryCommandState('insertOrderedList');
        };

        // Функция для дебаунса вызовов
        function debounce(func, wait) {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        }

        const debouncedUpdateButtons = debounce(updateButtons, 50);

        // Применяем форматирование - используем mousedown вместо click для предотвращения потери фокуса
        toolbar.addEventListener('mousedown', (e) => {
            const btn = e.target.closest('[data-command]');
            if (btn) {
                e.preventDefault(); // ВАЖНО: предотвращаем потерю фокуса
                const cmd = btn.getAttribute('data-command');
                const value = btn.getAttribute('data-value');

                // Обновляем состояние форматирования на основе команды
                switch(cmd) {
                    case 'bold':
                        formattingState.bold = !formattingState.bold;
                        break;
                    case 'italic':
                        formattingState.italic = !formattingState.italic;
                        break;
                    case 'underline':
                        formattingState.underline = !formattingState.underline;
                        break;
                    case 'strikeThrough':
                        formattingState.strikethrough = !formattingState.strikethrough;
                        break;
                    case 'insertUnorderedList':
                        formattingState.list = !formattingState.list;
                        // Сбрасываем нумерованный список при переключении
                        if (formattingState.list) {
                            formattingState.num = false;
                        }
                        break;
                    case 'insertOrderedList':
                        formattingState.num = !formattingState.num;
                        // Сбрасываем маркированный список при переключении
                        if (formattingState.num) {
                            formattingState.list = false;
                        }
                        break;
                    case 'removeFormat':
                        // For removeFormat, we don't toggle a state, just execute the command
                        break;
                }

                // Выполняем команду
                if (value) {
                    document.execCommand(cmd, false, value);
                } else {
                    document.execCommand(cmd, false, null);
                }

                // Возвращаем фокус в редактор и обновляем кнопки
                editor.focus();
                updateButtons(); // Обновляем сразу, без задержки
            }
        });


        // Сначала установим начальное состояние кнопок
        setTimeout(updateButtons, 100);

        // Слушатели событий для обновления состояния
        const events = ['keyup', 'mouseup', 'input', 'click', 'focus', 'mousemove'];
        events.forEach(ev => {
            editor.addEventListener(ev, () => {
                checkCurrentFormatting();
                debouncedUpdateButtons();
            });
        });

        // Для SPA: следим за изменением выделения в редакторе
        const handleSelectionChange = () => {
            if (document.activeElement === editor) {
                checkCurrentFormatting();
                debouncedUpdateButtons();
            }
        };

        document.addEventListener('selectionchange', handleSelectionChange);

        // Сохраняем обработчик для возможности удаления при очистке
        this.selectionChangeHandler = handleSelectionChange;
    },

    setupTags() {
        const input = this.container.querySelector('#articleTags');
        const display = this.container.querySelector('#tagsContainer');

        const renderTags = () => {
            // Очищаем контейнер и отрисовываем теги
            if (display) {
                display.innerHTML = this.tags.map((t, i) => `
                    <span class="tag-item">
                        ${t} <span class="tag-remove" data-idx="${i}">&times;</span>
                    </span>
                `).join('');
            }
        };

        // Добавляем тег при нажатии Enter
        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && input.value.trim()) {
                    e.preventDefault();
                    const tagValue = input.value.trim();

                    // Проверяем, что тег не дублируется
                    if (!this.tags.includes(tagValue)) {
                        this.tags.push(tagValue);
                        input.value = '';
                        renderTags(); // Обновляем отображение тегов
                    }
                }
            });

            // Обработка кнопки тегов (для мобильных устройств)
            const tagBtn = this.container.querySelector('#add-tag-mobile-btn');
            if (tagBtn) {
                tagBtn.onclick = (e) => {
                    e.preventDefault();
                    // Имитируем нажатие Enter для TagManager
                    const event = new KeyboardEvent('keydown', { key: 'Enter' });
                    input.dispatchEvent(event);
                    input.focus();
                };
            }
        }

        // Обработка клика по тегам (для удаления)
        if (display) {
            display.addEventListener('click', (e) => {
                if (e.target.classList.contains('tag-remove')) {
                    const index = parseInt(e.target.dataset.idx);
                    if (!isNaN(index) && index >= 0 && index < this.tags.length) {
                        this.tags.splice(index, 1);
                        renderTags(); // Обновляем отображение тегов
                    }
                }
            });
        }
    },

    setupFormEvents() {
        // Кнопка сохранения статьи
        const saveBtn = this.container.querySelector('#saveArticleBtn');
        saveBtn.addEventListener('click', () => {
            const payload = {
                title: this.container.querySelector('#articleTitle').value,
                author: this.container.querySelector('#articleAuthor').value,
                category: this.container.querySelector('#articleCategory').value,
                server: this.container.querySelector('#articleServer').value,
                locked: this.container.querySelector('#articleLocked').value === 'true',
                role: this.container.querySelector('#articleRole').value,
                tags: this.tags,
                content: this.container.querySelector('#articleContent').innerHTML
            };
            console.log("Отправка данных:", payload);

            // Check if we're updating an existing article or creating a new one
            const articleId = saveBtn.getAttribute('data-article-id');
            console.log("Article ID from button:", articleId); // Debug log
            if (articleId) {
                // Update existing article
                this.updateArticle(articleId, payload);
            } else {
                // Create new article
                this.createArticle(payload);
            }
        });

        // Кнопка предпросмотра - вызываем метод из spa-router
        const previewBtn = this.container.querySelector('#previewArticleBtn');
        previewBtn.addEventListener('click', () => {
            // Получаем данные из формы
            const title = this.container.querySelector('#articleTitle').value;
            const author = this.container.querySelector('#articleAuthor').value;
            const content = this.container.querySelector('#articleContent').innerHTML;

            // Устанавливаем значения в основной форме (где spa-router ожидает их найти)
            document.getElementById('articleTitle').value = title;
            document.getElementById('articleAuthor').value = author;

            // Копируем содержимое редактора в основной редактор
            const mainEditor = document.getElementById('articleContent');
            if (mainEditor) {
                mainEditor.innerHTML = content;
            }

            // Вызываем метод предпросмотра из spa-router
            if (window.spaRouter) {
                window.spaRouter.previewArticle();
            } else {
                // Резервный вариант - если spaRouter недоступен
                alert('Предварительный просмотр недоступен');
            }
        });
    },

    async loadData() {
        try {
            // Загрузка начальных данных (категории, серверы, роли и т.д.)
            // В реальном приложении это будут API-вызовы
            
            // Загрузка категорий
            const categorySelect = this.container.querySelector('#articleCategory');
            const categories = ['Новости', 'Руководства', 'Обновления', 'Анонсы'];
            categories.forEach(cat => {
                const option = document.createElement('option');
                option.value = cat.toLowerCase();
                option.textContent = cat;
                categorySelect.appendChild(option);
            });
            
            // Загрузка серверов
            const serverSelect = this.container.querySelector('#articleServer');
            const servers = ['Основной', 'Тестовый', 'Архив'];
            servers.forEach(server => {
                const option = document.createElement('option');
                option.value = server.toLowerCase();
                option.textContent = server;
                serverSelect.appendChild(option);
            });
            
            // Загрузка ролей
            const roleSelect = this.container.querySelector('#articleRole');
            const roles = ['Администратор', 'Модератор', 'Пользователь'];
            roles.forEach(role => {
                const option = document.createElement('option');
                option.value = role.toLowerCase();
                option.textContent = role;
                roleSelect.appendChild(option);
            });
        } catch (error) {
            console.error('Error loading data:', error);
            this.showMessage('Ошибка при загрузке данных', 'error');
        }
    },

    showMessage(message, type = 'info') {
        // Создаем временный элемент сообщения
        const messageEl = document.createElement('div');
        messageEl.textContent = message;
        messageEl.style.position = 'fixed';
        messageEl.style.top = '20px';
        messageEl.style.right = '20px';
        messageEl.style.padding = '10px 20px';
        messageEl.style.borderRadius = '4px';
        messageEl.style.zIndex = '3000';
        messageEl.style.color = 'white';

        // Устанавливаем цвет в зависимости от типа сообщения
        if (type === 'error') {
            messageEl.style.backgroundColor = '#ff4757';
        } else if (type === 'success') {
            messageEl.style.backgroundColor = '#2ed573';
        } else {
            messageEl.style.backgroundColor = '#3742fa';
        }

        document.body.appendChild(messageEl);

        // Удаляем сообщение через 3 секунды
        setTimeout(() => {
            document.body.removeChild(messageEl);
        }, 3000);
    },

    // Метод для создания статьи
    async createArticle(payload) {
        try {
            const response = await fetch('/api/articles', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + authManager.getToken() // Use authManager.getToken() directly
                },
                body: JSON.stringify(payload)
            });

            const result = await response.json();

            if (response.status === 403 || (result.error && result.error.includes('token'))) {
                // Handle token expiration
                this.showMessage('Сессия истекла. Пожалуйста, войдите снова.', 'error');
                authManager.logout();
                showModalLogin();
                return;
            }

            if (result.success) {
                this.showMessage('Статья успешно создана!', 'success');
                this.clearArticleForm();
            } else {
                this.showMessage(`Ошибка при создании статьи: ${result.error}`, 'error');
            }
        } catch (error) {
            console.error('Error creating article:', error);
            this.showMessage('Ошибка при создании статьи', 'error');
        }
    },

    // Метод для обновления статьи
    async updateArticle(articleId, payload) {
        try {
            const response = await fetch(`/api/articles/${articleId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + authManager.getToken() // Use authManager.getToken() directly
                },
                body: JSON.stringify(payload)
            });

            const result = await response.json();

            if (response.status === 403 || (result.error && result.error.includes('token'))) {
                // Handle token expiration
                this.showMessage('Сессия истекла. Пожалуйста, войдите снова.', 'error');
                authManager.logout();
                showModalLogin();
                return;
            }

            if (result.success) {
                this.showMessage('Статья успешно обновлена!', 'success');

                // Reset to create mode
                const saveBtn = this.container.querySelector('#saveArticleBtn');
                saveBtn.removeAttribute('data-article-id');
                this.container.querySelector('#article-form-title').textContent = 'Создать новую статью';
                saveBtn.textContent = 'Опубликовать';
            } else {
                this.showMessage(`Ошибка при обновлении статьи: ${result.error}`, 'error');
            }
        } catch (error) {
            console.error('Error updating article:', error);
            this.showMessage('Ошибка при обновлении статьи', 'error');
        }
    },

    // Метод для очистки формы
    clearArticleForm() {
        this.container.querySelector('#articleTitle').value = '';
        this.container.querySelector('#articleAuthor').value = '';
        this.container.querySelector('#articleCategory').value = '';
        this.container.querySelector('#articleServer').value = '';
        this.container.querySelector('#articleLocked').value = 'false';
        this.container.querySelector('#articleRole').value = '';
        this.container.querySelector('#articleContent').innerHTML = '';

        // Reset to create mode
        const saveBtn = document.getElementById('saveArticleBtn');
        if (saveBtn) {
            saveBtn.removeAttribute('data-article-id');
            saveBtn.textContent = 'Опубликовать';
        }
        this.container.querySelector('#article-form-title').textContent = 'Создать новую статью';

        // Clear tags
        this.tags = [];
        this.container.querySelector('#tagsContainer').innerHTML = '';
    },

    // Метод для редактирования статьи
    async editArticle(articleId) {
        try {
            const response = await fetch(`/api/articles/${articleId}`, {
                headers: { 'Authorization': 'Bearer ' + authManager.getToken() }
            });
            const result = await response.json();

            // Упрощаем проверку: если ID есть, значит данные загружены
            const article = result.data || result;

            if (article && (article.id || article._id)) {
                // Заполняем поля
                this.container.querySelector('#articleTitle').value = article.title || '';
                this.container.querySelector('#articleAuthor').value = article.author || '';
                this.container.querySelector('#articleCategory').value = article.category || '';
                this.container.querySelector('#articleServer').value = article.server_id || article.server || '';
                this.container.querySelector('#articleLocked').value = article.locked ? 'true' : 'false';
                this.container.querySelector('#articleRole').value = article.role_id || article.role || '';

                // Set content in editor
                const editor = this.container.querySelector('#articleContent');
                if (editor) {
                    editor.innerHTML = article.content || '';
                }

                // КЛЮЧЕВОЙ МОМЕНТ: Меняем кнопку
                const saveBtn = this.container.querySelector('#saveArticleBtn');
                if (saveBtn) {
                    saveBtn.setAttribute('data-article-id', articleId);
                    saveBtn.textContent = 'Обновить статью';
                }
                const formTitle = this.container.querySelector('#article-form-title');
                if (formTitle) formTitle.textContent = 'Редактировать статью';
            } else {
                this.showMessage('Статья не найдена в базе', 'error');
            }
        } catch (error) {
            this.showMessage('Ошибка сети при загрузке', 'error');
        }
    },

    // Метод для очистки обработчиков событий при уничтожении компонента
    cleanup() {
        if (this.selectionChangeHandler) {
            document.removeEventListener('selectionchange', this.selectionChangeHandler);
        }
    }
};

// Функция инициализации для совместимости
export async function initArticlesPage(container) {
    ArticlesModule.init(container);
}