const test = require('node:test');
const assert = require('node:assert/strict');
const articleLayers = require('./article-layers');

test('findAmbiguousPublicLayer catches legacy locked layers beside a plain public-looking layer', () => {
  const layers = [
    { id: 'open', roles: [], title: 'Ambiguous public layer', public: false },
    { id: 'legacy', roles: [], lockedNoRoles: true, title: 'Legacy hidden layer' }
  ];

  const ambiguous = articleLayers.findAmbiguousPublicLayer(layers);
  assert.equal(ambiguous && ambiguous.id, 'open');
});

test('resolvePublicArticleLayers treats legacy locked layers as restricted', () => {
  const article = {
    title: 'Legacy locked article',
    locked: true,
    roles: [],
    layers: [
      { id: 'open', roles: [], title: 'Ambiguous public layer', public: false },
      { id: 'legacy', roles: [], lockedNoRoles: true, title: 'Legacy hidden layer' }
    ]
  };

  const resolved = articleLayers.resolvePublicArticleLayers(article);
  assert.equal(resolved, null);
});
