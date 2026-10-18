import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { migrate } from '../scripts/migrate.mjs';
import { loadLocalEnv } from './helpers.mjs';

loadLocalEnv();
const testUrl=process.env.TEST_DATABASE_URL;
const skip=testUrl?false:'TEST_DATABASE_URL 未设置，跳过迁移测试';
const root=fileURLToPath(new URL('..',import.meta.url));

const expectedColumns={
 users:['created_at','email','id','last_login_at'],
 login_codes:['attempts','code_hash','created_at','email','expires_at','ip','used_at'],
 web_sessions:['created_at','expires_at','id','token_hash','user_id'],
 cli_tokens:['created_at','id','last_used_at','revoked_at','token_hash','user_id'],
 device_grants:['created_at','device_code_hash','expires_at','interval_seconds','last_poll_at','status','user_code','user_id'],
 products:['created_at','free_skill','id','name','page','paid_skill','prices','repo','summary','updated_at'],
 releases:['blob_path','notes','published_at','sha256','size','skill','version','yanked'],
};

test('迁移幂等：连跑两遍不报错不重放，表结构与版本记录正确',{skip},async()=>{
 await migrate(testUrl);                       // 第一遍：空库铺齐（或此前已铺过，均不应报错）
 const appliedSecond=await migrate(testUrl);   // 第二遍：幂等，应无新应用
 assert.deepEqual(appliedSecond,[]);
 const sql=postgres(testUrl,{max:1});
 try{
  const columns=await sql`select table_name,column_name from information_schema.columns where table_schema='public' order by table_name,column_name`;
  const byTable=new Map();
  for(const row of columns){
   if(!byTable.has(row.table_name)) byTable.set(row.table_name,[]);
   byTable.get(row.table_name).push(row.column_name);
  }
  for(const [table,want] of Object.entries(expectedColumns)) assert.deepEqual(byTable.get(table),want,`${table} 列结构不符`);
  const files=(await readdir(path.join(root,'db','migrations'))).filter(f=>f.endsWith('.sql')).sort();
  const recorded=await sql`select version,count(*)::int as times from schema_migrations group by version`;
  assert.equal(recorded.length,files.length,'版本记录条数应与迁移文件数一致');
  for(const row of recorded) assert.equal(row.times,1,`版本 ${row.version} 不应重复记录`);
  for(const file of files) assert.ok(recorded.some(r=>r.version===file.slice(0,-4)),`缺少 ${file} 的版本记录`);
 } finally { await sql.end({timeout:5}); }
});
