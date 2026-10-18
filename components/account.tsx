"use client";
import { createContext,useContext,useState,useEffect,useRef,useCallback,type ReactNode,type FormEvent } from "react";
import type { Skill } from "../lib/skills";
type Mode="login"|"register";
type Modal={kind:"auth"}|{kind:"skill";skill:Skill}|{kind:"legal";page:"terms"|"privacy";back:boolean}|null;
type Account={openAuth:(mode:Mode)=>void;openSkill:(skill:Skill)=>void;notify:(title:string,message:string)=>void;modalOpen:boolean};
const Context=createContext<Account|null>(null);
export function useAccount(){const value=useContext(Context);if(!value)throw new Error("AccountProvider required");return value;}
export function AccountProvider({children}:{children:ReactNode}){
 const [modal,setModal]=useState<Modal>(null),[mode,setMode]=useState<Mode>("login");
 const [email,setEmail]=useState(""),[password,setPassword]=useState(""),[nickname,setNickname]=useState("");
 const [remember,setRemember]=useState(false),[showPassword,setShowPassword]=useState(false);
 const [toast,setToast]=useState<{title:string;message:string}|null>(null);
 const timer=useRef<ReturnType<typeof setTimeout>|null>(null),returnFocus=useRef<HTMLElement|null>(null),dialog=useRef<HTMLDivElement>(null);
 const notify=useCallback((title:string,message:string)=>{if(timer.current)clearTimeout(timer.current);setToast({title,message});timer.current=setTimeout(()=>setToast(null),6500);},[]);
 function capture(){if(!modal)returnFocus.current=document.activeElement as HTMLElement;}
 function openAuth(next:Mode){capture();setMode(next);setShowPassword(false);setModal({kind:"auth"});}
 function openSkill(skill:Skill){if(!skill.listed)return;capture();setModal({kind:"skill",skill});}
 const close=useCallback(()=>{setModal(current=>current?.kind==="legal"&&current.back?{kind:"auth"}:null);},[]);
 // Browser storage and URL state are restored after hydration.
 /* eslint-disable react-hooks/set-state-in-effect */
 useEffect(()=>{
  try{const stored=localStorage.getItem("huanyu-remembered-email")||"";setEmail(stored);setRemember(!!stored);}catch{}
  const state=new URLSearchParams(location.search).get("state");
  if(state==="login"||state==="register"){setMode(state);setModal({kind:"auth"});}
  return ()=>{if(timer.current)clearTimeout(timer.current);};
 },[]);
 /* eslint-enable react-hooks/set-state-in-effect */
 useEffect(()=>{
  if(!modal){returnFocus.current?.focus();returnFocus.current=null;return;}
  const previous=document.body.style.overflow;document.body.style.overflow="hidden";dialog.current?.focus();
  function keydown(e:KeyboardEvent){
   if(e.key==="Escape"){e.preventDefault();close();}
   if(e.key!=="Tab")return;
   const items=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button,a[href],input,[tabindex="0"]')||[]).filter(el=>el.getClientRects().length && !el.hasAttribute("disabled") && el.tabIndex>=0);
   const first=items[0],last=items.at(-1);
   if(e.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){e.preventDefault();last?.focus();}
   else if(!e.shiftKey&&(document.activeElement===last||document.activeElement===dialog.current)){e.preventDefault();first?.focus();}
  }
  document.addEventListener("keydown",keydown);
  return()=>{document.body.style.overflow=previous;document.removeEventListener("keydown",keydown);};
 },[modal,close]);
 function submit(e:FormEvent){e.preventDefault();try{if(remember&&mode==="login")localStorage.setItem("huanyu-remembered-email",email);else localStorage.removeItem("huanyu-remembered-email");}catch{notify("无法记住邮箱","浏览器未允许本地存储，请检查浏览器设置。");return;}setPassword("");notify(mode==="login"?"登录交互已完成":"注册交互已完成","这是前台演示反馈，尚未连接账户与授权服务。");}
 function forgot(){const input=document.getElementById("email") as HTMLInputElement;if(!input.value||!input.checkValidity()){input.reportValidity();input.focus();return;}notify("找回密码","已验证邮箱格式；尚未接入密码重置邮件服务。");}
 function switchMode(next:Mode,focus=false){setMode(next);setShowPassword(false);if(focus)requestAnimationFrame(()=>document.getElementById(`tab-${next}`)?.focus());}
 return <Context.Provider value={{openAuth,openSkill,notify,modalOpen:!!modal}}>{children}
 {modal?.kind==="auth"&&<aside className="auth-column auth-overlay" onClick={e=>{if(e.target===e.currentTarget)close();}}><div className="auth-sticky" onClick={e=>{if(e.target===e.currentTarget)close();}}><div ref={dialog} className="auth-card corner-marks auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title" tabIndex={-1}>
 <button className="modal-close auth-close" onClick={close} aria-label="关闭登录窗口">×</button><div className="auth-topline"><span className="auth-seal">羽</span><span>焕羽 Skills / 账户</span></div><h2 id="auth-title">回到你的工作台。</h2><p className="auth-description">登录查看已购技能与终端授权码</p>
 <div className="auth-tabs" role="tablist" aria-label="账户操作" onKeyDown={e=>{if(e.key==="ArrowRight"||e.key==="ArrowLeft"){e.preventDefault();switchMode(mode==="login"?"register":"login",true);}}}><span className={`tab-indicator ${mode==="register"?"at-register":""}`} />{(["login","register"] as const).map(tab=><button key={tab} id={`tab-${tab}`} role="tab" aria-selected={mode===tab} tabIndex={mode===tab?0:-1} aria-controls="auth-panel" onClick={()=>switchMode(tab)}>{tab==="login"?"用户登录":"注册新账户"}</button>)}</div>
 <div id="auth-panel" role="tabpanel" aria-labelledby={`tab-${mode}`}>
 <form onSubmit={submit}>{mode==="register"&&<div className="form-field"><label htmlFor="nickname">如何称呼你</label><input id="nickname" name="nickname" value={nickname} onChange={e=>setNickname(e.target.value)} required autoComplete="nickname" maxLength={40} placeholder="你的名字" /></div>}
 <div className="form-field"><label htmlFor="email">邮箱地址</label><input id="email" name="email" value={email} onChange={e=>setEmail(e.target.value)} type="email" required autoComplete="email" placeholder="you@example.com" /></div>
 <div className="form-field"><div className="label-row"><label htmlFor="password">密码</label>{mode==="login"&&<button type="button" onClick={forgot}>忘记密码？</button>}</div><div className="password-wrap"><input id="password" name="password" value={password} onChange={e=>setPassword(e.target.value)} type={showPassword?"text":"password"} autoComplete={mode==="register"?"new-password":"current-password"} minLength={mode==="register"?8:1} required placeholder={mode==="register"?"设置至少 8 位密码":"输入你的密码"} /><button type="button" className="eye-button" onClick={()=>setShowPassword(!showPassword)} aria-label={showPassword?"隐藏密码":"显示密码"} aria-pressed={showPassword}><svg><use href="#eye" />{showPassword&&<path d="m3 3 18 18" />}</svg></button></div></div>
 {mode==="login"?<label className="remember"><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)} /><span>记住我的邮箱</span></label>:<p className="register-note">创建账户后，即可统一管理你的专业版技能。</p>}
 <button className="submit-button" type="submit"><span>{mode==="login"?"登录":"创建账户"}</span><span>→</span></button></form></div>
 <p className="terms">继续即同意<button onClick={()=>setModal({kind:"legal",page:"terms",back:true})}>服务条款</button><span>与</span><button onClick={()=>setModal({kind:"legal",page:"privacy",back:true})}>隐私政策</button></p>
 </div></div></aside>}
 {modal&&(modal.kind==="skill"||modal.kind==="legal")&&<div className="modal-overlay" onClick={e=>{if(e.target===e.currentTarget)close();}}><div ref={dialog} className="modal corner-marks" role="dialog" aria-modal="true" aria-labelledby={modal.kind==="skill"?"skill-dialog-title":"legal-dialog-title"} tabIndex={-1}><button className="modal-close" onClick={close} aria-label="关闭弹窗">×</button>
 {modal.kind==="skill"?<div><span className="modal-kicker">{modal.skill.category}</span><h2 id="skill-dialog-title">{modal.skill.title}</h2><h3>{modal.skill.id}</h3><p>{modal.skill.description}</p><div className="modal-versions">{modal.skill.editions.map(edition=><div key={edition}><b>{edition}</b><p>{edition==="开源基础版"?"核心方法，手动导入，自由使用。":"深度子技能、一键装配与终身升级。"}</p></div>)}</div><button className="submit-button" onClick={()=>openAuth("login")}>登录管理专业版授权 <span>→</span></button></div>:<div><span className="modal-kicker">焕羽 Skills</span><h2 id="legal-dialog-title">{modal.page==="terms"?"服务条款":"隐私政策"}</h2><p>{modal.page==="terms"?"当前为交互概念验证页面，未提供实际购买、账户注册或技能授权服务。正式交易与授权范围以平台上线后公布的协议为准。":"当前页面不会将邮箱或密码发送至服务器。密码不会持久化；仅在勾选“记住我的邮箱”时，将邮箱保存在此浏览器中。"}</p></div>}
 </div></div>}
 {toast&&<div className="toast" role="status" aria-live="polite"><span className="toast-mark">印</span><div><b>{toast.title}</b><p>{toast.message}</p></div><button onClick={()=>setToast(null)} aria-label="关闭通知">×</button></div>}
 </Context.Provider>;
}
