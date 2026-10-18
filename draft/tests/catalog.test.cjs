const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const factories = {};
  const context = vm.createContext({
    window: {}, location: { search: '' }, URLSearchParams,
    document: { activeElement: {}, addEventListener(name, callback) { if (name === 'alpine:init') callback(); } },
    Alpine: { data(name, factory) { factories[name] = factory; } }
  });
  for (const file of ['skills.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  }
  return { factories, items: context.window.HUANYU_SKILLS };
}

test('a newly listed product is searchable, categorized, and available to the shared detail view', () => {
  const { factories, items } = setup();
  items.push({ ...items[0], id: 'test-new-skill', title: '新增商品测试', category: '新分类', keywords: ['扩展验证'] });
  const catalog = factories.skillCatalog();
  assert.equal(catalog.filtered.length, 4);
  assert.ok(catalog.categories.includes('新分类'));
  catalog.query = '扩展验证';
  assert.equal(catalog.filtered.length, 1);
  assert.equal(catalog.filtered[0].id, 'test-new-skill');
  const store = factories.storeApp();
  store.openSkill('test-new-skill');
  assert.equal(store.selectedSkill.title, '新增商品测试');
});

test('unlisted products do not leak into search, categories, or detail lookup', () => {
  const { factories, items } = setup();
  items.push({ ...items[0], id: 'test-draft', title: '未上架测试', category: '隐藏分类', listed: false });
  const catalog = factories.skillCatalog();
  assert.equal(catalog.filtered.length, 3);
  assert.equal(catalog.categories.includes('隐藏分类'), false);
  catalog.query = '未上架测试';
  assert.equal(catalog.filtered.length, 0);
  const store = factories.storeApp();
  store.openSkill('test-draft');
  assert.equal(store.selectedSkill, null);
});

test('catalog growth uses the next page and changing filters resets pagination', () => {
  const { factories, items } = setup();
  for (let index = 0; index < 10; index++) items.push({ ...items[0], id: `test-extra-${index}` });
  const catalog = factories.skillCatalog();
  assert.equal(catalog.filtered.length, 13);
  assert.equal(catalog.visible.length, 8);
  catalog.limit += 8;
  assert.equal(catalog.visible.length, 13);
  catalog.selectCategory('内容与表达');
  assert.equal(catalog.limit, 8);
  assert.equal(catalog.filtered.length, 1);
});

test('all catalog items follow the same disclosure behavior and search is case insensitive', () => {
  const { factories, items } = setup();
  const catalog = factories.skillCatalog();
  for (const item of items) {
    catalog.toggle(item.id);
    assert.equal(catalog.expanded, item.id);
    catalog.toggle(item.id);
    assert.equal(catalog.expanded, '');
  }
  catalog.query = '  ORACLE-BONE  ';
  assert.equal(catalog.filtered.length, 1);
  assert.equal(catalog.filtered[0].id, 'oracle-bone');
});
