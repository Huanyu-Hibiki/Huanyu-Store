import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { migrate } from '../scripts/migrate.mjs';
import { loadLocalEnv } from './helpers.mjs';

loadLocalEnv();
const testUrl=process.env.TEST_DATABASE_URL;
const skip=testUrl?false:'TEST_DATABASE_URL 未设置，跳过集成测试（起 dev server 需要测试库）';
const root=fileURLToPath(new URL('..',import.meta.url));

const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));

function reservePort(){
 return new Promise((resolve,reject)=>{
  const probe=createServer();
  probe.once('error',reject);
  probe.listen(0,'127.0.0.1',()=>{
   const port=probe.address().port; // close 之后 address() 会变 null，须先取
   probe.close(()=>resolve(port));
  });
 });
}

// Windows 下须杀整棵进程树，否则 next dev 的子进程残留、端口句柄不释放。
function stopServer(child){
 return new Promise((resolve)=>{
  if (child.exitCode!==null) return resolve();
  const guard=setTimeout(resolve,5000); // 兜底：进程树未如期退出也不挂死测试
  child.once('exit',()=>{clearTimeout(guard);resolve();});
  if (process.platform==='win32') spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});
  else child.kill('SIGTERM');
 });
}

async function startDevServer(databaseUrl){
 const port=await reservePort();
 const child=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port',String(port)],{
  cwd:root,
  env:{...process.env,DATABASE_URL:databaseUrl,NEXT_TELEMETRY_DISABLED:'1'},
  stdio:['ignore','pipe','pipe'],
  windowsHide:true,
 });
 const output=[];
 child.stdout.on('data',(chunk)=>output.push(chunk));
 child.stderr.on('data',(chunk)=>output.push(chunk));
 const base=`http://127.0.0.1:${port}`;
 const deadline=Date.now()+120000;
 while(Date.now()<deadline){
  if (child.exitCode!==null) throw new Error(`dev server 提前退出:\n${Buffer.concat(output).toString()}`);
  try { if ((await fetch(base)).ok) return {base,stop:()=>stopServer(child)}; } catch { /* 端口尚未就绪，继续轮询 */ }
  await sleep(500);
 }
 await stopServer(child);
 throw new Error(`dev server 起动超时:\n${Buffer.concat(output).toString()}`);
}

// 集成骨架的清场动作：测试间互不残留数据。
async function resetDatabase(){
 const sql=postgres(testUrl,{max:1});
 try{
  await sql`truncate table users,login_codes,web_sessions,cli_tokens,device_grants,products,releases restart identity cascade`;
 } finally { await sql.end({timeout:5}); }
}

test('GET /api/health 数据库连通时返回 200 ok',{skip},async()=>{
 await migrate(testUrl);
 await resetDatabase();
 const server=await startDevServer(testUrl);
 try{
  const res=await fetch(`${server.base}/api/health`);
  assert.equal(res.status,200);
  assert.deepEqual(await res.json(),{status:'ok'});
 } finally { await server.stop(); }
});

test('GET /api/health 数据库不可达时返回统一错误形状而非裸 500',{skip},async()=>{
 const server=await startDevServer('postgres://postgres:dev@127.0.0.1:1/store_test');
 try{
  const res=await fetch(`${server.base}/api/health`);
  assert.equal(res.status,503);
  const body=await res.json();
  assert.deepEqual(Object.keys(body).sort(),['error','message']);
  assert.equal(body.error,'database_unavailable');
  assert.ok(typeof body.message==='string'&&body.message.length>0);
 } finally { await server.stop(); }
});
