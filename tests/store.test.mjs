import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { migrate } from '../scripts/migrate.mjs';
import { loadLocalEnv, resetDatabase, startDevServer } from './helpers.mjs';

loadLocalEnv();
const testUrl=process.env.TEST_DATABASE_URL;
const skip=testUrl?false:'TEST_DATABASE_URL 未设置，跳过商品注册集成测试';
process.env.PUBLISHER_EMAILS='publisher@example.com'; // 单名白名单：非 publisher 场景用名单外邮箱

const outboxDir=mkdtempSync(path.join(tmpdir(),'huanyu-store-product-mail-'));
const outbox=path.join(outboxDir,'outbox.jsonl');
let server;

if (testUrl){
  test.before(async()=>{
    delete process.env.RESEND_API_KEY; // 测试一律走假发送器
    process.env.FAKE_MAIL_OUTBOX=outbox;
    await migrate(testUrl);
    server=await startDevServer(testUrl);
  });
  test.after(async()=>{ if (server) await server.stop(); rmSync(outboxDir,{recursive:true,force:true}); });
  test.beforeEach(async()=>{ await resetDatabase(testUrl); writeFileSync(outbox,''); });
}

// —— CLI client.js normalizeCatalog 的同构复刻（跨仓库不可 import；字段/空值/唯一性逐条对齐源码）——
// 外层容错数组/{products}/{catalog}；id 非空唯一、name 非空；free/paid null 或 {skill} 且规范名
// （含 Windows 保留名拒绝）全目录不重复；free/paid 至少其一；prices 为对象。
const CANONICAL=/^[a-z0-9][a-z0-9-]*$/,RESERVED=/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
function normalizeCatalog(data){
  const products=Array.isArray(data)?data:data?.products??data?.catalog;
  if (!Array.isArray(products)) throw new Error('catalogIncomplete');
  const names=new Set(),ids=new Set();
  return products.map((product)=>{
    if (!product||typeof product.id!=='string'||!product.id||ids.has(product.id)
      ||typeof product.name!=='string'||!product.name) throw new Error('catalogDuplicate');
    ids.add(product.id);
    const item={...product,prices:product.prices??{}};
    for (const type of ['free','paid']){
      const variant=product[type];
      if (variant==null){ item[type]=null; continue; }
      const name=typeof variant==='string'?variant:variant.skill;
      if (!CANONICAL.test(name)||RESERVED.test(name)||names.has(name)) throw new Error('catalogInvalidSkill');
      names.add(name);
      item[type]={skill:name};
    }
    if (!item.free&&!item.paid) throw new Error('catalogMissingSkill');
    if (!item.prices||typeof item.prices!=='object'||Array.isArray(item.prices)) throw new Error('catalogInvalidPrice');
    return item;
  });
}

async function post(pathname,body,{cookie}={}){
  const res=await fetch(`${server.base}${pathname}`,{
    method:'POST',
    headers:{'content-type':'application/json',origin:server.base,...(cookie?{cookie}:{})},
    body:JSON.stringify(body),
  });
  return {res,data:await res.json().catch(()=>null)};
}

function readOutbox(){
  return readFileSync(outbox,'utf8').split(/\r?\n/).filter(Boolean).map((line)=>JSON.parse(line));
}

/** 任务 3 的 fetch 驱动链路（假发送器 web 登录 → 设备码批准 → 轮询换令牌）。 */
async function cliTokenOf(email){
  const device=await post('/api/cli/device',{client_name:'hy-test',platform:process.platform});
  assert.equal(device.res.status,200);
  await post('/api/auth/code',{email});
  const code=readOutbox().filter((m)=>m.to===email).at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
  const verified=await post('/api/auth/verify',{email,code});
  assert.equal(verified.res.status,200);
  const cookie=verified.res.headers.getSetCookie().find((c)=>c.startsWith('__Host-huanyu_session=')).split(';')[0];
  const decision=await post('/api/cli/approve',{user_code:device.data.user_code,approve:true},{cookie});
  assert.equal(decision.res.status,200);
  const polled=await post('/api/cli/token',{device_code:device.data.device_code});
  assert.equal(polled.res.status,200);
  return polled.data.token;
}

async function putProduct(skill,body,{token,raw}={}){
  const res=await fetch(`${server.base}/api/store/products/${encodeURIComponent(skill)}`,{
    method:'PUT',
    headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},
    body:raw??JSON.stringify(body),
  });
  return {res,data:await res.json().catch(()=>null)};
}

const getCatalog=async()=>{
  const res=await fetch(`${server.base}/api/store/catalog`);
  return {res,data:await res.json().catch(()=>null)};
};

test('鉴权门槛：无令牌 401、令牌无效 401、非 publisher 403 not_a_publisher、publisher 200',{skip},async()=>{
  const anonymous=await putProduct('demo-skill',{summary:'x'});
  assert.equal(anonymous.res.status,401);
  assert.equal(anonymous.data.error,'unauthorized');

  const garbage=await putProduct('demo-skill',{summary:'x'},{token:'hy_nonsense'});
  assert.equal(garbage.res.status,401);
  assert.equal(garbage.data.error,'unauthorized');
  assert.deepEqual(Object.keys(garbage.data).sort(),['error','message']);

  const reader=await cliTokenOf('reader@example.com');
  const forbidden=await putProduct('demo-skill',{summary:'x'},{token:reader});
  assert.equal(forbidden.res.status,403);
  assert.equal(forbidden.data.error,'not_a_publisher');
  assert.deepEqual(Object.keys(forbidden.data).sort(),['error','message']);

  const publisher=await cliTokenOf('publisher@example.com');
  const allowed=await putProduct('demo-skill',{summary:'x'},{token:publisher});
  assert.equal(allowed.res.status,200,JSON.stringify(allowed.data));
});

test('catalog 公开无鉴权：空目录 {products: []}；注册后立即反映且形状过 CLI normalizeCatalog 复刻',{skip},async()=>{
  const empty=await getCatalog();
  assert.equal(empty.res.status,200);
  assert.deepEqual(empty.data,{products:[]});
  assert.equal(empty.res.headers.get('cache-control'),'no-store','注册→可见必须即时，不做共享缓存');
  assert.equal((await fetch(`${server.base}/api/store/catalog`,{headers:{authorization:'Bearer whatever'}})).status,200,'公开端点不校验令牌');

  const token=await cliTokenOf('publisher@example.com');
  // 创建语义与 CLI 参考服务一致：id 取 URL 规范名、name 兜底同名、free 缺省指向自身；prices 按方案合并。
  const created=await putProduct('demo-skill',{
    name:'演示商品',summary:'说明文本。',repo:'https://example.com/repo',
    free:'demo-skill',paid:'demo-skill-pro',
    prices:{lifetime:{amount:9900,currency:'cny',interval:null}},
  },{token});
  assert.equal(created.res.status,200,JSON.stringify(created.data));
  // PUT 响应即完整商品对象：CLI client.product() 用 normalizeCatalog([data])[0] 校验同一形状
  assert.deepEqual(normalizeCatalog([created.data])[0].id,'demo-skill');
  assert.equal(created.data.name,'演示商品');
  assert.deepEqual(created.data.free,{skill:'demo-skill'});
  assert.deepEqual(created.data.paid,{skill:'demo-skill-pro'});
  assert.deepEqual(created.data.prices,{lifetime:{amount:9900,currency:'cny',interval:null}});

  const catalog=await getCatalog();
  assert.equal(catalog.res.status,200);
  const normalized=normalizeCatalog(catalog.data); // 服务端固定 {products} 外层
  assert.equal(normalized.length,1);
  assert.equal(normalized[0].id,'demo-skill');
  assert.equal(normalized[0].summary,'说明文本。');

  // 最小创建：不带 name/free 也成立（name/free 兜底 URL 规范名）
  const minimal=await putProduct('future-skill',{summary:'预告。'},{token});
  assert.equal(minimal.res.status,200);
  assert.equal(minimal.data.name,'future-skill');
  assert.deepEqual(minimal.data.free,{skill:'future-skill'});
  assert.equal(normalizeCatalog((await getCatalog()).data).length,2);
});

test('合并更新：按 id/free/paid 任一命中定位，只动提供的键，prices 方案级合并',{skip},async()=>{
  const token=await cliTokenOf('publisher@example.com');
  const created=await putProduct('demo-skill',{
    name:'演示商品',summary:'旧摘要',free:'demo-skill',paid:'demo-skill-pro',
    prices:{lifetime:{amount:6900,currency:'cny',interval:null}},
  },{token});
  assert.equal(created.res.status,200);

  // 按 paid 规范名定位：只改 summary，其余键原样
  const byPaid=await putProduct('demo-skill-pro',{summary:'新摘要'},{token});
  assert.equal(byPaid.res.status,200);
  assert.equal(byPaid.data.summary,'新摘要');
  assert.equal(byPaid.data.name,'演示商品');
  assert.deepEqual(byPaid.data.free,{skill:'demo-skill'});
  assert.deepEqual(byPaid.data.paid,{skill:'demo-skill-pro'});
  assert.equal(byPaid.data.prices.lifetime.amount,6900,'未提供的 prices 键不动');

  // 按 id 定位：prices 增新方案保留旧方案；同方案覆盖
  const merged=await putProduct('demo-skill',{prices:{yearly:{amount:12000,currency:'cny'}}},{token});
  assert.equal(merged.res.status,200);
  assert.deepEqual(Object.keys(merged.data.prices).sort(),['lifetime','yearly']);
  const replaced=await putProduct('demo-skill',{prices:{lifetime:{amount:9900,currency:'cny'}}},{token});
  assert.equal(replaced.data.prices.lifetime.amount,9900);
  assert.equal(replaced.data.prices.yearly.amount,12000,'覆盖单方案不丢其他方案');

  // 换配对：paid 整值替换，catalog 立即反映
  const repaired=await putProduct('demo-skill',{paid:'demo-pro-max'},{token});
  assert.equal(repaired.res.status,200);
  assert.deepEqual(repaired.data.paid,{skill:'demo-pro-max'});
  const catalog=normalizeCatalog((await getCatalog()).data);
  assert.deepEqual(catalog[0].paid,{skill:'demo-pro-max'});
});

test('400 拒绝族：skill 名撞车/非法规范名/保留名/prices 形状/未知字段/非对象体',{skip},async()=>{
  const token=await cliTokenOf('publisher@example.com');
  assert.equal((await putProduct('demo-skill',{free:'demo-skill',paid:'demo-skill-pro'},{token})).res.status,200);
  const bad=(skill,body,extra={})=>putProduct(skill,body,{token,...extra});

  // 新商品 free 撞现有商品 paid / id；更新时配对值撞他商品
  for (const [skill,body] of [
    ['b-skill',{free:'demo-skill-pro'}],
    ['b-skill',{free:'demo-skill'}],
    ['demo-skill',{paid:'demo-skill-pro'}], // demo-skill-pro 属自身 paid——不冲突（幂等重设）
  ]) {
    const result=await bad(skill,body);
    if (skill==='demo-skill') assert.equal(result.res.status,200,'自身配对不算冲突');
    else {
      assert.equal(result.res.status,400,`${skill} ${JSON.stringify(body)}`);
      assert.equal(result.data.error,'invalid_field');
      assert.match(result.data.message,/已属于其他商品/);
    }
  }
  // 与另一商品配对（先建第二商品）
  assert.equal((await bad('second-skill',{name:'第二商品'})).res.status,200);
  const clash=await bad('second-skill',{paid:'demo-skill-pro'});
  assert.equal(clash.res.status,400);
  assert.match(clash.data.message,/demo-skill-pro 已属于其他商品/);

  // free 与 paid 相同
  assert.equal((await bad('c-skill',{free:'x-skill',paid:'x-skill'})).res.status,400);
  // URL 规范名非法 / Windows 保留名
  for (const name of ['Bad','a_b','con','com1']) {
    const result=await bad(name,{summary:'x'});
    assert.equal(result.res.status,400,name);
    assert.equal(result.data.error,'invalid_field');
    assert.match(result.data.message,/Skill 名无效/);
  }
  // free 值非法
  assert.equal((await bad('demo-skill',{free:'Bad'})).res.status,400);
  // prices 形状
  for (const prices of [{lifetime:{amount:'x',currency:'cny'}},{lifetime:{amount:0,currency:'cny'}},
    {lifetime:{amount:1,currency:'cn'}},{Bad:{amount:1,currency:'cny'}},'x',[],null]) {
    const result=await bad('demo-skill',{prices});
    assert.equal(result.res.status,400,JSON.stringify(prices));
    assert.match(result.data.message,/prices 无效/);
  }
  // 文本字段与未知字段、非对象体
  assert.equal((await bad('demo-skill',{name:''})).res.status,400);
  assert.equal((await bad('demo-skill',{bogus:1})).res.status,400);
  assert.equal((await putProduct('demo-skill',null,{token,raw:'"text"'})).res.status,400);
  // 全部拒绝后 catalog 不残留脏数据
  const catalog=normalizeCatalog((await getCatalog()).data);
  assert.deepEqual(catalog.map((item)=>item.id),['demo-skill','second-skill']);
});

// —— 真实 CLI 冒烟（沿用任务 3 模式：隔离 APPDATA/XDG，不污染本机配置）——
const CLI_BIN=process.env.HY_CLI_BIN||'C:\\Huanyu-Hibiki\\coding\\Huanyu-CLI\\bin\\hy.js';
const cliSkip=()=> !testUrl?'TEST_DATABASE_URL 未设置，跳过真实 CLI 冒烟'
  :!existsSync(CLI_BIN)?`未找到 ${CLI_BIN}（可用 HY_CLI_BIN 指定），跳过真实 CLI 冒烟`:false;

/** 跑真实 hy 命令：环境隔离（HY_API 指测试服务、APPDATA/XDG 指临时目录），返回 {code,stdout,stderr}。 */
function runCli(args,{token}={}){
  const appdata=mkdtempSync(path.join(tmpdir(),'huanyu-cli-appdata-'));
  const xdg=mkdtempSync(path.join(tmpdir(),'huanyu-cli-xdg-'));
  const env={...process.env,HY_API:server.base,APPDATA:appdata,XDG_CONFIG_HOME:xdg};
  delete env.CI;
  if (token===undefined) delete env.HY_TOKEN; else env.HY_TOKEN=token;
  const child=spawn(process.execPath,[CLI_BIN,...args],{
    cwd:tmpdir(),env,stdio:['ignore','pipe','pipe'],windowsHide:true,
  });
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk)=>{stdout+=chunk;});
  child.stderr.setEncoding('utf8');child.stderr.on('data',(chunk)=>{stderr+=chunk;});
  return new Promise((resolve)=>{
    const timer=setTimeout(()=>{
      if (process.platform==='win32') spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});
      else child.kill('SIGKILL');
    },60_000);
    timer.unref?.();
    child.once('exit',(code)=>{
      clearTimeout(timer);
      rmSync(appdata,{recursive:true,force:true});
      rmSync(xdg,{recursive:true,force:true});
      resolve({code,stdout,stderr});
    });
  });
}

test('真实 CLI 冒烟：hy product 注册后 hy list 可见（退出码 0）；hy product 的完整注册依赖 /api/store/versions（任务 5）',{skip:cliSkip()},async()=>{
  const token=await cliTokenOf('publisher@example.com');
  // 经鉴权 PUT 先落一个商品（等价 CLI fixture 直连钉住服务端语义的做法）
  const seeded=await putProduct('smoke-skill',{
    name:'冒烟商品',summary:'任务4冒烟。',free:'smoke-skill',paid:'smoke-pro',
    prices:{lifetime:{amount:100,currency:'cny',interval:null}},
  },{token});
  assert.equal(seeded.res.status,200,JSON.stringify(seeded.data));

  // hy list 是 CLI 消费 catalog 的命令（cli.js list(ctx) 只读目录，不碰 versions）：
  // 真实 CLI 的 normalizeCatalog 逐字校验服务端目录——退出 0 + 免费付费两行齐全即契约达成。
  const listed=await runCli(['list','--json']);
  assert.equal(listed.code,0,`${listed.stdout}\n${listed.stderr}`);
  const parsed=JSON.parse(listed.stdout);
  assert.equal(parsed.ok,true);
  const skills=parsed.skills;
  assert.deepEqual(skills.map((s)=>s.skill).sort(),['smoke-pro','smoke-skill']);
  const free=skills.find((s)=>s.skill==='smoke-skill');
  assert.equal(free.type,'free');
  assert.equal(free.name,'冒烟商品');
  assert.equal(free.summary,'任务4冒烟。');
  const paid=skills.find((s)=>s.skill==='smoke-pro');
  assert.equal(paid.type,'paid');
  assert.deepEqual(paid.prices,{lifetime:{amount:100,currency:'cny',interval:null}});

  // 真实 hy product：HY_TOKEN 免设备码直连。CLI 的 product 流程硬依赖 GET /api/store/versions
  // （cli.js product(ctx) 在 PUT 前必取版本表做 known 预检），该端点是任务 5 交付——当前 404 使 CLI
  // 以 invalid_response 退出 1。本断言钉住任务边界：任务 5 落地 versions 后翻转为退出 0 的完整注册。
  const product=await runCli(['product','smoke-skill','--set','summary=真实CLI更新。','--json'],{token});
  assert.equal(product.code,1,`${product.stdout}\n${product.stderr}`);
  const event=JSON.parse(product.stdout);
  assert.equal(event.error,'invalid_response');
  assert.equal(event.command,'product');
});
