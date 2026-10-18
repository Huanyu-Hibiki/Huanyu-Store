/** Blob 私有存储门面：真仓（@vercel/blob，access private）与假存储（FAKE_BLOB_DIR 落盘）同一形状。
 *  实现放 .mjs 供 node:test 直测（lib/email.mjs 先例）；download 端点经 signedUrl 取短时签名 URL
 *  （真仓 presigned / 假仓自指回环 attest URL）、经 read 私读字节（带令牌 200 直出）。 */
import { put as vercelPut, issueSignedToken, presignUrl } from '@vercel/blob';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isCanonicalSkillName } from './store-core.mjs';
import { isVersion } from './publish-core.mjs';

// 对象键闭合形状（security L-4）：假存储把它当文件路径 join，真仓签名也以它为口径——
// 三段式且第三段不含路径分隔符，路径逃逸（../）与可执行伪装在此拦下（.tar.gz 后允许 (\..+)? 尾缀）
const BLOB_KEY=/^releases\/[a-z0-9-]+\/[A-Za-z0-9.+-]+\.tar\.gz(\..+)?$/;
function assertBlobKey(key){
  if (typeof key!=='string'||!BLOB_KEY.test(key)) throw new Error(`非法 Blob 键：${key}`);
}

/** 存储键：releases/<skill>/<version>-<随机后缀>.tar.gz——随机后缀防猜（私有仓访问控制之外的纵深防御）。
 *  skill/version 形状在此内部断言（上游已校验过，这是落盘/落仓前的最后一道闸）。 */
export function storageKey(skill,version){
  if (!isCanonicalSkillName(skill)) throw new Error(`非法 skill 名：${skill}`);
  if (!isVersion(version)) throw new Error(`非法版本号：${version}`);
  return `releases/${skill}/${version}-${randomBytes(6).toString('hex')}.tar.gz`;
}

const fakeRoot=()=>process.env.FAKE_BLOB_DIR||path.join(tmpdir(),'huanyu-store-blob');

/** @param {string} skill @param {string} version @param {Buffer} body @returns {Promise<{path:string,url:string}>} */
async function realPut(skill,version,body){
  const key=storageKey(skill,version);
  assertBlobKey(key);
  const result=await vercelPut(key,body,{
    access:'private',contentType:'application/gzip',addRandomSuffix:false,token:process.env.BLOB_READ_WRITE_TOKEN,
  });
  return {path:result.pathname,url:result.url};
}

/** 私读入口（任务 6 download）：离线签发的短时 get URL，不经函数中转即不可匿名访问。
 *  TTL 15 分钟 ≥ 10 分钟（设计风险表：远超 CLI 120s 下载超时）。 */
export const SIGNED_URL_TTL_MS=15*60*1000;

async function realSignedUrl(key){
  assertBlobKey(key);
  const validUntil=Date.now()+SIGNED_URL_TTL_MS;
  const token=await issueSignedToken({token:process.env.BLOB_READ_WRITE_TOKEN,pathname:key,validUntil});
  const {presignedUrl}=await presignUrl(token,{operation:'get',pathname:key,validUntil});
  return presignedUrl;
}

/** 假存储：对象只落本地目录（无公开路由即私有），url 为本地可读路径。 */
async function fakePut(skill,version,body){
  const key=storageKey(skill,version);
  assertBlobKey(key);
  const file=path.join(fakeRoot(),...key.split('/'));
  await mkdir(path.dirname(file),{recursive:true});
  await writeFile(file,body);
  return {path:key,url:file};
}

/** 假仓「签名 URL」= 自指回环（任务 6）：指向本服务的 blob-attest 路径，可被真实 CLI 的
 *  redirect:'follow' 直接 fetch。不可猜性由对象键的随机后缀承担（storageKey 12 位 hex，
 *  等价 presigned URL 的 bearer 语义），新鲜度由 exp 强制；Next 按路由分别打包 lib、跨路由
 *  无共享模块状态，故不引入 HMAC 密钥（验证参数 = 键形状 + exp 窗口）。
 *  真仓 302 到 Vercel presigned URL，不经过 attest 路径——此 URL 仅本地开发/测试存在。 */
export function attestUrl(base,key,issuedAt=Date.now()){
  assertBlobKey(key);
  return `${base}/api/store/blob-attest?key=${encodeURIComponent(key)}&exp=${issuedAt+SIGNED_URL_TTL_MS}`;
}

/** blob-attest 入参校验：键形状闭合 + 未过期 + 有效期不高于签发 + TTL（防自报远未来 exp）。 */
export function verifyAttest(key,exp,now=Date.now()){
  if (typeof key!=='string'||!BLOB_KEY.test(key)) return false;
  const expiry=Number(exp);
  return Number.isSafeInteger(expiry)&&expiry>now&&expiry<=now+SIGNED_URL_TTL_MS+60_000;
}

const fakeSignedUrl=async (key,{base}={})=>{
  assertBlobKey(key);
  if (!base) throw new Error('假仓签名 URL 需要站点基址（siteBase）');
  return attestUrl(base,key);
};

async function fakeRead(key){
  assertBlobKey(key);
  return readFile(path.join(fakeRoot(),...key.split('/')));
}

/** 真仓私读（带令牌 200 直出）：经 presigned URL 取回字节，函数中转流式回传（≤4MB，设计假设 #7）。 */
async function realRead(key){
  const res=await fetch(await realSignedUrl(key));
  if (!res.ok) throw new Error(`Blob 读取失败（${res.status}）`);
  return Buffer.from(await res.arrayBuffer());
}

/** BLOB_READ_WRITE_TOKEN 有无双态（lib/email.mjs 模式）：无 token 且非生产走假存储；
 *  生产无 token 在首次使用时响亮失败（优于静默假成功）。 */
export function blobStore(){
  if (process.env.BLOB_READ_WRITE_TOKEN) return {put:realPut,signedUrl:realSignedUrl,read:realRead};
  if (process.env.NODE_ENV==='production')
    return {put:async()=>{throw new Error('生产环境未配置 BLOB_READ_WRITE_TOKEN：假 Blob 存储被禁用');},
      signedUrl:async()=>{throw new Error('生产环境未配置 BLOB_READ_WRITE_TOKEN：假 Blob 存储被禁用');},
      read:async()=>{throw new Error('生产环境未配置 BLOB_READ_WRITE_TOKEN：假 Blob 存储被禁用');}};
  return {put:fakePut,signedUrl:fakeSignedUrl,read:fakeRead};
}
