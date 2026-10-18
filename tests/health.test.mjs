import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../scripts/migrate.mjs';
import { loadLocalEnv, resetDatabase, startDevServer } from './helpers.mjs';

loadLocalEnv();
const testUrl=process.env.TEST_DATABASE_URL;
const skip=testUrl?false:'TEST_DATABASE_URL 未设置，跳过集成测试（起 dev server 需要测试库）';

test('GET /api/health 数据库连通时返回 200 ok',{skip},async()=>{
 await migrate(testUrl);
 await resetDatabase(testUrl);
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
  assert.equal(body.message,'数据库暂时不可用'); // 静态文案：驱动原始错误文本（含主机/用户名）只进服务端日志，不出现在响应里
 } finally { await server.stop(); }
});
