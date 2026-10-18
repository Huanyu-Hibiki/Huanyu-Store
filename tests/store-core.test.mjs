import test from 'node:test';
import assert from 'node:assert/strict';
// 商品注册/合并更新的纯逻辑（对齐 CLI 端契约：skills.js isSkillName 规范名 + test/fixture.js 的
// PUT products 参考实现——字段白名单、合并语义、配对冲突判定逐条同构）。
import { applyProductUpdate, isCanonicalSkillName, PRICE_PLAN_MAX_LENGTH, PRICE_PLANS_MAX, PRICES_MAX_BYTES } from '../lib/store-core.mjs';

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
  // 各字段的合法形状样本（repo/page 收紧后还需过 URL/路径形状校验，专项测试在后续用例）
  const valid = { name: '合法文本', summary: '合法文本', repo: 'https://example.com/repo', page: '/store/a-skill/' };
  for (const field of ['name', 'summary', 'repo', 'page']) {
    for (const bad of ['', '   ', long, 42, null]) {
      const result = applyProductUpdate('a-skill', { [field]: bad }, null, []);
      assert.equal(result.ok, false, `${field}=${JSON.stringify(bad)}`);
      assert.match(result.message, new RegExp(`${field} 无效`));
    }
    assert.equal(applyProductUpdate('a-skill', { [field]: valid[field] }, null, []).ok, true, field);
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

// —— 审查修复（security M-1 / quality M2 M3 / L-1）：写入端收紧项 ——

test('增长上限常量导出（方案名 32 / 方案数 16 / 序列化 16KB）', () => {
  assert.equal(PRICE_PLAN_MAX_LENGTH,32);
  assert.equal(PRICE_PLANS_MAX,16);
  assert.equal(PRICES_MAX_BYTES,16384);
});

test('prices 增长上限：方案名 ≤32、方案数 ≤16、序列化字节 ≤16KB，超限 400 语义', () => {
  const plans=(n)=>Object.fromEntries(Array.from({length:n},(_,i)=>[`p${i}`,{amount:1,currency:'cny'}]));
  // 方案名长度 33：正则合法但超长
  const longPlan=applyProductUpdate('a-skill',{prices:{['p'.repeat(33)]:{amount:1,currency:'cny'}}},null,[]);
  assert.equal(longPlan.ok,false);
  assert.match(longPlan.message,/prices 无效/);
  // 方案数 17：直接给足
  const tooMany=applyProductUpdate('a-skill',{prices:plans(PRICE_PLANS_MAX+1)},null,[]);
  assert.equal(tooMany.ok,false);
  assert.match(tooMany.message,/prices 无效/);
  // 合法边界：16 方案放行
  assert.equal(applyProductUpdate('a-skill',{prices:plans(PRICE_PLANS_MAX)},null,[]).ok,true);
  // 合并结果越限：既有 16 方案 + 新增 1 → 合并后 17 拒（即使本次只加方案没动别的）
  const fatBase={id:'fat',name:'fat',summary:'',repo:null,page:null,free:{skill:'fat'},paid:null,prices:plans(PRICE_PLANS_MAX)};
  const overflow=applyProductUpdate('fat',{prices:{extra:{amount:1,currency:'cny'}}},fatBase,[]);
  assert.equal(overflow.ok,false);
  assert.match(overflow.message,/prices 无效/);
  // 既有 16 方案、本次不碰 prices → 不误伤
  assert.equal(applyProductUpdate('fat',{summary:'x'},fatBase,[]).ok,true);
  // 序列化字节超 16KB 的载荷整体拒绝（形状/字节任一分支，行为都是 400 prices 无效）
  const huge=applyProductUpdate('a-skill',{prices:{big:{amount:1,currency:'cny',interval:'x'.repeat(20000)}}},null,[]);
  assert.equal(huge.ok,false);
  assert.match(huge.message,/prices 无效/);
});

test('文本字段拒绝 C0/C1 控制字符与 ANSI 转义，仅豁免 \n \t（notes 未来同规则）', () => {
  for (const field of ['name','summary']) {
    for (const bad of ['a\x00b','a\x1b[31mb','a\rb','a\x7fb','a\u0085b','a\u009fb']) {
      const result=applyProductUpdate('a-skill',{[field]:bad},null,[]);
      assert.equal(result.ok,false,`${field}=${JSON.stringify(bad)}`);
      assert.match(result.message,new RegExp(`${field} 无效`));
    }
    // 换行/制表是合法的（说明文本要放多行）
    assert.equal(applyProductUpdate('a-skill',{[field]:'第一行\n第二行\t缩进'},null,[]).ok,true,field);
  }
});

test('page 形状：站内绝对路径 /^\/(?!\/)/，绝对 URL/协议相对/javascript: 全拒', () => {
  const ok=applyProductUpdate('a-skill',{page:'/store/a-skill/'},null,[]);
  assert.equal(ok.ok,true);
  for (const bad of ['http://evil.example/x','//evil.example','javascript:alert(1)','store/x','','/\/evil',' /x']) {
    const result=applyProductUpdate('a-skill',{page:bad},null,[]);
    assert.equal(result.ok,false,JSON.stringify(bad));
    assert.match(result.message,/page 无效/);
  }
});

test('repo 形状：必须 http(s):// 完整 URL', () => {
  for (const good of ['https://github.com/user/repo','http://example.com/a/b?c=d']) {
    assert.equal(applyProductUpdate('a-skill',{repo:good},null,[]).ok,true,good);
  }
  for (const bad of ['ftp://example.com/x','github.com/user/repo','javascript:alert(1)','https://','http://','//example.com/x','example.com']) {
    const result=applyProductUpdate('a-skill',{repo:bad},null,[]);
    assert.equal(result.ok,false,JSON.stringify(bad));
    assert.match(result.message,/repo 无效/);
  }
});

test('price 键集闭合：键必须 ⊆ {amount, currency, interval}，未知键拒绝不透传落库', () => {
  const bad=applyProductUpdate('a-skill',{prices:{lifetime:{amount:1,currency:'cny',bogus:'x'}}},null,[]);
  assert.equal(bad.ok,false);
  assert.match(bad.message,/prices 无效/);
  const extra=applyProductUpdate('a-skill',{prices:{lifetime:{amount:1,currency:'cny',interval:null,extra:1}}},null,[]);
  assert.equal(extra.ok,false);
  assert.equal(applyProductUpdate('a-skill',{prices:{lifetime:{amount:1,currency:'cny',interval:null}}},null,[]).ok,true);
  assert.equal(applyProductUpdate('a-skill',{prices:{lifetime:{amount:1,currency:'cny'}}},null,[]).ok,true);
});
