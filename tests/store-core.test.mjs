import test from 'node:test';
import assert from 'node:assert/strict';
// 商品注册/合并更新的纯逻辑（对齐 CLI 端契约：skills.js isSkillName 规范名 + test/fixture.js 的
// PUT products 参考实现——字段白名单、合并语义、配对冲突判定逐条同构）。
import { applyProductUpdate, isCanonicalSkillName } from '../lib/store-core.mjs';

test('isCanonicalSkillName：^[a-z0-9][a-z0-9-]*$ 且排除 Windows 保留名（对齐 CLI skills.js）', () => {
  for (const good of ['a', 'demo-skill', 'a-b2', '0start', 'com-tail', 'connect']) assert.equal(isCanonicalSkillName(good), true, good);
  for (const bad of ['', 'A', 'Demo', '-a', 'a_b', 'a.b', 'a b', '中文', 42, null, undefined,
    'con', 'prn', 'aux', 'nul', 'com1', 'lpt9', 'CON', 'Com3', 'con.x']) assert.equal(isCanonicalSkillName(bad), false, String(bad));
});

test('applyProductUpdate：非法规范名 400 语义（Skill 名无效）', () => {
  for (const bad of ['Bad', 'a_b', 'con']) {
    const result = applyProductUpdate(bad, {}, null, []);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_field');
    assert.match(result.message, /Skill 名无效/);
  }
});

test('applyProductUpdate：请求体须为对象，未知字段拒绝', () => {
  for (const body of [null, 'text', 42, [], true]) {
    const result = applyProductUpdate('a-skill', body, null, []);
    assert.equal(result.ok, false, String(body));
    assert.equal(result.error, 'invalid_field');
  }
  const unknown = applyProductUpdate('a-skill', { bogus: 'x' }, null, []);
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /未知字段 bogus/);
});

test('applyProductUpdate：name/summary/repo/page 文本字段校验（非空 trim、≤500）', () => {
  const long = 'x'.repeat(501);
  for (const field of ['name', 'summary', 'repo', 'page']) {
    for (const bad of ['', '   ', long, 42, null]) {
      const result = applyProductUpdate('a-skill', { [field]: bad }, null, []);
      assert.equal(result.ok, false, `${field}=${JSON.stringify(bad)}`);
      assert.match(result.message, new RegExp(`${field} 无效`));
    }
    assert.equal(applyProductUpdate('a-skill', { [field]: '合法文本' }, null, []).ok, true, field);
  }
});

test('applyProductUpdate：free/paid 须为合法规范名', () => {
  for (const field of ['free', 'paid']) {
    for (const bad of ['', 'Bad', 'a_b', 'con', 42, null, { skill: 'a-skill' }]) {
      const result = applyProductUpdate('a-skill', { [field]: bad }, null, []);
      assert.equal(result.ok, false, `${field}=${JSON.stringify(bad)}`);
      assert.match(result.message, new RegExp(`${field} 无效`));
    }
    assert.equal(applyProductUpdate('a-skill', { [field]: 'good-name' }, null, []).ok, true, field);
  }
});

test('applyProductUpdate：prices 形状校验（方案名/amount/currency/interval）', () => {
  const good = (prices) => applyProductUpdate('a-skill', { prices }, null, []);
  assert.equal(good({}).ok, true);
  assert.equal(good({ lifetime: { amount: 9900, currency: 'cny', interval: null } }).ok, true);
  assert.equal(good({ yearly: { amount: 12000, currency: 'CNY' } }).ok, true, '大写币种按 CLI fixture 的 /i 容忍');
  assert.equal(good({ monthly: { amount: 1, currency: 'cny', interval: 'month' } }).ok, true);
  for (const bad of [null, 'x', [], 42,
    { Bad: { amount: 1, currency: 'cny' } }, { '-x': { amount: 1, currency: 'cny' } },
    { lifetime: null }, { lifetime: 'x' }, { lifetime: [] },
    { lifetime: { amount: 'x', currency: 'cny' } }, { lifetime: { amount: 0, currency: 'cny' } },
    { lifetime: { amount: -1, currency: 'cny' } }, { lifetime: { amount: 1.5, currency: 'cny' } },
    { lifetime: { currency: 'cny' } }, { lifetime: { amount: 1, currency: 'cn' } },
    { lifetime: { amount: 1, currency: 'cnyx' } }, { lifetime: { amount: 1, currency: 42 } },
    { lifetime: { amount: 1, currency: 'cny', interval: 42 } },
  ]) {
    const result = good(bad);
    assert.equal(result.ok, false, `prices=${JSON.stringify(bad)}`);
    assert.match(result.message, /prices 无效/);
  }
});

test('applyProductUpdate：创建缺省与 CLI fixture 一致——id 取 URL 规范名、name 兜底同名、free 指向自身', () => {
  const result = applyProductUpdate('new-skill', { summary: '预告。' }, null, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.product, {
    id: 'new-skill', name: 'new-skill', summary: '预告。', repo: null, page: null,
    free: { skill: 'new-skill' }, paid: null, prices: {},
  });
  const full = applyProductUpdate('new-skill', {
    name: '新技能', free: 'new-skill', paid: 'new-skill-pro',
    prices: { lifetime: { amount: 1900, currency: 'cny', interval: null } },
  }, null, []);
  assert.equal(full.product.name, '新技能');
  assert.deepEqual(full.product.paid, { skill: 'new-skill-pro' });
});

test('applyProductUpdate：合并更新只动提供的键；prices 按方案名合并、同方案覆盖', () => {
  const existing = {
    id: 'a-skill', name: '旧名', summary: '旧摘要', repo: 'https://example.com/repo', page: null,
    free: { skill: 'a-skill' }, paid: { skill: 'a-pro' }, prices: { lifetime: { amount: 6900, currency: 'cny', interval: null } },
  };
  const touched = applyProductUpdate('a-skill', { summary: '新摘要' }, existing, []);
  assert.equal(touched.ok, true);
  assert.equal(touched.product.summary, '新摘要');
  assert.equal(touched.product.name, '旧名', '未提供的键不动');
  assert.deepEqual(touched.product.prices, { lifetime: { amount: 6900, currency: 'cny', interval: null } });
  assert.deepEqual(touched.product.free, { skill: 'a-skill' });

  const added = applyProductUpdate('a-skill', { prices: { yearly: { amount: 12000, currency: 'cny' } } }, existing, []);
  assert.deepEqual(Object.keys(added.product.prices).sort(), ['lifetime', 'yearly'], 'prices 按方案合并不丢旧方案');
  const replaced = applyProductUpdate('a-skill', { prices: { lifetime: { amount: 9900, currency: 'cny' } } }, existing, []);
  assert.equal(replaced.product.prices.lifetime.amount, 9900, '同方案覆盖');

  const paired = applyProductUpdate('a-skill', { paid: 'a-pro-max' }, existing, []);
  assert.deepEqual(paired.product.paid, { skill: 'a-pro-max' }, 'free/paid 整值替换');
  assert.deepEqual(paired.product.free, { skill: 'a-skill' });
});

test('applyProductUpdate：free 与 paid 相同拒绝、双双缺失拒绝', () => {
  const same = applyProductUpdate('a-skill', { free: 'x-skill', paid: 'x-skill' }, null, []);
  assert.equal(same.ok, false);
  assert.match(same.message, /free 与 paid 不能相同/);
  const bare = {
    id: 'ghost', name: 'ghost', summary: '', repo: null, page: null, free: null, paid: null, prices: {},
  };
  const missing = applyProductUpdate('ghost', {}, bare, []);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /缺少 free\/paid/);
});

test('applyProductUpdate：配对值与他商品冲突（id/free/paid 任一命中）拒绝并指名', () => {
  const otherA = { id: 'demo', name: '演示', summary: '', repo: null, page: null, free: { skill: 'demo-free' }, paid: { skill: 'demo-pro' }, prices: {} };
  const otherB = { id: 'solo', name: 'solo', summary: '', repo: null, page: null, free: null, paid: { skill: 'solo-pro' }, prices: {} };
  const existing = { id: 'a-skill', name: 'A', summary: '', repo: null, page: null, free: { skill: 'a-skill' }, paid: null, prices: {} };
  // 新商品 free 撞他商品 paid / free / id
  for (const value of ['demo-pro', 'demo-free', 'demo']) {
    const result = applyProductUpdate('b-skill', { free: value }, null, [otherA, otherB]);
    assert.equal(result.ok, false, value);
    assert.equal(result.error, 'invalid_field');
    assert.match(result.message, new RegExp(`${value} 已属于其他商品`));
  }
  // 更新时新配对值撞他商品
  const clash = applyProductUpdate('a-skill', { paid: 'solo-pro' }, existing, [otherA, otherB]);
  assert.equal(clash.ok, false);
  assert.match(clash.message, /solo-pro 已属于其他商品/);
  // 与自身 id/free/paid 相同不算冲突；不与他商品重叠的值放行
  const self = applyProductUpdate('a-skill', { paid: 'a-skill' }, existing, [otherA, otherB]);
  assert.equal(self.ok, false, 'free 与 paid 相同仍拒绝');
  const ok = applyProductUpdate('a-skill', { paid: 'a-pro' }, existing, [otherA, otherB]);
  assert.equal(ok.ok, true);
});
