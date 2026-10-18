"use client";
import { useState, useEffect } from "react";
import { skills } from "../lib/skills";
import { filterSkills, categoriesFor } from "../lib/catalog.mjs";
import { useAccount } from "./account";
export function Catalog() {
 const [query,setQuery]=useState(""); const [category,setCategory]=useState("全部");
 const [expanded,setExpanded]=useState(""); const [limit,setLimit]=useState(8);
 const [copied,setCopied]=useState(""); const { openSkill,notify }=useAccount();
 useEffect(() => {
  const requested = new URLSearchParams(location.search).get("preview");
  if (skills.some(skill => skill.listed && skill.id === requested)) {
   // URL-derived initial state is read after hydration to keep server markup stable.
   // eslint-disable-next-line react-hooks/set-state-in-effect
   setExpanded(requested!);
  }
 }, []);
 const filtered=filterSkills(skills,query,category); const categories=categoriesFor(skills);
 function reset() {setLimit(8);setExpanded("");}
 async function copy(id:string) {
  try { const output=document.querySelector(`[data-preview="${id}"]`) as HTMLElement; await navigator.clipboard.writeText(output.innerText);setCopied(id);setTimeout(()=>setCopied(current=>current===id?"":current),2500); }
  catch {notify("复制未完成","请选中交付稿中的文字，手动复制。");}
 }
 return <section className="skill-catalog store-catalog" id="skills" aria-labelledby="catalog-title">
 <header className="store-heading"><div><p>按需选择，投入工作。</p><h2 id="catalog-title">技能商店</h2></div><span className="store-count" role="status" aria-live="polite">{filtered.length} 项技能</span></header>
 <div className="store-toolbar"><div className="store-categories" role="group" aria-label="技能分类">{categories.map(option=><button key={option} aria-pressed={category===option} onClick={()=>{setCategory(option);reset();}}>{option}</button>)}</div><div className="store-search"><label htmlFor="skill-search">搜索技能</label><input id="skill-search" aria-label="搜索技能" type="search" value={query} onChange={e=>{setQuery(e.target.value);reset();}} placeholder="搜索名称、用途或关键词" autoComplete="off" /></div></div>
 <div className="store-products">{filtered.slice(0,limit).map(skill=><article className="store-product" key={skill.id}>
 <h3 className="product-heading"><button className="product-toggle" id={`product-toggle-${skill.id}`} aria-controls={`product-preview-${skill.id}`} aria-expanded={expanded===skill.id} onClick={()=>setExpanded(expanded===skill.id?"":skill.id)}><span className="product-name" data-glyph={skill.title.slice(0,1)}><span>{skill.title}</span><small>{skill.id}</small></span><span className="product-summary"><span>{skill.description}</span><small><span>{skill.category}</span><i aria-hidden="true">·</i><span>{skill.editions.join(" / ")}</span></small></span><span className="product-expander" aria-hidden="true">{expanded===skill.id?"−":"＋"}</span></button></h3>
 <div className="catalog-proof product-preview" id={`product-preview-${skill.id}`} aria-labelledby={`product-toggle-${skill.id}`} role="region" hidden={expanded!==skill.id}>
 <aside className="raw-copy"><span>{skill.preview.inputLabel}</span><p>{skill.preview.input}</p><small>{skill.preview.note}</small></aside><div className="proof-paper"><div data-preview={skill.id}><span className="paper-caption">{skill.preview.outputLabel}</span><h4>{skill.preview.title.join("\n")}</h4>{skill.preview.paragraphs.map((p,i)=><p key={i}>{p}</p>)}</div><div className="catalog-proof-actions"><button onClick={()=>openSkill(skill)}>版本与授权</button><button onClick={()=>copy(skill.id)}>{copied===skill.id?"已复制 ✓":"复制示例"}</button></div></div></div>
 </article>)}</div>
 {filtered.length===0&&<div className="store-empty"><h3>没有找到匹配的技能</h3><p>试试其他关键词，或清除分类筛选。</p><button onClick={()=>{setQuery("");setCategory("全部");reset();}}>清除搜索与筛选</button></div>}
 {limit<filtered.length&&<div className="store-pagination"><button onClick={()=>setLimit(limit+8)}>显示更多技能</button><span>已显示 {Math.min(limit,filtered.length)} / {filtered.length}</span></div>}
 </section>;
}
