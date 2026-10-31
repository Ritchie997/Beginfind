const fs = require('fs');
const assert = require('assert');

// Mock browser environment
global.window = global;
global.document = {
  createElement: function (tag) {
    const el = {
      tagName: tag.toUpperCase(),
      className: '',
      classList: {
        _classes: new Set(),
        add: function (...cls) { cls.forEach(c => this._classes.add(c)); },
        remove: function (...cls) { cls.forEach(c => this._classes.delete(c)); },
        has: function (c) { return this._classes.has(c); },
        contains: function (c) { return this._classes.has(c); },
        toggle: function (c, force) {
          if (force !== undefined) {
            if (force) this._classes.add(c); else this._classes.delete(c);
            return force;
          }
          if (this._classes.has(c)) { this._classes.delete(c); return false; }
          this._classes.add(c); return true;
        }
      },
      dataset: {},
      style: {},
      children: [],
      append: function (...args) { this.children.push(...args); },
      appendChild: function (child) { this.children.push(child); return child; },
      remove: function () {},
      querySelector: function (sel) { return null; },
      querySelectorAll: function (sel) { return []; },
      addEventListener: function (type, fn) {
        this._listeners = this._listeners || {};
        this._listeners[type] = this._listeners[type] || [];
        this._listeners[type].push(fn);
      },
      removeEventListener: function () {},
      getBoundingClientRect: function () {
        return { top: 100, bottom: 130, left: 50, right: 80, width: 30, height: 30 };
      }
    };
    return el;
  },
  body: {
    appendChild: function (el) { return el; },
    contains: function () { return true; }
  },
  addEventListener: function () {},
  removeEventListener: function () {}
};
global.innerWidth = 1200;
global.innerHeight = 800;

// Load editor-blocks.js
require('../public/editor-blocks.js');

console.log('Testing window.EditorBlocks...');
assert(window.EditorBlocks, 'window.EditorBlocks must be defined');

const EB = window.EditorBlocks;
assert(typeof EB.genBlockId === 'function', 'genBlockId should be function');
assert(typeof EB.cloneBlock === 'function', 'cloneBlock should be function');
assert(typeof EB.createBlock === 'function', 'createBlock should be function');
assert(typeof EB.moveBlockInList === 'function', 'moveBlockInList should be function');
assert(typeof EB.duplicateBlockInList === 'function', 'duplicateBlockInList should be function');
assert(typeof EB.removeBlockFromList === 'function', 'removeBlockFromList should be function');
assert(typeof EB.renderBlockControls === 'function', 'renderBlockControls should be function');
assert(typeof EB.renderCoreBlockBody === 'function', 'renderCoreBlockBody should be function');

// Test block creation
const b1 = EB.createBlock('paragraph', { markdown: 'Hello world' });
const b2 = EB.createBlock('heading', { level: 2, markdown: 'Heading' });
const b3 = EB.createBlock('divider');

assert.strictEqual(b1.type, 'paragraph');
assert.strictEqual(b1.data.markdown, 'Hello world');
assert(b1.id.startsWith('b'), 'b1.id must start with b');

assert.strictEqual(b2.type, 'heading');
assert.strictEqual(b2.data.level, 2);

const list = [b1, b2, b3];

// Test moveBlockInList
console.log('Testing moveBlockInList...');
// Can't move first block up
const moveUpFirst = EB.moveBlockInList(list, b1.id, -1);
assert.strictEqual(moveUpFirst.moved, false, 'First block cannot move up');

// Move b1 down
const moveDownFirst = EB.moveBlockInList(list, b1.id, 1);
assert.strictEqual(moveDownFirst.moved, true, 'b1 should move down');
assert.strictEqual(list[0].id, b2.id, 'b2 should now be first');
assert.strictEqual(list[1].id, b1.id, 'b1 should now be second');

// Move b3 (last) down
const moveDownLast = EB.moveBlockInList(list, b3.id, 1);
assert.strictEqual(moveDownLast.moved, false, 'Last block cannot move down');

// Test duplicateBlockInList
console.log('Testing duplicateBlockInList...');
const dupRes = EB.duplicateBlockInList(list, b1.id);
assert.strictEqual(dupRes.duplicated, true, 'b1 should be duplicated');
assert.strictEqual(list.length, 4, 'list should now have 4 blocks');
assert.strictEqual(list[2].id, dupRes.newBlock.id, 'newBlock should be placed immediately after b1');
assert.notStrictEqual(list[2].id, b1.id, 'cloned block must have a distinct ID');
assert.strictEqual(list[2].data.markdown, 'Hello world', 'cloned block should retain data');

// Test removeBlockFromList
console.log('Testing removeBlockFromList...');
const remRes = EB.removeBlockFromList(list, dupRes.newBlock.id);
assert.strictEqual(remRes.removed, true, 'Duplicate should be removed');
assert.strictEqual(list.length, 3, 'list should be back to 3 blocks');

// Test renderBlockControls
console.log('Testing renderBlockControls...');
let movedDir = null;
let duplicatedCalled = false;
let removedCalled = false;

const controlsRes = EB.renderBlockControls({
  block: list[0],
  list: list,
  index: 0,
  wrap: document.createElement('div'),
  onMove: (dir) => { movedDir = dir; },
  onDuplicate: () => { duplicatedCalled = true; },
  onRemove: () => { removedCalled = true; }
});

assert(controlsRes.controls, 'controls DOM element should be returned');
assert(controlsRes.moreBtn, 'moreBtn DOM element should be returned');
assert.strictEqual(controlsRes.controls.children.length, 5, 'controls should contain 5 buttons: drag, up, down, duplicate, delete');

const [dragBtn, upBtn, downBtn, dupBtn, delBtn] = controlsRes.controls.children;
assert(upBtn.disabled, 'upBtn must be disabled for index 0');
assert(!downBtn.disabled, 'downBtn must not be disabled for index 0');

// Click downBtn
downBtn._listeners.click[0]({ stopPropagation: () => {} });
assert.strictEqual(movedDir, 1, 'Clicking downBtn must invoke onMove(1)');

// Click dupBtn
dupBtn._listeners.click[0]({ stopPropagation: () => {} });
assert.strictEqual(duplicatedCalled, true, 'Clicking dupBtn must invoke onDuplicate()');

// Click delBtn
delBtn._listeners.click[0]({ stopPropagation: () => {} });
assert.strictEqual(removedCalled, true, 'Clicking delBtn must invoke onRemove()');

// Test renderBlockControls without move buttons (for publication editor)
const controlsWithoutMove = EB.renderBlockControls({
  block: list[0],
  list: list,
  index: 0,
  showMoveButtons: false
});
assert.strictEqual(controlsWithoutMove.controls.children.length, 3, 'controls with showMoveButtons:false must contain 3 buttons: drag, duplicate, delete (no up/down arrows)');


// Test renderCoreBlockBody
console.log('Testing renderCoreBlockBody...');
const paraBlock = EB.createBlock('paragraph', { markdown: 'Testing core body' });
const paraBody = EB.renderCoreBlockBody(paraBlock, {
  makeTextarea: (val, opts) => {
    const ta = document.createElement('textarea');
    ta.value = val;
    return ta;
  }
});
assert(paraBody, 'Core body should render for paragraph');
assert.strictEqual(paraBody.value, 'Testing core body');

const unknownBlock = { id: 'x', type: 'infobox', data: {} };
const unknownBody = EB.renderCoreBlockBody(unknownBlock, {});
assert.strictEqual(unknownBody, null, 'Core body should return null for non-core types');

console.log('ALL TESTS PASSED SUCCESSFULLY!');
