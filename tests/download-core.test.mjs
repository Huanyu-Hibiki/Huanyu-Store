import test from 'node:test';
import assert from 'node:assert/strict';
import { DOWNLOAD_MAP_KEY_MAX, DOWNLOAD_WINDOW_MAX, DOWNLOAD_WINDOW_MS, resolveDownload, slidingWindowAllow } from '../lib/download-core.mjs';
import { SIGNED_URL_TTL_MS, attestUrl, verifyAttest } from '../lib/blob.mjs';

const KEY='releases/demo-skill/1.0.0-ab12cd34ef56.tar.gz';
const row=(version,{yanked=false}={})=>({version,sha256:'0'.repeat(64),size:10,blob_path:`releases/s/${version}-ab12cd34ef56.tar.gz`,yanked});

test('resolveDownload：付费 skill（某商品 paid_skill）恒 402 inactive，未发布/带版本同样拒',()=>{
  const paid={paidSkills:new Set(['demo-pro']),catalogNames:new Set(['demo-pro','demo-free'])};
  for (const version of [null,'1.0.0']) {
    const out=resolveDownload({skill:'demo-pro',version,rows:[row('1.0.0')],...paid});
    assert.equal(out.ok,false);
    assert.equal(out.status,402);
    assert.equal(out.error,'inactive');
    assert.equal(typeof out.message,'string');
  }
  const unpublished=resolveDownload({skill:'demo-pro',version:null,rows:[],...paid});
  assert.equal(unpublished.status,402,'付费判定先于版本存在性（402 即止，不泄露版本状态）');
});

test('resolveDownload：未知 skill（catalog 与孤儿 releases 都没有）404 not_found',()=>{
  const out=resolveDownload({skill:'ghost',version:null,rows:[],paidSkills:new Set(),catalogNames:new Set(['demo-free'])});
  assert.equal(out.ok,false);
  assert.equal(out.status,404);
  assert.equal(out.error,'not_found');
});

test('resolveDownload：catalog 免费名未发布 404；孤儿（不在 catalog、有 releases）按免费放行',()=>{
  const roles={paidSkills:new Set(),catalogNames:new Set(['shelved-skill'])};
  assert.equal(resolveDownload({skill:'shelved-skill',version:null,rows:[],...roles}).status,404);
  const orphan=resolveDownload({skill:'orphan-skill',version:null,rows:[row('0.3.0')],...roles});
  assert.equal(orphan.ok,true);
  assert.equal(orphan.row.version,'0.3.0');
});

test('resolveDownload：缺省版本=最高未 yank；指定版本取该行；指定不存在 404；全部 yank 缺省 404',()=>{
  const roles={paidSkills:new Set(),catalogNames:new Set()};
  const rows=[row('1.0.0'),row('2.0.0'),row('3.0.0',{yanked:true})];
  const latest=resolveDownload({skill:'demo-skill',version:null,rows,...roles});
  assert.equal(latest.ok,true);
  assert.equal(latest.row.version,'2.0.0','缺省取最高未 yank（yanked 不回落入选）');
  const explicit=resolveDownload({skill:'demo-skill',version:'1.0.0',rows,...roles});
  assert.equal(explicit.row.version,'1.0.0');
  assert.equal(resolveDownload({skill:'demo-skill',version:'9.9.9',rows,...roles}).status,404);
  assert.equal(resolveDownload({skill:'demo-skill',version:'3.0.0',rows,...roles}).status,404,'指定 yanked 版本 404（任务 7 语义预铺）');
  const allYanked=resolveDownload({skill:'demo-skill',version:null,rows:rows.map((item)=>({...item,yanked:true})),...roles});
  assert.equal(allYanked.status,404,'全部 yank 时缺省不回落占位版本');
});

test('slidingWindowAllow：窗口内放行 max 次、第 max+1 次拒；窗口滑出恢复；key 互不影响',()=>{
  const hits=new Map();
  let now=1_000;
  for (let i=0;i<DOWNLOAD_WINDOW_MAX;i++) assert.equal(slidingWindowAllow(hits,'ip-a',now),true);
  assert.equal(slidingWindowAllow(hits,'ip-a',now),false);
  assert.equal(slidingWindowAllow(hits,'ip-b',now),true,'限频按 IP 独立计数');
  now+=DOWNLOAD_WINDOW_MS+1;
  assert.equal(slidingWindowAllow(hits,'ip-a',now),true,'窗口滑出后恢复');
  // 滑动语义：老记录按各自时刻滑出、后到记录仍占窗（不是整窗清零的固定窗口）
  const hits2=new Map();
  const start=5_000;
  for (let i=0;i<DOWNLOAD_WINDOW_MAX-1;i++) assert.equal(slidingWindowAllow(hits2,'ip',start),true);
  assert.equal(slidingWindowAllow(hits2,'ip',start+30_000),true,'后到的一次也计入（窗满）');
  assert.equal(slidingWindowAllow(hits2,'ip',start+30_001),false,'窗满拒');
  assert.equal(slidingWindowAllow(hits2,'ip',start+60_000),true,'@start 的记录已滑出、@+30s 的仍占窗');
});

test('attestUrl/verifyAttest：假仓回环签名 URL 形状、TTL ≥10 分钟、过期/坏键/远未来拒绝',()=>{
  assert.ok(SIGNED_URL_TTL_MS>=10*60*1000,'TTL ≥ 10 分钟（设计风险表：远超 CLI 120s 下载超时）');
  const url=attestUrl('http://127.0.0.1:3999',KEY,1_000);
  assert.equal(url,`http://127.0.0.1:3999/api/store/blob-attest?key=${encodeURIComponent(KEY)}&exp=${1000+SIGNED_URL_TTL_MS}`);
  assert.equal(verifyAttest(KEY,String(1000+SIGNED_URL_TTL_MS),1_500),true,'未过期放行');
  assert.equal(verifyAttest(KEY,String(1000+SIGNED_URL_TTL_MS),1000+SIGNED_URL_TTL_MS),false,'过期拒');
  assert.equal(verifyAttest('../etc/passwd',String(1000+SIGNED_URL_TTL_MS),1_500),false,'键形状拒（路径逃逸）');
  assert.equal(verifyAttest(KEY,'not-a-number',1_500),false,'exp 非法拒');
  assert.equal(verifyAttest(KEY,String(1000+SIGNED_URL_TTL_MS+3_600_000),1_500),false,'远未来 exp 拒（有效期上限 = 签发 + TTL）');
  assert.equal(verifyAttest(null,null,1_500),false,'缺参拒');
});

test('verifyAttest：HIGH-1 实测复现的路径穿越形态全拒（尾缀分支不得放行含 / 的后缀）',()=>{
  for (const key of ['releases/a/1.0.0.tar.gz./../../../../etc/passwd','releases/a/1.0.0.tar.gz.extra/../../escape']) {
    assert.equal(verifyAttest(key,String(Date.now()+SIGNED_URL_TTL_MS)),false,JSON.stringify(key));
  }
});

test('slidingWindowAllow：Map 键数上限——未超不重置、超限整窗重置后从零计数（quality M3）',()=>{
  const big=new Map();
  for (let i=0;i<DOWNLOAD_MAP_KEY_MAX;i++) big.set(`k${i}`,[9_000]);
  assert.equal(slidingWindowAllow(big,'at-cap',9_500),true);
  assert.equal(big.size,DOWNLOAD_MAP_KEY_MAX+1,'恰在上限不重置（新键照常计入）');
  big.set('overflow',[9_000]);
  assert.equal(slidingWindowAllow(big,'fresh',9_600),true,'重置后的请求放行');
  assert.equal(big.size,1,'超上限触发整窗重置（best-effort 内存护栏，已注释登记）');
  assert.deepEqual(big.get('fresh'),[9_600],'重置后从零计数');
});
