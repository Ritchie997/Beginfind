const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('article editor: antropedia-editor-client dynamically re-binds to new DOM roots and guards events', () => {
  const editorClientJs = fs.readFileSync(path.resolve(__dirname, '../../public/site/antropedia-editor-client.js'), 'utf8');

  // 1. Root-tracking and re-binding
  assert.ok(editorClientJs.includes('this._boundEditorRoot === editorRoot'), 'init must track _boundEditorRoot to detect DOM replacement');
  assert.ok(editorClientJs.includes('this._boundEditorRoot = editorRoot;'), 'init must record _boundEditorRoot');
  assert.ok(editorClientJs.includes('this._boundEditorRoot = null;'), 'closeEditor/cleanup must clear _boundEditorRoot');

  // 2. Button event listener guards
  assert.ok(editorClientJs.includes('saveDraftBtn._editorBound = true;'), 'saveDraftBtn must be guarded against duplicate binding');
  assert.ok(editorClientJs.includes('loadDraftBtn._editorBound = true;'), 'loadDraftBtn must be guarded against duplicate binding');
  assert.ok(editorClientJs.includes('resetArticleBtn._editorBound = true;'), 'resetArticleBtn must be guarded against duplicate binding');
  assert.ok(editorClientJs.includes('saveArticleBtn._editorBound = true;'), 'saveArticleBtn must be guarded against duplicate binding');

  // 3. Authors payload handles null/missing IDs
  assert.ok(editorClientJs.includes('.filter((id) => id != null)'), 'collectArticleAuthorsPayload must filter out null/invalid IDs');

  // 4. Layers response compatibility
  assert.ok(editorClientJs.includes('layersData.usingLayers || layersData.layersEnabled'), 'loadArticleForEdit must support usingLayers and layersEnabled');
});

test('article editor: site.js cleanup invokes antropediaEditor.cleanup', () => {
  const siteJs = fs.readFileSync(path.resolve(__dirname, '../../public/site/site.js'), 'utf8');
  assert.ok(siteJs.includes('window.antropediaEditor.cleanup()'), 'site.js cleanupPublicPage must invoke antropediaEditor.cleanup()');
});

test('article editor: spa-router allows loading draft over open article and provides revert on reset', () => {
  const spaRouterJs = fs.readFileSync(path.resolve(__dirname, '../../public/spa-router.js'), 'utf8');

  // 1. loadDraft with force parameter
  assert.ok(spaRouterJs.includes('async loadDraft(draftId, { silent = false, force = false } = {})'), 'loadDraft must accept force parameter');
  assert.ok(spaRouterJs.includes('this.loadDraft(draftId, { force: true })'), 'openDraftFromModal must pass force: true');

  // 2. resetArticle provides revert when articleId is set
  assert.ok(spaRouterJs.includes('const articleId = saveBtn ? saveBtn.getAttribute(\'data-article-id\') : null;'), 'resetArticle must check data-article-id');
  assert.ok(spaRouterJs.includes('await this.editArticle(articleId);'), 'resetArticle must revert to loaded article when articleId is present');
});
