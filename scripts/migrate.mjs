import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';

const migrationsDir=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','db','migrations');

/** 对目标库按文件名顺序应用未执行的迁移；每个迁移单独成事务并记入版本表，重复执行幂等。返回本次应用的版本列表。 */
export async function migrate(connectionString){
 const sql=postgres(connectionString,{max:1,onnotice:()=>{}}); // 幂等重跑时 42P07「已存在, skipping」NOTICE 无信息量，静默
 const applied=[];
 try{
  await sql`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
  const files=(await readdir(migrationsDir)).filter((file)=>file.endsWith('.sql')).sort();
  for(const file of files){
   const version=file.slice(0,-'.sql'.length);
   const recorded=await sql`select 1 from schema_migrations where version = ${version}`;
   if (recorded.length>0) continue;
   const body=await readFile(path.join(migrationsDir,file),'utf8');
   await sql.begin(async (tx)=>{
    await tx.unsafe(body); // 迁移文件是仓库内受控 SQL，无外部参数
    await tx`insert into schema_migrations (version) values (${version})`;
   });
   applied.push(version);
  }
  return applied;
 } finally { await sql.end({timeout:5}); }
}

const invokedDirectly=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if (invokedDirectly){
 const target=process.env.DATABASE_URL;
 if (!target){
  console.error('缺少 DATABASE_URL（示例：node --env-file=.env.local scripts/migrate.mjs）');
  process.exitCode=1;
 } else {
  const applied=await migrate(target);
  console.log(applied.length?`已应用迁移：${applied.join(', ')}`:'无待应用迁移');
 }
}
