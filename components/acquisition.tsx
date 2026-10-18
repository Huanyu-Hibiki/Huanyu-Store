"use client";
import { useState } from "react";
import { useAccount } from "./account";
export function Acquisition() {
 const [copied,setCopied]=useState(false); const {openAuth,notify}=useAccount();
 async function copy() {try {await navigator.clipboard.writeText("npx hy login --token <授权码>\nnpx hy install <skill>");setCopied(true);setTimeout(()=>setCopied(false),2500);notify("安装指令已复制","将占位符替换为你的授权码与技能名称后，在终端运行。");} catch {notify("复制未完成","请选中终端里的两行指令手动复制。");}}
 return <section className="acquisition license-edition" id="editions" aria-labelledby="edition-title"><div className="license-heading"><span>焕羽专业版</span><h2 id="edition-title">按需选择，统一管理。</h2><p>开源技能前往 GitHub 获取，专业授权在账户中管理与装配。</p></div><div className="license-body" id="installation"><a className="license-open-source" href="https://github.com/Huanyu-Hibiki/Huanyu-Skills" target="_blank" rel="noopener noreferrer"><span><svg aria-hidden="true"><use href="#github" /></svg>浏览开源 Skills</span><span aria-hidden="true">↗</span></a><button className="license-action" onClick={()=>openAuth("login")}>进入授权中心 <span>↗</span></button><details className="install-details"><summary>装配指南 <span>＋</span></summary><div className="purchase-command"><code>npx hy login --token &lt;授权码&gt;<br />npx hy install &lt;skill&gt;</code><button onClick={copy} aria-label={copied?"已复制命令":"复制安装命令"}>{copied?"已复制":"复制"}</button></div></details></div></section>;
}
