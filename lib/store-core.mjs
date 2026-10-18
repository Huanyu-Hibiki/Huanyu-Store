/** 商品注册/目录的纯逻辑（无 DB/运行时依赖），供 node:test 直接单测与 lib/store.ts 复用。
 *  契约基线 = CLI test/fixture.js 的 PUT products 参考实现（字段白名单/合并语义/配对冲突判定）；
 *  服务端在基线上收紧（CLI 端 parseProductFields 先行拦掉同类越界，收紧只作用于直连 API 的调用方，
 *  修改时不得以「对齐 CLI」为由回退收紧项）：repo/page 形状校验、price 键集闭合、interval 形状、
 *  严格类型与增长上限。 */
import { Buffer } from 'node:buffer';

// —— 增长上限（防误配/滥用撑爆行与目录载荷）：目录商品行数不设 sanity 上限（目录即商品本体）——
export const PRICE_PLAN_MAX_LENGTH=32; // 单个价格方案名长度
export const PRICE_PLANS_MAX=16;       // 价格方案数
export const PRICES_MAX_BYTES=16384;   // prices 序列化后总字节（16KB；形状上限合力下实际不可达，纵深防御）

// Windows 保留设备名不能作安装目录，CLI 全链拒绝，服务端同一规则收口
const RESERVED=/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const CANONICAL=/^[a-z0-9][a-z0-9-]*$/;
const PRICE_PLAN=/^[a-z][a-z0-9_-]*$/;
const PRICE_KEYS=new Set(['amount','currency','interval']);
const TEXT_MAX=500;
// 文本字段拒绝 C0/C1 控制字符与 ANSI 转义（\x1b 属 C0），仅豁免 \n\t——
// notes 将来复用同一规则（版本说明需要换行）
const CONTROL=/[\u0000-\u0008\u000b\u000c\u000d-\u001f\u007f-\u009f]/;
// page 与 CLI subscriptionUrl 同语义：站内绝对路径；绝对 URL/协议相对/javascript: 全拒
const PAGE_SHAPE=/^\/(?!\/)/;
const isHttpUrl=(value)=>{ try { const url=new URL(value); return url.protocol==='http:'||url.protocol==='https:'; } catch { return false; } };
// prices 方案：amount 为安全正整数分、currency 三字母（CLI 端 parseProductFields 同款）；
// interval 可选（买断 lifetime 无 interval，CLI 发 null）
const priceShape=(price)=>price&&typeof price==='object'&&!Array.isArray(price)
  &&Number.isSafeInteger(price.amount)&&price.amount>0
  &&typeof price.currency==='string'&&/^[a-z]{3}$/i.test(price.currency)
  &&(price.interval===undefined||price.interval===null
    ||(typeof price.interval==='string'&&price.interval.trim()&&price.interval.length<=24));

/** @param {unknown} value @returns {boolean} */
export function isCanonicalSkillName(value){
  return typeof value==='string'&&CANONICAL.test(value)&&!RESERVED.test(value);
}

/** @typedef {{skill:string}} SkillRef
 *  @typedef {{amount:number,currency:string,interval?:string|null}} Price
 *  @typedef {{id:string,name:string,summary:string,repo:string|null,page:string|null,
 *             free:SkillRef|null,paid:SkillRef|null,prices:Record<string,Price>}} Product
 *  @typedef {{ok:true,product:Product}} Applied
 *  @typedef {{ok:false,error:'invalid_field',message:string}} Rejected */

/** prices 方案表校验：形状（含键集闭合 ⊆ {amount,currency,interval}，未知键不透传落 jsonb）
 *  + 增长上限（方案名长/方案数/序列化字节）。 @param {unknown} value @returns {string|null} */
function pricesProblem(value){
  if (!value||typeof value!=='object'||Array.isArray(value)) return 'prices 无效。';
  const entries=Object.entries(value);
  if (entries.length>PRICE_PLANS_MAX) return 'prices 无效。';
  if (!entries.every(([plan,price])=>PRICE_PLAN.test(plan)&&plan.length<=PRICE_PLAN_MAX_LENGTH
    &&priceShape(price)&&Object.keys(price).every((key)=>PRICE_KEYS.has(key)))) return 'prices 无效。';
  if (Buffer.byteLength(JSON.stringify(value))>PRICES_MAX_BYTES) return 'prices 无效。';
  return null;
}

/** 字段白名单校验（name/summary 文本、repo http(s) URL、page 站内路径、free/paid 规范名、prices 方案表）。
 *  @param {Record<string,unknown>} fields @returns {string|null} */
function validateFields(fields){
  for (const [key,value] of Object.entries(fields)){
    if (key==='name'||key==='summary'){
      if (typeof value!=='string'||!value.trim()||value.length>TEXT_MAX||CONTROL.test(value)) return `${key} 无效。`;
    } else if (key==='repo'){
      if (typeof value!=='string'||!value.trim()||value.length>TEXT_MAX||CONTROL.test(value)||!isHttpUrl(value)) return 'repo 无效。';
    } else if (key==='page'){
      if (typeof value!=='string'||value.length>TEXT_MAX||CONTROL.test(value)||!PAGE_SHAPE.test(value)) return 'page 无效。';
    } else if (key==='free'||key==='paid'){
      if (!isCanonicalSkillName(value)) return `${key} 无效。`;
    } else if (key==='prices'){
      const problem=pricesProblem(value);
      if (problem) return problem;
    } else return `未知字段 ${key}。`;
  }
  return null;
}

/** 商品更新终审：定位语义由调用方完成（existing 已按 id/free/paid 命中或为 null=创建）。
 *  创建缺省与 CLI 参考服务一致：id 取 URL 规范名、name 兜底同名、free 指向自身；
 *  合并只动调用方提供的键，prices 按方案名合并（同方案覆盖）。
 *  @param {string} skill @param {unknown} fields @param {Product|null} existing @param {Product[]} others
 *  @returns {Applied|Rejected} */
export function applyProductUpdate(skill,fields,existing,others){
  const reject=(message)=>({ok:false,error:'invalid_field',message});
  if (!isCanonicalSkillName(skill)) return reject('Skill 名无效。');
  if (!fields||typeof fields!=='object'||Array.isArray(fields)) return reject('请求体须为 JSON 对象。');
  const invalid=validateFields(fields);
  if (invalid) return reject(invalid);
  const base=existing??{id:skill,name:skill,summary:'',repo:null,page:null,free:{skill},paid:null,prices:{}};
  const next={...base,
    ...(fields.name!==undefined?{name:fields.name}:{}),
    ...(fields.summary!==undefined?{summary:fields.summary}:{}),
    ...(fields.repo!==undefined?{repo:fields.repo}:{}),
    ...(fields.page!==undefined?{page:fields.page}:{}),
    ...(fields.free!==undefined?{free:{skill:fields.free}}:{}),
    ...(fields.paid!==undefined?{paid:{skill:fields.paid}}:{}),
    ...(fields.prices!==undefined?{prices:{...base.prices,...fields.prices}}:{})};
  // 上限终审判合并结果而非入参：既有方案 + 新增方案合力越限也在本单拦下
  const mergedProblem=pricesProblem(next.prices);
  if (mergedProblem) return reject(mergedProblem);
  if (next.free&&next.paid&&next.free.skill===next.paid.skill) return reject('free 与 paid 不能相同。');
  if (!next.free&&!next.paid) return reject('商品缺少 free/paid。');
  // 目录 skill 名全局唯一是 CLI normalizeCatalog 的契约：配对值不得属于其他商品（id/free/paid 任一命中即冲突）
  for (const skillName of [next.free?.skill,next.paid?.skill]){
    if (skillName&&others.some((item)=>[item.id,item.free?.skill,item.paid?.skill].includes(skillName)))
      return reject(`${skillName} 已属于其他商品。`);
  }
  return {ok:true,product:next};
}
