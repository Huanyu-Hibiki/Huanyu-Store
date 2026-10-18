import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "焕羽 Skills · 技能商店", description: "焕羽开发的 AI Agent Skills 商业化平台。浏览技能、查看交付示例，按需选择开源版本与专业授权。" };
export const viewport: Viewport = { themeColor: "#101110" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
 return <html lang="zh-CN"><head><link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" /><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Noto+Serif+SC:wght@400;500;600;700;900&display=swap" rel="stylesheet" /></head><body>{children}</body></html>;
}
