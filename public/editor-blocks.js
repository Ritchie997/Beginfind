(function () {
  'use strict';

  function genBlockId() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  const TYPE_LABELS = {
    paragraph: 'Текст',
    heading: 'Заголовок',
    quote: 'Цитата',
    code: 'Код',
    list: 'Список',
    divider: 'Линия',
    callout: 'Плашка',
    table: 'Таблица',
    image: 'Картинка',
    audio: 'Аудио',
    columns: 'Колонки',
    infobox: 'Инфобокс',
    'spoiler-section': 'Спойлер-секция',
    map: 'Карта'
  };

  function blockTypeTag(block) {
    if (!block) return '';
    if (block.type === 'heading') return 'Заголовок H' + ((block.data && block.data.level) || 2);
    if (block.type === 'list') {
      const style = block.data && block.data.style;
      const styles = { bullet: 'Список', ordered: 'Нумерованный список', checklist: 'Чек-лист' };
      return styles[style] || 'Список';
    }
    if (block.type === 'callout') {
      const variant = block.data && block.data.variant;
      const variants = { info: 'Плашка', tip: 'Совет', warning: 'Предупреждение' };
      return variants[variant] || 'Плашка';
    }
    return TYPE_LABELS[block.type] || block.type;
  }

  function cloneBlock(block) {
    if (!block) return null;
    const cloned = JSON.parse(JSON.stringify(block));
    cloned.id = genBlockId();
    if (cloned.data && Array.isArray(cloned.data.items)) {
      cloned.data.items = cloned.data.items.map(function (it) {
        return Object.assign({}, it, { id: genBlockId() });
      });
    }
    if (cloned.data && Array.isArray(cloned.data.blocks)) {
      cloned.data.blocks = cloned.data.blocks.map(cloneBlock);
    }
    if (cloned.data && Array.isArray(cloned.data.columns)) {
      cloned.data.columns = cloned.data.columns.map(function (col) {
        const c = Object.assign({}, col);
        if (Array.isArray(c.blocks)) c.blocks = c.blocks.map(cloneBlock);
        return c;
      });
    }
    return cloned;
  }

  function createBlock(type, initialData) {
    const block = {
      id: genBlockId(),
      type: type || 'paragraph',
      data: Object.assign({}, initialData)
    };
    if (block.type === 'paragraph' && typeof block.data.markdown !== 'string') {
      block.data.markdown = '';
    } else if (block.type === 'heading') {
      if (!block.data.level) block.data.level = 2;
      if (typeof block.data.markdown !== 'string') block.data.markdown = '';
    } else if (block.type === 'quote' && typeof block.data.markdown !== 'string') {
      block.data.markdown = '';
    } else if (block.type === 'list') {
      if (!block.data.style) block.data.style = 'bullet';
      if (!Array.isArray(block.data.items) || !block.data.items.length) {
        block.data.items = [{ id: genBlockId(), markdown: '', checked: false, indent: 0 }];
      }
    } else if (block.type === 'divider') {
      // no specific data
    } else if (block.type === 'code') {
      if (typeof block.data.language !== 'string') block.data.language = '';
      if (typeof block.data.code !== 'string') block.data.code = '';
    } else if (block.type === 'callout') {
      if (!block.data.variant) block.data.variant = 'info';
      if (typeof block.data.title !== 'string') block.data.title = '';
      if (typeof block.data.markdown !== 'string') block.data.markdown = '';
    } else if (block.type === 'audio') {
      if (typeof block.data.src !== 'string') block.data.src = '';
      if (typeof block.data.title !== 'string') block.data.title = '';
      if (typeof block.data.artist !== 'string') block.data.artist = '';
    }
    return block;
  }

  function moveBlockInList(list, blockOrId, dir) {
    if (!Array.isArray(list) || !list.length) return { moved: false };
    const id = typeof blockOrId === 'string' ? blockOrId : (blockOrId && blockOrId.id);
    const idx = list.findIndex(function (b) { return b.id === id; });
    if (idx === -1) return { moved: false };
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= list.length) return { moved: false };
    const item = list.splice(idx, 1)[0];
    list.splice(targetIdx, 0, item);
    return { moved: true, oldIndex: idx, newIndex: targetIdx, block: item };
  }

  function duplicateBlockInList(list, blockOrId) {
    if (!Array.isArray(list) || !list.length) return { duplicated: false };
    const id = typeof blockOrId === 'string' ? blockOrId : (blockOrId && blockOrId.id);
    const idx = list.findIndex(function (b) { return b.id === id; });
    if (idx === -1) return { duplicated: false };
    const cloned = cloneBlock(list[idx]);
    list.splice(idx + 1, 0, cloned);
    return { duplicated: true, newBlock: cloned, newIndex: idx + 1 };
  }

  function removeBlockFromList(list, blockOrId, ensureMinimumParagraph) {
    if (!Array.isArray(list) || !list.length) return { removed: false };
    const id = typeof blockOrId === 'string' ? blockOrId : (blockOrId && blockOrId.id);
    const idx = list.findIndex(function (b) { return b.id === id; });
    if (idx === -1) return { removed: false };
    const removed = list.splice(idx, 1)[0];
    if (list.length === 0 && ensureMinimumParagraph !== false) {
      list.push(createBlock('paragraph', { markdown: '' }));
    }
    return { removed: true, removedBlock: removed, remainingCount: list.length };
  }

  let activeActionMenu = null;
  let activeActionMenuDocHandler = null;

  function closeBlockActionMenu() {
    if (activeActionMenu) {
      activeActionMenu.remove();
      activeActionMenu = null;
    }
    if (activeActionMenuDocHandler) {
      document.removeEventListener('click', activeActionMenuDocHandler, true);
      document.removeEventListener('keydown', activeActionMenuDocHandler, true);
      activeActionMenuDocHandler = null;
    }
  }

  function openBlockActionMenu(anchorBtn, opts) {
    closeBlockActionMenu();
    if (!anchorBtn) return;
    opts = opts || {};

    const menu = document.createElement('div');
    menu.className = 'eb-block-action-menu';

    const list = opts.list || [];
    const block = opts.block;
    let idx = opts.index;
    if (typeof idx !== 'number' && block && Array.isArray(list)) {
      idx = list.findIndex(function (b) { return b.id === block.id; });
    }

    // 1. Вверх
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.innerHTML = '<i class="fas fa-arrow-up"></i> <span>Переместить вверх</span>';
    upBtn.disabled = idx <= 0;
    upBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeBlockActionMenu();
      if (opts.onMove) opts.onMove(-1);
    });
    menu.appendChild(upBtn);

    // 2. Вниз
    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.innerHTML = '<i class="fas fa-arrow-down"></i> <span>Переместить вниз</span>';
    downBtn.disabled = idx === -1 || idx >= list.length - 1;
    downBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeBlockActionMenu();
      if (opts.onMove) opts.onMove(1);
    });
    menu.appendChild(downBtn);

    // 3. Дублировать
    const dupBtn = document.createElement('button');
    dupBtn.type = 'button';
    dupBtn.innerHTML = '<i class="fas fa-copy"></i> <span>Дублировать блок</span>';
    dupBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeBlockActionMenu();
      if (opts.onDuplicate) opts.onDuplicate();
    });
    menu.appendChild(dupBtn);

    // Дополнительные пункты (копирование в буфер, вставка, выделение и т.д.)
    if (typeof opts.getExtraMenuItems === 'function') {
      const extras = opts.getExtraMenuItems() || [];
      extras.forEach(function (it) {
        if (!it) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.innerHTML = '<i class="fas ' + (it.icon || 'fa-circle') + '"></i> <span>' + it.label + '</span>';
        if (it.disabled) btn.disabled = true;
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          closeBlockActionMenu();
          if (it.action) it.action();
        });
        menu.appendChild(btn);
      });
    }

    // 4. Удалить
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'eb-action-danger';
    delBtn.innerHTML = '<i class="fas fa-trash"></i> <span>Удалить блок</span>';
    delBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeBlockActionMenu();
      if (opts.onRemove) opts.onRemove();
    });
    menu.appendChild(delBtn);

    document.body.appendChild(menu);
    activeActionMenu = menu;

    const rect = anchorBtn.getBoundingClientRect();
    let top = rect.bottom + 4;
    let left = rect.left;

    // Предотвратить вылет за границы окна
    const menuRect = menu.getBoundingClientRect();
    if (left + menuRect.width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - menuRect.width - 8);
    }
    if (top + menuRect.height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - menuRect.height - 4);
    }
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';

    activeActionMenuDocHandler = function (ev) {
      if (ev.type === 'keydown' && ev.key === 'Escape') {
        closeBlockActionMenu();
        return;
      }
      if (!menu.contains(ev.target) && ev.target !== anchorBtn) {
        closeBlockActionMenu();
      }
    };

    setTimeout(function () {
      document.addEventListener('click', activeActionMenuDocHandler, true);
      document.addEventListener('keydown', activeActionMenuDocHandler, true);
    }, 10);
  }

  function renderBlockControls(opts) {
    opts = opts || {};
    const block = opts.block;
    const list = opts.list || [];
    let idx = opts.index;
    if (typeof idx !== 'number' && block && Array.isArray(list)) {
      idx = list.findIndex(function (b) { return b.id === block.id; });
    }

    const controls = document.createElement('div');
    controls.className = 'eb-block-controls';

    // 1. Ручка перетаскивания (грип): тянуть — drag&drop, клик — меню позиции и действий
    const dragBtn = document.createElement('button');
    dragBtn.type = 'button';
    dragBtn.className = 'eb-drag-handle';
    dragBtn.title = 'Потяните — переместить, клик — меню действий';
    dragBtn.innerHTML = '<i class="fas fa-grip-vertical"></i>';
    dragBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (opts.onSelect && (e.shiftKey || e.ctrlKey || e.metaKey || opts.hasSelection)) {
        opts.onSelect({ range: e.shiftKey });
        return;
      }
      openBlockActionMenu(dragBtn, opts);
    });
    if (typeof opts.attachDragHandle === 'function' && opts.wrap) {
      opts.attachDragHandle(dragBtn, opts.wrap);
    }

    // 2. Явная кнопка «Вверх»
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'eb-move-btn eb-move-up';
    upBtn.title = 'Переместить вверх';
    upBtn.innerHTML = '<i class="fas fa-arrow-up"></i>';
    upBtn.disabled = idx <= 0;
    upBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (opts.onMove) opts.onMove(-1);
    });

    // 3. Явная кнопка «Вниз»
    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'eb-move-btn eb-move-down';
    downBtn.title = 'Переместить вниз';
    downBtn.innerHTML = '<i class="fas fa-arrow-down"></i>';
    downBtn.disabled = idx === -1 || idx >= list.length - 1;
    downBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (opts.onMove) opts.onMove(1);
    });

    // 4. Явная кнопка «Дублировать блок»
    const dupBtn = document.createElement('button');
    dupBtn.type = 'button';
    dupBtn.className = 'eb-copy-btn eb-duplicate-btn';
    dupBtn.title = 'Дублировать блок';
    dupBtn.innerHTML = '<i class="fas fa-copy"></i>';
    dupBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (opts.onDuplicate) opts.onDuplicate();
    });

    // 5. Явная кнопка «Удалить блок»
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'eb-remove';
    delBtn.title = 'Удалить блок';
    delBtn.innerHTML = '<i class="fas fa-trash"></i>';
    delBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (opts.onRemove) opts.onRemove();
    });

    const showMoveButtons = opts.showMoveButtons !== false && opts.showUpDown !== false;
    if (showMoveButtons) {
      controls.append(dragBtn, upBtn, downBtn, dupBtn, delBtn);
    } else {
      controls.append(dragBtn, dupBtn, delBtn);
    }

    // Мобильная / компактная кнопка меню
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'eb-block-more-btn eb-drag-handle';
    moreBtn.title = 'Действия с блоком';
    moreBtn.innerHTML = '<i class="fas fa-ellipsis-vertical"></i>';
    moreBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (opts.onSelect && (e.shiftKey || e.ctrlKey || e.metaKey || opts.hasSelection)) {
        opts.onSelect({ range: e.shiftKey });
        return;
      }
      openBlockActionMenu(moreBtn, opts);
    });
    if (typeof opts.attachDragHandle === 'function' && opts.wrap) {
      opts.attachDragHandle(moreBtn, opts.wrap);
    }

    return { controls: controls, moreBtn: moreBtn };
  }

  // Рендеринг тел базовых 7 типов блоков (общих для Antropedia и AllTell)
  function renderCoreBlockBody(block, opts) {
    if (!block) return null;
    opts = opts || {};
    const makeTa = opts.makeTextarea;
    const notifyInput = opts.onInput || function () {};
    const notifyStructure = opts.onStructureChange || function () {};

    if (block.type === 'paragraph') {
      if (!makeTa) return null;
      return makeTa(block.data.markdown, {
        placeholder: 'Начните писать текст… Enter — новый абзац, Shift+Enter — перенос строки.',
        splitOnEnter: true,
        onInput: function (val) {
          block.data.markdown = val;
          notifyInput(block);
        }
      });
    }

    if (block.type === 'heading') {
      if (!makeTa) return null;
      return makeTa(block.data.markdown, {
        placeholder: 'Заголовок H' + ((block.data && block.data.level) || 2) + '…',
        splitOnEnter: true,
        onInput: function (val) {
          block.data.markdown = val;
          notifyInput(block);
        }
      });
    }

    if (block.type === 'quote') {
      if (!makeTa) return null;
      return makeTa(block.data.markdown, {
        placeholder: 'Текст цитаты…',
        splitOnEnter: false,
        onInput: function (val) {
          block.data.markdown = val;
          notifyInput(block);
        }
      });
    }

    if (block.type === 'list') {
      const wrap = document.createElement('div');
      wrap.className = 'eb-gap';

      const styleGroup = document.createElement('div');
      styleGroup.className = 'eb-list-style-group';
      [
        { key: 'bullet', label: 'Маркеры' },
        { key: 'ordered', label: 'Нумерация' },
        { key: 'checklist', label: 'Чек-лист' }
      ].forEach(function (s) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = s.label;
        if (block.data.style === s.key) btn.className = 'active';
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          block.data.style = s.key;
          notifyStructure(block);
        });
        styleGroup.appendChild(btn);
      });
      wrap.appendChild(styleGroup);

      function normalizeEbItemsIndent(items) {
        if (!Array.isArray(items)) return;
        let prevIndent = -1;
        items.forEach(function (it, i) {
          let ind = Math.max(0, Math.min(5, parseInt(it.indent, 10) || 0));
          if (i === 0) ind = 0;
          else if (ind > prevIndent + 1) ind = prevIndent + 1;
          it.indent = ind;
          prevIndent = ind;
        });
      }

      function openEbListStylePopover(anchorBtn, currentStyle, onSelect) {
        document.querySelectorAll('.eb-list-style-popover').forEach(function (el) { el.remove(); });
        const popover = document.createElement('div');
        popover.className = 'eb-list-style-popover';
        const options = [
          { key: 'bullet', label: 'Маркер', icon: 'fa-list-ul' },
          { key: 'ordered', label: 'Нумерация', icon: 'fa-list-ol' },
          { key: 'checklist', label: 'Чек-лист', icon: 'fa-square-check' }
        ];
        options.forEach(function (opt) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'eb-list-style-opt' + (currentStyle === opt.key ? ' active' : '');
          btn.innerHTML = '<i class="fas ' + opt.icon + '"></i> <span>' + opt.label + '</span>';
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            popover.remove();
            onSelect(opt.key);
          });
          popover.appendChild(btn);
        });
        document.body.appendChild(popover);
        const rect = anchorBtn.getBoundingClientRect();
        popover.style.position = 'fixed';
        popover.style.top = (rect.bottom + 4) + 'px';
        popover.style.left = Math.max(10, Math.min(window.innerWidth - 140, rect.right - 130)) + 'px';

        function close(e) {
          if (!popover.contains(e.target) && e.target !== anchorBtn) {
            popover.remove();
            document.removeEventListener('pointerdown', close);
            document.removeEventListener('keydown', onKey);
          }
        }
        function onKey(e) {
          if (e.key === 'Escape') {
            popover.remove();
            document.removeEventListener('pointerdown', close);
            document.removeEventListener('keydown', onKey);
          }
        }
        setTimeout(function () {
          document.addEventListener('pointerdown', close);
          document.addEventListener('keydown', onKey);
        }, 0);
      }

      function getEbOrderedMarker(items, idx, defaultStyle) {
        const curIndent = Math.max(0, Math.min(5, parseInt(items[idx].indent, 10) || 0));
        let count = 1;
        const defStyle = defaultStyle || 'ordered';
        for (let i = idx - 1; i >= 0; i--) {
          const prevIndent = Math.max(0, Math.min(5, parseInt(items[i].indent, 10) || 0));
          if (prevIndent < curIndent) break;
          const itStyle = items[i].style || defStyle;
          if (prevIndent === curIndent && itStyle === 'ordered') count++;
        }
        return count + '.';
      }

      const itemsEl = document.createElement('div');
      itemsEl.className = 'eb-gap';
      block.data.items = Array.isArray(block.data.items) ? block.data.items : [];
      if (!block.data.items.length) {
        block.data.items.push({ id: genBlockId(), markdown: '', checked: false, indent: 0 });
      }
      normalizeEbItemsIndent(block.data.items);

      block.data.items.forEach(function (item, idx) {
        const row = document.createElement('div');
        row.className = 'eb-list-item';
        const indent = Math.max(0, Math.min(5, parseInt(item.indent, 10) || 0));
        row.dataset.indent = String(indent);
        if (indent > 0) {
          row.style.marginLeft = (indent * 24) + 'px';
        }
        if (item.checked) {
          row.classList.add('is-checked');
        }

        const effectiveStyle = item.style || block.data.style || 'bullet';
        const isItemCheck = effectiveStyle === 'checklist';

        if (isItemCheck) {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !!item.checked;
          cb.addEventListener('change', function () {
            item.checked = cb.checked;
            row.classList.toggle('is-checked', !!item.checked);
            notifyInput(block);
          });
          row.appendChild(cb);
        } else {
          const marker = document.createElement('span');
          marker.className = 'eb-list-marker eb-list-type-toggle';
          marker.title = 'Нажмите, чтобы сменить стиль пункта (маркер / нумерация / чек-лист)';
          if (effectiveStyle === 'ordered') {
            marker.textContent = getEbOrderedMarker(block.data.items, idx, block.data.style);
          } else {
            const bullets = ['•', '◦', '▪'];
            marker.textContent = bullets[indent % bullets.length] || '•';
          }
          marker.addEventListener('click', function (e) {
            e.stopPropagation();
            const nextStyleMap = { bullet: 'ordered', ordered: 'checklist', checklist: 'bullet' };
            item.style = nextStyleMap[effectiveStyle] || 'bullet';
            notifyStructure(block);
          });
          row.appendChild(marker);
        }

        if (makeTa) {
          const ta = makeTa(item.markdown, {
            placeholder: indent > 0 ? 'Подпункт списка…' : 'Пункт списка…',
            onInput: function (val) {
              item.markdown = val;
              notifyInput(block);
            }
          });
          ta.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              const pos = ta.selectionStart;
              const before = ta.value.slice(0, pos);
              const after = ta.value.slice(pos);
              item.markdown = before;
              block.data.items.splice(idx + 1, 0, {
                id: genBlockId(),
                markdown: after,
                checked: false,
                indent: item.indent || 0,
                style: item.style
              });
              normalizeEbItemsIndent(block.data.items);
              notifyStructure(block);
            } else if (e.key === 'Tab' && !e.shiftKey) {
              e.preventDefault();
              if (idx > 0) {
                const prevIndent = Math.max(0, Math.min(5, parseInt(block.data.items[idx - 1].indent, 10) || 0));
                const curIndent = Math.max(0, Math.min(5, parseInt(item.indent, 10) || 0));
                if (curIndent < prevIndent + 1 && curIndent < 5) {
                  item.indent = curIndent + 1;
                  normalizeEbItemsIndent(block.data.items);
                  notifyStructure(block);
                }
              }
            } else if (e.key === 'Tab' && e.shiftKey) {
              e.preventDefault();
              const curIndent = Math.max(0, Math.min(5, parseInt(item.indent, 10) || 0));
              if (curIndent > 0) {
                item.indent = curIndent - 1;
                normalizeEbItemsIndent(block.data.items);
                notifyStructure(block);
              }
            } else if (e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
              const curIndent = Math.max(0, Math.min(5, parseInt(item.indent, 10) || 0));
              if (curIndent > 0) {
                e.preventDefault();
                item.indent = curIndent - 1;
                normalizeEbItemsIndent(block.data.items);
                notifyStructure(block);
              } else if (block.data.items.length > 1 && !item.markdown) {
                e.preventDefault();
                block.data.items.splice(idx, 1);
                normalizeEbItemsIndent(block.data.items);
                notifyStructure(block);
              }
            }
          });
          row.appendChild(ta);
        }

        const actions = document.createElement('div');
        actions.className = 'eb-list-item-actions';

        const prevIndent = idx > 0 ? (Math.max(0, Math.min(5, parseInt(block.data.items[idx - 1].indent, 10) || 0))) : 0;
        const canIndent = idx > 0 && indent < prevIndent + 1 && indent < 5;
        const canOutdent = indent > 0;

        const outdentBtn = document.createElement('button');
        outdentBtn.type = 'button';
        outdentBtn.className = 'eb-icon-btn eb-list-shift-btn';
        outdentBtn.title = 'Уменьшить отступ (Shift+Tab)';
        outdentBtn.disabled = !canOutdent;
        outdentBtn.innerHTML = '<i class="fas fa-outdent"></i>';
        outdentBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (!canOutdent) return;
          item.indent = indent - 1;
          normalizeEbItemsIndent(block.data.items);
          notifyStructure(block);
        });

        const indentBtn = document.createElement('button');
        indentBtn.type = 'button';
        indentBtn.className = 'eb-icon-btn eb-list-shift-btn';
        indentBtn.title = 'Сделать подпунктом (Tab)';
        indentBtn.disabled = !canIndent;
        indentBtn.innerHTML = '<i class="fas fa-indent"></i>';
        indentBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (!canIndent) return;
          item.indent = indent + 1;
          normalizeEbItemsIndent(block.data.items);
          notifyStructure(block);
        });

        const styleBtn = document.createElement('button');
        styleBtn.type = 'button';
        styleBtn.className = 'eb-icon-btn eb-list-style-btn';
        const styleIcons = {
          bullet: 'fa-list-ul',
          ordered: 'fa-list-ol',
          checklist: 'fa-square-check'
        };
        const styleTitles = {
          bullet: 'Маркер',
          ordered: 'Нумерация',
          checklist: 'Чек-лист'
        };
        styleBtn.title = 'Стиль пункта: ' + (styleTitles[effectiveStyle] || 'Маркер');
        styleBtn.innerHTML = '<i class="fas ' + (styleIcons[effectiveStyle] || 'fa-list-ul') + '"></i>';
        styleBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          openEbListStylePopover(styleBtn, effectiveStyle, function (newStyle) {
            item.style = newStyle;
            notifyStructure(block);
          });
        });

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'eb-icon-btn eb-list-del-btn';
        del.title = 'Удалить пункт';
        del.innerHTML = '<i class="fas fa-xmark"></i>';
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          if (block.data.items.length <= 1) return;
          block.data.items.splice(idx, 1);
          normalizeEbItemsIndent(block.data.items);
          notifyStructure(block);
        });

        actions.append(outdentBtn, indentBtn, styleBtn, del);
        row.appendChild(actions);

        itemsEl.appendChild(row);
      });
      wrap.appendChild(itemsEl);

      const btnRow = document.createElement('div');
      btnRow.className = 'eb-list-bottom-actions';

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'eb-mini-btn';
      addBtn.innerHTML = '<i class="fas fa-plus"></i> Пункт';
      addBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        const lastItem = block.data.items[block.data.items.length - 1];
        const indent = lastItem ? (lastItem.indent || 0) : 0;
        block.data.items.push({ id: genBlockId(), markdown: '', checked: false, indent: indent });
        normalizeEbItemsIndent(block.data.items);
        notifyStructure(block);
      });

      const addSubBtn = document.createElement('button');
      addSubBtn.type = 'button';
      addSubBtn.className = 'eb-mini-btn';
      addSubBtn.innerHTML = '<i class="fas fa-level-down-alt fa-rotate-90"></i> Подпункт';
      addSubBtn.title = 'Добавить вложенный подпункт';
      addSubBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        const lastItem = block.data.items[block.data.items.length - 1];
        const curIndent = lastItem ? (lastItem.indent || 0) : 0;
        const subIndent = Math.min(5, curIndent + 1);
        block.data.items.push({ id: genBlockId(), markdown: '', checked: false, indent: subIndent });
        normalizeEbItemsIndent(block.data.items);
        notifyStructure(block);
      });

      btnRow.append(addBtn, addSubBtn);
      wrap.appendChild(btnRow);

      return wrap;
    }

    if (block.type === 'divider') {
      const wrap = document.createElement('div');
      wrap.className = 'eb-divider-block';
      wrap.innerHTML = '<i class="fas fa-minus"></i><hr><span>Разделитель</span>';
      return wrap;
    }

    if (block.type === 'code') {
      const wrap = document.createElement('div');
      wrap.className = 'eb-code-editor eb-gap';

      const lang = document.createElement('input');
      lang.type = 'text';
      lang.className = 'eb-input eb-input-sm';
      lang.placeholder = 'язык (например, js, python, css)';
      lang.value = (block.data && block.data.language) || '';
      lang.addEventListener('input', function () {
        block.data.language = lang.value;
        notifyInput(block);
      });

      wrap.appendChild(lang);
      if (makeTa) {
        const codeArea = makeTa((block.data && block.data.code) || '', {
          className: 'eb-code-text',
          placeholder: 'Код…',
          onInput: function (val) {
            block.data.code = val;
            notifyInput(block);
          }
        });
        wrap.appendChild(codeArea);
      }
      return wrap;
    }

    if (block.type === 'callout') {
      const wrap = document.createElement('div');
      const curVariant = (block.data && block.data.variant) || 'info';
      wrap.className = 'eb-callout-editor eb-variant-' + curVariant + ' eb-gap';

      const variants = document.createElement('div');
      variants.className = 'eb-callout-variant-group';
      [
        ['info', 'fa-circle-info', 'Информация'],
        ['tip', 'fa-lightbulb', 'Совет'],
        ['warning', 'fa-triangle-exclamation', 'Осторожно']
      ].forEach(function (item) {
        const v = item[0], icon = item[1], label = item[2];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.innerHTML = '<i class="fas ' + icon + '"></i> ' + label;
        if (curVariant === v) btn.className = 'active';
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          block.data.variant = v;
          notifyStructure(block);
        });
        variants.appendChild(btn);
      });
      wrap.appendChild(variants);

      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.className = 'eb-input';
      titleInput.placeholder = 'Заголовок плашки (необязательно)';
      titleInput.value = (block.data && block.data.title) || '';
      titleInput.addEventListener('input', function () {
        block.data.title = titleInput.value;
        notifyInput(block);
      });
      wrap.appendChild(titleInput);

      if (makeTa) {
        const bodyArea = makeTa((block.data && block.data.markdown) || '', {
          placeholder: 'Текст примечания…',
          onInput: function (val) {
            block.data.markdown = val;
            notifyInput(block);
          }
        });
        wrap.appendChild(bodyArea);
      }
      return wrap;
    }

    // Не базовый тип — оставляем расширенному обработчику
    return null;
  }

  // Экспорт общего модуля блоков
  window.EditorBlocks = {
    genBlockId: genBlockId,
    TYPE_LABELS: TYPE_LABELS,
    blockTypeTag: blockTypeTag,
    cloneBlock: cloneBlock,
    createBlock: createBlock,
    moveBlockInList: moveBlockInList,
    duplicateBlockInList: duplicateBlockInList,
    removeBlockFromList: removeBlockFromList,
    openBlockActionMenu: openBlockActionMenu,
    closeBlockActionMenu: closeBlockActionMenu,
    renderBlockControls: renderBlockControls,
    renderCoreBlockBody: renderCoreBlockBody
  };
})();
