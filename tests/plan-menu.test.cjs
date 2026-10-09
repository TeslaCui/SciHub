const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Drive real card event handlers with deterministic touch timers; no database writes.
function harness() {
  const timers = new Map(), elements = new Map();
  let nextTimer = 0, clock = 0;
  const document = { activeElement: null, addEventListener() {}, querySelectorAll: () => [] };
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const handlers = new Map();
    const node = { id, style: {}, isConnected: true, hidden: true, innerHTML: '', value: '',
      classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {},
      addEventListener(type, callback, capture) {
        const list = handlers.get(type) || [];
        if (capture) list.unshift(callback); else list.push(callback);
        handlers.set(type, list);
      },
      emit(type, options = {}) {
        const event = { target: node, detail: 1, preventDefault() { this.prevented = true; },
          stopImmediatePropagation() { this.stopped = true; }, ...options };
        for (const handler of handlers.get(type) || []) { handler(event); if (event.stopped) break; }
        return event;
      },
      closest: () => null, remove() { this.isConnected = false; },
      focus() { document.activeElement = node; }, getBoundingClientRect: () => ({ left: 20, top: 30 }),
      querySelector: (selector) => element(id + selector), querySelectorAll: () => [],
    };
    elements.set(id, node); return node;
  }
  Object.assign(document, { body: element('body'), getElementById: element,
    createElement: () => element('menu-' + elements.size) });
  const window = { addEventListener() {}, dispatchEvent() {}, innerWidth: 390, innerHeight: 844 };
  const context = vm.createContext({ window, document, CustomEvent: class {}, console, Date: class extends Date { static now() { return clock; } },
    SciHubSafety: { createSaveQueue: () => ({}) }, setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id) });
  const source = fs.readFileSync(path.join(__dirname, '..', 'experiment.js'), 'utf8')
    .replace('  window.Plans = {', '  window.__menuTest = { bindPlanContextMenu, getMenu: () => planContextMenu };\n  window.Plans = {');
  vm.runInContext(source, context);
  const card = element('card');
  window.__menuTest.bindPlanContextMenu(card, { id: 1, title: '虚构方案' });
  let opened = 0;
  card.addEventListener('click', () => opened++);
  return { card, api: window.__menuTest, document, opened: () => opened, elapse: (ms) => { clock += ms; },
    hold: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); } };
}
const touch = { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 360, clientY: 810 };

test('a long press opens the menu and release never navigates, even after a long hold', () => {
  const h = harness();
  h.card.emit('pointerdown', touch); h.hold();
  assert.ok(h.api.getMenu());
  assert.equal(h.api.getMenu().style.left, '232px');
  assert.equal(h.api.getMenu().style.top, '748px');
  h.elapse(10000);
  h.card.emit('pointerup', touch);
  assert.equal(h.card.emit('click').prevented, true);
  assert.equal(h.opened(), 0);
  h.card.emit('pointerdown', touch); h.card.emit('pointerup', touch); h.card.emit('click');
  assert.equal(h.opened(), 1);
});

test('scroll movement, a short tap, secondary touches and embedded buttons cannot start a long press', () => {
  for (const options of [touch, { ...touch, isPrimary: false }, { ...touch, target: { closest: () => ({}) } }]) {
    const h = harness(); h.card.emit('pointerdown', options);
    h.card.emit('pointermove', { ...touch, clientY: 785 }); h.hold();
    assert.equal(h.api.getMenu(), null);
  }
  const h = harness(); h.card.emit('pointerdown', touch); h.card.emit('pointerup', touch); h.hold();
  h.card.emit('click'); assert.equal(h.opened(), 1); assert.equal(h.api.getMenu(), null);
});

test('right-click and keyboard menu shortcuts open actions without following the card', () => {
  const h = harness();
  assert.equal(h.card.emit('contextmenu', { clientX: 30, clientY: 40 }).prevented, true);
  assert.ok(h.api.getMenu());
  assert.equal(h.card.emit('keydown', { key: 'F10', shiftKey: true }).prevented, true);
  assert.equal(h.card.emit('keydown', { key: 'ContextMenu' }).prevented, true);
  assert.equal(h.opened(), 0);
});
