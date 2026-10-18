import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import postgres from 'postgres';
import { migrate } from '../scripts/migrate.mjs';
import { loadLocalEnv, resetDatabase, startDevServer } from './helpers.mjs';

loadLocalEnv();
const testUrl=process.env.TEST_DATABASE_URL;
const skip=testUrl?false:'TEST_DATABASE_URL 未设置，跳过版本发布集成测试';
process.env.PUBLISHER_EMAILS='publisher@example.com';
delete process.env.BLOB_READ_WRITE_TOKEN; // 集成测试一律走假 Blob 存储
const blobDir=mkdtempSync(path.join(tmpdir(),'huanyu-store-blob-'));
process.env.FAKE_BLOB_DIR=blobDir;
// security L-1：本文件全部 download_url/publish.url 断言经 SITE_ORIGIN 规范源闸门
process.env.SITE_ORIGIN='https://origin.example';

const outboxDir=mkdtempSync(path.join(tmpdir(),'huanyu-store-publish-mail-'));
const outbox=path.join(outboxDir,'outbox.jsonl');
let server;

if (testUrl){
  test.before(async()=>{
    delete process.env.RESEND_API_KEY; // 测试一律走假发送器
    process.env.FAKE_MAIL_OUTBOX=outbox;
    await migrate(testUrl);
    server=await startDevServer(testUrl);
  });
  test.after(async()=>{ if (server) await server.stop(); rmSync(outboxDir,{recursive:true,force:true}); rmSync(blobDir,{recursive:true,force:true}); });
  test.beforeEach(async()=>{ await resetDatabase(testUrl); writeFileSync(outbox,''); rmSync(blobDir,{recursive:true,force:true}); });
}

const sha256Of=(bytes)=>createHash('sha256').update(bytes).digest('hex');
const gz=(input)=>gzipSync(Buffer.from(input));
const NOTES='首发说明：修复若干问题。\n第二行';

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

/** publish 上传：头与体按 CLI client.publish 同构（sha256 缺省按体计算，便于注入错值）。 */
async function publishPackage({name='demo-skill',version='1.0.0',sha256,body,notes,token}){
  const res=await fetch(`${server.base}/api/store/publish`,{
    method:'POST',
    headers:{'content-type':'application/gzip','x-skill-name':name,'x-skill-version':version,
      'x-content-sha256':sha256??sha256Of(body),
      ...(notes!==undefined?{'x-notes':notes}:{}),
      ...(token?{authorization:`Bearer ${token}`}:{})},
    body,
  });
  return {res,data:await res.json().catch(()=>null)};
}

const getVersions=async()=>{
  const res=await fetch(`${server.base}/api/store/versions`);
  return {res,data:await res.json().catch(()=>null)};
};

async function putProduct(skill,body,{token}={}){
  const res=await fetch(`${server.base}/api/store/products/${encodeURIComponent(skill)}`,{
    method:'PUT',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body),
  });
  return {res,data:await res.json().catch(()=>null)};
}

// CLI client.js versions() 的同构复刻：catalog 内每个名字必有条目、latest 严格 semver、history 数组。
const SEMVER_STRICT=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function cliVersionsCheck(catalog,data){
  const skills=data?.skills??data;
  for (const product of catalog){
    for (const type of ['free','paid']){
      const name=product[type]?.skill;
      if (!name) continue;
      const release=skills?.[name];
      if (!release||!SEMVER_STRICT.test(release.latest)||!Array.isArray(release.history))
        throw new Error(`invalidVersions: ${name}`);
    }
  }
  return skills;
}

/** 假存储里某 skill 的落盘文件（每版本一个；调用方自行约束版本数）。 */
function blobFilesOf(skill){
  const directory=path.join(blobDir,'releases',skill);
  return existsSync(directory)?readdirSync(directory).map((name)=>path.join(directory,name)):[];
}

test('publish 错误族：401 无令牌 / 403 非 publisher / 400 头形状（名字、semver、hex）',{skip},async()=>{
  const body=gz('package body');
  const anonymous=await publishPackage({body});
  assert.equal(anonymous.res.status,401);
  assert.equal(anonymous.data.error,'unauthorized');

  const reader=await cliTokenOf('reader@example.com');
  const forbidden=await publishPackage({body,token:reader});
  assert.equal(forbidden.res.status,403);
  assert.equal(forbidden.data.error,'not_a_publisher');
  assert.deepEqual(Object.keys(forbidden.data).sort(),['error','message']);

  const publisher=await cliTokenOf('publisher@example.com');
  // 头形状：非法名 / 前导零 semver / 摘要非 64 hex（鉴权已过，管道在头校验早退——不读体）
  for (const headers of [{name:'Bad'},{name:'con'},{version:'01.0.0'},{version:'1.0'},{sha256:'0'.repeat(63)},{sha256:'g'.repeat(64)}]) {
    const result=await publishPackage({...headers,body,token:publisher});
    assert.equal(result.res.status,400,JSON.stringify(headers));
    assert.equal(result.data.error,'invalid_package');
  }
  // X-Notes：坏百分号编码 / 解码后超 2000 / 控制字符
  for (const notes of ['%ZZ',encodeURIComponent('x'.repeat(2001)),encodeURIComponent('a\x1b[31mb')]) {
    const result=await publishPackage({body,notes,token:publisher});
    assert.equal(result.res.status,400,JSON.stringify(notes));
    assert.equal(result.data.error,'invalid_package');
  }
  // 全部拒绝后不落任何版本记录
  assert.deepEqual((await getVersions()).data,{skills:{}});
});

test('publish 错误族：400 魔数非 gzip / 400 摘要不符 / 409 同版本重发 / 409 低于最高版本',{skip},async()=>{
  const publisher=await cliTokenOf('publisher@example.com');
  const first=await publishPackage({name:'gate-skill',version:'1.0.0',body:gz('v1'),token:publisher});
  assert.equal(first.res.status,200,JSON.stringify(first.data));

  const notGzip=await publishPackage({name:'gate-skill',version:'1.0.1',body:Buffer.from('plain text'),token:publisher});
  assert.equal(notGzip.res.status,400);
  assert.equal(notGzip.data.error,'invalid_package');
  assert.match(notGzip.data.message,/gzip/);

  const wrongSha=await publishPackage({name:'gate-skill',version:'1.0.1',sha256:'0'.repeat(64),body:gz('v2'),token:publisher});
  assert.equal(wrongSha.res.status,400);
  assert.equal(wrongSha.data.error,'invalid_package');

  // 同版本重发（内容不同）：按 (skill,version) 唯一拒绝，不比对历史 sha（契约幂等语义）
  const duplicate=await publishPackage({name:'gate-skill',version:'1.0.0',body:gz('v1 different bytes'),token:publisher});
  assert.equal(duplicate.res.status,409);
  assert.equal(duplicate.data.error,'version_exists');

  // 低于最高版本：409 version_regression（CLI 对未知 409 code 展示 message，文案指明两个版本号）
  const regression=await publishPackage({name:'gate-skill',version:'0.2.0',body:gz('old'),token:publisher});
  assert.equal(regression.res.status,409);
  assert.equal(regression.data.error,'version_regression');
  assert.match(regression.data.message,/0\.2\.0/);
  assert.match(regression.data.message,/1\.0\.0/);

  // 跳版本允许：1.0.0 → 2.5.0 直接放行
  const skip=await publishPackage({name:'gate-skill',version:'2.5.0',body:gz('v3'),token:publisher});
  assert.equal(skip.res.status,200,JSON.stringify(skip.data));

  const versions=(await getVersions()).data.skills['gate-skill'];
  assert.deepEqual(versions.history.map((item)=>item.version),['2.5.0','1.0.0'],'失败请求不落库，成功两版降序');
});

test('publish 413 too_large：4.1MB 真实 gzip 实测包（早退与流式累计双路径）',{skip},async()=>{
  const publisher=await cliTokenOf('publisher@example.com');
  // 不可压缩随机字节 → gzip 后仍 >4MB，模拟真实大包（设计风险表点名实测项）
  const big=gzipSync(randomBytes(4300000));
  assert.ok(big.length>4*1024*1024,`实测包须超 4MB（当前 ${big.length}）`);
  const result=await publishPackage({name:'big-skill',version:'1.0.0',body:big,token:publisher});
  assert.equal(result.res.status,413,JSON.stringify(result.data));
  assert.equal(result.data.error,'too_large');
  // 流式累计路径：分块上传（无整体 Content-Length 的 Web 流式体，与 CLI 上传同构）同样 413
  const stream=new ReadableStream({start(controller){
    for (let offset=0;offset<big.length;offset+=512*1024) controller.enqueue(big.subarray(offset,offset+512*1024));
    controller.close();
  }});
  const streamed=await fetch(`${server.base}/api/store/publish`,{
    method:'POST',duplex:'half',
    headers:{'content-type':'application/gzip','x-skill-name':'big-skill','x-skill-version':'1.0.0',
      'x-content-sha256':sha256Of(big),authorization:`Bearer ${publisher}`},
    body:stream,
  });
  assert.equal(streamed.status,413);
  assert.equal((await streamed.json()).error,'too_large');
  // 拒绝后无版本记录、无落盘对象
  assert.deepEqual((await getVersions()).data,{skills:{}});
  assert.deepEqual(blobFilesOf('big-skill'),[]);
});

test('publish 成功：响应五字段逐字过 CLI publishResponse（size=实际字节数）；假存储落盘哈希一致',{skip},async()=>{
  const publisher=await cliTokenOf('publisher@example.com');
  const body=gz('real package content');
  const result=await publishPackage({name:'ok-skill',version:'1.0.0',body,notes:encodeURIComponent(NOTES),token:publisher});
  assert.equal(result.res.status,200,JSON.stringify(result.data));
  // CLI client.publish 的响应校验逐字复刻：skill/version/sha256 回显、size===上传字节数、url 非空字符串
  assert.equal(result.data.skill,'ok-skill');
  assert.equal(result.data.version,'1.0.0');
  assert.equal(result.data.sha256,sha256Of(body));
  assert.ok(Number.isSafeInteger(result.data.size)&&result.data.size===body.length);
  assert.equal(typeof result.data.url,'string');
  assert.ok(result.data.url.length>0);
  assert.match(result.data.url,/\/api\/store\/download\/ok-skill\?version=1\.0\.0&format=tar\.gz$/);
  // 假存储私有性：对象只落本地目录（不经任何公开路由），内容哈希与 X-Content-SHA256 一致
  const files=blobFilesOf('ok-skill');
  assert.equal(files.length,1);
  assert.equal(sha256Of(readFileSync(files[0])),sha256Of(body));
  // versions 立即可查：latest/history/notes 解码/published_at ISO
  const entry=(await getVersions()).data.skills['ok-skill'];
  assert.equal(entry.latest,'1.0.0');
  assert.equal(entry.sha256,sha256Of(body));
  assert.equal(entry.download_url,result.data.url);
  assert.equal(entry.history.length,1);
  assert.equal(entry.history[0].notes,NOTES);
  assert.ok(!Number.isNaN(Date.parse(entry.history[0].published_at)),'published_at 是可解析的 ISO 字符串');
});

test('publish 两版本：history 降序、latest 正确、跳版本后回落旧版被拒',{skip},async()=>{
  const publisher=await cliTokenOf('publisher@example.com');
  assert.equal((await publishPackage({name:'multi-skill',version:'0.1.0',body:gz('a'),notes:encodeURIComponent('第一版'),token:publisher})).res.status,200);
  assert.equal((await publishPackage({name:'multi-skill',version:'1.2.0',body:gz('b'),notes:encodeURIComponent('第二版'),token:publisher})).res.status,200);
  const entry=(await getVersions()).data.skills['multi-skill'];
  assert.equal(entry.latest,'1.2.0');
  assert.deepEqual(entry.history.map((item)=>item.version),['1.2.0','0.1.0']);
  assert.deepEqual(entry.history.map((item)=>item.notes),['第二版','第一版']);
  assert.equal(entry.sha256,sha256Of(gz('b')),'sha256 指向 latest');
  // 低于最高（0.9.0 < 1.2.0）拒绝
  const stale=await publishPackage({name:'multi-skill',version:'0.9.0',body:gz('c'),token:publisher});
  assert.equal(stale.res.status,409);
  assert.equal(stale.data.error,'version_regression');
});

test('versions 与 CLI 语义对齐：catalog 名字必有条目（未发布占位）、孤儿条目可见、versions() 复刻通过',{skip},async()=>{
  const publisher=await cliTokenOf('publisher@example.com');
  assert.equal((await putProduct('shop-skill',{name:'商店商品',summary:'说明。',free:'shop-skill',paid:'shop-pro'},{token:publisher})).res.status,200);
  assert.equal((await publishPackage({name:'shop-skill',version:'1.0.0',body:gz('s'),token:publisher})).res.status,200);
  // 孤儿版本：未入目录的 skill 也可见（CLI product 预检 known 依赖 versions[skill]）
  assert.equal((await publishPackage({name:'orphan-skill',version:'0.3.0',body:gz('o'),token:publisher})).res.status,200);

  const {res,data}=await getVersions();
  assert.equal(res.status,200);
  assert.equal(res.headers.get('cache-control'),'no-store','发布→查询必须即时可见');
  // CLI versions() 同构断言：catalog（free shop-skill + paid shop-pro）每个名字必有合法条目
  const catalog=(await (await fetch(`${server.base}/api/store/catalog`)).json()).products;
  const skills=cliVersionsCheck(catalog,data);
  assert.equal(skills['shop-skill'].latest,'1.0.0');
  assert.deepEqual(skills['shop-pro'],{latest:'0.0.0',history:[]},'未发布名字占位过 CLI 校验');
  assert.equal(skills['orphan-skill'].latest,'0.3.0','孤儿条目对 CLI 可见（product 预检）');
});

// —— 审查修复：quality M1+security L-3 / M2 / M-1 / L-1 ——

test('早退路径清空请求体：401/403/头形状 400 早退后连接可复用（quality M1+security L-3）',{skip},async()=>{
  const publisher=await cliTokenOf('publisher@example.com');
  const reader=await cliTokenOf('reader@example.com');
  const body=gz('x'.repeat(512*1024));
  const streamBody=()=>new ReadableStream({start(controller){
    for (let offset=0;offset<body.length;offset+=64*1024) controller.enqueue(body.subarray(offset,offset+64*1024));
    controller.close();
  }});
  // 三早退路径全带流式体（响应先于体完成）：未消费完就回响应会毒化 keep-alive 连接
  const cases=[
    {headers:{},status:401,error:'unauthorized'},
    {headers:{authorization:`Bearer ${reader}`},status:403,error:'not_a_publisher'},
    {headers:{'x-skill-name':'Bad',authorization:`Bearer ${publisher}`},status:400,error:'invalid_package'},
  ];
  for (const testCase of cases){
    const rejected=await fetch(`${server.base}/api/store/publish`,{
      method:'POST',duplex:'half',
      headers:{'content-type':'application/gzip','x-skill-name':'drain-skill','x-skill-version':'1.0.0',
        'x-content-sha256':sha256Of(body),...testCase.headers},
      body:streamBody(),
    });
    assert.equal(rejected.status,testCase.status,JSON.stringify(testCase));
    assert.equal((await rejected.json()).error,testCase.error);
    // 不变量钉住：早退已清空体 → 紧跟同连接池的请求 5s 内完成（否则 undici 悬挂到 300s headersTimeout）
    const follow=await fetch(`${server.base}/api/store/versions`,{signal:AbortSignal.timeout(5000)});
    assert.equal(follow.status,200);
    await follow.json();
  }
  assert.deepEqual((await getVersions()).data,{skills:{}},'早退的版本不得落库');
});

test('并发版本单调性（quality M2）：并发发 2.0.0 与 1.5.0，恰一个 200 一个 409 version_regression',{skip},async()=>{
  const publisher=await cliTokenOf('publisher@example.com');
  // node:http 裸 socket 各起一条连接：fetch 可能复用同一 keep-alive 连接把两请求排队成串行，
  // 竞态窗口就消失——裸连接保证两请求在服务端真正同时落地
  const postRaw=(skill,body,version)=>new Promise((resolve,reject)=>{
    const req=httpRequest(new URL('/api/store/publish',server.base),{method:'POST',headers:{
      'content-type':'application/gzip','x-skill-name':skill,'x-skill-version':version,
      'x-content-sha256':sha256Of(body),authorization:`Bearer ${publisher}`}},(res)=>{
      let raw=''; res.setEncoding('utf8'); res.on('data',(chunk)=>raw+=chunk);
      res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));
    });
    req.on('error',reject);
    req.end(body);
  });
  // 多轮（新 skill 各一轮）暴露偶发的交错：无锁时低版本可能赶在高版本插入前通过预检
  for (let round=1;round<=3;round++){
    const skill=`race-skill-${round}`;
    assert.equal((await publishPackage({name:skill,version:'1.0.0',body:gz('seed'),token:publisher})).res.status,200);
    const [high,low]=await Promise.all([postRaw(skill,gz('high'),'2.0.0'),postRaw(skill,gz('low'),'1.5.0')]);
    const statuses=[high.status,low.status].sort();
    assert.deepEqual(statuses,[200,409],`第 ${round} 轮并发两版本必须恰一进一拒：2.0.0→${high.status} / 1.5.0→${low.status}`);
    const rejected=high.status===409?high:low;
    assert.equal(rejected.data.error,'version_regression');
    const entry=(await getVersions()).data.skills[skill];
    assert.deepEqual(entry.history.map((item)=>item.version),['2.0.0','1.0.0'],`第 ${round} 轮：2.0.0 在库、1.5.0 必被拒`);
  }
});

test('版本数上限（security M-1）：200 版本后再发 409 version_limit；199 时第 200 版放行',{skip},async()=>{
  const publisher=await cliTokenOf('publisher@example.com');
  const sql=postgres(testUrl,{max:1});
  try{
    await sql`insert into releases (skill, version, sha256, size, notes, blob_path)
      select 'cap-skill', '0.0.'||g, ${'0'.repeat(64)}, 1, null, 'releases/cap-skill/seed-x.tar.gz' from generate_series(1,200) g`;
    await sql`insert into releases (skill, version, sha256, size, notes, blob_path)
      select 'cap2-skill', '0.0.'||g, ${'0'.repeat(64)}, 1, null, 'releases/cap2-skill/seed-x.tar.gz' from generate_series(1,199) g`;
  } finally { await sql.end({timeout:5}); }
  const blocked=await publishPackage({name:'cap-skill',version:'1.0.0',body:gz('over'),token:publisher});
  assert.equal(blocked.res.status,409,JSON.stringify(blocked.data));
  assert.equal(blocked.data.error,'version_limit');
  assert.match(blocked.data.message,/200/);
  const allowed=await publishPackage({name:'cap2-skill',version:'0.1.0',body:gz('edge'),token:publisher});
  assert.equal(allowed.res.status,200,JSON.stringify(allowed.data));
  assert.equal((await getVersions()).data.skills['cap2-skill'].history.length,200,'恰 200 版在库');
});

test('SITE_ORIGIN 规范源（security L-1）：配置后 publish.url 与 versions.download_url 一律用规范前缀',{skip},async()=>{
  const publisher=await cliTokenOf('publisher@example.com');
  const result=await publishPackage({name:'origin-skill',version:'1.0.0',body:gz('o'),token:publisher});
  assert.equal(result.res.status,200);
  assert.equal(result.data.url,'https://origin.example/api/store/download/origin-skill?version=1.0.0&format=tar.gz');
  assert.equal((await getVersions()).data.skills['origin-skill'].download_url,result.data.url);
});

// —— 真实 CLI 冒烟（任务 3/4 模式：隔离 APPDATA/XDG + HY_TOKEN 直连 dev server）——
const CLI_BIN=process.env.HY_CLI_BIN||'C:\\Huanyu-Hibiki\\coding\\Huanyu-CLI\\bin\\hy.js';
const cliSkip=()=> !testUrl?'TEST_DATABASE_URL 未设置，跳过真实 CLI 冒烟'
  :!existsSync(CLI_BIN)?`未找到 ${CLI_BIN}（可用 HY_CLI_BIN 指定），跳过真实 CLI 冒烟`:false;

function runCli(args,{token}={}){
  const appdata=mkdtempSync(path.join(tmpdir(),'huanyu-cli-appdata-'));
  const xdg=mkdtempSync(path.join(tmpdir(),'huanyu-cli-xdg-'));
  const env={...process.env,HY_API:server.base,APPDATA:appdata,XDG_CONFIG_HOME:xdg};
  delete env.CI;
  if (token===undefined) delete env.HY_TOKEN; else env.HY_TOKEN=token;
  const child=spawn(process.execPath,[CLI_BIN,...args],{cwd:tmpdir(),env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk)=>{stdout+=chunk;});
  child.stderr.setEncoding('utf8');child.stderr.on('data',(chunk)=>{stderr+=chunk;});
  return new Promise((resolve)=>{
    const timer=setTimeout(()=>{
      if (process.platform==='win32') spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});
      else child.kill('SIGKILL');
    },90_000);
    timer.unref?.();
    child.once('exit',(code)=>{
      clearTimeout(timer);
      rmSync(appdata,{recursive:true,force:true});
      rmSync(xdg,{recursive:true,force:true});
      resolve({code,stdout,stderr});
    });
  });
}

/** CLI fixture 的 writeSkill 同构：SKILL.md frontmatter 带 name 与 metadata.version。 */
function writeSkill(root,name,version){
  const directory=path.join(root,name);
  mkdirSync(path.join(directory,'assets'),{recursive:true});
  writeFileSync(path.join(directory,'SKILL.md'),
    `---\nname: ${name}\ndescription: 冒烟 Skill\nmetadata:\n  version: "${version}"\n---\n\n# 冒烟\n`);
  writeFileSync(path.join(directory,'assets','example.txt'),`${name} ${version}\n`);
  return directory;
}

test('真实 CLI 冒烟：hy publish 临时 skill 目录退出 0 → 孤儿 hy product 完整注册退出 0',{skip:cliSkip()},async()=>{
  const token=await cliTokenOf('publisher@example.com');
  const scratch=mkdtempSync(path.join(tmpdir(),'hy-publish-smoke-'));
  try{
    const skillDir=writeSkill(scratch,'smoke-pub-skill','1.0.0');
    // 真实 hy publish：CLI 自行 tar 打包 + gzip + 流式上传，服务端全管道校验
    const published=await runCli(['publish',skillDir,'--json'],{token});
    assert.equal(published.code,0,`${published.stdout}\n${published.stderr}`);
    const event=JSON.parse(published.stdout);
    assert.equal(event.event,'publish');
    assert.equal(event.skill,'smoke-pub-skill');
    assert.equal(event.version,'1.0.0');
    assert.ok(/^[0-9a-f]{64}$/.test(event.sha256));
    assert.ok(Number.isSafeInteger(event.size)&&event.size>0);
    assert.equal(event.existing,false);
    // 落盘对象哈希与 CLI 计算的 sha256 一致（CLI 上传字节 = 服务端收到字节）
    const files=blobFilesOf('smoke-pub-skill');
    assert.equal(files.length,1);
    assert.equal(sha256Of(readFileSync(files[0])),event.sha256);

    // 孤儿（未注册商品）发布后，真实 hy product 完整注册——versions 预检 known 通过
    const product=await runCli(['product','smoke-pub-skill','--set','summary=真实CLI发布后注册。','--json'],{token});
    assert.equal(product.code,0,`${product.stdout}\n${product.stderr}`);
    const productEvent=JSON.parse(product.stdout);
    assert.equal(productEvent.event,'product');
    assert.equal(productEvent.product.free.skill,'smoke-pub-skill');
    assert.equal(productEvent.product.summary,'真实CLI发布后注册。');
  } finally {
    rmSync(scratch,{recursive:true,force:true});
  }
});
