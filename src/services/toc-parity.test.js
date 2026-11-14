const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('TOC: public/site/antropedia.html has sidebar markup and view layout parity', () => {
  const htmlPath = path.resolve(__dirname, '../../public/site/antropedia.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  // Must contain .antropedia-view-layout on publicArticleContainer
  assert.ok(
    html.includes('id="publicArticleContainer"') && html.includes('antropedia-view-layout'),
    'publicArticleContainer should include antropedia-view-layout class'
  );

  // Must contain aside with antropediaViewSidebar without hidden
  assert.match(
    html,
    /<aside id="antropediaViewSidebar" class="antropedia-view-sidebar">/,
    'antropediaViewSidebar should be present as an aside element'
  );

  // Must contain antropediaTocPanel inside sidebar
  assert.ok(
    html.includes('id="antropediaTocPanel"') && html.includes('antropedia-toc-panel'),
    'antropediaTocPanel should be present with antropedia-toc-panel class'
  );
});

test('TOC: public/views/antropedia.html has matching panel classes', () => {
  const adminHtmlPath = path.resolve(__dirname, '../../public/views/antropedia.html');
  const adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');

  assert.ok(
    adminHtml.includes('class="antropedia-view-layout"'),
    'admin panel must have antropedia-view-layout'
  );
  assert.ok(
    adminHtml.includes('id="antropediaViewSidebar"'),
    'admin panel must have antropediaViewSidebar'
  );
  assert.ok(
    adminHtml.includes('id="antropediaTocPanel"'),
    'admin panel must have antropediaTocPanel'
  );
});

test('TOC: public/site/site.css connects .antropedia-view-layout, .antropedia-view-sidebar, and .antropedia-toc-panel', () => {
  const cssPath = path.resolve(__dirname, '../../public/site/site.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  assert.ok(
    css.includes('.antropedia-view-layout'),
    'site.css must connect .antropedia-view-layout'
  );
  assert.ok(
    css.includes('.antropedia-view-sidebar'),
    'site.css must contain .antropedia-view-sidebar'
  );
  assert.ok(
    css.includes('.antropedia-toc-panel'),
    'site.css must contain .antropedia-toc-panel'
  );
  assert.ok(
    css.includes('.antropedia-toc-list'),
    'site.css must contain .antropedia-toc-list'
  );
  assert.ok(
    css.includes('.antropedia-toc-item'),
    'site.css must contain .antropedia-toc-item'
  );
  assert.ok(
    css.includes('.antropedia-toc-level-1') &&
    css.includes('.antropedia-toc-level-2') &&
    css.includes('.antropedia-toc-level-3'),
    'site.css must contain styles for H1-H3 levels'
  );
});

test('TOC: public/site/site.js implements renderToc with H1-H3 parsing, scroll spy and IntersectionObserver', () => {
  const jsPath = path.resolve(__dirname, '../../public/site/site.js');
  const js = fs.readFileSync(jsPath, 'utf8');

  assert.ok(js.includes('function renderToc('), 'site.js must define renderToc function');
  assert.ok(js.includes("querySelectorAll('h1, h2, h3')"), 'renderToc must query h1, h2, h3');
  assert.ok(js.includes('antropedia-toc-level-'), 'renderToc must assign level classes');
  assert.ok(js.includes('IntersectionObserver'), 'renderToc must support IntersectionObserver');
  assert.ok(js.includes('tocObserver.observe'), 'renderToc must observe headings with IntersectionObserver');
  assert.ok(js.includes('updateScrollSpy'), 'renderToc must have scroll spy');
});
