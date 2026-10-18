/** Shared catalogue rules, used by the React view and regression tests. */
/** @template {{listed:boolean,category:string,id:string,title:string,description:string,keywords?:string[]}} T @param {T[]} items @param {string} query @param {string} category @returns {T[]} */
export function filterSkills(items, query = "", category = "全部") {
 const normalized=query.trim().toLocaleLowerCase();
 return items.filter(item=>item.listed && (category==="全部" || item.category===category) && (!normalized || [item.id,item.title,item.description,item.category,...(item.keywords||[])].join(" ").toLocaleLowerCase().includes(normalized)));
}
/** @param {{listed:boolean,category:string}[]} items */
export function categoriesFor(items) {return ["全部",...new Set(items.filter(item=>item.listed).map(item=>item.category))];}
