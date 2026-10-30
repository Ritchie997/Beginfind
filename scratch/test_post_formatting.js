const fs = require('fs');

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function pickTextColor(hex) {
  // simple brightness check
  return '#ffffff';
}

function formatPostBody(body) {
  if (!body) return '';
  var text = escapeHtml(body);

  // 1. Извлекаем блоки кода ```lang\ncode\n``` чтобы внутренности не ломались другим форматированием
  var codeBlocks = [];
  text = text.replace(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)\r?\n```/g, function (_, lang, code) {
    var placeholder = '@@ALLTELLCODEBLOCK' + codeBlocks.length + '@@';
    var langAttr = lang ? ' class="language-' + lang.trim() + '"' : '';
    codeBlocks.push(
      '<pre class="alltell-post-code-block blk-code"><code' + langAttr + '>' + code + '</code></pre>'
    );
    return placeholder;
  });

  // 2. Врезки-плашки (callout): > [!NOTE|TIP|WARNING] Заголовок \n > текст
  text = text.replace(/((?:^(?:>|&gt;)\s*\[!(NOTE|INFO|TIP|WARNING|CAUTION)\][^\n]*(?:\n|$))(?:^(?:>|&gt;)[^\n]*(?:\n|$))*)/gim, function (match) {
    var lines = match.split('\n').filter(function (l) { return l.trim().length > 0; });
    var firstLine = lines[0].replace(/^(?:>|&gt;)\s*/, '');
    var headerMatch = firstLine.match(/^\[!(NOTE|INFO|TIP|WARNING|CAUTION)\]\s*(.*)$/i);
    var variant = 'info';
    var customTitle = '';
    if (headerMatch) {
      var vKey = headerMatch[1].toLowerCase();
      if (vKey === 'note' || vKey === 'info') variant = 'info';
      else if (vKey === 'tip') variant = 'tip';
      else if (vKey === 'warning' || vKey === 'caution') variant = 'warning';
      customTitle = headerMatch[2].trim();
    }
    var labels = { info: 'Информация', tip: 'Совет', warning: 'Внимание' };
    var icons = { info: 'fa-circle-info', tip: 'fa-lightbulb', warning: 'fa-triangle-exclamation' };
    var title = customTitle || labels[variant];
    var bodyLines = lines.slice(1).map(function (l) {
      return l.replace(/^(?:>|&gt;)\s*/, '');
    });
    var bodyText = bodyLines.join('<br>').replace(/(?:<br>)+$/, '');
    return '<aside class="alltell-post-callout blk-callout blk-callout-' + variant + '">' +
      '<div class="alltell-callout-header"><i class="fas ' + icons[variant] + '"></i><strong>' + title + '</strong></div>' +
      (bodyText ? '<div class="alltell-callout-body">' + bodyText + '</div>' : '') +
      '</aside>';
  });

  // Заголовки (#, ##, ###, ####)
  text = text.replace(/^(#{1,4})\s+(.+)$/gm, function (_, hashes, content) {
    var lvl = hashes.length;
    return '<h' + lvl + ' class="alltell-post-h' + lvl + '">' + content.trim() + '</h' + lvl + '>';
  });

  // Чек-листы
  text = text.replace(/((?:^[-*]\s+\[[ xX]\][^\n]*(?:\n|$))+)/gm, function (match) {
    var lines = match.trim().split('\n');
    var items = lines.map(function (line) {
      var m = line.match(/^[-*]\s+\[([ xX])\]\s*(.*)$/);
      var checked = m && m[1].toLowerCase() === 'x';
      var content = m ? m[2].trim() : line;
      return '<li class="alltell-checklist-item' + (checked ? ' is-checked' : '') + '">' +
             '<input type="checkbox"' + (checked ? ' checked' : '') + ' onchange="this.parentElement.classList.toggle(\'is-checked\', this.checked)">' +
             '<span>' + content + '</span></li>';
    }).join('');
    return '<ul class="alltell-checklist blk-checklist">' + items + '</ul>';
  });

  // Нумерованные списки
  text = text.replace(/((?:^\d+\.\s+[^\n]*(?:\n|$))+)/gm, function (match) {
    var lines = match.trim().split('\n');
    var items = lines.map(function (line) {
      var content = line.replace(/^\d+\.\s+/, '').trim();
      return '<li>' + content + '</li>';
    }).join('');
    return '<ol class="alltell-post-ol">' + items + '</ol>';
  });

  // Маркированные списки
  text = text.replace(/((?:^[-*•]\s+[^\n]*(?:\n|$))+)/gm, function (match) {
    var lines = match.trim().split('\n');
    var items = lines.map(function (line) {
      var content = line.replace(/^[-*•]\s+/, '').trim();
      return '<li>' + content + '</li>';
    }).join('');
    return '<ul class="alltell-post-ul">' + items + '</ul>';
  });

  // Обычные цитаты
  text = text.replace(/((?:^(?:>|&gt;)[^\n]*(?:\n|$))+)/gm, function (match) {
    var inner = match.split('\n').map(function (line) {
      return line.replace(/^(?:>|&gt;)\s*/, '');
    }).join('<br>').replace(/(?:<br>)+$/, '');
    return '<blockquote class="alltell-post-quote">' + inner + '</blockquote>';
  });

  // Разделитель: --- или ***
  text = text.replace(/^(?:---|—{3,}|\*\*\*)\s*$/gm, '<hr class="alltell-post-divider blk-divider">');

  // Выделение цветом: ==текст==(#hex) или ==текст==
  text = text.replace(/==([\s\S]+?)==\((#[0-9a-fA-F]{3,8})\)/g, function (_, content, hex) {
    return '<mark class="alltell-post-highlight" style="background:' + hex + ';color:' + pickTextColor(hex) + ';">' + content + '</mark>';
  });
  text = text.replace(/==([\s\S]+?)==/g, '<mark class="alltell-post-highlight">$1</mark>');

  // Инлайн-спойлеры: ||скрытый текст||
  text = text.replace(/\|\|([\s\S]+?)\|\|/g, '<span class="alltell-post-spoiler" title="Спойлер (нажмите для просмотра)" onclick="this.classList.toggle(\'is-revealed\')">$1</span>');

  // Жирный текст: **текст**
  text = text.replace(/\*\*([^\*\n]+?)\*\*/g, '<strong>$1</strong>');

  // Курсив: *текст* (если не звёздочки) или _текст_
  text = text.replace(/(^|[^\*])\*([^\*\n]+?)\*([^\*]|$)/g, '$1<em>$2</em>$3');
  text = text.replace(/(^|[^_])_([^_ \n][^_\n]*?[^_ \n])_([^_]|$)/g, '$1<em>$2</em>$3');

  // Зачёркнутый текст: ~~текст~~
  text = text.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');

  // Подчёркнутый текст: ++текст++ или <u>текст</u>
  text = text.replace(/\+\+([^\+\n]+?)\+\+/g, '<u>$1</u>');
  text = text.replace(/&lt;u&gt;([\s\S]+?)&lt;\/u&gt;/gi, '<u>$1</u>');

  // Инлайн-код: `код`
  text = text.replace(/`([^`\n]+?)`/g, '<code class="alltell-inline-code">$1</code>');

  // Wiki-ссылки на Antropedia: [[slug|title]], [[slug]] или [title]((slug))
  text = text.replace(/\[\[([^\]\|]+)(?:\|([^\]]+))?\]\]/g, function (_, slug, title) {
    var s = slug.trim();
    var t = (title || s).trim();
    return '<a href="/antropedia/' + encodeURIComponent(s) + '" class="alltell-post-wikilink"><i class="fas fa-book-bookmark"></i> ' + t + '</a>';
  });
  text = text.replace(/\[([^\]]+)\]\(\(([a-zA-Z0-9_\-\.]+)\)\)/g, function (_, title, slug) {
    return '<a href="/antropedia/' + encodeURIComponent(slug.trim()) + '" class="alltell-post-wikilink"><i class="fas fa-book-bookmark"></i> ' + title.trim() + '</a>';
  });

  // Обычные markdown-ссылки: [название](url)
  text = text.replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^\s\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="alltell-post-link">$1 <i class="fas fa-arrow-up-right-from-square"></i></a>');

  // Восстанавливаем блоки кода
  text = text.replace(/@@ALLTELLCODEBLOCK(\d+)@@/g, function (_, i) {
    return codeBlocks[Number(i)] || '';
  });

  return text;
}

// Тест
const sample = `
# Заголовок

Обычный абзац с **жирным** и [ссылкой](https://example.com).

\`\`\`javascript
const x = 10;
function test() { return x * 2; }
\`\`\`

> [!TIP] Полезный совет
> Читайте документацию внимательно!

---

> Простая цитата
`;

const result = formatPostBody(sample);
console.log('Result length:', result.length);
console.log('Contains code block:', result.includes('<pre class="alltell-post-code-block'));
console.log('Contains callout:', result.includes('alltell-post-callout'));
console.log('Contains divider:', result.includes('alltell-post-divider'));
console.log('Code contents preserved:', result.includes('const x = 10;'));
