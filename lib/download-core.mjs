/** 免费版下载的纯决策逻辑（无 DB/运行时依赖），供 node:test 直接单测与下载路由复用。
 *  契约基线 = CLI 端 src/install.js 的下载调用（route/version/format 拼法）与
 *  src/client.js 的 redirect 语义（无令牌 follow / 带令牌 error → 服务端对带令牌请求绝不 302）。 */
import { latestOf } from './publish-core.mjs';

/** 匿名下载限频（设计假设 #16 缓解）：内存滑动窗口 per-IP。serverless 多实例下各自计数，
 *  只能压低单实例放大率，best-effort（登记不改契约）。60 次/分钟远超一次正常安装的 1 次请求。 */
export const DOWNLOAD_WINDOW_MS=60_000;
export const DOWNLOAD_WINDOW_MAX=60;
// Map 键数上限（quality M3）：防伪造 x-forwarded-for 枚举撑爆内存；超限整窗重置——
// 放行一次瞬时突发后从零计数，与多实例 best-effort 同一量级的取舍（登记）
export const DOWNLOAD_MAP_KEY_MAX=10_000;

/** 滑动窗口判定：记录命中时刻，滑出窗口的旧记录逐条淘汰（非整窗清零的固定窗口）；
 *  滑空的键即时回收。拒绝路径不写回（数组长度已被放行路径封顶，重算无害）。
 *  @param {Map<string, number[]>} hits 调用方持有的共享状态（路由模块级单例）
 *  @param {string} key @param {number} now
 *  @param {{windowMs?:number,max?:number}} [limits] @returns {boolean} 是否放行 */
export function slidingWindowAllow(hits,key,now,{windowMs=DOWNLOAD_WINDOW_MS,max=DOWNLOAD_WINDOW_MAX}={}){
  if (hits.size>DOWNLOAD_MAP_KEY_MAX) hits.clear();
  const existing=hits.get(key);
  const fresh=(existing??[]).filter((at)=>now-at<windowMs);
  if (!fresh.length&&existing) hits.delete(key);
  if (fresh.length>=max) return false;
  fresh.push(now);
  hits.set(key,fresh);
  return true;
}

/** @typedef {{version:string,sha256:string,size:number,blob_path:string,yanked:boolean}} ReleaseRowLike
 *  @typedef {{ok:true,row:{version:string,sha256:string,size:number,blob_path:string}}} DownloadTarget
 *  @typedef {{ok:false,status:402|404,error:string,message:string}} DownloadRefusal */

/** 下载目标裁决（任务 6 重定向规则的命门）：付费（某商品 paid_skill）恒 402，与版本状态无关；
 *  未知（catalog 与 releases 都没有）404；缺省版本 = 最高未 yank（全部 yank 不回落占位，404）；
 *  指定版本必须存在且未 yank（任务 7 的 yank 语义在此预铺）。孤儿（不在 catalog）按免费放行。
 *  @param {{skill:string,version:string|null,rows:ReleaseRowLike[],paidSkills:Set<string>,catalogNames:Set<string>}} input
 *  @returns {DownloadTarget|DownloadRefusal} */
export function resolveDownload({skill,version,rows,paidSkills,catalogNames}){
  if (paidSkills.has(skill)) return {ok:false,status:402,error:'inactive',message:'该 Skill 需要有效订阅后安装。'};
  if (!rows.length&&!catalogNames.has(skill)) return {ok:false,status:404,error:'not_found',message:'未找到该 Skill。'};
  const standing=rows.filter((row)=>!row.yanked);
  const target=version==null
    ?(standing.length?latestOf(standing):null)
    :(standing.find((row)=>row.version===version)?.version??null);
  if (!target) return {ok:false,status:404,error:'not_found',message:'未找到可用版本。'};
  const row=standing.find((item)=>item.version===target);
  return {ok:true,row:{version:row.version,sha256:row.sha256,size:row.size,blob_path:row.blob_path}};
}
