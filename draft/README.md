# 焕羽 Skills · 当前确认版本

这是用户确认保留的最新视觉版本。图片不变，所有技能使用统一的 + 原位展开；目录支持持续新增商品，不限定商品数量。

当前设计规范与交互说明见 [DESIGN.md](DESIGN.md)。

## 运行

在本目录执行 `npm run dev`，打开 http://127.0.0.1:3000/ 。也可从仓库根目录执行 `npm run dev`。

- index.html：页面与账户弹窗。
- styles.css：按原加载顺序合并的当前四份样式，未重排规则。
- app.js、skills.js：交互与商品目录。新增商品方法见 SKILLS-CATALOG.md。
- vendor/：Alpine.js、GSAP、ScrollTrigger。
- assets/：当前主图、参考来源和样式实际引用的字体及许可。
- tests/：商品目录验证。
- evidence/latest/：最新确认页面桌面、手机和底部入口截图。

底部「浏览开源 Skills」在新标签打开 https://github.com/Huanyu-Hibiki/Huanyu-Skills 。专业授权、登录、注册、支付和授权签发仍为前台演示，没有真实后端。

保留原有入场、滚动动效及减少动态效果支持。用户已接受当前视觉，后续按具体反馈调整，不再追逐评审分数。

验证：`npm run check`、`npm test`。
