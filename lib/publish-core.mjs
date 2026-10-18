/** 版本发布的纯逻辑（无 DB/运行时依赖），供 node:test 直接单测与路由/lib/releases.ts 复用。
 *  契约基线 = CLI 端 src/skills.js isVersion（严格 semver，无前导零）与 test/fixture.js 的
 *  publish/versions 参考实现（错误语义、history/latest 形状）；服务端在基线上按设计收紧
 *  （4MB 上限、X-Notes 百分号解码与 CONTROL 规则）。 */
import { createHash } from 'node:crypto';
import { CONTROL, isCanonicalSkillName } from './store-core.mjs';

export const MAX_PACKAGE_BYTES=4*1024*1024; // 设计假设 #2：Vercel 请求体硬限 4.5MB 的安全余量
export const NOTES_MAX_LENGTH=2000;
// 每 skill 版本数上限（security M-1）：防 releases 行与 versions 载荷无界增长；
// versions 端点不加响应护栏（登记：目录规模受此上限与商品数自然约束）
export const RELEASES_PER_SKILL_MAX=200;

/** 写入端版本数闸门判定。 @param {number} count @returns {boolean} */
export function isReleaseCountLimited(count){
  return count>=RELEASES_PER_SKILL_MAX;
}
const SEMVER=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_HEX=/^[0-9a-f]{64}$/;
const GZIP_MAGIC=[0x1f,0x8b];

/** 语义化版本（CLI skills.js isVersion 同规则：三段、无前导零、无前后缀）。 @param {unknown} value */
export function isVersion(value){
  return typeof value==='string'&&SEMVER.test(value);
}

/** 语义化版本逐段比较（BigInt），与 CLI skills.js compare 同构（文本序在 0.10.0 vs 0.9.0 会判反）。
 *  @param {string} a @param {string} b @returns {-1|0|1} */
export function compareVersions(a,b){
  const aa=a.split('.').map(BigInt),bb=b.split('.').map(BigInt);
  for (let i=0;i<3;i++) if (aa[i]!==bb[i]) return aa[i]>bb[i]?1:-1;
  return 0;
}

/** @typedef {{ok:true,name:string,version:string,sha256:string,notes:string|null}} Headers
 *  @typedef {{ok:false,message:string}} HeaderProblem */

/** notes 值的共同约束（X-Notes 解码后与 notes PUT 同源）：≤2000 且不含控制字符
 *  （CONTROL 规则，豁免 \n\t）。返回 null 表示通过，否则返回问题片段（调用方拼前缀）。
 *  @param {string} value @returns {string|null} */
function notesProblem(value){
  if (value.length>NOTES_MAX_LENGTH) return `超过 ${NOTES_MAX_LENGTH} 字符。`;
  if (CONTROL.test(value)) return '含控制字符。';
  return null;
}

/** notes 修订终审（PUT /api/store/releases/<skill>/<version>/notes 的 body.notes）：
 *  值须为字符串并过共同约束；空串归一 null（清空说明与不带说明等价）。
 *  @param {unknown} value @returns {{ok:true,notes:string|null}|{ok:false,message:string}} */
export function validateNotes(value){
  if (typeof value!=='string') return {ok:false,message:'notes 须为字符串。'};
  const problem=notesProblem(value);
  if (problem) return {ok:false,message:`notes ${problem}`};
  return {ok:true,notes:value===''?null:value};
}

/** publish 头校验（管道最便宜的检查，先于读体）：规范名 / 严格 semver / 64 位小写 hex 摘要 /
 *  X-Notes 百分号解码后 ≤2000 且不含控制字符（任务 4 的 CONTROL 规则，豁免 \n\t）。
 *  @param {{name:unknown,version:unknown,sha256:unknown,notes?:unknown}} header
 *  @returns {Headers|HeaderProblem} */
export function validatePublishHeaders({name,version,sha256,notes}){
  if (!isCanonicalSkillName(name)) return {ok:false,message:'Skill 名无效。'};
  if (!isVersion(version)) return {ok:false,message:'版本号须为语义化版本（如 1.0.0）。'};
  if (typeof sha256!=='string'||!SHA256_HEX.test(sha256)) return {ok:false,message:'X-Content-SHA256 须为 64 位十六进制摘要。'};
  let decoded=null;
  if (typeof notes==='string'&&notes!==''){
    try { decoded=decodeURIComponent(notes); }
    catch { return {ok:false,message:'X-Notes 百分号编码无效。'}; }
    const problem=notesProblem(decoded);
    if (problem) return {ok:false,message:`X-Notes 解码后${problem}`};
    if (decoded==='') decoded=null;
  }
  return {ok:true,name,version,sha256,notes:decoded};
}

/** @typedef {{ok:true,bytes:Buffer,sha256:string}} ReadOk
 *  @typedef {{ok:false,error:'invalid_package'|'too_large',message:string}} ReadProblem */

// 拒绝后丢弃体的上限 = CLI 端打包上限（100MB）：合法超限包仍能收到干净的 413，
// 恶意无限流在此截断（cancel 会断连接，客户端表现为网络错误而非状态码——可接受的残余面）。
const DRAIN_CAP=100*1024*1024;

/** 读完并丢弃流内容（有界）：Handler 未消费完请求体就回响应会毒化 keep-alive 连接
 *  （后继复用该连接的请求悬挂到超时），早退路径必须先清空再回。 */
export async function drainBody(stream,capBytes=DRAIN_CAP){
  const reader=stream.getReader();
  let drained=0;
  try{
    for(;;){
      const {done,value}=await reader.read();
      if (done) return;
      drained+=value.byteLength;
      if (drained>capBytes) return; // 超上限交由 finally 的 cancel 截断
    }
  } finally {
    await reader.cancel().catch(()=>{});
  }
}

/** 流式读上传体：gzip 魔数 1f 8b（首 2 字节）+ 累计字节 ≤4MB + sha256。
 *  Content-Length 可早退的粗检在路由层；此处按实际读到的字节为准（分块上传无 Content-Length 时唯一防线）。
 *  命中拒绝后继续丢弃剩余体（有界），保持连接可复用再返回错误。
 *  读体上界 ≈ 4MB 有效载荷 + 拒绝后至多 100MB 丢弃（DRAIN_CAP），内存驻留仍 ≤4MB。
 *  @param {ReadableStream<Uint8Array>} stream @param {number} maxBytes
 *  @returns {Promise<ReadOk|ReadProblem>} */
export async function readPackageBody(stream,maxBytes=MAX_PACKAGE_BYTES){
  const reader=stream.getReader();
  const chunks=[];
  const hash=createHash('sha256');
  let total=0,magicSeen=false,prefix=Buffer.alloc(0),problem=null,drained=0;
  try{
    for(;;){
      const {done,value}=await reader.read();
      if (done) break;
      const chunk=Buffer.from(value);
      if (problem){
        drained+=chunk.length;
        if (drained>DRAIN_CAP) break;
        continue;
      }
      total+=chunk.length;
      if (total>maxBytes){ problem={ok:false,error:'too_large',message:'包超过 4MB 上限。'}; continue; }
      if (!magicSeen){
        // 分片可能不足 2 字节：攒到能判魔数为止
        prefix=Buffer.concat([prefix,chunk]);
        if (prefix.length>=GZIP_MAGIC.length){
          magicSeen=true;
          if (prefix[0]!==GZIP_MAGIC[0]||prefix[1]!==GZIP_MAGIC[1])
            problem={ok:false,error:'invalid_package',message:'上传内容不是有效的 gzip 包。'};
        }
      }
      if (problem) continue;
      hash.update(chunk);
      chunks.push(chunk);
    }
  } finally {
    await reader.cancel().catch(()=>{});
  }
  if (problem) return problem;
  if (total===0) return {ok:false,error:'invalid_package',message:'缺少上传内容。'};
  if (!magicSeen) return {ok:false,error:'invalid_package',message:'上传内容不是有效的 gzip 包。'};
  return {ok:true,bytes:Buffer.concat(chunks),sha256:hash.digest('hex')};
}

/** @typedef {{version:string,yanked?:boolean}} HistoryLike */

/** latest 计算：最高未 yank 版本；全部下架时保留最高版本占位（任务 7 的 yank 语义消费同一函数）。
 *  @param {HistoryLike[]} history @returns {string|null} */
export function latestOf(history){
  if (!history.length) return null;
  const standing=history.filter((item)=>!item.yanked);
  const pool=standing.length?standing:history;
  let best=pool[0].version;
  for (const item of pool) if (compareVersions(item.version,best)>0) best=item.version;
  return best;
}

/** @typedef {{skill:string,version:string,sha256:string,notes:string|null,yanked:boolean,published_at:Date|string}} ReleaseRow
 *  @typedef {{version:string,published_at:string,notes:string|null,yanked?:true}} HistoryEntry
 *  @typedef {{latest:string,history:HistoryEntry[],sha256?:string,download_url?:string}} SkillVersions */

/** versions 载荷组装：history 降序（published_at desc，同刻按 version desc）；latest/sha256/download_url
 *  指向同一版本；孤儿版本（不在 catalog）也有条目（CLI product 预检 known 依赖 versions[skill]）；
 *  catalog 内未发布的名字给 {latest:'0.0.0',history:[]} 占位（CLI versions() 对每个目录名字必查形状）。
 *  @param {ReleaseRow[]} rows @param {string[]} catalogNames
 *  @param {(skill:string,version:string)=>string} urlFor @returns {Record<string,SkillVersions>} */
export function versionsPayload(rows,catalogNames,urlFor){
  const groups=new Map();
  for (const row of rows){
    const list=groups.get(row.skill)??[];
    list.push(row);
    groups.set(row.skill,list);
  }
  const skills={};
  for (const [skill,group] of groups){
    const history=group
      .map((row)=>({version:row.version,published_at:new Date(row.published_at).toISOString(),
        notes:row.notes??null,...(row.yanked?{yanked:true}:{})}))
      .sort((a,b)=>{
        const byTime=new Date(b.published_at).getTime()-new Date(a.published_at).getTime();
        return byTime!==0?byTime:-compareVersions(a.version,b.version);
      });
    const latest=latestOf(history);
    const top=group.find((row)=>row.version===latest);
    skills[skill]={latest,history,sha256:top.sha256,download_url:urlFor(skill,latest)};
  }
  for (const name of catalogNames) if (!skills[name]) skills[name]={latest:'0.0.0',history:[]};
  return skills;
}

/** 任务 6 download 端点的访问入口（publish 响应 url 与 versions download_url 同一形状）。 */
export function downloadUrlFor(base,skill,version){
  return `${base}/api/store/download/${encodeURIComponent(skill)}?version=${encodeURIComponent(version)}&format=tar.gz`;
}
