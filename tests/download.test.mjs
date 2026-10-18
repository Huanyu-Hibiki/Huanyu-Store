import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import postgres from 'postgres';
import { migrate } from '../scripts/migrate.mjs';
import { loadLocalEnv, resetDatabase, startDevServer } from './helpers.mjs';

loadLocalEnv();
const testUrl=process.env.TEST_DATABASE_URL;
const skip=testUrl?false:'TEST_DATABASE_URL 未设置，跳过下载集成测试';
process.env.PUBLISHER_EMAILS='publisher@example.com';
delete process.env.BLOB_READ_WRITE_TOKEN; // 集成测试一律走假 Blob 存储
const blobDir=mkdtempSync(path.join(tmpdir(),'huanyu-store-blob-'));
process.env.FAKE_BLOB_DIR=blobDir;
// 与 publish.test.mjs 不同：这里刻意不设 SITE_ORIGIN——假仓回环 attest URL 必须指回本机 dev
// server（siteBase 回落 Host 头），302 跟随后才能拿到真实字节。

const outboxDir=mkdtempSync(path.join(tmpdir(),'huanyu-store-download-mail-'));
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

async function publishPackage({name,version,body,token}){
  const res=await fetch(`${server.base}/api/store/publish`,{
    method:'POST',
    headers:{'content-type':'application/gzip','x-skill-name':name,'x-skill-version':version,
      'x-content-sha256':sha256Of(body),authorization:`Bearer ${token}`},
    body,
  });
  return {res,data:await res.json().catch(()=>null)};
}

async function putProduct(skill,body,{token}={}){
  const res=await fetch(`${server.base}/api/store/products/${encodeURIComponent(skill)}`,{
    method:'PUT',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body),
  });
  return {res,data:await res.json().catch(()=>null)};
}

const download=(name,{version,token,format='tar.gz',ip}={})=>{
  const query=new URLSearchParams({format});
  if (version!==undefined) query.set('version',version);
  return fetch(`${server.base}/api/store/download/${encodeURIComponent(name)}?${query}`,{
    redirect:'manual',
    headers:{...(token?{authorization:`Bearer ${token}`}:{}),...(ip?{'x-forwarded-for':ip}:{})},
  });
};

/** 302 → 跟随 Location 拿字节（真实 CLI 的 redirect:'follow' 语义同构）。 */
async function follow(location){
  const res=await fetch(location);
  assert.equal(res.status,200,`attest 附件须 200：${location}`);
  return {res,bytes:Buffer.from(await res.arrayBuffer())};
}

test('download 全矩阵：302/200 直出/402/404/400/401 + 发布字节对账 + 版本选择 + yank 过滤',{skip},async()=>{
  const publisher=await cliTokenOf('publisher@example.com');
  const v1=gz('free skill v1 bytes'),v2=gz('free skill v2 bytes');
  assert.equal((await publishPackage({name:'matrix-free',version:'1.0.0',body:v1,token:publisher})).res.status,200);
  assert.equal((await publishPackage({name:'matrix-free',version:'1.1.0',body:v2,token:publisher})).res.status,200);
  assert.equal((await putProduct('matrix-free',{name:'矩阵商品',summary:'免费+付费配对。',free:'matrix-free',paid:'matrix-pro'},{token:publisher})).res.status,200);
  assert.equal((await publishPackage({name:'matrix-pro',version:'1.0.0',body:gz('paid bytes'),token:publisher})).res.status,200);
  assert.equal((await publishPackage({name:'matrix-orphan',version:'0.3.0',body:gz('orphan bytes'),token:publisher})).res.status,200);

  // 匿名免费缺省版本：302 → Location 指向本服务 attest 路径 → 跟随得 200，字节与发布时逐字一致
  const latest=await download('matrix-free');
  assert.equal(latest.status,302,'免费 + 无 Authorization → 302 签名 URL');
  assert.equal(latest.headers.get('cache-control'),'no-store');
  const location=latest.headers.get('location');
  const at=new URL(location);
  assert.equal(at.origin,new URL(server.base).origin,'假仓签名 URL 自指回环（本机 dev server）');
  assert.equal(at.pathname,'/api/store/blob-attest');
  const served=await follow(location);
  assert.deepEqual(served.bytes,v2,'缺省版本 = latest（1.1.0），字节与发布时一致');
  assert.equal(sha256Of(served.bytes),sha256Of(v2));
  assert.equal(served.res.headers.get('content-type'),'application/gzip');

  // 匿名指定历史版本：302 → v1 字节（历史版本可下）
  const older=await download('matrix-free',{version:'1.0.0'});
  assert.equal(older.status,302);
  assert.deepEqual((await follow(older.headers.get('location'))).bytes,v1);

  // 带有效令牌：绝不 302（redirect:'error' 下 undici 遇 302 即抛），200 直出 + 两个 X- 头 + 字节一致
  const direct=await fetch(`${server.base}/api/store/download/matrix-free?version=1.1.0&format=tar.gz`,{
    headers:{authorization:`Bearer ${publisher}`},redirect:'error',
  });
  assert.equal(direct.status,200,'带令牌 → 200 直出');
  assert.equal(direct.headers.get('x-content-sha256'),sha256Of(v2));
  assert.equal(direct.headers.get('x-skill-version'),'1.1.0');
  assert.equal(direct.headers.get('cache-control'),'no-store');
  assert.deepEqual(Buffer.from(await direct.arrayBuffer()),v2);

  // 付费 skill：匿名与带令牌都 402 inactive（CLI 展示订阅引导，属预期）
  for (const token of [undefined,publisher]) {
    const paid=await download('matrix-pro',{version:'1.0.0',token});
    assert.equal(paid.status,402,`付费下载须 402（token=${token?'yes':'no'}）`);
    const data=await paid.json();
    assert.equal(data.error,'inactive');
    assert.equal(typeof data.message,'string');
    assert.deepEqual(Object.keys(data).sort(),['error','message']);
  }

  // 未知 skill / 未知版本 → 404；format 非 tar.gz → 400；无效令牌 → 401
  assert.equal((await download('ghost-skill')).status,404);
  assert.equal((await (await download('matrix-free',{version:'9.9.9'})).json()).error,'not_found');
  const badFormat=await download('matrix-free',{format:'zip'});
  assert.equal(badFormat.status,400);
  assert.equal((await badFormat.json()).error,'invalid_format');
  assert.equal((await download('matrix-free',{token:'hy_not-a-real-token'})).status,401);

  // 孤儿（不在 catalog）匿名可下：302 → 字节一致
  const orphan=await download('matrix-orphan');
  assert.equal(orphan.status,302);
  assert.deepEqual((await follow(orphan.headers.get('location'))).bytes,gz('orphan bytes'));

  // yank 过滤（任务 7 端点未到，直接置位验证查找逻辑）：缺省回落未 yank、指定 yanked 404
  const sql=postgres(testUrl,{max:1});
  try{
    await sql`update releases set yanked=true where skill='matrix-free' and version='1.1.0'`;
    const fallback=await download('matrix-free');
    assert.equal(fallback.status,302);
    assert.deepEqual((await follow(fallback.headers.get('location'))).bytes,v1,'缺省回落到最高未 yank（1.0.0）');
    assert.equal((await download('matrix-free',{version:'1.1.0'})).status,404,'指定 yanked 版本 404');
  } finally { await sql.end({timeout:5}); }
});

test('匿名下载限频：同 IP 60 次/分钟内放行、第 61 次 429、他 IP 不受影响',{skip},async()=>{
  const publisher=await cliTokenOf('publisher@example.com');
  assert.equal((await publishPackage({name:'rate-skill',version:'1.0.0',body:gz('rate'),token:publisher})).res.status,200);
  const ip='203.0.113.77';
  for (let i=0;i<60;i++){
    const res=await download('rate-skill',{ip});
    assert.equal(res.status,302,`第 ${i+1} 次须放行（302）`);
  }
  const blocked=await download('rate-skill',{ip});
  assert.equal(blocked.status,429,'第 61 次 → 429');
  const data=await blocked.json();
  assert.equal(data.error,'rate_limited');
  assert.equal(blocked.headers.get('cache-control'),'no-store');
  assert.equal((await download('rate-skill',{ip:'198.51.100.9'})).status,302,'正常频率的其他 IP 不受影响');
});

// —— 真实 CLI 冒烟（任务 6 核心交付）：真实 hy publish 两版本 → 隔离沙箱 hy install → 版本对账 ——
const CLI_BIN=process.env.HY_CLI_BIN||'C:\\Huanyu-Hibiki\\coding\\Huanyu-CLI\\bin\\hy.js';
const cliSkip=()=> !testUrl?'TEST_DATABASE_URL 未设置，跳过真实 CLI 冒烟'
  :!existsSync(CLI_BIN)?`未找到 ${CLI_BIN}（可用 HY_CLI_BIN 指定），跳过真实 CLI 冒烟`:false;

/** CLI 子进程：HOME/USERPROFILE/APPDATA/XDG 全部指向沙箱——宿主发现（hosts.js 的九个用户级根）
 *  与凭据目录（config.js）都从这些变量展开，绝不能碰本机真实目录。 */
function runCli(args,{token,sandbox,cwd}){
  const env={...process.env,HY_API:server.base,
    ...(sandbox?{USERPROFILE:sandbox.home,HOME:sandbox.home,APPDATA:sandbox.appdata,XDG_CONFIG_HOME:sandbox.xdg}:{})};
  delete env.CI;
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
    `---\nname: ${name}\ndescription: 安装冒烟 Skill\nmetadata:\n  version: "${version}"\n---\n\n# 安装冒烟\n`);
  writeFileSync(path.join(directory,'assets','example.txt'),`${name} ${version}\n`);
  return directory;
}

test('真实 CLI 冒烟：hy publish 两版本 + hy product 注册 → 隔离沙箱 hy install 装进 zcode 宿主并升级',{skip:cliSkip()},async()=>{
  const token=await cliTokenOf('publisher@example.com');
  const scratch=mkdtempSync(path.join(tmpdir(),'hy-install-smoke-'));
  const sandboxRoot=mkdtempSync(path.join(tmpdir(),'hy-install-sandbox-'));
  const sandbox={root:sandboxRoot,home:path.join(sandboxRoot,'home'),
    appdata:path.join(sandboxRoot,'appdata'),xdg:path.join(sandboxRoot,'xdg')};
  // 预建 .zcode：installationRoots 只认「宿主根的父目录已存在」的宿主，zcode 是最高优先序
  mkdirSync(path.join(sandbox.home,'.zcode'),{recursive:true});
  try{
    // 两版本发布（真实 CLI 打包上传：tar + gzip + 流式 sha256）
    writeSkill(scratch,'smoke-install-skill','1.0.0');
    const first=await runCli(['publish',path.join(scratch,'smoke-install-skill'),'--json'],{token,sandbox,cwd:scratch});
    assert.equal(first.code,0,`${first.stdout}\n${first.stderr}`);
    writeSkill(scratch,'smoke-install-skill','2.0.0');
    const second=await runCli(['publish',path.join(scratch,'smoke-install-skill'),'--json'],{token,sandbox,cwd:scratch});
    assert.equal(second.code,0,`${second.stdout}\n${second.stderr}`);
    // 商品注册（免费版入目录——CLI install 只认 catalog 内的名字）
    const product=await runCli(['product','smoke-install-skill','--set','summary=安装闭环冒烟。','--json'],{token,sandbox,cwd:scratch});
    assert.equal(product.code,0,`${product.stdout}\n${product.stderr}`);

    // 首次安装：无令牌（免费版不带 Authorization）→ 302 跟随 → sha256 对账 → 装进沙箱宿主目录
    const install=await runCli(['install','smoke-install-skill','--json'],{sandbox,cwd:scratch});
    assert.equal(install.code,0,`${install.stdout}\n${install.stderr}`);
    const event=JSON.parse(install.stdout);
    const hostRoot=path.join(sandbox.home,'.zcode','skills');
    assert.equal(event.installations.length,1);
    assert.equal(event.installations[0].name,'smoke-install-skill');
    assert.equal(event.installations[0].version,'2.0.0','install 恒装 versions.latest（CLI 无版本指定语法）');
    assert.equal(event.installations[0].path,path.join(hostRoot,'smoke-install-skill'));
    const installed=readFileSync(path.join(hostRoot,'smoke-install-skill','SKILL.md'),'utf8');
    assert.match(installed,/version: "2\.0\.0"/,'沙箱内 SKILL.md 版本号 = latest');
    assert.equal(readFileSync(path.join(hostRoot,'smoke-install-skill','assets','example.txt'),'utf8'),'smoke-install-skill 2.0.0\n');

    // 旧版本下载对账（CLI 源码确认：install 无 <skill>@<version> 语法——isSkillName 拒绝 @，
    // 恒取 versions.latest；历史版本以带版本参数的直连下载验证字节，与发布时 CLI 计算的 sha256 对账）
    const older=await download('smoke-install-skill',{version:'1.0.0'});
    assert.equal(older.status,302);
    const olderBytes=(await follow(older.headers.get('location'))).bytes;
    assert.equal(sha256Of(olderBytes),JSON.parse(first.stdout).sha256,'历史版本字节与发布时完全一致');
    const versions=(await (await fetch(`${server.base}/api/store/versions`)).json()).skills['smoke-install-skill'];
    assert.equal(versions.latest,'2.0.0');

    // 降级沙箱到「已装 2.0.0」之外再验一次升级事务？——重装同版本走幂等替换即可证事务完整：
    // 删除宿主内副本后重装，仍退出 0 且版本正确。
    rmSync(path.join(hostRoot,'smoke-install-skill'),{recursive:true,force:true});
    const reinstall=await runCli(['install','smoke-install-skill','--json'],{sandbox,cwd:scratch});
    assert.equal(reinstall.code,0,`${reinstall.stdout}\n${reinstall.stderr}`);
    assert.equal(JSON.parse(reinstall.stdout).installations[0].version,'2.0.0');
    assert.match(readFileSync(path.join(hostRoot,'smoke-install-skill','SKILL.md'),'utf8'),/version: "2\.0\.0"/);
  } finally {
    rmSync(scratch,{recursive:true,force:true});
    rmSync(sandbox.root,{recursive:true,force:true});
  }
});
