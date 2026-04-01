// editor-manager.js - Module for managing the rich text editor functionality

class EditorManager {
  constructor() {
    this.editor = null;
    this.toolbar = null;
    this.imageWrappers = new Set();
    this.savedRange = null;
    this.init();
  }

  init() {
    // Initialize when editor is available
    this.setupEventListeners();
  }

  setupEventListeners() {
    // Set up event listeners that will be attached when editor is loaded
    document.addEventListener('click', this.handleDocumentClick.bind(this));
    window.addEventListener('resize', this.handleResize.bind(this));
  }

  // Save the current selection/cursor position
  saveSelection() {
    const sel = window.getSelection();
    if (sel.getRangeAt && sel.rangeCount) {
      this.savedRange = sel.getRangeAt(0).cloneRange();
    }
  }

  // Initialize the editor when it's loaded on the page
  initializeEditor() {
    this.editor = document.getElementById('articleContent');
    this.toolbar = document.getElementById('toolbar') || document.querySelector('.editor-toolbar');

    if (this.editor) {
      // Guarantee that empty editor contains at least one paragraph
      if (this.editor.innerHTML.trim() === "") {
          this.editor.innerHTML = "<p><br></p>";
      }

      // Command that forces browser to always create <p> when pressing Enter
      document.execCommand('defaultParagraphSeparator', false, 'p');

      // Setup toolbar event listeners
      this.setupToolbar();

      // Setup editor event listeners
      this.setupEditorEvents();

      // Wrap existing images in the editor
      this.wrapExistingImages();
    }
  }

  setupToolbar() {
    if (!this.toolbar) return;

    // Handle formatting buttons using mousedown to prevent focus loss
    const buttons = this.toolbar.querySelectorAll('.toolbar-button[data-command]');
    buttons.forEach(btn => {
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault(); // This prevents focus loss!

            // Save current selection before executing the command
            if (this.editor) {
                this.editor.focus();
                this.saveSelection();
            }

            const command = btn.getAttribute('data-command');

            // Handle alignment commands with smart targeting
            if (['justifyLeft', 'justifyCenter', 'justifyRight'].includes(command)) {
                this.executeAlignmentCommandSmart(command);
            } else {
                // Execute the command normally for non-alignment commands
                this.executeCommand(command);
            }

            // Update toolbar active states after applying formatting
            this.updateToolbarActiveStates();

            if (this.editor) {
                this.editor.focus();
            }
        });
    });

    // Handle image insertion buttons separately
    const insertImageFileBtn = document.getElementById('insert-image-file-btn');
    const insertImageUrlBtn = document.getElementById('insert-image-url-btn');
    const insertLinkBtn = document.getElementById('editor-link-btn');

    if (insertImageFileBtn) {
      insertImageFileBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        // Save current selection before executing the command
        if (this.editor) {
          this.editor.focus();
          this.saveSelection();
        }
        this.insertImageFromPC();
      });
    }

    if (insertImageUrlBtn) {
      insertImageUrlBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        // Save current selection before executing the command
        if (this.editor) {
          this.editor.focus();
          this.saveSelection();
        }
        this.insertImageFromURL();
      });
    }

    // Handle link insertion button
    if (insertLinkBtn) {
      insertLinkBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        // Save current selection before executing the command
        if (this.editor) {
          this.editor.focus();
          this.saveSelection();
        }
        this.insertLink();
      });
    }

    const blockquoteBtn = this.toolbar.querySelector('[data-command="formatBlock"][data-value="blockquote"]');
    if (blockquoteBtn) {
      blockquoteBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        // Save current selection before executing the command
        if (this.editor) {
          this.editor.focus();
          this.saveSelection();
        }
        document.execCommand('formatBlock', false, 'blockquote');
        this.updateToolbarActiveStates();
        if (this.editor) {
          this.editor.focus();
        }
      });
    }

    // Handle spoiler button
    const spoilerBtn = document.getElementById('btn-spoiler');
    if (spoilerBtn) {
      spoilerBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        // Save current selection before executing the command
        if (this.editor) {
          this.editor.focus();
          this.saveSelection();
        }
        this.applyClassToSelection('spoiler-text');
      });
    }

  }

  // Execute alignment command with smart targeting (like in Word)
  executeAlignmentCommandSmart(command) {
    this.editor.focus();

    // 1. Try to use the standard command
    document.execCommand('styleWithCSS', false, true);
    document.execCommand(command, false, null);

    // 2. Fix on the fly: find the current container and force the style
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
        let container = selection.getRangeAt(0).commonAncestorContainer;

        // Find the parent block element (P, DIV, H1, H2, H3, LI, BLOCKQUOTE)
        while (container && container !== this.editor) {
            if (container.nodeType === 1 && (['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE'].includes(container.tagName))) {
                // Apply alignment directly to the block
                const alignValue = command.replace('justify', '').toLowerCase();
                container.style.textAlign = alignValue === 'full' ? 'justify' : alignValue;
                break;
            }
            container = container.parentNode;
        }
    }

    // Return focus and update button states
    this.editor.focus();
    this.updateToolbarActiveStates();
  }

  // Execute editor command with proper handling
  executeCommand(command, value = null) {
    this.editor.focus();

    // For alignment commands, sometimes it's useful to enable styleWithCSS
    if (command.startsWith('justify')) {
        document.execCommand('styleWithCSS', false, true);
    }

    document.execCommand(command, false, value);

    // Return focus and update button states
    this.editor.focus();
    this.updateToolbarActiveStates();
  }


  setupEditorEvents() {
    if (!this.editor) return;

    // Add event listeners for updating toolbar states
    this.editor.addEventListener('keyup', () => {
      this.updateToolbarActiveStates();
      this.saveSelection();
    });
    this.editor.addEventListener('mouseup', () => {
      this.updateToolbarActiveStates();
      this.saveSelection();
    });
    this.editor.addEventListener('click', this.updateToolbarActiveStates.bind(this));
    this.editor.addEventListener('input', () => {
      this.updateToolbarActiveStates();
      this.saveSelection();

      // Если внутри редактора появляется пустой спойлер - удаляем его
      const emptySpoilers = this.editor.querySelectorAll('mark[data-type="spoiler"]:empty');
      emptySpoilers.forEach(spoiler => spoiler.remove());

      // Также удаляем пустые span с красным цветом для полной санитарной очистки
      const badSpans = this.editor.querySelectorAll('span[style*="color: red"]');
      badSpans.forEach(s => {
        if(s.textContent.trim() === "") s.remove();
      });
    });
    this.editor.addEventListener('selectionchange', () => {
      this.updateToolbarActiveStates();
      this.saveSelection();
    });
    this.editor.addEventListener('click', this.handleImageClick.bind(this));

    // Add keydown event to clean up empty elements when deleting
    this.editor.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' || e.key === 'Delete') {
            // Небольшая задержка, чтобы браузер успел удалить символ
            setTimeout(() => {
                const emptySpans = this.editor.querySelectorAll('span:empty');
                emptySpans.forEach(span => span.remove());

                // Also remove empty mark tags with data-type="spoiler"
                const emptySpoilers = this.editor.querySelectorAll('mark[data-type="spoiler"]:empty');
                emptySpoilers.forEach(spoiler => spoiler.remove());
            }, 10);
        }

        if (e.key === 'Enter') {
            const selection = window.getSelection();
            const anchorNode = selection.anchorNode.parentElement;

            if (anchorNode && anchorNode.hasAttribute('data-type') && anchorNode.getAttribute('data-type') === 'spoiler') {
                // Если жмем Enter в спойлере - принудительно выходим из него
                e.preventDefault();
                const div = document.createElement('div');
                div.innerHTML = '<br>';
                anchorNode.after(div);

                const range = document.createRange();
                range.setStart(div, 0);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        }
    });

    // Add click handler for spoiler reveal
    this.editor.addEventListener('click', (e) => {
        if (e.target.hasAttribute('data-type') && e.target.getAttribute('data-type') === 'spoiler') {
            // Одиночный клик — просто показываем содержимое (только визуально)
            e.target.classList.toggle('revealed');
        }
    });

    // Add double-click handler for editing inside spoiler
    this.editor.addEventListener('dblclick', (e) => {
        if (e.target.hasAttribute('data-type') && e.target.getAttribute('data-type') === 'spoiler') {
            // Двойной клик — позволяем редактировать текст внутри
            e.target.setAttribute('contenteditable', 'true');
            e.target.focus();
        }
    });

    // Add keyup handler for detecting and removing empty spoiler tags
    this.editor.addEventListener('keyup', (e) => {
        if (e.key === 'Backspace' || e.key === 'Delete') {
            const selection = window.getSelection();
            if (!selection.rangeCount) return;

            // Находим, где находится курсор
            let container = selection.anchorNode;
            if (container.nodeType === 3) container = container.parentElement;

            // Если мы внутри спойлера и он пустой или содержит только невидимый символ
            if (container && container.hasAttribute('data-type') && container.getAttribute('data-type') === 'spoiler') {
                if (container.textContent.length === 0 || container.textContent === '\u200B') {
                    const parent = container.parentNode;
                    const textNode = document.createTextNode('\u00A0'); // Обычный пробел
                    parent.replaceChild(textNode, container);

                    // Ставим курсор на этот пробел и сбрасываем форматирование
                    const range = document.createRange();
                    range.setStart(textNode, 1);
                    range.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(range);

                    // ФИНАЛЬНЫЙ УДАР ПО ЦВЕТАМ
                    document.execCommand('removeFormat', false, null);
                }
            }
        }
    });
  }

  // formatText method is no longer needed as formatting is handled directly in toolbar event listeners

  // Update toolbar active states based on current selection
  updateToolbarActiveStates() {
    if (!this.toolbar) return;

    // Check formatting states using document.queryCommandState
    const boldActive = document.queryCommandState('bold');
    const italicActive = document.queryCommandState('italic');
    const underlineActive = document.queryCommandState('underline');
    const strikethroughActive = document.queryCommandState('strikeThrough');
    const unorderedListActive = document.queryCommandState('insertUnorderedList');
    const orderedListActive = document.queryCommandState('insertOrderedList');

    // First, try to find buttons by their data-command attributes (used in articles.html)
    const commandButtons = [
      { cmd: 'bold', selector: '[data-command="bold"]', state: boldActive },
      { cmd: 'italic', selector: '[data-command="italic"]', state: italicActive },
      { cmd: 'underline', selector: '[data-command="underline"]', state: underlineActive },
      { cmd: 'strikeThrough', selector: '[data-command="strikeThrough"]', state: strikethroughActive },
      { cmd: 'insertUnorderedList', selector: '[data-command="insertUnorderedList"]', state: unorderedListActive },
      { cmd: 'insertOrderedList', selector: '[data-command="insertOrderedList"]', state: orderedListActive }
    ];

    commandButtons.forEach(item => {
      const button = this.toolbar.querySelector(item.selector);
      if (button) {
        if (item.cmd === 'insertUnorderedList') {
          // Special handling for list buttons to ensure mutual exclusivity
          button.classList.toggle('active', item.state && !orderedListActive);
        } else if (item.cmd === 'insertOrderedList') {
          // Special handling for list buttons to ensure mutual exclusivity
          button.classList.toggle('active', item.state && !unorderedListActive);
        } else {
          button.classList.toggle('active', item.state);
        }
      }
    });

    // Handle alignment buttons separately since queryCommandState is unreliable for alignment
    this.updateAlignmentButtonStates();

    // Fallback to ID-based selectors for backward compatibility
    const idButtons = [
      { cmd: 'bold', selector: '#bold-btn', state: boldActive },
      { cmd: 'italic', selector: '#italic-btn', state: italicActive },
      { cmd: 'underline', selector: '#underline-btn', state: underlineActive },
      { cmd: 'strikeThrough', selector: '#strike-btn', state: strikethroughActive },
      { cmd: 'insertUnorderedList', selector: '#list-btn', state: unorderedListActive },
      { cmd: 'insertOrderedList', selector: '#ordered-list-btn', state: orderedListActive }
    ];

    idButtons.forEach(item => {
      const button = document.querySelector(item.selector);
      if (button) {
        if (item.cmd === 'insertUnorderedList') {
          // Special handling for list buttons to ensure mutual exclusivity
          button.classList.toggle('active', item.state && !orderedListActive);
        } else if (item.cmd === 'insertOrderedList') {
          // Special handling for list buttons to ensure mutual exclusivity
          button.classList.toggle('active', item.state && !unorderedListActive);
        } else {
          button.classList.toggle('active', item.state);
        }
      }
    });
  }

  // Update alignment button states based on current selection (since queryCommandState is unreliable for alignment)
  updateAlignmentButtonStates() {
    if (!this.toolbar) return;

    const selection = window.getSelection();
    if (!selection.rangeCount) return;

    const range = selection.getRangeAt(0);
    let element = range.commonAncestorContainer;

    // If the selection is a text node, get its parent element
    if (element.nodeType === Node.TEXT_NODE) {
      element = element.parentElement;
    }

    // Walk up the DOM tree to find the nearest block element
    while (element && element !== this.editor) {
      if (element.nodeType === Node.ELEMENT_NODE &&
          ['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE'].includes(element.tagName)) {
        break;
      }
      element = element.parentElement;
    }

    // Reset all alignment buttons
    const alignButtons = [
      { cmd: 'justifyLeft', selector: '[data-command="justifyLeft"]' },
      { cmd: 'justifyCenter', selector: '[data-command="justifyCenter"]' },
      { cmd: 'justifyRight', selector: '[data-command="justifyRight"]' }
    ];

    alignButtons.forEach(item => {
      const button = this.toolbar.querySelector(item.selector);
      if (button) {
        button.classList.remove('active');
      }
    });

    // If we found a block element, check its text-align style
    if (element && element !== this.editor) {
      // Check inline styles first (which we set directly)
      let textAlign = element.style.textAlign;

      // If no inline style, check computed style
      if (!textAlign) {
        const computedStyle = window.getComputedStyle(element);
        textAlign = computedStyle.textAlign;
      }

      // Activate the appropriate alignment button based on text-align value
      let activeButtonSelector;
      switch (textAlign) {
        case 'left':
          activeButtonSelector = '[data-command="justifyLeft"]';
          break;
        case 'center':
          activeButtonSelector = '[data-command="justifyCenter"]';
          break;
        case 'right':
          activeButtonSelector = '[data-command="justifyRight"]';
          break;
        default:
          // If no specific alignment or it's 'start'/'justify', don't activate any button
          return;
      }

      const activeButton = this.toolbar.querySelector(activeButtonSelector);
      if (activeButton) {
        activeButton.classList.add('active');
      }
    }
  }


  updateToolbarStyles() {
    // Alias for updateToolbarActiveStates for backward compatibility
    this.updateToolbarActiveStates();
  }

  // Function to insert image from file
  async insertImageFromPC() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';

    fileInput.onchange = async (event) => {
      const file = event.target.files[0];
      if (file) {
        // Validate file type and size
        if (!file.type.startsWith('image/')) {
          showMessage('Пожалуйста, выберите файл изображения', 'error');
          return;
        }

        const maxSize = 5 * 1024 * 1024; // 5MB
        if (file.size > maxSize) {
          showMessage('Размер файла превышает допустимый лимит (5MB)', 'error');
          return;
        }

        try {
          const result = await apiClient.uploadImage(file);
          if (result.success) {
            this.insertImageToEditor(result.data.url);
          } else {
            showMessage('Ошибка при загрузке изображения: ' + result.error, 'error');
          }
        } catch (error) {
          console.error('Error:', error);
          showMessage('Произошла ошибка при загрузке изображения', 'error');
        }
      }
    };

    fileInput.click();
  }

  // Function to insert link
  insertLink() {
    const url = prompt("Введите URL ссылки:");
    if(url) {
      // Focus back to editor and restore saved selection before inserting link
      if (this.editor) {
        this.editor.focus();

        // If we have a saved range, restore it before inserting
        if (this.savedRange) {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(this.savedRange);
        }
      }

      document.execCommand('createLink', false, url);
      if (this.editor) {
        this.editor.focus();
      }
    }
  }

  // Apply class to selected text
  applyClassToSelection(className) {
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);

    let element;
    if (className === 'spoiler-text') {
      // For spoiler, use mark tag with data-type attribute
      element = document.createElement('mark');
      element.setAttribute('data-type', 'spoiler');
    } else {
      element = document.createElement('span');
      element.classList.add(className);
    }

    // For spoiler, add click handler to reveal it in editor
    if (className === 'spoiler-text') {
      element.title = "Кликните, чтобы увидеть";
      element.onclick = (e) => {
        e.stopPropagation();
        element.classList.toggle('revealed');
      };
    }

    try {
      // Оборачиваем выделенный текст
      element.appendChild(range.extractContents());
      range.insertNode(element);

      // Выход из спойлера: добавляем чистый текст после него
      const afterNode = document.createTextNode('\u00A0');
      element.after(afterNode);

      const newRange = document.createRange();
      newRange.setStartAfter(afterNode);
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);

      // ПРИНУДИТЕЛЬНЫЙ СБРОС ЦВЕТА (убирает синий и красный)
      document.execCommand('removeFormat', false, null);
      this.editor.focus();
    } catch (e) {
      console.error("Не удалось применить стиль:", e);
    }

    // Focus back to editor
    if (this.editor) {
      this.editor.focus();
    }
  }

  // Function to insert image from URL
  insertImageFromURL() {
    const imageUrl = prompt('Введите URL изображения:');
    if (imageUrl) {
      this.insertImageToEditor(imageUrl);
    }
  }

  // Insert image into editor
  insertImageToEditor(imageUrl) {
    const imgElement = document.createElement('img');
    imgElement.src = imageUrl;
    imgElement.style.maxWidth = '100%';
    imgElement.style.maxHeight = '75vh';  // ограничиваем высоту, чтобы панель управления всегда была видна
    imgElement.style.borderRadius = '4px';
    imgElement.style.margin = '10px 0';
    imgElement.alt = 'Изображение';
    imgElement.className = 'article-inline-image';

    // Create wrapper container for the image
    const imageWrapper = document.createElement('div');
    imageWrapper.className = 'image-wrapper';
    imageWrapper.style.position = 'relative';
    imageWrapper.style.display = 'block';
    imageWrapper.appendChild(imgElement);

    // Focus back to editor and restore saved selection before inserting
    if (this.editor) {
      this.editor.focus();

      // If we have a saved range, restore it before inserting
      if (this.savedRange) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(this.savedRange);
      }
    }

    // Insert the wrapped container at the current cursor position
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(imageWrapper);
    } else {
      // If no selection, add to the end of content
      if (this.editor) {
        this.editor.appendChild(imageWrapper);
      }
    }

    // Add the wrapper to our tracking set
    this.imageWrappers.add(imageWrapper);

    // Add click handler to the image
    imgElement.addEventListener('click', this.handleImageClick.bind(this));

    // Focus back to editor after insertion
    if (this.editor) {
      this.editor.focus();
    }
  }

  // Handle image click to show controls
  handleImageClick(event) {
    // Hide all existing image controls
    this.hideAllImageControls();

    const clickedElement = event.target;

    // If click was on an image
    if (clickedElement.tagName === 'IMG' && clickedElement.classList.contains('article-inline-image')) {
      event.stopPropagation();

      const wrapper = clickedElement.parentElement;
      if (wrapper && wrapper.classList.contains('image-wrapper')) {
        // Check if controls panel already exists
        let controlPanel = wrapper.querySelector('.image-control-panel');

        if (!controlPanel) {
          // Create new controls panel
          controlPanel = this.createImageControlPanel(clickedElement);
          wrapper.appendChild(controlPanel);
        }

        // Show the controls panel and adjust its position
        setTimeout(() => {
          this.adjustControlPanelPosition(wrapper, controlPanel);
          controlPanel.style.opacity = '1';
        }, 0);
      }
    }
    // If click was outside image and its controls
    else if (!clickedElement.classList.contains('image-control-button') &&
             !clickedElement.classList.contains('image-size-option') &&
             clickedElement.closest('.image-control-panel') === null &&
             clickedElement.closest('.image-size-menu') === null) {
      // Hide all controls
      this.hideAllImageControls();
    }
  }

  // Create image controls panel
  createImageControlPanel(imgElement) {
    // Create container for control buttons
    const controlPanel = document.createElement('div');
    controlPanel.className = 'image-control-panel';
    controlPanel.style.position = 'absolute';
    controlPanel.style.top = '5px';
    controlPanel.style.right = '5px';
    controlPanel.style.display = 'flex';
    controlPanel.style.gap = '5px';
    controlPanel.style.zIndex = '1000';
    controlPanel.style.opacity = '0';
    controlPanel.style.transition = 'opacity 0.2s ease';

    // Settings button - opens modal editor
    const settingsButton = document.createElement('button');
    settingsButton.type = 'button';
    settingsButton.className = 'image-control-button';
    settingsButton.innerHTML = '⚙️';
    settingsButton.title = 'Настройки изображения';
    settingsButton.onclick = (e) => {
      e.stopPropagation();
      this.openImageEditorModal(imgElement);
    };

    // Delete button
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'image-control-button';
    deleteButton.innerHTML = '🗙';
    deleteButton.title = 'Удалить изображение';
    deleteButton.onclick = (e) => {
      e.stopPropagation();
      if (confirm('Вы уверены, что хотите удалить это изображение?')) {
        const wrapper = imgElement.parentElement;
        wrapper.remove();
        this.hideAllImageControls();
      }
    };

    controlPanel.appendChild(settingsButton);
    controlPanel.appendChild(deleteButton);

    return controlPanel;
  }

  // Create image size menu
  createImageSizeMenu(imgElement) {
    const sizeMenu = document.createElement('div');
    sizeMenu.className = 'image-size-menu';
    sizeMenu.style.display = 'none';

    // Calculate max size based on screen width
    const maxWidthForScreen = Math.floor(window.innerWidth * 0.8) + 'px'; // 80% screen width

    const sizeOptions = [
      { name: 'Маленький', value: '300px' },
      { name: 'Средний', value: '600px' },
      { name: 'Большой', value: '100%' },
      { name: 'На экран', value: maxWidthForScreen }
    ];

    sizeOptions.forEach(size => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'image-size-option';
      button.textContent = size.name;
      button.style.display = 'block';
      button.style.width = '100%';
      button.style.padding = '5px';
      button.style.margin = '2px 0';
      button.style.border = 'none';
      button.style.background = 'var(--background-tertiary)';
      button.style.color = 'var(--text-normal)';
      button.style.borderRadius = '3px';
      button.style.cursor = 'pointer';
      button.onclick = (e) => {
        e.stopPropagation();
        this.changeImageSize(imgElement, size.value);
        sizeMenu.style.display = 'none';
      };

      sizeMenu.appendChild(button);
    });

    return sizeMenu;
  }

  // Change image size
  changeImageSize(imgElement, size) {
    if (typeof size === 'string') {
      if (size === 'none') {
        imgElement.style.maxWidth = '100%';  // Limit width but preserve original size
        imgElement.style.width = 'auto';
      } else if (size.endsWith('%') || size.endsWith('px')) {
        // Set max width limit to prevent controls from going off screen
        if (size.endsWith('px')) {
          const pxValue = parseInt(size);
          if (pxValue > window.innerWidth * 0.8) {  // no more than 80% screen width
            imgElement.style.maxWidth = (window.innerWidth * 0.8) + 'px';
          } else {
            imgElement.style.maxWidth = size;
          }
        } else {
          imgElement.style.maxWidth = size;
        }
      } else {
        // Support for legacy values
        switch(size) {
          case 'small':
            imgElement.style.maxWidth = '300px';
            break;
          case 'medium':
            imgElement.style.maxWidth = '600px';
            break;
          case 'large':
            imgElement.style.maxWidth = '100%';
            break;
          case 'original':
            imgElement.style.maxWidth = '100%';  // Limit to prevent going off screen
            break;
        }
      }
    }
  }

  // Function to hide all image controls
  hideAllImageControls() {
    document.querySelectorAll('.image-control-panel').forEach(panel => {
      panel.style.opacity = '0';
    });
    document.querySelectorAll('.image-size-menu').forEach(menu => {
      menu.style.display = 'none';
    });
  }

  // Function to wrap existing images in the editor
  wrapExistingImages() {
    if (!this.editor) return;

    // Find all images in the editor that aren't wrapped
    const images = this.editor.querySelectorAll('img:not(.article-inline-image)');

    images.forEach(img => {
      // Check if already wrapped
      if (img.parentElement && img.parentElement.classList.contains('image-wrapper')) {
        return; // Already wrapped, skip
      }

      // Create wrapper container
      const imageWrapper = document.createElement('div');
      imageWrapper.className = 'image-wrapper';
      imageWrapper.style.position = 'relative';
      imageWrapper.style.display = 'block';

      // Replace image with wrapped version
      if (img.parentNode) {
        img.parentNode.replaceChild(imageWrapper, img);
        imageWrapper.appendChild(img);
      }

      // Add styling class and click handler
      if (!img.classList.contains('article-inline-image')) {
        img.classList.add('article-inline-image');
        img.style.maxWidth = '100%';
        img.style.height = 'auto';

        // Add click handler for image management
        img.addEventListener('click', this.handleImageClick.bind(this));
      }

      // Add to tracking set
      this.imageWrappers.add(imageWrapper);
    });
  }

  // Function to adjust controls panel position to prevent going off screen
  adjustControlPanelPosition(wrapper, controlPanel) {
    // Ensure controls panel is displayed to measure its dimensions
    controlPanel.style.visibility = 'hidden';
    controlPanel.style.opacity = '1';
    controlPanel.style.display = 'flex';

    // Measure dimensions
    const panelRect = controlPanel.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();

    // Calculate position in document coordinates
    let top = 5; // top margin
    let right = 5; // right margin

    // Check if panel would go off the right edge of the window
    if (wrapperRect.right - right - panelRect.width < 0) {
      right = wrapperRect.right - 5; // Set margin so panel stays inside
      controlPanel.style.right = right + 'px';
      controlPanel.style.left = 'auto';
    } else {
      controlPanel.style.right = right + 'px';
      controlPanel.style.left = 'auto';
    }

    // Check if panel would go off the left edge of the window
    if (wrapperRect.left + right + panelRect.width > window.innerWidth) {
      // If controls panel goes off edges, move it to the left of the image
      const newRight = -(panelRect.width + 5);
      controlPanel.style.right = newRight + 'px';
      controlPanel.style.left = 'auto';
    }

    // Check if panel would go off the top edge
    if (wrapperRect.top + top < 0) {
      top = -wrapperRect.top + 5; // Correct position
      controlPanel.style.top = Math.max(5, top) + 'px';
    } else {
      controlPanel.style.top = top + 'px';
    }

    // Restore visibility
    controlPanel.style.visibility = 'visible';
  }

  // Handle clicks outside the editor to hide controls
  handleDocumentClick(event) {
    if (this.editor && !this.editor.contains(event.target)) {
      this.hideAllImageControls();
    }
  }

  // Handle window resize to adjust controls
  handleResize() {
    this.hideAllImageControls();
  }

  // Open compact image editor popup (no modal)
  openImageEditorModal(imgElement) {
    // Hide all controls first
    this.hideAllImageControls();
    
    // Get current image properties
    const currentWidth = imgElement.getAttribute('data-width') || imgElement.style.maxWidth || imgElement.style.width || '100%';
    const wrapper = imgElement.parentElement;
    const currentAlign = wrapper.style.textAlign || 
                         (wrapper.style.display === 'flex' ? 
                          (wrapper.style.justifyContent === 'flex-end' ? 'right' : 
                           wrapper.style.justifyContent === 'center' ? 'center' : 'left') : 
                          'center');
    const currentAlt = imgElement.alt || '';
    const captionElement = wrapper.querySelector('.image-caption');
    const currentCaption = captionElement ? captionElement.textContent : '';
    
    // Create compact popup menu
    const popup = document.createElement('div');
    popup.className = 'image-editor-popup';
    popup.style.cssText = 'position:absolute;background:var(--background-secondary);border:1px solid var(--background-accent);border-radius:8px;padding:12px;box-shadow:0 4px 16px rgba(0,0,0,0.4);z-index:1001;min-width:280px;max-width:320px;';
    
    // Position popup directly under the settings button
    const settingsBtn = wrapper.querySelector('button[title="Настройки изображения"]');
    if (settingsBtn) {
      const btnRect = settingsBtn.getBoundingClientRect();
      
      // Append temporarily to get dimensions
      popup.style.visibility = 'hidden';
      document.body.appendChild(popup);
      
      const actualPopupRect = popup.getBoundingClientRect();
      
      // Position exactly under the button, aligned to the right edge of the button
      let top = btnRect.bottom + window.scrollY + 5;
      let left = btnRect.right + window.scrollX - actualPopupRect.width;
      
      // Adjust if goes off screen horizontally
      if (left < 10) {
        left = btnRect.left + window.scrollX;
      }
      
      // Adjust if goes off screen vertically (show above instead)
      if (top + actualPopupRect.height > window.innerHeight + window.scrollY) {
        top = btnRect.top + window.scrollY - actualPopupRect.height - 5;
      }
      
      popup.style.top = top + 'px';
      popup.style.left = left + 'px';
      popup.style.visibility = 'visible';
    }
    
    // Store temp values
    let tempWidth = currentWidth;
    let tempAlign = currentAlign;
    let tempAlt = currentAlt;
    let tempCaption = currentCaption;
    
    // Size section
    const sizeSection = document.createElement('div');
    sizeSection.style.marginBottom = '12px';
    
    const sizeLabel = document.createElement('div');
    sizeLabel.textContent = 'Размер';
    sizeLabel.style.cssText = 'color:var(--text-muted);font-size:12px;font-weight:600;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;';
    sizeSection.appendChild(sizeLabel);
    
    const sizePresets = document.createElement('div');
    sizePresets.style.display = 'grid';
    sizePresets.style.gridTemplateColumns = '1fr 1fr';
    sizePresets.style.gap = '6px';
    
    const presets = [
      { name: 'Мал.', value: '300px' },
      { name: 'Сред.', value: '500px' },
      { name: 'Бол.', value: '800px' },
      { name: '100%', value: '100%' }
    ];
    
    presets.forEach(preset => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = preset.name;
      btn.style.cssText = 'padding:6px 8px;border:1px solid var(--background-accent);border-radius:4px;background:(tempWidth === preset.value) ? var(--blurple) : var(--background-tertiary);color:(tempWidth === preset.value) ? #fff : var(--text-normal);cursor:pointer;font-size:12px;transition:all 0.2s;';
      btn.style.backgroundColor = (currentWidth === preset.value) ? 'var(--blurple)' : 'var(--background-tertiary)';
      btn.style.color = (currentWidth === preset.value) ? '#fff' : 'var(--text-normal)';
      
      btn.onmouseover = () => {
        if (tempWidth !== preset.value) {
          btn.style.backgroundColor = 'var(--background-modifier-selected)';
        }
      };
      btn.onmouseout = () => {
        if (tempWidth !== preset.value) {
          btn.style.backgroundColor = 'var(--background-tertiary)';
        }
      };
      
      btn.onclick = (e) => {
        e.stopPropagation();
        tempWidth = preset.value;
        // Apply immediately
        this.applyImageSize(imgElement, wrapper, preset.value);
        // Update button states
        Array.from(sizePresets.children).forEach(child => {
          child.style.backgroundColor = 'var(--background-tertiary)';
          child.style.color = 'var(--text-normal)';
        });
        btn.style.backgroundColor = 'var(--blurple)';
        btn.style.color = '#fff';
      };
      
      sizePresets.appendChild(btn);
    });
    
    sizeSection.appendChild(sizePresets);
    
    // Custom width slider
    const sliderContainer = document.createElement('div');
    sliderContainer.style.marginTop = '10px';
    
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '100';
    slider.max = '1200';
    slider.value = parseInt(currentWidth) || 500;
    slider.style.cssText = 'width:100%;cursor:pointer;';
    
    const sliderValue = document.createElement('div');
    sliderValue.textContent = `${slider.value}px`;
    sliderValue.style.cssText = 'text-align:right;color:var(--text-muted);font-size:11px;margin-top:4px;';
    
    slider.oninput = (e) => {
      e.stopPropagation();
      const val = `${slider.value}px`;
      sliderValue.textContent = val;
      tempWidth = val;
      this.applyImageSize(imgElement, wrapper, val);
      // Reset preset buttons
      Array.from(sizePresets.children).forEach(child => {
        child.style.backgroundColor = 'var(--background-tertiary)';
        child.style.color = 'var(--text-normal)';
      });
    };
    
    sliderContainer.appendChild(slider);
    sliderContainer.appendChild(sliderValue);
    sizeSection.appendChild(sliderContainer);
    popup.appendChild(sizeSection);
    
    // Alignment section
    const alignSection = document.createElement('div');
    alignSection.style.marginBottom = '12px';
    
    const alignLabel = document.createElement('div');
    alignLabel.textContent = 'Выравнивание';
    alignLabel.style.cssText = 'color:var(--text-muted);font-size:12px;font-weight:600;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;';
    alignSection.appendChild(alignLabel);
    
    const alignButtons = document.createElement('div');
    alignButtons.style.display = 'flex';
    alignButtons.style.gap = '6px';
    
    const alignOptions = [
      { icon: '⬅️', value: 'left', title: 'Слева' },
      { icon: '↕️', value: 'center', title: 'По центру' },
      { icon: '➡️', value: 'right', title: 'Справа' }
    ];
    
    alignOptions.forEach(option => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = option.icon;
      btn.title = option.title;
      btn.style.cssText = 'flex:1;padding:8px;border:1px solid var(--background-accent);border-radius:4px;background:(tempAlign === option.value) ? var(--blurple) : var(--background-tertiary);color:(tempAlign === option.value) ? #fff : var(--text-normal);cursor:pointer;font-size:14px;transition:all 0.2s;';
      btn.style.backgroundColor = (currentAlign === option.value) ? 'var(--blurple)' : 'var(--background-tertiary)';
      btn.style.color = (currentAlign === option.value) ? '#fff' : 'var(--text-normal)';
      
      btn.onmouseover = () => {
        if (tempAlign !== option.value) {
          btn.style.backgroundColor = 'var(--background-modifier-selected)';
        }
      };
      btn.onmouseout = () => {
        if (tempAlign !== option.value) {
          btn.style.backgroundColor = 'var(--background-tertiary)';
        }
      };
      
      btn.onclick = (e) => {
        e.stopPropagation();
        tempAlign = option.value;
        this.applyAlignment(imgElement, wrapper, option.value);
        // Update button states
        Array.from(alignButtons.children).forEach(child => {
          child.style.backgroundColor = 'var(--background-tertiary)';
          child.style.color = 'var(--text-normal)';
        });
        btn.style.backgroundColor = 'var(--blurple)';
        btn.style.color = '#fff';
      };
      
      alignButtons.appendChild(btn);
    });
    
    alignSection.appendChild(alignButtons);
    popup.appendChild(alignSection);
    
    // Alt text section
    const altSection = document.createElement('div');
    altSection.style.marginBottom = '12px';
    
    const altLabel = document.createElement('div');
    altLabel.textContent = 'ALT текст';
    altLabel.style.cssText = 'color:var(--text-muted);font-size:12px;font-weight:600;margin-bottom:6px;';
    altSection.appendChild(altLabel);
    
    const altInput = document.createElement('input');
    altInput.type = 'text';
    altInput.value = currentAlt;
    altInput.placeholder = 'Описание изображения';
    altInput.style.cssText = 'width:100%;padding:6px 8px;border:1px solid var(--background-accent);border-radius:4px;background:var(--background-tertiary);color:var(--text-normal);font-size:12px;box-sizing:border-box;';
    
    altInput.oninput = (e) => {
      e.stopPropagation();
      tempAlt = altInput.value;
      imgElement.alt = altInput.value;
    };
    
    altSection.appendChild(altInput);
    popup.appendChild(altSection);
    
    // Caption section
    const captionSection = document.createElement('div');
    captionSection.style.marginBottom = '12px';
    
    const captionLabel = document.createElement('div');
    captionLabel.textContent = 'Подпись';
    captionLabel.style.cssText = 'color:var(--text-muted);font-size:12px;font-weight:600;margin-bottom:6px;';
    captionSection.appendChild(captionLabel);
    
    const captionInput = document.createElement('textarea');
    captionInput.value = currentCaption;
    captionInput.placeholder = 'Подпись под изображением';
    captionInput.style.cssText = 'width:100%;padding:6px 8px;border:1px solid var(--background-accent);border-radius:4px;background:var(--background-tertiary);color:var(--text-normal);font-size:12px;resize:vertical;min-height:50px;box-sizing:border-box;';
    
    captionInput.oninput = (e) => {
      e.stopPropagation();
      tempCaption = captionInput.value;
      this.updateCaption(wrapper, captionInput.value);
    };
    
    captionSection.appendChild(captionInput);
    popup.appendChild(captionSection);
    
    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Закрыть';
    closeBtn.style.cssText = 'width:100%;padding:8px;border:none;border-radius:4px;background:var(--background-accent);color:var(--text-normal);cursor:pointer;font-size:12px;font-weight:500;transition:all 0.2s;';
    
    closeBtn.onmouseover = () => {
      closeBtn.style.backgroundColor = 'var(--background-modifier-selected)';
    };
    closeBtn.onmouseout = () => {
      closeBtn.style.backgroundColor = 'var(--background-accent)';
    };
    
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      popup.remove();
    };
    
    popup.appendChild(closeBtn);
    
    // Add click outside to close
    const closeOnClickOutside = (e) => {
      if (!popup.contains(e.target)) {
        popup.remove();
        document.removeEventListener('click', closeOnClickOutside);
      }
    };
    
    // Delay adding the listener so the current click doesn't trigger it
    setTimeout(() => {
      document.addEventListener('click', closeOnClickOutside);
    }, 10);
    
    document.body.appendChild(popup);
  }
  
  // Apply image size
  applyImageSize(imgElement, wrapper, size) {
    if (size === '100%') {
      imgElement.style.width = '100%';
      imgElement.style.maxWidth = 'none';
      wrapper.style.width = '100%';
    } else {
      imgElement.style.width = size;
      imgElement.style.maxWidth = size;
      wrapper.style.width = size;
    }
    imgElement.setAttribute('data-width', size);
    
    // Update caption max-width to match image barrier
    const caption = wrapper.querySelector('.image-caption');
    if (caption) {
      caption.style.maxWidth = wrapper.style.width || '100%';
    }
  }
  
  // Apply alignment - wrapper acts as barrier for text
  applyAlignment(imgElement, wrapper, align) {
    // Сбрасываем только margins, сохраняя display: inline-block
    wrapper.style.marginLeft = '';
    wrapper.style.marginRight = '';
    imgElement.style.float = '';
    
    // Wrapper всегда inline-block для ограничения текста
    wrapper.style.display = 'inline-block';
    wrapper.style.verticalAlign = 'top';
    wrapper.style.maxWidth = '100%';
    wrapper.style.marginBottom = '10px';
    
    if (align === 'left') {
      wrapper.style.marginLeft = '0';
      wrapper.style.marginRight = 'auto';
    } else if (align === 'right') {
      wrapper.style.marginLeft = 'auto';
      wrapper.style.marginRight = '0';
    } else {
      // Center
      wrapper.style.marginLeft = 'auto';
      wrapper.style.marginRight = 'auto';
    }
    
    // Обновляем выравнивание подписи - всегда по центру относительно картинки
    const caption = wrapper.querySelector('.image-caption');
    if (caption) {
      caption.style.display = 'block';
      caption.style.marginLeft = 'auto';
      caption.style.marginRight = 'auto';
      caption.style.textAlign = 'center';
      caption.style.width = '100%';
    }
  }

  
  // Update caption
  updateCaption(wrapper, text) {
    // Remove old caption
    let oldCap = wrapper.querySelector('.image-caption');
    if (oldCap) oldCap.remove();
    
    if (text && text.trim()) {
      const newCap = document.createElement('div');
      newCap.className = 'image-caption';
      newCap.style.cssText = 'text-align:center;margin-top:8px;color:var(--text-muted);font-size:13px;font-style:italic;max-width:100%;';
      newCap.textContent = text;
      wrapper.appendChild(newCap);
    }
  }
    
  // Clean up editor when leaving the page
  cleanup() {
    // Remove all image wrappers from tracking
    this.imageWrappers.clear();
    
    // Hide all controls
    this.hideAllImageControls();
  }
}

// Create global instance
const editorManager = new EditorManager();

// Export for use in other modules
window.editorManager = editorManager;