import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { migrate } from '../scripts/migrate.mjs';
import { loadLocalEnv, resetDatabase, startDevServer } from './helpers.mjs';

loadLocalEnv();
const testUrl=process.env.TEST_DATABASE_URL;
const skip=testUrl?false:'TEST_DATABASE_URL 未设置，跳过版本生命周期集成测试';
process.env.PUBLISHER_EMAILS='publisher@example.com';
delete process.env.BLOB_READ_WRITE_TOKEN; // 集成测试一律走假 Blob 存储
const blobDir=mkdtempSync(path.join(tmpdir(),'huanyu-store-blob-'));
process.env.FAKE_BLOB_DIR=blobDir;
// 与 download.test.mjs 同口径：不设 SITE_ORIGIN——下载断言要走假仓回环 attest URL 取真实字节。

const outboxDir=mkdtempSync(path.join(tmpdir(),'huanyu-store-life-mail-'));
const outbox=path.join(outboxDir,'outbox.jsonl');
let server;

if (testUrl){
  test.before(async()=>{
    delete process.env.RESEND_API_KEY;
    process.env.FAKE_MAIL_OUTBOX=outbox;
    await migrate(testUrl);
    server=await startDevServer(testUrl);
  });
  test.after(async()=>{ if (server) await server.stop(); rmSync(outboxDir,{recursive:true,force:true}); rmSync(blobDir,{recursive:true,force:true}); });
  test.beforeEach(async()=>{ await resetDatabase(testUrl); writeFileSync(outbox,''); rmSync(blobDir,{recursive:true,force:true}); });
}

const sha256Of=(bytes)=>createHash('sha256').update(bytes).digest('hex');
const gz=(input)=>gzipSync(Buffer.from(input));

async function post(pathname,body,{cookie}={}){
  const res=await fetch(`${server.base}${pathname}`,{
    method:'POST',headers:{'content-type':'application/json',origin:server.base,...(cookie?{cookie}:{})},body:JSON.stringify(body),
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

/** publish 上传：头与体按 CLI client.publish 同构。 */
async function publishPackage({name,version,body,notes,token}){
  const res=await fetch(`${server.base}/api/store/publish`,{
    method:'POST',
    headers:{'content-type':'application/gzip','x-skill-name':name,'x-skill-version':version,
      'x-content-sha256':sha256Of(body),
      ...(notes!==undefined?{'x-notes':notes}:{}),
      ...(token?{authorization:`Bearer ${token}`}:{})},
    body,
  });
  return {res,data:await res.json().catch(()=>null)};
}

const releaseUrl=(skill,version)=>`${server.base}/api/store/releases/${encodeURIComponent(skill)}/${encodeURIComponent(version)}`;
const yank=(skill,version,{token}={})=>fetch(releaseUrl(skill,version),{
  method:'DELETE',headers:{...(token?{authorization:`Bearer ${token}`}:{})},
});
const putNotes=(skill,version,notes,{token}={})=>fetch(`${releaseUrl(skill,version)}/notes`,{
  method:'PUT',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},
  body:JSON.stringify(notes),
});
const getVersions=async()=>{
  const res=await fetch(`${server.base}/api/store/versions`);
  return {res,data:await res.json().catch(()=>null)};
};
const download=(name,{version}={})=>{
  const query=new URLSearchParams({format:'tar.gz'});
  if (version!==undefined) query.set('version',version);
  return fetch(`${server.base}/api/store/download/${encodeURIComponent(name)}?${query}`,{redirect:'manual'});
};

/** 302 → 跟随 Location 拿字节（真实 CLI 的 redirect:'follow' 语义同构）。 */
async function follow(location){
  const res=await fetch(location);
  assert.equal(res.status,200,`attest 附件须 200：${location}`);
  return {res,bytes:Buffer.from(await res.arrayBuffer())};
}

test('yank 鉴权与幂等：401/403/未知 404 统一形状；两连删均 200 同形状（CLI unpublish 响应逐字校验）',{skip},async()=>{
  const reader=await cliTokenOf('reader@example.com');
  const publisher=await cliTokenOf('publisher@example.com');
  assert.equal((await publishPackage({name:'yank-skill',version:'1.0.0',body:gz('y'),token:publisher})).res.status,200);

  const anonymous=await yank('yank-skill','1.0.0');
  assert.equal(anonymous.status,401);
  assert.deepEqual(Object.keys(await anonymous.json()).sort(),['error','message']);
  const forbidden=await yank('yank-skill','1.0.0',{token:reader});
  assert.equal(forbidden.status,403);
  assert.equal((await forbidden.json()).error,'not_a_publisher');

  // 未知 skill / 未知版本 → 404 统一形状
  for (const [skill,version] of [['ghost-skill','1.0.0'],['yank-skill','9.9.9']]) {
    const missing=await yank(skill,version,{token:publisher});
    assert.equal(missing.status,404,`${skill} ${version}`);
    const data=await missing.json();
    assert.deepEqual(Object.keys(data).sort(),['error','message']);
    assert.equal(data.error,'not_found');
  }

  // 首删与重复删：均 200，响应形状逐字 = {skill, version, yanked: true}（client.js unpublish 校验）
  for (const round of [1,2]) {
    const res=await yank('yank-skill','1.0.0',{token:publisher});
    assert.equal(res.status,200,`第 ${round} 次删除须 200（幂等）`);
    assert.deepEqual(await res.json(),{skill:'yank-skill',version:'1.0.0',yanked:true});
  }
  // 下架后 versions 保留条目并标记
  const entry=(await getVersions()).data.skills['yank-skill'];
  assert.equal(entry.latest,'1.0.0','仅一版且已下架 → 最高版本占位');
  assert.equal(entry.history[0].yanked,true);

  // 孤儿版本（未注册商品）同样可下架
  assert.equal((await publishPackage({name:'orphan-yank-skill',version:'0.1.0',body:gz('o'),token:publisher})).res.status,200);
  const orphan=await yank('orphan-yank-skill','0.1.0',{token:publisher});
  assert.equal(orphan.status,200);
  assert.deepEqual(await orphan.json(),{skill:'orphan-yank-skill',version:'0.1.0',yanked:true});
});

test('契约假设 #4 三条：yank 后 latest 回落 + history 保留标记；全下架 latest 占位 + 任何版本下载 404',{skip},async()=>{
  const publisher=await cliTokenOf('publisher@example.com');
  const v1=gz('life v1 bytes'),v2=gz('life v2 bytes'),v3=gz('life v3 bytes');
  for (const [version,body] of [['1.0.0',v1],['2.0.0',v2],['3.0.0',v3]])
    assert.equal((await publishPackage({name:'life-skill',version,body,token:publisher})).res.status,200);

  // 条 1+2：yank 3.0.0 → latest 回落 2.0.0；history 保留三条且 3.0.0 带 yanked 标记
  assert.deepEqual(await (await yank('life-skill','3.0.0',{token:publisher})).json(),{skill:'life-skill',version:'3.0.0',yanked:true});
  let entry=(await getVersions()).data.skills['life-skill'];
  assert.equal(entry.latest,'2.0.0','latest 回落到最高未下架版本');
  assert.deepEqual(entry.history.map((item)=>item.version),['3.0.0','2.0.0','1.0.0'],'history 保留全部条目');
  assert.equal(entry.history[0].yanked,true,'下架条目带 yanked: true');
  assert.ok(!('yanked' in entry.history[1])&&!('yanked' in entry.history[2]),'未下架条目不带 yanked 键');
  assert.equal(entry.sha256,sha256Of(v2),'sha256 指向回落后的 latest');
  // 下载：缺省 = 2.0.0 字节（latest 回落的消费端证明）；显式 3.0.0 → 404
  const def=await download('life-skill');
  assert.equal(def.status,302);
  assert.deepEqual((await follow(def.headers.get('location'))).bytes,v2,'缺省版本字节 = 回落后的 latest（2.0.0）');
  assert.equal((await download('life-skill',{version:'3.0.0'})).status,404,'已下架版本显式请求 404');

  // 条 3：全部下架 → latest=3.0.0 占位（形状完整 + 全 history yanked），任何版本下载 404
  await yank('life-skill','2.0.0',{token:publisher});
  await yank('life-skill','1.0.0',{token:publisher});
  entry=(await getVersions()).data.skills['life-skill'];
  assert.equal(entry.latest,'3.0.0','全部下架 → 最高版本占位（CLI 显示「全部版本已下架」）');
  assert.ok(entry.history.every((item)=>item.yanked===true),'全 history yanked');
  assert.ok(entry.history.some((item)=>item.version===entry.latest&&item.yanked),'CLI skills.js latestYanked 同构判定成立');
  assert.equal(typeof entry.sha256,'string','占位形状完整：sha256 仍在');
  assert.match(entry.download_url,/version=3\.0\.0/,'占位 download_url 指向最高版本');
  for (const version of [undefined,'1.0.0','2.0.0','3.0.0'])
    assert.equal((await download('life-skill',{version})).status,404,`全部下架后 ${version??'缺省'} 下载 404`);
});

test('version_regression 取历史最高（含 yank）：yank 2.0.0 后发 1.5.0 仍 409；重发已下架版本 409 version_exists',{skip},async()=>{
  const publisher=await cliTokenOf('publisher@example.com');
  assert.equal((await publishPackage({name:'regress-skill',version:'1.0.0',body:gz('a'),token:publisher})).res.status,200);
  assert.equal((await publishPackage({name:'regress-skill',version:'2.0.0',body:gz('b'),token:publisher})).res.status,200);
  assert.equal((await yank('regress-skill','2.0.0',{token:publisher})).status,200);

  // 任务 5 登记口径：下架不解除单调性——历史最高（含 yank）仍是地板
  const lower=await publishPackage({name:'regress-skill',version:'1.5.0',body:gz('c'),token:publisher});
  assert.equal(lower.res.status,409,'低于已下架的历史最高仍拒绝');
  assert.equal(lower.data.error,'version_regression');
  assert.match(lower.data.message,/1\.5\.0/);
  assert.match(lower.data.message,/2\.0\.0/);

  // 已下架版本仍占 (skill,version) 主键（与「历史最高含 yank」口径自洽）
  const same=await publishPackage({name:'regress-skill',version:'2.0.0',body:gz('different bytes'),token:publisher});
  assert.equal(same.res.status,409);
  assert.equal(same.data.error,'version_exists');

  // 高于历史最高的新版本放行（yank 不阻塞版本号前进）
  assert.equal((await publishPackage({name:'regress-skill',version:'2.1.0',body:gz('d'),token:publisher})).res.status,200);
  assert.equal((await getVersions()).data.skills['regress-skill'].latest,'2.1.0');
});

test('notes 修订：PUT 后 versions 立即反映；空串归一 null；长度/控制字符/bidi 全拒；缺键与非字符串 400；未知版本 404',{skip},async()=>{
  const reader=await cliTokenOf('reader@example.com');
  const publisher=await cliTokenOf('publisher@example.com');
  assert.equal((await publishPackage({name:'notes-skill',version:'1.0.0',body:gz('n'),notes:encodeURIComponent('首发说明'),token:publisher})).res.status,200);

  assert.equal((await putNotes('notes-skill','1.0.0',{notes:'x'})).status,401);
  assert.equal((await putNotes('notes-skill','1.0.0',{notes:'x'},{token:reader})).status,403);

  // 修订成功：响应 {skill, version, notes}，versions 立即反映
  const revised=await putNotes('notes-skill','1.0.0',{notes:'修订后的说明。\n第二行'},{token:publisher});
  const revisedBody=await revised.json().catch(()=>null);
  assert.equal(revised.status,200,JSON.stringify(revisedBody));
  assert.deepEqual(revisedBody,{skill:'notes-skill',version:'1.0.0',notes:'修订后的说明。\n第二行'});
  assert.equal((await getVersions()).data.skills['notes-skill'].history[0].notes,'修订后的说明。\n第二行');

  // 空串归一 null（清空说明）；versions 同步为 null
  const cleared=await putNotes('notes-skill','1.0.0',{notes:''},{token:publisher});
  const clearedBody=await cleared.json().catch(()=>null);
  assert.equal(cleared.status,200);
  assert.deepEqual(clearedBody,{skill:'notes-skill',version:'1.0.0',notes:null});
  assert.equal((await getVersions()).data.skills['notes-skill'].history[0].notes,null);

  // 未提供 notes 键 / 非 JSON 体 / 非字符串值 → 400（body 按原始文本发送，覆盖非 JSON 形态）
  for (const body of ['{}','not json','{"summary":"x"}','{"notes":42}','{"notes":null}']) {
    const res=await fetch(`${releaseUrl('notes-skill','1.0.0')}/notes`,{
      method:'PUT',headers:{'content-type':'application/json',authorization:`Bearer ${publisher}`},body,
    });
    assert.equal(res.status,400,JSON.stringify(body));
    assert.equal((await res.json()).error,'invalid_field');
  }
  // 长度/编码与 X-Notes 同源：超 2000 / 控制字符 / bidi 全套
  for (const notes of ['x'.repeat(2001),'a\x1b[31mb','a\rb','a\u200bb','a\u202eb','a\u2028b','a\u2066b']) {
    const res=await putNotes('notes-skill','1.0.0',{notes},{token:publisher});
    assert.equal(res.status,400,JSON.stringify(notes));
    assert.equal((await res.json()).error,'invalid_field');
  }
  // 恰好 2000 放行（边界值）
  assert.equal((await putNotes('notes-skill','1.0.0',{notes:'y'.repeat(2000)},{token:publisher})).status,200);
  // 未知版本 → 404 统一形状
  const missing=await putNotes('notes-skill','9.9.9',{notes:'x'},{token:publisher});
  assert.equal(missing.status,404);
  assert.deepEqual(Object.keys(await missing.json()).sort(),['error','message']);
});

// —— 审查修复（security L-1 / L-6）：早退体清空与参数形状预检 ——

test('早退路径清空请求体（security L-1）：yank/notes 的 401/403 与预检 404 早退后连接可复用',{skip},async()=>{
  const reader=await cliTokenOf('reader@example.com');
  const publisher=await cliTokenOf('publisher@example.com');
  // 大体（512KB）让响应先于体完成：未消费完就回响应会毒化 keep-alive 连接
  const body=JSON.stringify({notes:'x'.repeat(512*1024)});
  const cases=[
    {method:'DELETE',path:releaseUrl('drain-skill','1.0.0'),auth:null,status:401,error:'unauthorized'},
    {method:'DELETE',path:releaseUrl('drain-skill','1.0.0'),auth:reader,status:403,error:'not_a_publisher'},
    {method:'PUT',path:`${releaseUrl('drain-skill','1.0.0')}/notes`,auth:null,status:401,error:'unauthorized'},
    {method:'PUT',path:`${releaseUrl('drain-skill','1.0.0')}/notes`,auth:reader,status:403,error:'not_a_publisher'},
    // 形状预检 404（security L-6）：非法 skill/version 不触库直接早退，同须清空体
    {method:'DELETE',path:releaseUrl('Bad','1.0.0'),auth:publisher,status:404,error:'not_found'},
    {method:'DELETE',path:releaseUrl('drain-skill','01.0.0'),auth:publisher,status:404,error:'not_found'},
    {method:'PUT',path:`${releaseUrl('Bad','1.0.0')}/notes`,auth:publisher,status:404,error:'not_found'},
    {method:'PUT',path:`${releaseUrl('drain-skill','1.0')}/notes`,auth:publisher,status:404,error:'not_found'},
  ];
  for (const testCase of cases){
    const rejected=await fetch(testCase.path,{
      method:testCase.method,
      headers:{'content-type':'application/json',...(testCase.auth?{authorization:`Bearer ${testCase.auth}`}:{})},
      body,
    });
    assert.equal(rejected.status,testCase.status,JSON.stringify(testCase));
    assert.equal((await rejected.json()).error,testCase.error);
    // 不变量钉住：早退已清空体 → 紧跟同连接池的请求 5s 内完成（否则 undici 悬挂到 300s headersTimeout）
    const follow=await fetch(`${server.base}/api/store/versions`,{signal:AbortSignal.timeout(5000)});
    assert.equal(follow.status,200);
    await follow.json();
  }
});

test('参数形状预检（security L-6）：非法 skill/version 直接 404 统一形状，合法形状仍走库判定',{skip},async()=>{
  const publisher=await cliTokenOf('publisher@example.com');
  for (const [skill,version] of [['Bad','1.0.0'],['a_b','1.0.0'],['con','1.0.0'],['ok-skill','01.0.0'],['ok-skill','1.0'],['ok-skill','v1.0.0']]) {
    const missing=await yank(skill,version,{token:publisher});
    assert.equal(missing.status,404,`${skill} ${version}`);
    assert.deepEqual(await missing.json(),{error:'not_found',message:'未找到该版本。'});
    const notes=await putNotes(skill,version,{notes:'x'},{token:publisher});
    assert.equal(notes.status,404,`${skill} ${version} notes`);
    assert.deepEqual(await notes.json(),{error:'not_found',message:'未找到该版本。'});
  }
  // 合法形状但不存在：同样 404（库判定路径不受预检影响）
  assert.equal((await yank('ghost-skill','1.0.0',{token:publisher})).status,404);
  assert.equal((await putNotes('ghost-skill','1.0.0',{notes:'x'},{token:publisher})).status,404);
});

// —— 真实 CLI 冒烟（任务 7 核心交付）：三版本 → 真实 hy unpublish → install 装出回落版 → status 展示 ——
const CLI_BIN=process.env.HY_CLI_BIN||'C:\\Huanyu-Hibiki\\coding\\Huanyu-CLI\\bin\\hy.js';
const cliSkip=()=> !testUrl?'TEST_DATABASE_URL 未设置，跳过真实 CLI 冒烟'
  :!existsSync(CLI_BIN)?`未找到 ${CLI_BIN}（可用 HY_CLI_BIN 指定），跳过真实 CLI 冒烟`:false;

/** CLI 子进程：HOME/USERPROFILE/APPDATA/XDG 全部指向沙箱（与 download.test.mjs 同款隔离）。 */
function runCli(args,{token,sandbox,cwd}){
  const env={...process.env,HY_API:server.base,
    ...(sandbox?{USERPROFILE:sandbox.home,HOME:sandbox.home,APPDATA:sandbox.appdata,XDG_CONFIG_HOME:sandbox.xdg}:{})};
  delete env.CI;
  delete env.CODEX_HOME;
  if (token===undefined) delete env.HY_TOKEN; else env.HY_TOKEN=token;
  const child=spawn(process.execPath,[CLI_BIN,...args],{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk)=>{stdout+=chunk;});
  child.stderr.setEncoding('utf8');child.stderr.on('data',(chunk)=>{stderr+=chunk;});
  return new Promise((resolve)=>{
    const timer=setTimeout(()=>{
      if (process.platform==='win32') spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});
      else child.kill('SIGKILL');
    },120_000);
    timer.unref?.();
    child.once('exit',(code)=>{ clearTimeout(timer); resolve({code,stdout,stderr}); });
  });
}

/** CLI fixture 的 writeSkill 同构：SKILL.md frontmatter 带 name 与 metadata.version。 */
function writeSkill(root,name,version){
  const directory=path.join(root,name);
  mkdirSync(path.join(directory,'assets'),{recursive:true});
  writeFileSync(path.join(directory,'SKILL.md'),
    `---\nname: ${name}\ndescription: 生命周期冒烟 Skill\nmetadata:\n  version: "${version}"\n---\n\n# 生命周期冒烟\n`);
  writeFileSync(path.join(directory,'assets','example.txt'),`${name} ${version}\n`);
  return directory;
}

test('真实 CLI 冒烟：三版本 → hy unpublish 3.0.0 退出 0 → hy install 装出 2.0.0（latest 回落）→ hy status 含 2.0.0 → 全下架占位',{skip:cliSkip()},async()=>{
  const token=await cliTokenOf('publisher@example.com');
  const scratch=mkdtempSync(path.join(tmpdir(),'hy-life-smoke-'));
  const sandboxRoot=mkdtempSync(path.join(tmpdir(),'hy-life-sandbox-'));
  const sandbox={root:sandboxRoot,home:path.join(sandboxRoot,'home'),
    appdata:path.join(sandboxRoot,'appdata'),xdg:path.join(sandboxRoot,'xdg')};
  // 预建 .zcode：installationRoots 只认「宿主根的父目录已存在」的宿主，zcode 是最高优先序
  mkdirSync(path.join(sandbox.home,'.zcode'),{recursive:true});
  const name='smoke-life-skill';
  try{
    for (const version of ['1.0.0','2.0.0','3.0.0']){
      writeSkill(scratch,name,version);
      const published=await runCli(['publish',path.join(scratch,name),'--json'],{token,sandbox,cwd:scratch});
      assert.equal(published.code,0,`${published.stdout}\n${published.stderr}`);
    }
    const product=await runCli(['product',name,'--set','summary=生命周期冒烟。','--json'],{token,sandbox,cwd:scratch});
    assert.equal(product.code,0,`${product.stdout}\n${product.stderr}`);

    // 真实 hy unpublish <skill> 3.0.0：响应过 client.js unpublish 逐字校验，退出 0
    // （--json 外层是 CLI 输出包装 {ok, command, ...}，事件字段逐一断言）
    const unpublish=await runCli(['unpublish',name,'3.0.0','--json'],{token,sandbox,cwd:scratch});
    assert.equal(unpublish.code,0,`${unpublish.stdout}\n${unpublish.stderr}`);
    const unpublishEvent=JSON.parse(unpublish.stdout);
    assert.equal(unpublishEvent.event,'unpublish');
    assert.equal(unpublishEvent.skill,name);
    assert.equal(unpublishEvent.version,'3.0.0');
    assert.equal(unpublishEvent.yanked,true);

    // hy install：latest 已回落 → 装出 2.0.0（端到端证明）
    const install=await runCli(['install',name,'--json'],{sandbox,cwd:scratch});
    assert.equal(install.code,0,`${install.stdout}\n${install.stderr}`);
    assert.equal(JSON.parse(install.stdout).installations[0].version,'2.0.0','install 恒装 latest（yank 后回落 2.0.0）');
    const hostRoot=path.join(sandbox.home,'.zcode','skills');
    assert.match(readFileSync(path.join(hostRoot,name,'SKILL.md'),'utf8'),/version: "2\.0\.0"/);

    // hy status：读 versions 展示当前/最新版本（含 2.0.0），尚有未下架版本不打全下架标记
    const status=await runCli(['status','--json'],{sandbox,cwd:scratch});
    assert.equal(status.code,0,`${status.stdout}\n${status.stderr}`);
    const installed=JSON.parse(status.stdout).installations.find((item)=>item.name===name);
    assert.equal(installed.current,'2.0.0');
    assert.equal(installed.latest,'2.0.0','status 的 latest = 回落后的 2.0.0');
    assert.ok(!installed.all_yanked,'尚有未下架版本');

    // 下架剩余两版 → status 换占位语义：latest=3.0.0 占位 + all_yanked（CLI「全部版本已下架」分支）
    for (const version of ['2.0.0','1.0.0']){
      const again=await runCli(['unpublish',name,version,'--json'],{token,sandbox,cwd:scratch});
      assert.equal(again.code,0,`${again.stdout}\n${again.stderr}`);
    }
    const after=await runCli(['status','--json'],{sandbox,cwd:scratch});
    assert.equal(after.code,0,`${after.stdout}\n${after.stderr}`);
    const yankedAll=JSON.parse(after.stdout).installations.find((item)=>item.name===name);
    assert.equal(yankedAll.latest,'3.0.0','全部下架 → latest 占位最高版本');
    assert.equal(yankedAll.all_yanked,true,'CLI 检出「全部版本已下架」（占位语义端到端）');
  } finally {
    rmSync(scratch,{recursive:true,force:true});
    rmSync(sandbox.root,{recursive:true,force:true});
  }
});
