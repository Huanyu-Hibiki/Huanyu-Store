# 焕羽 Skills 商店

基于 Next.js App Router、React、TypeScript 与 GSAP，还原 `draft/DESIGN.md` 确认的「金石雕版 × 高精工学」设计。保留活字原图、最终 CSS 级联、现有内容、响应式布局与原位商品预览。

## 本地运行

要求 Node.js >= 20.9。

```sh
npm install
npm run dev
```

默认访问 http://127.0.0.1:3000；端口占用时以终端显示为准。本次验证运行在 http://127.0.0.1:3001。

```sh
npm run check
npm run lint
npm test
npm run test:ui
```

UI 回归需要先启动开发服务，并安装 Microsoft Edge；默认测试 3001，可用 `STORE_URL` 指定地址。生产命令为 `npm run build`、`npm start`，本次未运行生产构建。

## 结构

- `app/`：App Router 页面、元数据、全局样式。
- `components/`：商店、目录、账户弹窗与获取入口。
- `lib/skills.ts`：Next.js 商品唯一数据源，新增条目无需增加商品专属模板。
- `lib/catalog.mjs`：分类与搜索规则，供页面和回归测试共用。
- `public/assets/`：原活字素材、字体及来源和许可记录。
- `draft/`：完整保留的设计原型和规范，使用 `npm run draft` 单独预览。
- `evidence/next/`：桌面/手机比对、展开与账户截图、交互报告。

支持分类、搜索、空状态、每批 8 项分页、互斥展开、版本详情、复制、账户表单、密码显隐、邮箱记忆、Esc 关闭、焦点约束和关闭后焦点返回。支持 `?preview=oracle-bone` 与 `?state=login` / `?state=register`。

账户、邮件、订单、支付、授权签发与 CLI 服务均未接入。表单不会发送密码或伪造真实登录成功；仅勾选记忆时保存邮箱。CLI 命令沿用原稿，未验证真实安装服务。商用权益文案仍需上线前核定。

实现遵循 [Next.js 官方 App Router 文档](https://nextjs.org/docs/app)。

账户入口仅提供邮箱登录与注册；已移除 GitHub 登录演示。开源仓库链接保留。
