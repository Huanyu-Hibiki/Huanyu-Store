import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// 发布管道的纯逻辑（对齐 CLI 契约：skills.js isVersion 严格 semver、client.js publishResponse 五字段、
// test/fixture.js publish 参考实现的错误语义）。
import {
  MAX_PACKAGE_BYTES, NOTES_MAX_LENGTH, RELEASES_PER_SKILL_MAX, isVersion, compareVersions,
  validatePublishHeaders, validateNotes, readPackageBody, latestOf, versionsPayload, downloadUrlFor, isReleaseCountLimited,
} from '../lib/publish-core.mjs';
import { blobStore, storageKey } from '../lib/blob.mjs';

const sha256Of=(bytes)=>createHash('sha256').update(bytes).digest('hex');

test('isVersion：与 CLI skills.js 同规则——无前导零的三段数字',()=>{
  for (const good of ['0.0.0','1.0.0','0.1.0','10.20.30']) assert.equal(isVersion(good),true,good);
  for (const bad of ['01.0.0','0.01.0','0.0.01','1.0','1.0.0.0','v1.0.0','1.0.0-rc1','',42,null,undefined,'a.b.c'])
    assert.equal(isVersion(bad),false,String(bad));
});

test('compareVersions：逐段比较（0.10.0 > 0.9.0 的文本序陷阱不受影响）',()=>{
  assert.equal(compareVersions('0.10.0','0.9.0'),1);
  assert.equal(compareVersions('0.9.0','0.10.0'),-1);
  assert.equal(compareVersions('1.0.0','1.0.0'),0);
  assert.equal(compareVersions('2.0.0','10.0.0'),-1,'文本序会判反过来，必须数值序');
});

test('validatePublishHeaders：合法头通过并解出 notes',()=>{
  const result=validatePublishHeaders({
    name:'demo-skill',version:'1.0.0',sha256:'a'.repeat(64),
    notes:encodeURIComponent('首发说明：修复若干问题。\n第二行'),
  });
  assert.deepEqual(result,{ok:true,name:'demo-skill',version:'1.0.0',sha256:'a'.repeat(64),notes:'首发说明：修复若干问题。\n第二行'});
  // notes 缺省/空串 → null（空说明与不带说明等价）
  assert.equal(validatePublishHeaders({name:'a-skill',version:'0.1.0',sha256:'0'.repeat(64)}).notes,null);
  assert.equal(validatePublishHeaders({name:'a-skill',version:'0.1.0',sha256:'0'.repeat(64),notes:''}).notes,null);
});

test('validatePublishHeaders：名字/semver/hex 形状非法全拒（400 invalid_package 语义）',()=>{
  const good={version:'1.0.0',sha256:'a'.repeat(64)};
  for (const name of ['Bad','a_b','con','-x','',null,undefined,42]) {
    const result=validatePublishHeaders({...good,name});
    assert.equal(result.ok,false,JSON.stringify(name));
  }
  const base={name:'a-skill',sha256:'a'.repeat(64)};
  for (const version of ['1.0','1.0.0.0','01.0.0','v1.0.0','',null,undefined]) {
    const result=validatePublishHeaders({...base,version});
    assert.equal(result.ok,false,JSON.stringify(version));
  }
  const b={name:'a-skill',version:'1.0.0'};
  for (const sha256 of ['a'.repeat(63),'A'.repeat(64),'z'.repeat(64),'',null,undefined,'g'.repeat(64)]) {
    const result=validatePublishHeaders({...b,sha256});
    assert.equal(result.ok,false,JSON.stringify(sha256));
  }
});

test('validatePublishHeaders：X-Notes 解码后 ≤2000、控制字符拒绝、坏百分号编码拒绝',()=>{
  const base={name:'a-skill',version:'1.0.0',sha256:'a'.repeat(64)};
  assert.equal(validatePublishHeaders({...base,notes:encodeURIComponent('x'.repeat(NOTES_MAX_LENGTH))}).ok,true,'恰好 2000 放行');
  assert.equal(validatePublishHeaders({...base,notes:encodeURIComponent('x'.repeat(NOTES_MAX_LENGTH+1))}).ok,false,'2001 拒');
  assert.equal(validatePublishHeaders({...base,notes:encodeURIComponent('a\x1b[31mb')}).ok,false,'ANSI 转义拒');
  assert.equal(validatePublishHeaders({...base,notes:encodeURIComponent('a\rb')}).ok,false,'CR 拒（CONTROL 规则仅豁免 \\n \\t）');
  assert.equal(validatePublishHeaders({...base,notes:encodeURIComponent('第一行\n第二行\t缩进')}).ok,true,'换行/制表放行');
  assert.equal(validatePublishHeaders({...base,notes:'%ZZ'}).ok,false,'坏百分号编码拒');
});

test('validatePublishHeaders：X-Notes 拒绝零宽与方向控制符（bidi 欺骗，security L-5）',()=>{
  const base={name:'a-skill',version:'1.0.0',sha256:'a'.repeat(64)};
  for (const evil of ['a\u200bb','a\u202eb','a\u202ab','a\u2028b','a\u2029b','a\u2066b','a\u200fb']) {
    assert.equal(validatePublishHeaders({...base,notes:encodeURIComponent(evil)}).ok,false,JSON.stringify(evil));
  }
});

const streamOf=(bytes)=>new ReadableStream({
  start(controller){ for (const chunk of bytes) controller.enqueue(chunk); controller.close(); },
});

test('validateNotes：字符串通过、空串归一 null；非字符串/超长/控制字符（含 bidi）全拒（notes PUT 与 X-Notes 同源）',()=>{
  // 合法值：多行文本放行（CONTROL 仅豁免 \n \t）
  assert.deepEqual(validateNotes('修订说明：修复安装问题。\n第二行\t缩进'),
    {ok:true,notes:'修订说明：修复安装问题。\n第二行\t缩进'});
  assert.deepEqual(validateNotes(''),{ok:true,notes:null},'空串归一 null（清空说明与不带说明等价）');
  assert.equal(validateNotes('x'.repeat(NOTES_MAX_LENGTH)).ok,true,'恰好 2000 放行');
  // 值必须是字符串（body {notes: null/42/对象} 都拒——清空用空串）
  for (const bad of [null,undefined,42,true,{},['x']]) assert.equal(validateNotes(bad).ok,false,JSON.stringify(bad));
  // 超长（与 X-Notes 同为解码后口径）
  assert.equal(validateNotes('x'.repeat(NOTES_MAX_LENGTH+1)).ok,false,'2001 拒');
  // 控制字符与 bidi 全套（CONTROL 同源）：ANSI 转义 / CR / 零宽 / 方向覆盖 / 行分隔 / 隔离符
  for (const evil of ['a\x1b[31mb','a\rb','a\u200bb','a\u202eb','a\u202ab','a\u2028b','a\u2029b','a\u2066b','a\u200fb'])
    assert.equal(validateNotes(evil).ok,false,JSON.stringify(evil));
});

test('readPackageBody：合法 gzip 流 → 字节与 sha256；魔数 1f 8b 强制',async()=>{
  const body=gzipSync(Buffer.from('skill package payload'));
  const read=await readPackageBody(streamOf([body.subarray(0,5),body.subarray(5)]));
  assert.equal(read.ok,true);
  assert.equal(read.bytes.length,body.length);
  assert.equal(read.sha256,sha256Of(body));

  const notGzip=await readPackageBody(streamOf([Buffer.from('plain text archive')]));
  assert.equal(notGzip.ok,false);
  assert.equal(notGzip.error,'invalid_package');
  assert.match(notGzip.message,/gzip/);

  const empty=await readPackageBody(streamOf([]));
  assert.equal(empty.ok,false);
  assert.equal(empty.error,'invalid_package');

  const tiny=await readPackageBody(streamOf([Buffer.from([0x1f])]));
  assert.equal(tiny.ok,false,'单字节体过不了魔数');
  assert.equal(tiny.error,'invalid_package');
});

test('readPackageBody：累计字节超 4MB 即 413 too_large（无 Content-Length 的流式路径）',async()=>{
  const head=gzipSync(Buffer.from('x')); // 带 gzip 魔数的合法头，让管道走到尺寸检查
  const filler=Buffer.alloc(1024*1024,7); // 1MB 分片 ×4 + 头部 > 4MB
  const read=await readPackageBody(streamOf([head,filler,filler,filler,filler]));
  assert.equal(read.ok,false);
  assert.equal(read.error,'too_large');
  assert.equal(MAX_PACKAGE_BYTES,4*1024*1024);
  // 恰好 4MB 放行（边界值）
  const exact=await readPackageBody(streamOf([gzipSync(Buffer.alloc(MAX_PACKAGE_BYTES-64).subarray())]));
  assert.equal(exact.ok,true,'恰好 4MB 的 gzip 流放行');
});

test('latestOf：最高未 yank 优先；全部 yank 时回落最高版本占位（任务 7 语义的纯逻辑基座）',()=>{
  const history=[
    {version:'1.2.0',yanked:true},
    {version:'1.10.0',yanked:false},
    {version:'1.9.0',yanked:false},
  ];
  assert.equal(latestOf(history),'1.10.0');
  const allYanked=history.map((item)=>({...item,yanked:true}));
  assert.equal(latestOf(allYanked),'1.10.0','全部下架 → 最高版本占位');
  assert.equal(latestOf([{version:'0.1.0',yanked:false}]),'0.1.0');
  assert.equal(latestOf([]),null);
});

test('versionsPayload：history 降序（published_at desc，同刻按 version desc）、latest/sha256/download_url 指向最新',()=>{
  const t0='2026-10-18T08:00:00.000Z',t1='2026-10-18T09:00:00.000Z';
  const rows=[
    {skill:'demo-skill',version:'0.1.0',sha256:'0'.repeat(64),notes:'首发',yanked:false,published_at:new Date(t0)},
    {skill:'demo-skill',version:'2.0.0',sha256:'2'.repeat(64),notes:'跳版',yanked:false,published_at:new Date(t1)},
    {skill:'demo-skill',version:'1.5.0',sha256:'1'.repeat(64),notes:null,yanked:false,published_at:new Date(t1)}, // 同刻 → version desc 排在 2.0.0 后
  ];
  const skills=versionsPayload(rows,['demo-skill','demo-pro'],(skill,version)=>`https://x/api/store/download/${skill}?version=${version}&format=tar.gz`);
  assert.deepEqual(skills['demo-skill'].history.map((item)=>item.version),['2.0.0','1.5.0','0.1.0']);
  assert.equal(skills['demo-skill'].latest,'2.0.0');
  assert.equal(skills['demo-skill'].sha256,'2'.repeat(64));
  assert.equal(skills['demo-skill'].download_url,'https://x/api/store/download/demo-skill?version=2.0.0&format=tar.gz');
  assert.equal(skills['demo-skill'].history[2].notes,'首发');
  assert.equal(skills['demo-skill'].history[2].published_at,t0,'published_at 输出 ISO 字符串');
  // yanked 条目带标记（任务 7 消费；此处钉住形状）
  const flagged=versionsPayload([{skill:'y-skill',version:'1.0.0',sha256:'y'.repeat(64),notes:null,yanked:true,published_at:new Date(t0)}],[],()=>'u');
  assert.deepEqual(flagged['y-skill'].history,[{version:'1.0.0',published_at:t0,notes:null,yanked:true}]);
  assert.equal(flagged['y-skill'].latest,'1.0.0');
});

test('versionsPayload：孤儿版本可见（不在 catalog 也有条目）；catalog 未发布名字占位 {latest 0.0.0, history []}',()=>{
  const t0='2026-10-18T08:00:00.000Z';
  const skills=versionsPayload(
    [{skill:'orphan-skill',version:'1.0.0',sha256:'a'.repeat(64),notes:null,yanked:false,published_at:new Date(t0)}],
    ['registered-free','registered-pro'],
    ()=>'https://x/d',
  );
  assert.equal(skills['orphan-skill'].latest,'1.0.0','孤儿条目进 versions（CLI product 预检 known 依赖）');
  assert.deepEqual(skills['registered-free'],{latest:'0.0.0',history:[]});
  assert.deepEqual(skills['registered-pro'],{latest:'0.0.0',history:[]});
});

test('downloadUrlFor：/api/store/download/<skill>?version=<v>&format=tar.gz',()=>{
  assert.equal(downloadUrlFor('https://skills.huanyu.dev','demo-skill','1.0.0'),
    'https://skills.huanyu.dev/api/store/download/demo-skill?version=1.0.0&format=tar.gz');
});

// —— Blob 门面（lib/blob.mjs，环境双态同 lib/email.mjs 模式）——

async function withBlobEnv(env,fn){
  const saved={BLOB_READ_WRITE_TOKEN:process.env.BLOB_READ_WRITE_TOKEN,NODE_ENV:process.env.NODE_ENV,FAKE_BLOB_DIR:process.env.FAKE_BLOB_DIR};
  const scratch=mkdtempSync(path.join(tmpdir(),'huanyu-blob-test-'));
  try{
    delete process.env.BLOB_READ_WRITE_TOKEN;
    process.env.NODE_ENV='test';
    process.env.FAKE_BLOB_DIR=scratch;
    Object.assign(process.env,env);
    return await fn(scratch);
  } finally {
    for (const [key,value] of Object.entries(saved)){
      if (value===undefined) delete process.env[key];
      else process.env[key]=value;
    }
    rmSync(scratch,{recursive:true,force:true});
  }
}

test('假存储：put 落盘内容哈希一致，键形 releases/<skill>/<version>-<随机后缀>.tar.gz',async()=>{
  await withBlobEnv({},async(scratch)=>{
    const body=gzipSync(Buffer.from('blob payload'));
    const {path:key,url}=await blobStore().put('demo-skill','1.0.0',body);
    assert.match(key,/^releases\/demo-skill\/1\.0\.0-[0-9a-f]{8,}\.tar\.gz$/,'随机后缀防猜');
    const file=path.join(scratch,...key.split('/'));
    assert.ok(existsSync(file),'文件落盘 FAKE_BLOB_DIR');
    assert.equal(sha256Of(readFileSync(file)),sha256Of(body),'落盘内容与上传字节逐位一致');
    assert.equal(url,file,'url 返回本地可读路径');
    // 同 (skill,version) 重 put 落新键不覆盖旧对象（幂等由 (skill,version) 409 把关，不靠覆盖写）
    const again=await blobStore().put('demo-skill','1.0.0',body);
    assert.notEqual(again.path,key);
  });
});

test('生产护栏：NODE_ENV=production 且无 BLOB_READ_WRITE_TOKEN → put 响亮失败',async()=>{
  await withBlobEnv({NODE_ENV:'production'},async()=>{
    await assert.rejects(()=>blobStore().put('a-skill','1.0.0',Buffer.alloc(16)),
      /生产环境未配置 BLOB_READ_WRITE_TOKEN/);
  });
});

test('配置 BLOB_READ_WRITE_TOKEN 时选真仓门面（不在本测试真调网络）',async()=>{
  await withBlobEnv({BLOB_READ_WRITE_TOKEN:'vercel_blob_rw_test'},()=>{
    const store=blobStore();
    assert.equal(typeof store.put,'function');
    assert.equal(typeof store.signedUrl,'function','签名 URL 能力留接口（任务 6 download 消费）');
  });
});

test('readPackageBody：魔数跨分片边界——首分片恰 1 字节 0x1f，次分片 0x8b 起',async()=>{
  const body=gzipSync(Buffer.from('split magic'));
  const read=await readPackageBody(streamOf([body.subarray(0,1),body.subarray(1)]));
  assert.equal(read.ok,true);
  assert.equal(read.sha256,sha256Of(body));
  const readOneByte=await readPackageBody(streamOf([body.subarray(0,1)]));
  assert.equal(readOneByte.ok,false,'单字节 0x1f 无法确认魔数，整包拒');
  const badSecond=await readPackageBody(streamOf([Buffer.from([0x1f]),Buffer.from([0x00,0x01])]));
  assert.equal(badSecond.ok,false);
  assert.equal(badSecond.error,'invalid_package');
  assert.match(badSecond.message,/gzip/);
});

test('版本数上限常量与判定（security M-1）：RELEASES_PER_SKILL_MAX=200，count≥200 即拒',()=>{
  assert.equal(RELEASES_PER_SKILL_MAX,200);
  assert.equal(isReleaseCountLimited(0),false);
  assert.equal(isReleaseCountLimited(199),false);
  assert.equal(isReleaseCountLimited(200),true);
  assert.equal(isReleaseCountLimited(5000),true);
});

// —— Blob 键自校验（security L-4）——

test('storageKey：skill/version 形状内部断言，非法入参抛错',()=>{
  assert.match(storageKey('demo-skill','1.0.0'),/^releases\/demo-skill\/1\.0\.0-[0-9a-f]{8,}\.tar\.gz$/);
  for (const skill of ['Bad','a/b','','con','..']) {
    assert.throws(()=>storageKey(skill,'1.0.0'),/skill/,JSON.stringify(skill));
  }
  for (const version of ['1.0','01.0.0','x','1.0.0/evil','']) {
    assert.throws(()=>storageKey('a-skill',version),/版本/,JSON.stringify(version));
  }
});

test('假存储的 put/signedUrl 拒绝不匹配键形状的对象键（security L-4 单测钉住）',async()=>{
  await withBlobEnv({},async()=>{
    const store=blobStore();
    // 末两项 = HIGH-1 实测复现的穿越形态：尾缀分支曾以 (\..+) 放行含 / 的后缀，resolve 后逃出 fakeRoot
    for (const key of ['evil/path.tar.gz','releases/a/../../etc/passwd','releases/A/1.0.0-x.tar.gz',
      'plain.txt','','releases/a/','releases/a/1.0.0-x.tar.gz/../../escape','releases/a/1.0.0-x.tgz',
      'releases/a/1.0.0.tar.gz./../../../../etc/passwd','releases/a/1.0.0.tar.gz.extra/../../escape']) {
      await assert.rejects(()=>store.signedUrl(key,{base:'http://127.0.0.1:9'}),/Blob 键/,JSON.stringify(key));
      await assert.rejects(()=>store.read(key),/Blob 键/,JSON.stringify(key));
    }
    // 缺 base 拒（回环 attest URL 无处可指）；合法键（随机后缀）与契约允许的多余尾缀形态放行
    await assert.rejects(()=>store.signedUrl('releases/a-skill/1.0.0-abcd1234.tar.gz'),/基址/);
    const signed=await store.signedUrl('releases/a-skill/1.0.0-abcd1234.tar.gz',{base:'http://127.0.0.1:9'});
    assert.match(signed,/^http:\/\/127\.0\.0\.1:9\/api\/store\/blob-attest\?key=releases%2Fa-skill%2F1\.0\.0-abcd1234\.tar\.gz&exp=\d+$/);
    assert.match(await store.signedUrl('releases/a-skill/1.0.0-abcd1234.tar.gz.extra',{base:'http://127.0.0.1:9'}),/1\.0\.0-abcd1234\.tar\.gz\.extra&exp=\d+$/,'尾缀形态 (\\.[^/]+) 放行');
  });
});

test('假存储的 signedUrl 为自指回环 attest URL，read 取回落盘字节（任务 6 免令牌路径）',async()=>{
  await withBlobEnv({},async()=>{
    const store=blobStore();
    const {path:key}=await store.put('demo-skill','1.0.0',Buffer.from('x'));
    const signed=await store.signedUrl(key,{base:'http://127.0.0.1:9'});
    assert.ok(signed.startsWith(`http://127.0.0.1:9/api/store/blob-attest?key=${encodeURIComponent(key)}&exp=`),'回环 attest URL 携带对象键');
    assert.ok(/^\d+$/.test(signed.split('exp=')[1]),'exp 为毫秒时刻');
    assert.deepEqual(await store.read(key),Buffer.from('x'),'read 私读与 put 落盘字节一致');
    await assert.rejects(()=>store.read('evil/key'),/Blob 键/,'read 同受键形状闸门');
  });
});
