"use client";
import { useEffect, useState, type FormEvent } from "react";

/** /cli：验证码登录页（无密码，新邮箱即注册）+ 已登录态下的设备码确认卡（hy login）。 */
export default function CliPage() {
 const [email,setEmail]=useState("");
 const [code,setCode]=useState("");
 const [stage,setStage]=useState<"email"|"code">("email");
 const [sessionEmail,setSessionEmail]=useState<string|null>(null);
 // 设备码预填：verification_uri_complete 以 ?code=<user_code> 带入（确认卡在 hydration 后才渲染，无 SSR 差异面）
 const [deviceCode,setDeviceCode]=useState(()=>{
  const fromUrl=typeof window==="undefined"?null:new URLSearchParams(window.location.search).get("code");
  return fromUrl?fromUrl.toUpperCase():"";
 });
 const [deviceResult,setDeviceResult]=useState<"approved"|"denied"|null>(null);
 const [error,setError]=useState<string|null>(null);
 const [busy,setBusy]=useState(false);

 // hydration：已有会话直接进入已登录态
 useEffect(()=>{
  fetch("/api/auth/session")
   .then(async(res)=>{if(res.ok) setSessionEmail((await res.json()).email);})
   .catch(()=>{});
 },[]);

 async function call(path:string,body:unknown):Promise<{ok:boolean;message?:string;email?:string;status?:string}>{
  setBusy(true);
  try{
   const res=await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
   const data=await res.json().catch(()=>null);
   return {ok:res.ok,...(data??{})};
  }catch{
   return {ok:false,message:"网络异常，请稍后重试"};
  }finally{
   setBusy(false);
  }
 }

 async function sendCode(e:FormEvent){
  e.preventDefault();
  setError(null);
  const result=await call("/api/auth/code",{email});
  if(result.ok) setStage("code");
  else setError(result.message||"发送失败，请稍后重试");
 }

 async function verify(e:FormEvent){
  e.preventDefault();
  setError(null);
  const result=await call("/api/auth/verify",{email,code});
  if(result.ok){
   setSessionEmail(result.email||email.trim().toLowerCase());
   setCode("");
   setStage("email");
  }else setError(result.message||"验证失败，请稍后重试");
 }

 async function logout(){
  setError(null);
  const result=await call("/api/auth/logout",{});
  if(result.ok){
   setSessionEmail(null);
   setDeviceResult(null);
   setStage("email");
   setCode("");
  }else setError(result.message||"退出失败，请稍后重试");
 }

 async function decideDevice(approve:boolean){
  setError(null);
  const result=await call("/api/cli/approve",{user_code:deviceCode,approve});
  if(result.ok) setDeviceResult(approve?"approved":"denied");
  else setError(result.message||"操作失败，请稍后重试");
 }

 return <main className="cli-shell">
  <div className="cli-card">
   <div className="cli-topline"><span className="cli-seal">羽</span><span>焕羽 Skills / CLI</span></div>
   {sessionEmail?<>
    <h2>已登录。</h2>
    <p className="cli-email">{sessionEmail}</p>
    <div className="cli-device-slot">
     <h3>终端设备授权</h3>
     <p>核对终端（<code>hy login</code>）显示的设备码后确认授权。</p>
     {deviceResult?(deviceResult==="approved"
      ?<p>已授权，请回到终端继续登录。</p>
      :<p>已拒绝本次授权，终端将停止登录。</p>)
     :<form onSubmit={(e)=>{e.preventDefault();decideDevice(true);}}>
      <div className="cli-field"><label htmlFor="device-code">设备码（终端显示）</label>
       <input id="device-code" name="device-code" value={deviceCode}
        onChange={(e)=>setDeviceCode(e.target.value.toUpperCase())}
        autoCapitalize="characters" autoComplete="off" spellCheck={false}
        placeholder="XXXX-XXXX" disabled={busy} /></div>
      <button className="submit-button" type="submit" disabled={busy}><span>{busy?"提交中…":"确认授权"}</span><span>→</span></button>
      <button className="cli-link" type="button" onClick={()=>decideDevice(false)} disabled={busy}>拒绝授权</button>
     </form>}
    </div>
    <button className="submit-button" type="button" onClick={logout} disabled={busy}><span>{busy?"退出中…":"退出登录"}</span><span>→</span></button>
   </>:<>
    <h2>登录以管理 CLI 授权。</h2>
    <p className="cli-description">输入邮箱收取六位验证码，10 分钟内有效；新邮箱将自动注册，全程无需密码。</p>
    {stage==="email"?<form onSubmit={sendCode}>
     <div className="cli-field"><label htmlFor="email">邮箱地址</label>
      <input id="email" name="email" type="email" value={email} onChange={(e)=>setEmail(e.target.value)} required autoComplete="email" placeholder="you@example.com" disabled={busy} /></div>
     <button className="submit-button" type="submit" disabled={busy}><span>{busy?"发送中…":"发送验证码"}</span><span>→</span></button>
    </form>:<form onSubmit={verify}>
     <div className="cli-field"><label htmlFor="code">验证码（已发送至 {email.trim().toLowerCase()}）</label>
      <input id="code" name="code" value={code} onChange={(e)=>setCode(e.target.value)} inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required autoComplete="one-time-code" placeholder="6 位数字" disabled={busy} /></div>
      <button className="submit-button" type="submit" disabled={busy}><span>{busy?"登录中…":"登录"}</span><span>→</span></button>
      <button className="cli-link" type="button" onClick={()=>{setStage("email");setCode("");setError(null);}} disabled={busy}>换个邮箱</button>
    </form>}
   </>}
   {error&&<p className="cli-error" role="alert">{error}</p>}
  </div>
 </main>;
}
