import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLocalEnv, startDevServer } from './helpers.mjs';

loadLocalEnv();
const testUrl=process.env.TEST_DATABASE_URL;
const skip=testUrl?false:'TEST_DATABASE_URL 未设置，跳过 attest 生产关闭测试';

/** attest 生产关闭（security LOW-6，spec 观察锚定）：Next 16 dev 有单实例锁，同仓起不了第二台
 *  dev server——注入假 BLOB_READ_WRITE_TOKEN 的场景须在独立文件的独立 server 生命周期里验证。
 *  守卫分支不触库（404 早退），无需迁移。 */
test('attest 生产关闭镜像 blobStore() 双条件：注入假 BLOB_READ_WRITE_TOKEN → attest 404',{skip},async()=>{
  process.env.BLOB_READ_WRITE_TOKEN='fake-token-attest-guard-probe';
  try{
    const server=await startDevServer(testUrl);
    try{
      const res=await fetch(`${server.base}/api/store/blob-attest?key=${encodeURIComponent('releases/a/1.0.0-aaaaaaaaaaaa.tar.gz')}&exp=${Date.now()+60_000}`);
      assert.equal(res.status,404,'真仓模式（302 → presigned）下 attest 永不服务');
      assert.deepEqual(await res.json(),{error:'not_found',message:'不存在该对象。'},'与其余 attest 404 同文案');
    } finally { await server.stop(); }
  } finally { delete process.env.BLOB_READ_WRITE_TOKEN; }
});
