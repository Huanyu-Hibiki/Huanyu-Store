// 冒烟脚本（任务 8a）：对本地 dev server 跑 验证码登录 → 设备码换令牌 → 商品注册 →
// publish 两版 → catalog/versions 对账 → 匿名下载 302 跟随 sha256 对账 → yank 回落 →
// notes 修订 的全链路，随后直连 DATABASE_URL 清掉本脚本产生的全部行（可重复执行）。
// 用法：node --env-file=.env.local scripts/smoke.mjs [--base http://127.0.0.1:3000]
//   缺省自起 dev server（随机端口，更可重复：假发送器/假 Blob/PUBLISHER_EMAILS 由脚本注入）；
//   --base 指向已在跑的服务时，该服务须以假发送器（FAKE_MAIL_OUTBOX）启动、且其
//   PUBLISHER_EMAILS 含冒烟账号，否则登录/发布步会 FAIL 并说明原因。
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { loadLocalEnv, startDevServer } from '../tests/helpers.mjs';

const smokeEmail='smoke@example.com';
const skill=`smoke-e2e-${randomBytes(4).toString('hex')}`; // 随机后缀：不与库里任何现存数据相撞

const die=(message)=>{ console.error(message); process.exit(1); };

/** 单文件最小 ustar 条目 + 双零块收尾：publish 校验只看 gzip 魔数/sha/尺寸，
 *  但冒烟包按 CLI 真实上传形态打（tar.gz 内含 <skill>/SKILL.md）。 */
function tarOf(name,content){
  const body=Buffer.from(content,'utf8');
  const octal=(value,width)=>value.toString(8).padStart(width,'0');
  const header=Buffer.alloc(512);
  header.write(name,0,100);
  header.write('0000644',100,7);
  header.write('0000000',108,7);
  header.write('0000000',116,7);
  header.write(octal(body.length,11),124,11);
  header.write(octal(Math.floor(Date.now()/1000),11),136,11);
  header.write('        ',148,8); // checksum 先置 8 空格再求和
  header.write('0',156,1);        // typeflag：常规文件
  header.write('ustar\0',257,6);
  header.write('00',263,2);
  let checksum=0;
  for (const byte of header) checksum+=byte;
  header.write(octal(checksum,6)+'\0 ',148,8);
  return Buffer.concat([header,body,Buffer.alloc((512-(body.length%512))%512),Buffer.alloc(1024)]);
}

const skillMd=(version)=>
  `---\nname: ${skill}\ndescription: 冒烟脚本测试包（跑完自清理）\nmetadata:\n  version: "${version}"\n---\n\n# 冒烟 ${version}\n`;
const packageOf=(version)=>gzipSync(tarOf(`${skill}/SKILL.md`,skillMd(version)));
const sha256Of=(bytes)=>createHash('sha256').update(bytes).digest('hex');

async function main(){
  const args=process.argv.slice(2);
  const baseFlag=args.indexOf('--base');
  const externalBase=baseFlag!==-1?args[baseFlag+1]:undefined;
  if (baseFlag!==-1&&!externalBase) die('用法：node --env-file=.env.local scripts/smoke.mjs [--base http://127.0.0.1:3000]');

  loadLocalEnv();
  const databaseUrl=process.env.DATABASE_URL;
  if (!databaseUrl) die('缺少 DATABASE_URL（示例：node --env-file=.env.local scripts/smoke.mjs）');

  // —— 自起模式的环境注入：只改本进程 env，startDevServer 会原样传给 dev server 子进程 ——
  let outboxDir=null,blobDir=null,outbox;
  if (!externalBase){
    delete process.env.RESEND_API_KEY;         // 强制假发送器（即使 .env.local 配了真密钥）
    delete process.env.BLOB_READ_WRITE_TOKEN;  // 强制假 Blob（确定性 + 可清理）
    delete process.env.SITE_ORIGIN;            // 假仓回环 attest URL 需回落请求 Host 指回本服务
    process.env.PUBLISHER_EMAILS=smokeEmail;   // 让冒烟账号过发布者白名单
    outboxDir=mkdtempSync(path.join(tmpdir(),'huanyu-smoke-mail-'));
    blobDir=mkdtempSync(path.join(tmpdir(),'huanyu-smoke-blob-'));
    outbox=path.join(outboxDir,'outbox.jsonl');
    process.env.FAKE_MAIL_OUTBOX=outbox;
    process.env.FAKE_BLOB_DIR=blobDir;
  } else {
    outbox=process.env.FAKE_MAIL_OUTBOX; // --base 模式：沿用调用方环境里的假发送器 outbox
  }

  let server=null;
  const steps=[];
  let alive=true;
  /** 顺序执行一步：失败记 FAIL 并拦住后续业务步（依赖前序状态）；force=true 无视拦截
   *  （清理步必须在中途失败后仍然执行）。run 自身永不 reject。 */
  const run=async(name,fn,{force=false}={})=>{
    if (!alive&&!force) return;
    try{
      const detail=await fn();
      steps.push({name,ok:true});
      console.log(`PASS ${steps.length}. ${name}${detail?` — ${detail}`:''}`);
    }catch(error){
      alive=false;
      steps.push({name,ok:false,detail:error.message});
      console.error(`FAIL ${steps.length}. ${name} — ${error.message}`);
    }
  };

  try{
    server=externalBase
      ?{base:externalBase.replace(/\/+$/,''),stop:async()=>{}}
      :await startDevServer(databaseUrl);
    console.log(`[smoke] 目标 ${server.base}（${externalBase?'外部服务':'自起 dev server'}；skill=${skill}，账号=${smokeEmail}）`);

    const auth={authorization:''};
    const post=async(pathname,body,{cookie}={})=>{
      const res=await fetch(`${server.base}${pathname}`,{
        method:'POST',headers:{'content-type':'application/json',origin:server.base,...(cookie?{cookie}:{})},
        body:JSON.stringify(body),
      });
      return {res,data:await res.json().catch(()=>null)};
    };
    const readOutbox=()=>existsSync(outbox)
      ?readFileSync(outbox,'utf8').split(/\r?\n/).filter(Boolean).map((line)=>JSON.parse(line))
      :[];
    const versionsOf=async()=>{
      const res=await fetch(`${server.base}/api/store/versions`);
      return (await res.json()).skills?.[skill];
    };

    await run('health 探针',async()=>{
      const res=await fetch(`${server.base}/api/health`);
      const data=await res.json().catch(()=>null);
      if (res.status!==200||data?.status!=='ok')
        throw new Error(`HTTP ${res.status} ${JSON.stringify(data)}（库未迁移？先跑 node --env-file=.env.local scripts/migrate.mjs）`);
      return '数据库连通';
    });

    await run('验证码登录 + 设备码换令牌（假发送器读码）',async()=>{
      const device=await post('/api/cli/device',{client_name:'store-smoke',platform:process.platform});
      if (device.res.status!==200) throw new Error(`device HTTP ${device.res.status}`);
      const sent=await post('/api/auth/code',{email:smokeEmail});
      if (sent.res.status!==200) throw new Error(`发码 HTTP ${sent.res.status}：${JSON.stringify(sent.data)}`);
      const code=readOutbox().filter((mail)=>mail.to===smokeEmail).at(-1)?.text?.match(/\b(\d{6})\b/)?.[1];
      if (!code) throw new Error(`outbox（${outbox??'未设置 FAKE_MAIL_OUTBOX'}）未检出验证码——--base 模式要求目标服务以假发送器启动`);
      const verified=await post('/api/auth/verify',{email:smokeEmail,code});
      if (verified.res.status!==200) throw new Error(`verify HTTP ${verified.res.status}`);
      const cookie=verified.res.headers.getSetCookie().find((entry)=>entry.startsWith('__Host-huanyu_session='))?.split(';')[0];
      if (!cookie) throw new Error('verify 未下发会话 cookie');
      const decision=await post('/api/cli/approve',{user_code:device.data.user_code,approve:true},{cookie});
      if (decision.res.status!==200) throw new Error(`approve HTTP ${decision.res.status}`);
      const polled=await post('/api/cli/token',{device_code:device.data.device_code});
      if (polled.res.status!==200) throw new Error(`token HTTP ${polled.res.status}`);
      auth.authorization=`Bearer ${polled.data.token}`;
      const me=await fetch(`${server.base}/api/auth/me`,{headers:auth});
      const meData=await me.json().catch(()=>null);
      if (meData?.publisher!==true)
        throw new Error(`me.publisher=${JSON.stringify(meData?.publisher)}：自起模式由脚本注入；--base 模式须目标服务的 PUBLISHER_EMAILS 含 ${smokeEmail}`);
      return `${smokeEmail} publisher=true`;
    });

    await run('PUT products 注册测试商品',async()=>{
      const res=await fetch(`${server.base}/api/store/products/${skill}`,{
        method:'PUT',headers:{'content-type':'application/json',...auth},
        body:JSON.stringify({name:`冒烟商品 ${skill}`,summary:'冒烟脚本自动注册，跑完自清理。',free:skill}),
      });
      const data=await res.json().catch(()=>null);
      if (res.status!==200||data?.id!==skill) throw new Error(`HTTP ${res.status} ${JSON.stringify(data)}`);
      return `id=${skill} free=${data.free.skill}`;
    });

    let v1Bytes,v2Bytes;
    await run('publish 两版本（tar.gz 含 SKILL.md）',async()=>{
      const publish=async(version,bytes,notes)=>{
        const res=await fetch(`${server.base}/api/store/publish`,{
          method:'POST',
          headers:{'content-type':'application/gzip','x-skill-name':skill,'x-skill-version':version,
            'x-content-sha256':sha256Of(bytes),...(notes!==undefined?{'x-notes':notes}:{}),...auth},
          body:bytes,
        });
        const data=await res.json().catch(()=>null);
        if (res.status!==200) throw new Error(`${version} HTTP ${res.status} ${JSON.stringify(data)}`);
        if (data.sha256!==sha256Of(bytes)) throw new Error(`${version} 响应 sha256 与上传体不符`);
      };
      v1Bytes=packageOf('1.0.0');
      v2Bytes=packageOf('1.1.0');
      await publish('1.0.0',v1Bytes,encodeURIComponent('冒烟首发说明'));
      await publish('1.1.0',v2Bytes);
      return `1.0.0（${v1Bytes.length}B）+ 1.1.0（${v2Bytes.length}B）`;
    });

    await run('catalog/versions 断言',async()=>{
      const catalog=await (await fetch(`${server.base}/api/store/catalog`)).json();
      const mine=catalog.products?.find((product)=>product.id===skill);
      if (!mine||mine.free?.skill!==skill) throw new Error(`catalog 未含 ${skill}`);
      const entry=await versionsOf();
      if (entry?.latest!=='1.1.0') throw new Error(`latest=${entry?.latest}，期望 1.1.0`);
      if (entry.history?.length!==2) throw new Error(`history ${entry.history?.length} 条，期望 2`);
      if (entry.sha256!==sha256Of(v2Bytes)) throw new Error('versions.sha256 与 1.1.0 上传体不符');
      return `latest=1.1.0 history=2 catalog 命中`;
    });

    const downloadDefault=()=>fetch(`${server.base}/api/store/download/${skill}?format=tar.gz`,{redirect:'manual'});
    await run('匿名 download 302 跟随 + sha256 对账',async()=>{
      const res=await downloadDefault();
      if (res.status!==302) throw new Error(`期望 302（免费 + 无 Authorization），得到 ${res.status}`);
      const followed=await fetch(res.headers.get('location'));
      if (!followed.ok) throw new Error(`跟随签名 URL HTTP ${followed.status}`);
      const bytes=Buffer.from(await followed.arrayBuffer());
      if (sha256Of(bytes)!==sha256Of(v2Bytes)) throw new Error('latest（1.1.0）字节与发布时不一致');
      return `${bytes.length}B sha256=${sha256Of(bytes).slice(0,12)}…`;
    });

    await run('yank 最高版 → latest 回落 + 缺省下载字节回落',async()=>{
      const res=await fetch(`${server.base}/api/store/releases/${skill}/1.1.0`,{method:'DELETE',headers:auth});
      const data=await res.json().catch(()=>null);
      if (res.status!==200||data?.yanked!==true) throw new Error(`HTTP ${res.status} ${JSON.stringify(data)}`);
      const entry=await versionsOf();
      if (entry?.latest!=='1.0.0') throw new Error(`yank 后 latest=${entry?.latest}，期望回落 1.0.0`);
      if (entry.history?.[0]?.yanked!==true) throw new Error('history[0]（1.1.0）未带 yanked 标记');
      const redownload=await downloadDefault();
      if (redownload.status!==302) throw new Error(`回落下载期望 302，得到 ${redownload.status}`);
      const bytes=Buffer.from(await (await fetch(redownload.headers.get('location'))).arrayBuffer());
      if (sha256Of(bytes)!==sha256Of(v1Bytes)) throw new Error('缺省下载字节未回落到 1.0.0');
      return 'latest=1.0.0，缺省下载 sha256=1.0.0';
    });

    await run('notes 修订 → versions 立即反映',async()=>{
      const res=await fetch(`${server.base}/api/store/releases/${skill}/1.0.0/notes`,{
        method:'PUT',headers:{'content-type':'application/json',...auth},
        body:JSON.stringify({notes:'冒烟修订后的说明。'}),
      });
      const data=await res.json().catch(()=>null);
      if (res.status!==200||data?.notes!=='冒烟修订后的说明。') throw new Error(`HTTP ${res.status} ${JSON.stringify(data)}`);
      const entry=await versionsOf();
      const revised=entry.history?.find((item)=>item.version==='1.0.0')?.notes;
      if (revised!=='冒烟修订后的说明。') throw new Error(`versions 反映 ${JSON.stringify(revised)}`);
      return 'notes 已更新';
    });
  } finally {
    // —— 清理（含中途失败，force 执行）：直连 DATABASE_URL 删本脚本产生的行；users 无级联，先删子行 ——
    await run('清理：直连 DATABASE_URL 删除冒烟数据并核对零残留',async()=>{
      const sql=postgres(databaseUrl,{max:1});
      try{
        const users=await sql`select id from users where email=${smokeEmail}`;
        for (const user of users){
          await sql`delete from device_grants where user_id=${user.id}`;
          await sql`delete from cli_tokens where user_id=${user.id}`;
          await sql`delete from web_sessions where user_id=${user.id}`;
        }
        await sql`delete from login_codes where email=${smokeEmail}`;
        await sql`delete from users where email=${smokeEmail}`;
        await sql`delete from releases where skill=${skill}`;
        await sql`delete from products where id=${skill} or free_skill=${skill} or paid_skill=${skill}`;
        const [leftover]=await sql`select
          (select count(*) from users where email=${smokeEmail}) as users,
          (select count(*) from releases where skill=${skill}) as releases,
          (select count(*) from products where id=${skill} or free_skill=${skill} or paid_skill=${skill}) as products`;
        const residue={users:Number(leftover.users),releases:Number(leftover.releases),products:Number(leftover.products)};
        if (residue.users||residue.releases||residue.products) throw new Error(`残留行：${JSON.stringify(residue)}`);
        return 'users/releases/products 残留 0 行';
      } finally { await sql.end({timeout:5}); }
    },{force:true});
    if (blobDir){ rmSync(blobDir,{recursive:true,force:true}); rmSync(outboxDir,{recursive:true,force:true}); }
    if (server) await server.stop();
  }

  const failed=steps.filter((entry)=>!entry.ok);
  if (failed.length){
    console.error(`\n冒烟失败（${failed.length} 步）：`);
    for (const failure of failed) console.error(`  FAIL ${failure.name} — ${failure.detail}`);
    process.exit(1);
  }
  console.log(`\n冒烟全链路 PASS（${steps.length} 步）：login → product → publish×2 → catalog/versions → download → yank → notes → 自清理`);
}

main().catch((error)=>{ console.error(`[smoke] 未预期错误：${error?.stack??error}`); process.exit(1); });
