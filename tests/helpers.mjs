import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const root=fileURLToPath(new URL('..',import.meta.url));

/** npm test 不会自动读取 .env.local；存在则补读。已设置的环境变量优先（CI 直接注入时不受影响）。 */
export function loadLocalEnv() {
 if (!existsSync('.env.local')) return;
 for (const line of readFileSync('.env.local','utf8').split(/\r?\n/)) {
  const match=line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (match && match[2]!=='' && process.env[match[1]]===undefined) process.env[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');
 }
}

const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));

/** 预订一个空闲端口：先占住拿端口号再释放，测试服务随后绑定。 */
export function reservePort(){
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
export function stopServer(child){
 return new Promise((resolve)=>{
  if (child.exitCode!==null) return resolve();
  const guard=setTimeout(resolve,5000); // 兜底：进程树未如期退出也不挂死测试
  child.once('exit',()=>{clearTimeout(guard);resolve();});
  if (process.platform==='win32') spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});
  else child.kill('SIGTERM');
 });
}

/** 起 next dev（随机空闲端口；显式传入的 DATABASE_URL 优先于 .env.local），首页 200 即就绪，返回 {base, stop}。 */
export async function startDevServer(databaseUrl){
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
  try {
   const res=await fetch(base);
   await res.arrayBuffer(); // 就绪探测也须消费响应体，否则连接挂起、句柄泄漏
   if (res.ok) return {base,stop:()=>stopServer(child)};
  } catch { /* 端口尚未就绪，继续轮询 */ }
  await sleep(500);
 }
 await stopServer(child);
 throw new Error(`dev server 起动超时:\n${Buffer.concat(output).toString()}`);
}

/** 集成测试间的清场：清空全部业务表，用例互不残留数据。 */
export async function resetDatabase(connectionString){
 const sql=postgres(connectionString,{max:1});
 try{
  await sql`truncate table users,login_codes,web_sessions,cli_tokens,device_grants,products,releases restart identity cascade`;
 } finally { await sql.end({timeout:5}); }
}
