"use client";
import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { AccountProvider, useAccount } from "./account";
import { Catalog } from "./catalog";
import { Acquisition } from "./acquisition";

function StoreContent() {
 const { openAuth, modalOpen } = useAccount();
 const scope = useRef<HTMLDivElement>(null);
 useEffect(() => {
  gsap.registerPlugin(ScrollTrigger);
  const media = gsap.matchMedia();
  media.add("(prefers-reduced-motion: no-preference)", () => {
   gsap.from(".hero-type > *", { y:13, opacity:0, duration:.7, stagger:.09, ease:"power3.out", clearProps:"all" });
   gsap.from(".hero-art img", { scale:1.04, duration:1.2, ease:"power3.out" });
   gsap.to(".hero-art img", { y:60, scale:.9, opacity:.5, ease:"none", scrollTrigger:{trigger:".hero",start:"top top",end:"bottom top",scrub:true} });
   gsap.from(".skill-catalog", {y:15,duration:.45,scrollTrigger:{trigger:".skill-catalog",start:"top 93%",once:true},clearProps:"all"});
   gsap.from(".license-body", {y:12,duration:.4,scrollTrigger:{trigger:".acquisition",start:"top 93%",once:true},clearProps:"all"});
  }, scope);
  return () => media.revert();
 }, []);
 return <div ref={scope}>
  <svg className="svg-defs" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs>
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>
    <symbol id="github" viewBox="0 0 24 24"><path fill="currentColor" d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.64-1.25-1.64-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 .1.9 2.31 3.29 1.02.1-.73.39-1.23.71-1.51-2.5-.29-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.01-.12-.29-.5-1.43.11-2.97 0 0 .95-.31 3.08 1.15a10.68 10.68 0 0 1 5.6 0c2.14-1.46 3.08-1.15 3.08-1.15.61 1.54.23 2.68.11 2.97.72.78 1.16 1.78 1.16 3.01 0 4.32-2.63 5.27-5.14 5.55.4.35.76 1.03.76 2.08v3.02c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z"/></symbol>
    <symbol id="eye" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></symbol>
    <symbol id="lock" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="1"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/></symbol>
  </defs></svg>
<div className="paper-grain" aria-hidden="true" />
 <div className="page-frame" inert={modalOpen}>
    <header className="header">
      <a className="brand" href="#" aria-label="焕羽 Skills首页"><span className="brand-seal">焕<br />羽</span><span><b>焕羽 Skills</b><small>HUANYU SKILLS</small></span></a>
      <nav aria-label="主导航"><a className="nav-active" href="#skills">技能商店</a><a href="#installation">装配指南</a><a href="#philosophy">关于焕羽</a></nav>
      <div className="header-account"><button className="header-login" onClick={() => openAuth("login")}>登录</button><button className="header-auth" onClick={() => openAuth("register")}>注册 <span aria-hidden="true">↗</span></button></div>
    </header>

<main><section className="hero" aria-labelledby="hero-title"><div className="hero-type"><p className="byline">焕羽 Skills · AI Agent 技能商店</p><h1 id="hero-title">为工作，<br /><span>找到好技能。</span></h1><p className="hero-description">浏览焕羽开发的 AI Agent Skills。<br />查看交付示例，选择适合你的技能与授权。</p><div className="hero-actions"><a className="primary-action" href="#skills">浏览技能 <span>↓</span></a><a className="quiet-action" href="#editions">开源与专业版 <span>→</span></a></div></div><figure className="hero-art type-art"><img src="/assets/movable-type-hero.png" alt="墨黑活字字块的凸起字面、木纹与磨损边缘特写" width="1672" height="941" fetchPriority="high" /></figure></section>
<Catalog /><Acquisition /></main>    <footer id="philosophy"><a className="footer-brand" href="#">焕羽 Skills</a><span>© 2026 焕羽 · 独立开发与维护</span><button className="footer-open-source" onClick={() => openAuth("login")}>我的授权</button><a href="#" className="back-top" aria-label="回到顶部">↑</a></footer>
</div></div>;
}
export function Storefront() { return <AccountProvider><StoreContent /></AccountProvider>; }

