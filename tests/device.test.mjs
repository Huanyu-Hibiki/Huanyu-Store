import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import postgres from 'postgres';
import { migrate } from '../scripts/migrate.mjs';
import { loadLocalEnv,resetDatabase,startDevServer,stopServer } from './helpers.mjs';
import { sha256Hex } from '../lib/auth-core.mjs';
import { generateDeviceCode } from '../lib/device-core.mjs';

loadLocalEnv();
const testUrl=process.env.TEST_DATABASE_URL;
const skip=testUrl?false:'TEST_DATABASE_URL 未设置，跳过设备码授权集成测试';
// 白名单带大小写/空白噪声：验证归一（大小写、逗号两侧空白）后判定
process.env.PUBLISHER_EMAILS='Publisher@Example.com , second.publisher@example.com';

// 假发送器 outbox：dev server 按 FAKE_MAIL_OUTBOX 追加 JSON 行，web 登录读码断言（全程不发真信）
const outboxDir=mkdtempSync(path.join(tmpdir(),'huanyu-store-mail-'));
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

const USER_CODE_RE=/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

function readOutbox(){
 return readFileSync(outbox,'utf8').split(/\r?\n/).filter(Boolean).map((line)=>JSON.parse(line));
}

async function post(pathname,body,{cookie,origin,headers}={}){
 const res=await fetch(`${server.base}${pathname}`,{
  method:'POST',
  headers:{'content-type':'application/json',
   ...(origin===null?{}:{origin:origin??server.base}),
   ...(cookie?{cookie}:{}),...(headers||{})},
  body:JSON.stringify(body),
 });
 return {res,data:await res.json().catch(()=>null)};
}

async function get(pathname,{token}={}){
 const res=await fetch(`${server.base}${pathname}`,{headers:{...(token?{authorization:`Bearer ${token}`}:{})}});
 return {res,data:await res.json().catch(()=>null)};
}

function cookiePair(res){
 const header=res.headers.getSetCookie().find((c)=>c.startsWith('__Host-huanyu_session='));
 return header?.split(';')[0];
}

async function withSql(run){
 const sql=postgres(testUrl,{max:1});
 try{ return await run(sql); } finally{ await sql.end({timeout:5}); }
}

/** 走任务 2 的验证码流程完成 web 登录，返回会话 Cookie 头。 */
async function webLogin(email){
 await post('/api/auth/code',{email});
 const mail=readOutbox().filter((m)=>m.to===email).at(-1);
 const code=mail?.text.match(/\b(\d{6})\b/)?.[1];
 const verified=await post('/api/auth/verify',{email,code});
 assert.equal(verified.res.status,200,`web 登录失败: ${JSON.stringify(verified.data)}`);
 return cookiePair(verified.res);
}

async function issueDevice(){
 const {res,data}=await post('/api/cli/device',{client_name:'hy-test',platform:process.platform});
 assert.equal(res.status,200);
 return data;
}

async function approveGrant(userCode,approve,cookie){
 return post('/api/cli/approve',{user_code:userCode,approve},{cookie});
}

test('device 签发：六字段齐全、单位秒、device_code 哈希落库、user_code 明文可显示',{skip},async()=>{
 const {res,data}=await post('/api/cli/device',{client_name:'hy/0.2.0',platform:'win32',lang:'zh-CN',bogus:'未知字段忽略'});
 assert.equal(res.status,200);
 assert.deepEqual(Object.keys(data).sort(),
  ['device_code','expires_in','interval','user_code','verification_uri','verification_uri_complete']);
 assert.equal(data.expires_in,600,'expires_in 单位秒（CLI 自行 ×1000）');
 assert.equal(data.interval,5,'interval 单位秒');
 assert.match(data.device_code,/^[A-Za-z0-9_-]{43}$/);
 assert.match(data.user_code,USER_CODE_RE);
 assert.equal(data.verification_uri,`${server.base}/cli`);
 assert.equal(data.verification_uri_complete,`${server.base}/cli?code=${data.user_code}`);

 // 库里只有 sha256；user_code 明文供确认页显示；TTL 10 分钟
 const rows=await withSql((sql)=>sql`select * from device_grants`);
 assert.equal(rows.length,1);
 assert.equal(rows[0].device_code_hash,sha256Hex(data.device_code));
 assert.equal(rows[0].user_code,data.user_code);
 assert.equal(rows[0].status,'pending');
 assert.equal(rows[0].interval_seconds,5);
 assert.ok(rows[0].expires_at.getTime()>Date.now()+590_000,'TTL 应接近 10 分钟');

 // 参数缺失 → 400 统一形状
 const bad=await post('/api/cli/device',{platform:'win32'});
 assert.equal(bad.res.status,400);
 assert.deepEqual(Object.keys(bad.data).sort(),['error','message']);

 // 确认页可渲染（verification_uri_complete 的目标）
 const page=await fetch(`${server.base}/cli?code=${data.user_code}`);
 assert.equal(page.status,200);
 assert.match(page.headers.get('content-type')||'',/text\/html/);
});

test('H-1/M-1 设备签发限频：每 IP 10 次/小时、全局日预算 2000，超限 429 统一形状',{skip},async()=>{
 const issue=(headers)=>post('/api/cli/device',{client_name:'hy-test',platform:'test'},{headers});
 // 同 IP 已 9 次 → 放行（第 10 次落库后达限）
 await withSql((sql)=>sql`insert into device_grants (device_code_hash,user_code,ip,expires_at)
  select 'seed-ip-'||g,'SEEDIP'||g,'203.0.113.7',now()+interval '10 minutes' from generate_series(1,9) g`);
 const ok=await issue({'x-forwarded-for':'203.0.113.7:51234'});
 assert.equal(ok.res.status,200);
 // 已 10 次 → 429，且不落新行
 const blocked=await issue({'x-forwarded-for':'203.0.113.7'});
 assert.equal(blocked.res.status,429);
 assert.deepEqual(Object.keys(blocked.data).sort(),['error','message']);
 assert.equal(blocked.data.error,'rate_limited');
 const count=await withSql((sql)=>sql`select count(*)::int as n from device_grants where ip='203.0.113.7'`);
 assert.equal(count[0].n,10,'超限请求不得落库');
 // 新 IP 但全局日预算已满 → 429（per-key 维度为 0，只有全局兜底能拦）
 await withSql((sql)=>sql`insert into device_grants (device_code_hash,user_code,ip,expires_at)
  select 'seed-daily-'||g,'SEEDDY'||g,'198.51.100.'||g,now()+interval '10 minutes' from generate_series(1,2000) g`);
 const global=await issue({'x-forwarded-for':'203.0.113.99'});
 assert.equal(global.res.status,429);
 assert.equal(global.data.error,'rate_limited');
});

test('M-1 终态清扫：签发顺带清理过期超 1 小时的 grant（防从不轮询的行无界膨胀）',{skip},async()=>{
 await withSql((sql)=>sql`insert into device_grants (device_code_hash,user_code,expires_at)
  values ('stale-hash','STALE-CODE',now()-interval '2 hours')`);
 const {res}=await post('/api/cli/device',{client_name:'hy-test',platform:'test'});
 assert.equal(res.status,200,'清扫不得阻塞正常签发');
 const rows=await withSql((sql)=>sql`select device_code_hash from device_grants`);
 assert.ok(!rows.some((row)=>row.device_code_hash==='stale-hash'),'超 1 小时的过期行应被清扫');
 // 刚过期未满 1 小时的行不动（仍在 24h 计数窗口内，由轮询路径自清理）
 await withSql((sql)=>sql`insert into device_grants (device_code_hash,user_code,expires_at)
  values ('fresh-stale-hash','FRESH-STALE',now()-interval '30 minutes')`);
 await post('/api/cli/device',{client_name:'hy-test',platform:'test'});
 const keep=await withSql((sql)=>sql`select 1 from device_grants where device_code_hash='fresh-stale-hash'`);
 assert.equal(keep.length,1,'未满 1 小时的过期行不清扫');
});

test('M-2 申请方自述：client_name/platform 落库、超长 400、GET approve 回显 pending grant 信息',{skip},async()=>{
 const issued=await post('/api/cli/device',{client_name:'kabuto@dev',platform:'win32'});
 assert.equal(issued.res.status,200);
 const [row]=await withSql((sql)=>sql`select client_name,platform from device_grants where user_code=${issued.data.user_code}`);
 assert.equal(row.client_name,'kabuto@dev');
 assert.equal(row.platform,'win32');
 // 长度上限 128：超长快速失败，不落库
 const long='x'.repeat(129);
 const bad=await post('/api/cli/device',{client_name:long,platform:'win32'});
 assert.equal(bad.res.status,400);
 assert.equal(bad.data.error,'invalid_request');
 const badPlatform=await post('/api/cli/device',{client_name:'ok',platform:long});
 assert.equal(badPlatform.res.status,400);
 // 确认页数据源：pending 且未过期 → {client_name, platform}；未知/过期 → 404 模糊形状
 const info=await fetch(`${server.base}/api/cli/approve?code=${issued.data.user_code}`);
 assert.equal(info.status,200);
 assert.deepEqual(await info.json(),{client_name:'kabuto@dev',platform:'win32'});
 assert.equal(info.headers.get('cache-control'),'no-store');
 const ghost=await fetch(`${server.base}/api/cli/approve?code=ABCD-2345`);
 assert.equal(ghost.status,404);
 assert.deepEqual(Object.keys(await ghost.json()).sort(),['error','message']);
 await withSql((sql)=>sql`update device_grants set expires_at = now() - interval '1 second' where user_code=${issued.data.user_code}`);
 assert.equal((await fetch(`${server.base}/api/cli/approve?code=${issued.data.user_code}`)).status,404);
});

test('LOW 路由加固：device_code 超长 128 快速失败；多值 x-forwarded-host 取第一个',{skip},async()=>{
 const long=await post('/api/cli/token',{device_code:'x'.repeat(129)});
 assert.equal(long.res.status,400);
 assert.equal(long.data.error,'invalid_request');
 // 反代链场景：x-forwarded-host 可能是逗号列表，取第一个（与 sameOrigin 的 Host 基准一致性）
 const {res,data}=await post('/api/cli/device',{client_name:'hy-test',platform:'test'},{headers:{'x-forwarded-host':`public.example, ${new URL(server.base).host}`}});
 assert.equal(res.status,200);
 assert.equal(data.verification_uri,'http://public.example/cli');
 assert.equal(data.verification_uri_complete,`http://public.example/cli?code=${data.user_code}`);
});

test('token 错误族：pending/slow_down/denied/expired_token 四码齐、终态行惰性清理',{skip},async()=>{
 // 未知 device_code → expired_token
 const unknown=await post('/api/cli/token',{device_code:generateDeviceCode()});
 assert.equal(unknown.res.status,400);
 assert.equal(unknown.data.error,'expired_token');

 const device=await issueDevice();
 const first=await post('/api/cli/token',{device_code:device.device_code});
 assert.equal(first.res.status,400);
 assert.deepEqual(Object.keys(first.data).sort(),['error','message']);
 assert.equal(first.data.error,'authorization_pending');
 // 快于 interval 一半的第二次轮询 → slow_down（CLI 收到后 interval += 5s）
 const second=await post('/api/cli/token',{device_code:device.device_code});
 assert.equal(second.res.status,400);
 assert.equal(second.data.error,'slow_down');
 // 隔够 interval/2 恢复 pending：回拨 last_poll_at，避免真实等待
 await withSql((sql)=>sql`update device_grants set last_poll_at = now() - interval '4 seconds'`);
 assert.equal((await post('/api/cli/token',{device_code:device.device_code})).data.error,'authorization_pending');

 // denied：首答 access_denied，行清理后复问 expired_token
 const denied=await issueDevice();
 const cookie=await webLogin('denier@example.com');
 const decision=await approveGrant(denied.user_code,false,cookie);
 assert.equal(decision.res.status,200);
 assert.equal(decision.data.status,'denied');
 const refused=await post('/api/cli/token',{device_code:denied.device_code});
 assert.equal(refused.res.status,400);
 assert.equal(refused.data.error,'access_denied');
 const deniedRows=await withSql((sql)=>sql`select count(*)::int as n from device_grants where user_code=${denied.user_code}`);
 assert.equal(deniedRows[0].n,0,'拒绝行应清理');
 assert.equal((await post('/api/cli/token',{device_code:denied.device_code})).data.error,'expired_token');

 // expired：过期行清理
 const stale=await issueDevice();
 await withSql((sql)=>sql`update device_grants set expires_at = now() - interval '1 second' where user_code=${stale.user_code}`);
 const expired=await post('/api/cli/token',{device_code:stale.device_code});
 assert.equal(expired.res.status,400);
 assert.equal(expired.data.error,'expired_token');
 const staleRows=await withSql((sql)=>sql`select count(*)::int as n from device_grants where user_code=${stale.user_code}`);
 assert.equal(staleRows[0].n,0,'过期行应清理');
});

test('批准 → 恰一枚 hy_ 令牌：{token,email}、sha256 落库、grant 消费、me() 形状过 CLI 校验',{skip},async()=>{
 const email='author@example.com';
 const device=await issueDevice();
 const cookie=await webLogin(email);
 const decision=await approveGrant(device.user_code,true,cookie);
 assert.equal(decision.res.status,200);
 assert.equal(decision.data.status,'approved');
 // grant 状态翻转并绑定批准用户
 const [grant]=await withSql((sql)=>sql`
  select g.status,u.email as approver from device_grants g left join users u on u.id=g.user_id
  where g.user_code=${device.user_code}`);
 assert.equal(grant.status,'approved');
 assert.equal(grant.approver,email);

 const polled=await post('/api/cli/token',{device_code:device.device_code});
 assert.equal(polled.res.status,200);
 assert.deepEqual(Object.keys(polled.data).sort(),['email','token']);
 assert.match(polled.data.token,/^hy_[A-Za-z0-9_-]{43}$/);
 assert.equal(polled.data.email,email);
 // 令牌 sha256 落库，库里无明文
 const tokens=await withSql((sql)=>sql`select t.token_hash,u.email from cli_tokens t join users u on u.id=t.user_id`);
 assert.equal(tokens.length,1);
 assert.equal(tokens[0].token_hash,sha256Hex(polled.data.token));
 assert.notEqual(tokens[0].token_hash,polled.data.token);
 assert.equal(tokens[0].email,email);
 // grant 已消费：再问 expired_token（一次批准只发一枚）
 assert.equal((await post('/api/cli/token',{device_code:device.device_code})).data.error,'expired_token');
 // me() 形状逐字过 CLI client.js 校验：subscriptions 空数组、publisher 布尔
 const me=await get('/api/auth/me',{token:polled.data.token});
 assert.equal(me.res.status,200);
 assert.deepEqual(me.data,{email,subscriptions:[],publisher:false});
 assert.equal(me.res.headers.get('cache-control'),'no-store');
});

test('approve 双门槛与模糊 404：无会话 401、跨 Origin 403、未知/过期 user_code 同一 404 形状',{skip},async()=>{
 const cookie=await webLogin('guard@example.com');
 const anonymous=await post('/api/cli/approve',{user_code:'ABCD-2345',approve:true},{cookie:null});
 assert.equal(anonymous.res.status,401);
 assert.equal(anonymous.data.error,'unauthorized');
 const foreign=await post('/api/cli/approve',{user_code:'ABCD-2345',approve:true},{cookie,origin:'https://evil.example'});
 assert.equal(foreign.res.status,403);
 assert.equal(foreign.data.error,'origin_forbidden');
 const noOrigin=await fetch(`${server.base}/api/cli/approve`,{
  method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({user_code:'ABCD-2345',approve:true}),
 });
 assert.equal(noOrigin.status,403);
 // 未知 user_code → 404 模糊形状
 const ghost=await approveGrant('ABCD-2345',true,cookie);
 assert.equal(ghost.res.status,404);
 assert.deepEqual(Object.keys(ghost.data).sort(),['error','message']);
 assert.equal(ghost.data.error,'not_found');
 // 过期 grant 的 user_code → 同一形状同一文案（不区分不存在/过期）
 const device=await issueDevice();
 await withSql((sql)=>sql`update device_grants set expires_at = now() - interval '1 second' where user_code=${device.user_code}`);
 const staleShape=await approveGrant(device.user_code,true,cookie);
 assert.equal(staleShape.res.status,404);
 assert.deepEqual(staleShape.data,ghost.data);
 // 形状非法 / approve 非布尔 → 400
 assert.equal((await approveGrant('ABC',true,cookie)).res.status,400);
 assert.equal((await post('/api/cli/approve',{user_code:'ABCD-2345',approve:'yes'},{cookie})).res.status,400);
});

test('publisher 白名单：PUBLISHER_EMAILS 忽略大小写空白；名单外 false',{skip},async()=>{
 async function publisherOf(email){
  const device=await issueDevice();
  const cookie=await webLogin(email);
  await approveGrant(device.user_code,true,cookie);
  const {data}=await post('/api/cli/token',{device_code:device.device_code});
  const me=await get('/api/auth/me',{token:data.token});
  assert.equal(me.res.status,200);
  return me.data.publisher;
 }
 assert.equal(await publisherOf('publisher@example.com'),true);
 assert.equal(await publisherOf('second.publisher@example.com'),true);
 assert.equal(await publisherOf('reader@example.com'),false);
});

test('logout：撤销后 me() 401、幂等重放 200、未知/缺失令牌 401',{skip},async()=>{
 const device=await issueDevice();
 const cookie=await webLogin('leaver@example.com');
 await approveGrant(device.user_code,true,cookie);
 const {data}=await post('/api/cli/token',{device_code:device.device_code});
 const token=data.token;

 assert.equal((await post('/api/cli/logout',{})).res.status,401);
 const garbage=await post('/api/cli/logout',{},{headers:{authorization:'Bearer nonsense'}});
 assert.equal(garbage.res.status,401);
 assert.equal(garbage.data.error,'unauthorized');
 const out=await post('/api/cli/logout',{},{headers:{authorization:`Bearer ${token}`}});
 assert.equal(out.res.status,200);
 assert.deepEqual(out.data,{revoked:true});
 const after=await get('/api/auth/me',{token});
 assert.equal(after.res.status,401);
 assert.deepEqual(Object.keys(after.data).sort(),['error','message']);
 assert.equal(after.data.error,'unauthorized');
 // 幂等：已撤销令牌重放 logout 仍 200
 const again=await post('/api/cli/logout',{},{headers:{authorization:`Bearer ${token}`}});
 assert.equal(again.res.status,200);
 assert.deepEqual(again.data,{revoked:true});
 assert.equal((await get('/api/auth/me')).res.status,401,'无令牌 me() 401');
});

test('批准后并发轮询恰一枚令牌：6 路并发 1×200，其余 400 expired_token',{skip},async()=>{
 const email='racer@example.com';
 const device=await issueDevice();
 const cookie=await webLogin(email);
 await approveGrant(device.user_code,true,cookie);
 const results=await Promise.all(Array.from({length:6},()=>post('/api/cli/token',{device_code:device.device_code})));
 const winners=results.filter((r)=>r.res.status===200);
 assert.equal(winners.length,1,'恰一路成功');
 for(const r of results.filter((item)=>item.res.status!==200)){
  assert.equal(r.res.status,400);
  assert.equal(r.data.error,'expired_token');
 }
 assert.equal(winners[0].data.email,email);
 const tokens=await withSql((sql)=>sql`select count(*)::int as n from cli_tokens`);
 assert.equal(tokens[0].n,1,'只落一枚令牌');
});

// 真实 CLI 冒烟：HY_CLI_BIN 可覆盖路径；仓库不存在（如 CI）时跳过
const CLI_BIN=process.env.HY_CLI_BIN||'C:\\Huanyu-Hibiki\\coding\\Huanyu-CLI\\bin\\hy.js';
const cliSkip=()=> !testUrl?'TEST_DATABASE_URL 未设置，跳过真实 CLI 冒烟'
 :!existsSync(CLI_BIN)?`未找到 ${CLI_BIN}（可用 HY_CLI_BIN 指定），跳过真实 CLI 冒烟`:false;

test('真实 CLI 冒烟：hy login 对 localhost 完成 device→web 登录→approve→token，退出码 0 且带 email',{skip:cliSkip()},async()=>{
 // 配置路径隔离：win32 读 env.APPDATA，POSIX 读 env.XDG_CONFIG_HOME，两路都注入临时目录，不污染本机真实配置；
 // ComSpec 指向不存在路径让「开浏览器」快速失败（等价无浏览器环境，不在开发机弹浏览器页），CLI 照常轮询。
 // Windows 环境键名大小写不敏感：须先删净两种写法再赋唯一键，否则真实 COMSPEC 抢先生效。
 const appdata=mkdtempSync(path.join(tmpdir(),'huanyu-cli-appdata-'));
 const xdg=mkdtempSync(path.join(tmpdir(),'huanyu-cli-xdg-'));
 const configFile=process.platform==='win32'
  ?path.join(appdata,'huanyu','config.json')
  :path.join(xdg,'huanyu','config.json');
 const env={...process.env,HY_API:server.base,APPDATA:appdata,XDG_CONFIG_HOME:xdg};
 delete env.HY_TOKEN; // 环境令牌会短路设备码流程
 delete env.CI;       // CI 模式禁用交互登录
 delete env.COMSPEC; delete env.ComSpec;
 env.ComSpec=path.join(appdata,'missing-cmd.exe');
 const child=spawn(process.execPath,[CLI_BIN,'login','--json'],{
  cwd:tmpdir(),env,stdio:['ignore','pipe','pipe'],windowsHide:true,
 });
 const stdout=[],stderr=[];
 let pending='',resolved=false;
 const deviceSeen=new Promise((resolve)=>{
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',(chunk)=>{
   stdout.push(chunk); pending+=chunk;
   let index;
   while((index=pending.indexOf('\n'))>=0){
    const line=pending.slice(0,index); pending=pending.slice(index+1);
    if (!line.trim()) continue;
    try{
     const parsed=JSON.parse(line);
     if (parsed.event==='device'&&!resolved){ resolved=true; resolve(parsed); }
    }catch{ /* 非事件行忽略 */ }
   }
  });
 });
 child.stderr.setEncoding('utf8');
 child.stderr.on('data',(chunk)=>stderr.push(chunk));
 const exited=new Promise((resolve)=>child.once('exit',(code)=>resolve(code)));
 // 竞速败方定时器：unref 不挂事件循环，finally 再 clearTimeout 兜底
 const timers=[];
 const timeout=(label)=>new Promise((_,reject)=>{
  const timer=setTimeout(()=>reject(new Error(`${label} 超时`)),60_000);
  timers.push(timer); timer.unref?.();
 });
 try{
  const device=await Promise.race([deviceSeen,timeout('device 签发')]);
  assert.match(device.user_code,USER_CODE_RE);
  assert.equal(device.verification_uri_complete,`${server.base}/cli?code=${device.user_code}`);
  // 赶在 CLI 首轮轮询（device 后 interval=5s）前完成 web 登录与批准
  const email='publisher@example.com';
  const cookie=await webLogin(email);
  const decision=await approveGrant(device.user_code,true,cookie);
  assert.equal(decision.res.status,200);
  const code=await Promise.race([exited,timeout('CLI 退出')]);
  const events=stdout.join('').split(/\r?\n/).filter(Boolean)
   .map((line)=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);
  const login=events.find((item)=>item.event==='login');
  assert.equal(code,0,`CLI 退出码异常:\n${stdout.join('')}\n${stderr.join('')}`);
  assert.ok(login,'应输出 login 完成事件');
  assert.equal(login.status,'complete');
  assert.equal(login.email,email);
  assert.match(login.token_prefix,/^hy_/);
  // CLI 落盘凭证（按平台走隔离的 APPDATA/XDG 路径）：token 直接过 me()，白名单对真实令牌生效
  const config=JSON.parse(readFileSync(configFile,'utf8'));
  assert.equal(config.email,email);
  assert.equal(config.api,server.base);
  assert.match(config.token,/^hy_[A-Za-z0-9_-]{43}$/);
  const me=await get('/api/auth/me',{token:config.token});
  assert.equal(me.res.status,200);
  assert.deepEqual(me.data,{email,subscriptions:[],publisher:true});
 }finally{
  for(const timer of timers) clearTimeout(timer);
  await stopServer(child); // 已退出时是 no-op，异常时兜底杀进程树
  rmSync(appdata,{recursive:true,force:true});
  rmSync(xdg,{recursive:true,force:true});
 }
});
