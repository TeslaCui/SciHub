const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const builder = require('../tools/build-guide.cjs');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('a changed user feature or edited generated guide fails the release gate', () => {
  assert.equal(builder.check(read).version, JSON.parse(read('version.json')).version);
  assert.throws(() => builder.check(file => read(file) + (file === 'experiment.js' ? '\n// changed feature' : '')), /功能源码变化/);
  assert.throws(() => builder.check(file => read(file) + (file === 'guide.html' ? '\nmanual edit' : '')), /教程产物过期/);
});

test('guide release validation rejects mismatched versions and lost operation warnings', () => {
  const guide = builder.load(read(builder.SOURCE));
  const release = JSON.parse(read('version.json'));
  assert.throws(() => builder.validate({...guide,version:'0.0.0'},release), /教程版本/);
  guide.procedures.find(item => item.id === 'merge-review').caution = [];
  assert.throws(() => builder.validate(guide,release), /操作前提醒/);
});

test('rendering preserves bilingual procedural warnings before actions and escapes markup', () => {
  const guide = builder.load(read(builder.SOURCE));
  const item = guide.procedures.find(item => item.id === 'record-delete');
  item.steps[0].en = 'Read <script>unsafe</script> text.';
  const outputs = builder.render(guide);
  assert.ok(outputs['guide.html'].includes('Read &lt;script&gt;unsafe&lt;/script&gt; text.'));
  const html = outputs['guide.html'].split('id="record-delete"')[1].split('</details>')[0];
  assert.ok(html.indexOf('guide-caution') < html.indexOf('<ol>'));
  assert.ok(outputs['docs/USER-GUIDE.md'].includes('删除无法撤销'));
});
