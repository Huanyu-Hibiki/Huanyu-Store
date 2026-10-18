/** 商品注册/目录的纯逻辑（无 DB/运行时依赖），供 node:test 直接单测与 lib/store.ts 复用。
 *  契约对齐 CLI 端：规范名 = skills.js isSkillName（^[a-z0-9][a-z0-9-]*$ 且非 Windows 保留名）；
 *  字段白名单/合并语义/配对冲突判定 = CLI test/fixture.js 的 PUT products 参考实现。 */

// Windows 保留设备名不能作安装目录，CLI 全链拒绝，服务端同一规则收口
const RESERVED=/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const CANONICAL=/^[a-z0-9][a-z0-9-]*$/;
const PRICE_PLAN=/^[a-z][a-z0-9_-]*$/;
const TEXT_MAX=500;
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
 *  @typedef {{ok:false,error:'invalid_field',message:string}} Rejected
 *  字段白名单校验（name/summary/repo/page 文本、free/paid 规范名、prices 方案表）。 */
function validateFields(fields){
  for (const [key,value] of Object.entries(fields)){
    if (key==='name'||key==='summary'||key==='repo'||key==='page'){
      if (typeof value!=='string'||!value.trim()||value.length>TEXT_MAX) return `${key} 无效。`;
    } else if (key==='free'||key==='paid'){
      if (!isCanonicalSkillName(value)) return `${key} 无效。`;
    } else if (key==='prices'){
      if (!value||typeof value!=='object'||Array.isArray(value)
        ||!Object.entries(value).every(([plan,price])=>PRICE_PLAN.test(plan)&&priceShape(price))) return 'prices 无效。';
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
  if (next.free&&next.paid&&next.free.skill===next.paid.skill) return reject('free 与 paid 不能相同。');
  if (!next.free&&!next.paid) return reject('商品缺少 free/paid。');
  // 目录 skill 名全局唯一是 CLI normalizeCatalog 的契约：配对值不得属于其他商品（id/free/paid 任一命中即冲突）
  for (const skillName of [next.free?.skill,next.paid?.skill]){
    if (skillName&&others.some((item)=>[item.id,item.free?.skill,item.paid?.skill].includes(skillName)))
      return reject(`${skillName} 已属于其他商品。`);
  }
  return {ok:true,product:next};
}
