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

test('screenshots use valid shared paths and must match the reviewed image bytes', () => {
  const guide = builder.load(read(builder.SOURCE));
  const release = JSON.parse(read('version.json'));
  const fig = guide.procedures.find(item => item.figures?.length).figures[0];
  const outputs = builder.render(guide);
  assert.ok(outputs['guide.html'].includes(`src="${fig.file}?v=${release.version}"`));
  assert.ok(outputs['docs/USER-GUIDE.md'].includes(`](../${fig.file})`));
  assert.ok(read('sw.js').includes(`./${fig.file}?v=${release.version}`));
  assert.throws(() => builder.check(read, file => {
    const bytes = fs.readFileSync(path.join(__dirname, '..', file));
    bytes[bytes.length-1] ^= 1;
    return bytes;
  }), /截图变化/);
  fig.file = '../private.png';
  assert.throws(() => builder.validate(guide,release), /教程目录/);
});

test('a missing screenshot or mismatched dimensions blocks the guide release', () => {
  assert.throws(() => builder.check(read, () => { throw new Error('missing image'); }), /missing image/);
  assert.throws(() => builder.check(read, file => {
    const bytes = fs.readFileSync(path.join(__dirname, '..', file));
    bytes.writeUInt32BE(1,16);
    return bytes;
  }), /截图宽度/);
});
