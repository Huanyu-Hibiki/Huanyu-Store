import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { migrate } from '../scripts/migrate.mjs';
import { loadLocalEnv,resetDatabase,startDevServer } from './helpers.mjs';
import { sha256Hex,hashCode } from '../lib/auth-core.mjs';

loadLocalEnv();
const testUrl=process.env.TEST_DATABASE_URL;
const skip=testUrl?false:'TEST_DATABASE_URL 未设置，跳过验证码登录集成测试';

// 假发送器 outbox：dev server 进程按 FAKE_MAIL_OUTBOX 追加 JSON 行，测试读取断言（全程不发真信）
const outboxDir=mkdtempSync(path.join(tmpdir(),'huanyu-store-mail-'));
const outbox=path.join(outboxDir,'outbox.jsonl');
let server;

if (testUrl){
 test.before(async()=>{
  delete process.env.RESEND_API_KEY; // 无论本机是否配过密钥，测试一律走假发送器
  process.env.FAKE_MAIL_OUTBOX=outbox;
  await migrate(testUrl);
  server=await startDevServer(testUrl);
 });
 test.after(async()=>{ if (server) await server.stop(); rmSync(outboxDir,{recursive:true,force:true}); });
 test.beforeEach(async()=>{ await resetDatabase(testUrl); writeFileSync(outbox,''); });
}

function readOutbox(){
 return readFileSync(outbox,'utf8').split(/\r?\n/).filter(Boolean).map((line)=>JSON.parse(line));
}

/** 从 outbox 取该邮箱最近一封邮件里的 6 位验证码。 */
function latestCode(email){
 const mail=readOutbox().filter((m)=>m.to===email).at(-1);
 return mail?.text.match(/\b(\d{6})\b/)?.[1];
}

/** 与真实验证码错开的错误码。 */
function wrongCodeOf(code){ return code==='000000'?'000001':'000000'; }

async function postJson(pathname,body,cookie,extraHeaders){
 const res=await fetch(`${server.base}${pathname}`,{
  method:'POST',
  headers:{'content-type':'application/json',origin:server.base,...(cookie?{cookie}:{}),...(extraHeaders||{})},
  body:JSON.stringify(body),
 });
 const data=await res.json().catch(()=>null);
 return {res,data};
}

/** 从响应解析出可回放的 Cookie 头（undici 无 cookie jar，secure cookie 手动兜底）。 */
function cookiePair(res){
 const header=res.headers.getSetCookie().find((c)=>c.startsWith('__Host-huanyu_session='));
 return header?.split(';')[0];
}

async function withSql(run){
 const sql=postgres(testUrl,{max:1});
 try{ return await run(sql); } finally{ await sql.end({timeout:5}); }
}

test('验证码登录全链路：收码（假发送器）→ 验证发 cookie → 会话 → 登出 → 401',{skip},async()=>{
 const email='visitor@example.com';
 const sent=await postJson('/api/auth/code',{email});
 assert.equal(sent.res.status,200);
 assert.equal(JSON.stringify(sent.data).match(/\d{6}/),null,'响应不得回显验证码');
 const code=latestCode(email);
 assert.match(code,/^\d{6}$/);

 // 哈希落库且绑定 email；库中不存在明文码
 const rows=await withSql((sql)=>sql`select code_hash from login_codes where email=${email}`);
 assert.equal(rows.length,1);
 assert.equal(rows[0].code_hash,hashCode(email,code));
 assert.notEqual(rows[0].code_hash,sha256Hex(code));

 const verified=await postJson('/api/auth/verify',{email,code});
 assert.equal(verified.res.status,200);
 assert.deepEqual(verified.data,{email});
 const setCookie=verified.res.headers.getSetCookie().join('\n');
 assert.match(setCookie,/__Host-huanyu_session=/); // __Host- 前缀：浏览器侧强制 Secure+Path=/
 assert.match(setCookie,/HttpOnly/i);
 assert.match(setCookie,/Secure/i);
 assert.match(setCookie,/SameSite=Lax/i);
 assert.match(setCookie,/Max-Age=2592000/i); // 30 天

 const cookie=cookiePair(verified.res);
 assert.ok(cookie);
 const me=await fetch(`${server.base}/api/auth/session`,{headers:{cookie}});
 assert.equal(me.status,200);
 assert.deepEqual(await me.json(),{email});
 assert.equal(me.headers.get('cache-control'),'no-store','会话响应不得被缓存');

 // 会话令牌哈希落库：cookie 原值不可逆推出，库中无明文令牌
 const tokenValue=cookie.split('=')[1];
 const sessions=await withSql((sql)=>sql`select token_hash from web_sessions`);
 assert.equal(sessions.length,1);
 assert.equal(sessions[0].token_hash,sha256Hex(tokenValue));
 assert.notEqual(sessions[0].token_hash,tokenValue);

 const out=await postJson('/api/auth/logout',{},cookie);
 assert.equal(out.res.status,200);
 const after=await fetch(`${server.base}/api/auth/session`,{headers:{cookie}});
 assert.equal(after.status,401);
 assert.equal(after.headers.get('cache-control'),'no-store');
 const body=await after.json();
 assert.deepEqual(Object.keys(body).sort(),['error','message']);
 assert.equal(body.error,'unauthorized');
 const remaining=await withSql((sql)=>sql`select 1 from web_sessions`);
 assert.equal(remaining.length,0,'登出后会话行应被撤销');
});

test('邮箱小写归一：Mixed 与 lower 视为同一账号',{skip},async()=>{
 const mixed='Mixed.Case@Example.COM';
 const sent=await postJson('/api/auth/code',{email:mixed});
 assert.equal(sent.res.status,200);
 const verified=await postJson('/api/auth/verify',{email:mixed,code:latestCode('mixed.case@example.com')});
 assert.equal(verified.res.status,200);
 assert.equal(verified.data.email,'mixed.case@example.com');
 assert.equal(await withSql((sql)=>sql`select count(*)::int as n from users where email='mixed.case@example.com'`).then((r)=>r[0].n),1);

 // 同一邮箱换小写再次登录：upsert 而非新建账号
 const again=await postJson('/api/auth/code',{email:'mixed.case@example.com'});
 assert.equal(again.res.status,200);
 const reVerified=await postJson('/api/auth/verify',{email:'mixed.case@example.com',code:latestCode('mixed.case@example.com')});
 assert.equal(reVerified.res.status,200);
 assert.equal(await withSql((sql)=>sql`select count(*)::int as n from users where email='mixed.case@example.com'`).then((r)=>r[0].n),1);
});

test('单码尝试上限：5 次错误后作废，正确码也不可用；新码不受旧码牵连',{skip},async()=>{
 const email='brute@example.com';
 await postJson('/api/auth/code',{email});
 const code=latestCode(email);
 const wrong=wrongCodeOf(code);
 for(let i=0;i<5;i++){
  const bad=await postJson('/api/auth/verify',{email,code:wrong});
  assert.equal(bad.res.status,400);
  assert.deepEqual(Object.keys(bad.data).sort(),['error','message']);
  assert.equal(bad.data.error,'invalid_code');
 }
 // 第 6 次即使输对也失败（旧码已作废）
 const tooLate=await postJson('/api/auth/verify',{email,code});
 assert.equal(tooLate.res.status,400);
 assert.equal(tooLate.data.error,'invalid_code');

 // 重发新码：旧码不可用，新码可登录
 await postJson('/api/auth/code',{email});
 const fresh=latestCode(email);
 const stale=await postJson('/api/auth/verify',{email,code});
 assert.equal(stale.res.status,400);
 const ok=await postJson('/api/auth/verify',{email,code:fresh});
 assert.equal(ok.res.status,200);
 assert.equal(ok.data.email,email);
});

test('H-1 并发尝试上限：16 个并发错码后 attempts 恒 ≤5，正确码必失效',{skip},async()=>{
 const email='race@example.com';
 await postJson('/api/auth/code',{email});
 const code=latestCode(email);
 const wrong=wrongCodeOf(code);
 const results=await Promise.all(Array.from({length:16},()=>postJson('/api/auth/verify',{email,code:wrong})));
 for(const r of results) assert.equal(r.res.status,400);
 const rows=await withSql((sql)=>sql`select attempts from login_codes where email=${email}`);
 assert.equal(rows.length,1);
 assert.equal(rows[0].attempts,5,`并发递增不得越过 5 次上限（实际 ${rows[0].attempts}）`);
 const correct=await postJson('/api/auth/verify',{email,code});
 assert.equal(correct.res.status,400,'耗尽后正确码也必须失效');
});

test('并发双花：同一正确码并行两个 verify，恰一个 200 且只建一个会话',{skip},async()=>{
 const email='double@example.com';
 await postJson('/api/auth/code',{email});
 const code=latestCode(email);
 const pair=await Promise.all([
  postJson('/api/auth/verify',{email,code}),
  postJson('/api/auth/verify',{email,code}),
 ]);
 assert.equal(pair.filter((r)=>r.res.status===200).length,1,'恰一个成功');
 assert.equal(pair.filter((r)=>r.res.status===400).length,1,'另一个必须失败');
 const sessions=await withSql((sql)=>sql`select count(*)::int as n from web_sessions`);
 assert.equal(sessions[0].n,1);
});

test('verify 端点每 IP 限频：同 IP 累计 30 次失败尝试后 429',{skip},async()=>{
 // 6 个码 × 5 次错 = 30 次（跨 2 个邮箱绕开每邮箱发码限制；码行 ip 均为 unknown）
 for(let c=0;c<6;c++){
  const email=`vlimit-${c%2}@example.com`;
  const sent=await postJson('/api/auth/code',{email});
  assert.equal(sent.res.status,200);
  const wrong=wrongCodeOf(latestCode(email));
  for(let k=0;k<5;k++) assert.equal((await postJson('/api/auth/verify',{email,code:wrong})).res.status,400);
 }
 const sent=await postJson('/api/auth/code',{email:'vlimit-0@example.com'});
 assert.equal(sent.res.status,200);
 const blocked=await postJson('/api/auth/verify',{email:'vlimit-0@example.com',code:wrongCodeOf(latestCode('vlimit-0@example.com'))});
 assert.equal(blocked.res.status,429);
 assert.deepEqual(Object.keys(blocked.data).sort(),['error','message']);
 assert.equal(blocked.data.error,'rate_limited');
});

test('发信限频（每邮箱 5 封/小时）：第 6 封 429 统一错误形状',{skip},async()=>{
 const email='flood@example.com';
 for(let i=0;i<5;i++) assert.equal((await postJson('/api/auth/code',{email})).res.status,200);
 const sixth=await postJson('/api/auth/code',{email});
 assert.equal(sixth.res.status,429);
 assert.deepEqual(Object.keys(sixth.data).sort(),['error','message']);
 assert.equal(sixth.data.error,'rate_limited');
 assert.equal(readOutbox().filter((m)=>m.to===email).length,5,'超限的请求不得发信');
});

test('发信限频（每 IP 20 封/小时）：第 21 封 429',{skip},async()=>{
 for(let i=0;i<4;i++){
  const email=`ip-limit-${i}@example.com`;
  for(let j=0;j<5;j++) assert.equal((await postJson('/api/auth/code',{email})).res.status,200);
 }
 const beyond=await postJson('/api/auth/code',{email:'ip-limit-4@example.com'});
 assert.equal(beyond.res.status,429);
 assert.equal(beyond.data.error,'rate_limited');
});

test('H-2 IPv6 限频键归一 /64：轮换低 64 位不绕过每 IP 限额',{skip},async()=>{
 const v6=(low)=>`2001:db8:abcd:12:0:0:0:${low.toString(16)}`;
 for(let i=0;i<4;i++){
  const email=`v6-${i}@example.com`;
  for(let j=0;j<5;j++){
   const res=await postJson('/api/auth/code',{email},null,{'x-forwarded-for':v6(i*5+j+1)});
   assert.equal(res.res.status,200);
  }
 }
 // 21 封：邮箱维度未到限（新邮箱），若未按 /64 归一则会放行
 const beyond=await postJson('/api/auth/code',{email:'v6-4@example.com'},null,{'x-forwarded-for':'2001:db8:abcd:12:ffff:ffff:ffff:ffff'});
 assert.equal(beyond.res.status,429);
 assert.equal(beyond.data.error,'rate_limited');
});

test('H-2 全局日预算：24h 内已发 200 封 → 拒绝发码（防 Resend 配额耗尽成全站登录 DoS）',{skip},async()=>{
 await withSql((sql)=>sql`insert into login_codes (email,code_hash,ip,expires_at)
  select 'seed'||g||'@example.com','seed','seed-ip',now() from generate_series(1,200) g`);
 // 新邮箱+新 IP：per-key 维度均为 0，只有全局兜底能拦
 const res=await postJson('/api/auth/code',{email:'budget@example.com'},null,{'x-forwarded-for':'203.0.113.9'});
 assert.equal(res.res.status,429);
 assert.equal(res.data.error,'rate_limited');
});

test('M-1 CSRF 纵深：POST /api/auth/* 缺 Origin 或外域 Origin 一律 403；GET 不受限',{skip},async()=>{
 const email='csrf@example.com';
 const noOrigin=await fetch(`${server.base}/api/auth/code`,{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email}),
 });
 assert.equal(noOrigin.status,403);
 assert.equal((await noOrigin.json()).error,'origin_forbidden');
 const foreign=await fetch(`${server.base}/api/auth/verify`,{
  method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:JSON.stringify({email,code:'123456'}),
 });
 assert.equal(foreign.status,403);
 assert.equal((await foreign.json()).error,'origin_forbidden');
 // GET session 非状态变更，不要求 Origin
 const session=await fetch(`${server.base}/api/auth/session`);
 assert.equal(session.status,401);
 assert.equal((await session.json()).error,'unauthorized');
});

test('M-2/清理：发信失败响亮 500 且不落库占额度（不占限频、不留未送达有效码）',{skip},async()=>{
 // next dev 同目录单实例锁：先停主服务，换 FAKE_MAIL_OUTBOX 指向目录（appendFile 必败）起「发信必败」实例，测完恢复
 const brokenDir=mkdtempSync(path.join(tmpdir(),'huanyu-store-broken-outbox-'));
 const savedOutbox=process.env.FAKE_MAIL_OUTBOX;
 await server.stop();
 process.env.FAKE_MAIL_OUTBOX=brokenDir;
 const broken=await startDevServer(testUrl);
 try{
  const res=await fetch(`${broken.base}/api/auth/code`,{
   method:'POST',headers:{'content-type':'application/json',origin:broken.base},body:JSON.stringify({email:'fail@example.com'}),
  });
  assert.equal(res.status,500);
  const data=await res.json();
  assert.equal(data.error,'email_send_failed');
  const rows=await withSql((sql)=>sql`select count(*)::int as n from login_codes where email='fail@example.com'`);
  assert.equal(rows[0].n,0,'发信失败应 best-effort 清理刚插入的码行');
 }finally{
  await broken.stop();
  process.env.FAKE_MAIL_OUTBOX=savedOutbox;
  rmSync(brokenDir,{recursive:true,force:true});
  server=await startDevServer(testUrl);
 }
});

test('统一模糊错误与防枚举：码错/过期/未知邮箱同文案，发码响应不泄露注册状态',{skip},async()=>{
 const shape=async (run)=>{
  const {res,data}=await run();
  assert.deepEqual(Object.keys(data).sort(),['error','message']);
  return {status:res.status,error:data.error,message:data.message};
 };
 // 未请求过码的邮箱验证 → 与码错同文案
 const unknown=await shape(()=>postJson('/api/auth/verify',{email:'ghost@example.com',code:'111111'}));
 const email='fuzzy@example.com';
 await postJson('/api/auth/code',{email});
 const wrong=await shape(()=>postJson('/api/auth/verify',{email,code:wrongCodeOf(latestCode(email))}));
 assert.equal(unknown.status,400);
 assert.equal(unknown.error,'invalid_code');
 assert.equal(unknown.message,wrong.message); // 不区分码错/过期/不存在
 // 非法邮箱 / 非法请求体 → 400 统一形状
 assert.equal((await shape(()=>postJson('/api/auth/code',{email:'not-an-email'}))).error,'invalid_email');
 assert.equal((await postJson('/api/auth/verify',{email,code:'abc'})).res.status,400);
 // 未携带会话 → 401 统一形状
 assert.equal((await shape(()=>fetch(`${server.base}/api/auth/session`).then((res)=>res.json().then((data)=>({res,data}))))).error,'unauthorized');
 // 登出幂等：无会话也 200
 const anonymous=await postJson('/api/auth/logout',{});
 assert.equal(anonymous.res.status,200);
 // 发码响应对新邮箱与已注册邮箱完全一致（不泄露注册状态）
 const fresh=await postJson('/api/auth/code',{email:'brand-new@example.com'});
 const registered=await postJson('/api/auth/code',{email:'fuzzy@example.com'}); // 本用例开头已收过码的邮箱
 assert.equal(fresh.res.status,registered.res.status);
 assert.deepEqual(fresh.data,registered.data);
});
