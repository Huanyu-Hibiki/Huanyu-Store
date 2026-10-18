# 焕羽 Skills 商店服务端 API 实施计划

日期：2026-10-18
设计依据：`docs/designs/2026-10-18-store-api-design.md`（已批准，grill-me 落定）
基线：`tsc --noEmit` 零错、`npm test` 3/3 绿（2026-10-18 实测）

## 总览

8 个 tracer-bullet 垂直切片，按「数据库基座 → 验证码登录 → 设备码/CLI 登录 → 商品与目录 → 版本发布 → 免费安装闭环 → 生命周期 → 联调上线」的依赖链串行推进。每个切片以「真实 CLI 或浏览器对 localhost 服务端完成一个端到端行为」为交付；契约字段名逐字对齐 CLI 端 `client.js`/`auth.js`。支付零接触（设计假设 #5/#12）。

## 前置准备

- [x] 设计文档已批准（grill-me 四题落定）
- [x] 基线测试通过（tsc 零错 + 3/3 绿）
- [ ] 实现前读 `node_modules/next/dist/docs/` 的 route handlers / dynamic route params / cookies 章节（仓库 AGENTS.md：Next.js 16 有破坏性变更）
- [ ] 环境密钥（Vercel + 本地 `.env`）：`DATABASE_URL`（Vercel 一键接入 Neon 后 `vercel env pull` 或手抄）；`BLOB_READ_WRITE_TOKEN`（建 Blob 私有仓，任务 5 前就绪即可）；`RESEND_API_KEY` + 发信域 `skills.huanyu.dev` DNS 验证（Resend 生成记录 → Cloudflare 粘贴；未就绪前用假发送器开发，不阻塞任务 2）；`PUBLISHER_EMAILS`（你的私人邮箱）
- [ ] 本地/CI 测试库：CI 用 GitHub Actions postgres service；本地 `TEST_DATABASE_URL` 指任意可达 PG（Neon 免费库即可）→ 本地已用 Docker postgres:16（容器 huanyu-store-pg，store/store_test 两库）

## 任务列表

### 任务 1: 数据库基座——迁移可执行、探针可查、测试骨架可起服务 ✅ 完成（210d8c7 + 审查修复 0eb80b6，2026-10-18）
- **交付**: 运维者对空库执行幂等迁移一次铺齐 7 张表（users/login_codes/web_sessions/cli_tokens/device_grants/products/releases + schema_migrations 版本表）；`GET /api/health` 返回数据库连通状态；集成测试骨架（起 dev server + 独立测试库 + 每用例清场）跑通第一条对探针的断言。
- **验收标准**:
  - [ ] 迁移脚本重复执行不报错（幂等）；带版本记录表
  - [ ] `/api/health` 无库连接时显式报错形状、有库时 200
  - [ ] 单元测试与集成测试并存于既有 `npm test`，全绿且不回退现有 3 条
  - [ ] 错误响应统一 `{error, message}` 形状（后续所有路由复用）
- **阻塞边**: 无
- **安全**: 否

### 任务 2: 验证码登录闭环——/cli 页输邮箱收码即登录 ✅ 完成（2026-10-18）
- **交付**: 访客在 `/cli` 页输入邮箱 → 收到 Resend 六位验证码（10 分钟 TTL）→ 输码获得 Web 会话；退出登录生效。新邮箱即注册，无需密码。
- **验收标准**:
  - [ ] 发码端点哈希落库、不回显验证码；单码尝试上限 5 次后作废
  - [ ] 限频生效：每邮箱 5 封/小时、每 IP 20 封/小时，超限 429 且错误形状统一
  - [ ] 会话 cookie httpOnly+secure+lax、30 天；session/logout 端点行为正确
  - [ ] 集成测试覆盖：收码（假发送器）→ 验证 → 会话 → 登出 → 会话失效
  - [ ] Resend 真发路径仅在配了密钥时启用；未配时假发送器，测试/本地开发两不误
- **阻塞边**: 任务 1
- **安全**: 是（认证·用户输入·密钥）

### 任务 3: 设备码授权——真实 `hy login` 对 localhost 完成 ✅ 完成（cce439b + 审查修复 1ecc0bf：签发限频/时钟统一/防钓鱼回显/POSIX 冒烟隔离，2026-10-18）
- **交付**: 发布者在终端跑真实 `hy login`（`HY_API=http://localhost:3000`）：CLI 拿到设备码 → 浏览器打开 `/cli` 确认页（已登录态下显示 user_code，确认/拒绝）→ CLI 轮询换到 `hy_` 令牌 → `me()` 返回 email/publisher。
- **验收标准**:
  - [ ] device 响应六字段齐全，`expires_in`=600/`interval`=5 单位秒
  - [ ] token 轮询错误族齐：authorization_pending/slow_down/access_denied/expired_token（400 + error 字段）；过期码清理后可重发
  - [ ] 令牌 sha256 落库；`/api/cli/logout` 撤销后 me() 401
  - [ ] `/api/auth/me` 形状逐字对齐 CLI 校验（email/subscriptions 空数组/publisher 布尔）；publisher = PUBLISHER_EMAILS 白名单判定
  - [ ] `/cli` 页未登录先走任务 2 登录流再回到确认页
  - [ ] 集成测试：全流程含拒绝分支与过期分支；真实 CLI 手工冒烟通过
- **阻塞边**: 任务 2
- **安全**: 是（认证·令牌）

### 任务 4: 商品注册与目录——`hy product` 注册后 catalog 公开可见 ✅ 完成（ddd3a2b + 审查修复 7261768：增长上限/字段收口/事务边界/竞态测试，2026-10-18。真实 hy product 完整注册依赖 /api/store/versions——CLI product 流程在 PUT 前必取版本表做 known 预检，该端点随任务 5 交付；冒烟已用断言钉住边界，任务 5 落地后翻转为退出 0）
- **交付**: 发布者用真实 `hy product` 注册/合并更新商品（名称/摘要/仓库/页面/免费与付费配对/定价），任何客户端 `GET /api/store/catalog` 立即看到契约形状的完整目录。
- **验收标准**:
  - [ ] 非 publisher 调用 403；未登录 401；无令牌 401
  - [ ] 商品校验：id/规范名（`^[a-z0-9][a-z0-9-]*$`）/free-paid 至少其一/重复 skill 名拒绝；prices 形状合法
  - [ ] 响应回完整商品对象，字段名经 CLI 端 normalizeCatalog 校验通过
  - [ ] catalog 无鉴权公开返回 `{products: [...]}`；空目录也返回空数组而非 404
  - [ ] 集成测试：注册 → 更新 → catalog 反映；非法字段 400
- **阻塞边**: 任务 3
- **安全**: 是（鉴权·用户输入）

### 任务 5: 版本发布——`hy publish` 全管道落私有 Blob，versions 可查 ✅ 完成（6ab545b + 审查修复 74cb45b：早退 drain/并发单调性 advisory lock/跨仓库契约闸门/版本数上限 200/SITE_ORIGIN/键自校验/bidi 拒绝，2026-10-18）
- **交付**: 发布者用真实 `hy publish` 上传 tar.gz：通过全部校验（gzip 魔数、≤4MB、流式 sha256 与头一致、semver、409 族）后落入私有 Blob 仓并插入版本记录；`GET /api/store/versions` 返回 latest/history。
- **验收标准**:
  - [ ] 错误语义齐：400 invalid_package（魔数/sha 不符/名字非法）、409 version_exists、409 低于 latest、413 too_large（>4MB，用 4.1MB 实测包验证）、403 not_a_publisher
  - [ ] 响应 `{skill, version, sha256, size, url}` 五字段逐字对齐 CLI publishResponse 校验
  - [ ] Blob 对象不可匿名直读（私有仓生效）
  - [ ] versions：`{skills: {name: {latest, history, sha256, download_url}}}`，history 降序、允许跳版本、拒绝回退
  - [ ] 集成测试：发布两个版本（含 X-Notes）→ versions 形状与排序正确；同版本重发 409
- **阻塞边**: 任务 4
- **安全**: 是（鉴权·上传内容校验）

### 任务 6: 免费版安装闭环——真实 `hy install` 装进本机 ✅ 完成（d07f8df + 审查修复 8d58eaf：blob-attest 路径穿越(HIGH)/attest 限频与统一404/匿名限频语义/键数上限/nosniff/read 包装，2026-10-18）
- **交付**: 消费者 `HY_API=http://localhost:3000 hy install <免费skill>` 端到端成功：CLI 打 download 端点 → 服务端 302 到短时签名 URL（无令牌）或 200 直出（带令牌）→ CLI 校验 sha256 → 装进本机宿主目录。
- **验收标准**:
  - [ ] 无 Authorization 免费请求 → 302 → 签名 URL（短 TTL），CLI `redirect: follow` 语义吻合
  - [ ] 带令牌请求绝不 302：200 直出 + `X-Content-SHA256` + `X-Skill-Version` 头
  - [ ] 付费 skill 请求 → 402 inactive（含 CLI 期待的 error 字段）；未知 skill/版本 → 404；format 非 tar.gz → 400
  - [ ] version 缺省取 latest 未 yank；指定历史版本可下
  - [ ] 真实 CLI 安装冒烟通过（含 sha256 校验与事务安装）
- **阻塞边**: 任务 5
- **安全**: 是（下载边界·付费闸门）

### 任务 7: 版本生命周期——yank 幂等下架、notes 修订、占位语义 ✅ 完成（ff62e38 + 审查修复 fd054ef：version_limit 文案/早退 drain+requirePublisher 收口/CONTROL 补漏/stopServer 等树退出（3 轮全量稳定）/参数预检，2026-10-18）
- **交付**: 发布者 `hy unpublish` 下架版本（重复下架仍 200）、`notes` PUT 修订说明；下架后新安装 404、versions 历史保留、全部下架时 latest 占位。
- **验收标准**:
  - [ ] yank 幂等（重复 DELETE 200 `{skill, version, yanked: true}`）；latest 回落到最高未下架版本
  - [ ] 全部下架：latest 保留最高版本占位 + 全 history 标记 yanked，下载 404（契约假设 #4 三条全落地）
  - [ ] notes 修订后 versions 响应立即反映；长度/编码校验（≤2000，百分号编码入参）
  - [ ] 集成测试：发布 3 版 → yank 中间版 → 下载 404/最新回落 → 全 yank → 占位
- **阻塞边**: 任务 6
- **安全**: 是（鉴权变更）

### 任务 8: 联调冒烟与上线收尾——生产域名全闭环
- **交付**: CI 六格矩阵绿（含 postgres service）；一条冒烟脚本跑完 login→product→publish→install→yank 全链路；Vercel 生产环境四密钥齐套后，真实 CLI 对 `https://skills.huanyu.dev` 完成发布与安装。
- **验收标准**:
  - [ ] CI：windows/macos/ubuntu × Node 20/22，单测 + 集成（service postgres + 测试库迁移 + 清场）全绿
  - [ ] 冒烟脚本进 `scripts/`，可重复执行（自建测试商品，跑完清理）
  - [ ] 生产验证：真实 `hy login`（真 Resend 收码）→ `hy product` → `hy publish` → 另一目录 `hy install` 成功
  - [ ] 文档收尾：README 服务端章节（端点/环境变量/迁移/冒烟）与 release-checklist 勾稽
- **阻塞边**: 任务 7
- **安全**: 否（运维收尾）

## 并行机会（frontier）

依赖链完全线性（1→2→3→4→5→6→7→8）：认证链与商店链共享令牌鉴权基座，无自然并行 frontier。若任务 5 实现中发现 publish 管道过大，可在其内部拆「校验管道」与「Blob 落仓」两片，前者不阻塞 versions 只读部分——按执行时实际体量决定。

## 风险 & 缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Next.js 16 API 与训练数据不一致 | 高 | 中 | 任务 1 前读 `node_modules/next/dist/docs/`；route handler 形状以文档为准 |
| Vercel 4.5MB 流式请求体实测偏差 | 中 | 高 | 任务 5 用 4.1MB 实测包验证 413 边界；若流式也被截，降上限到实测安全值（契约自由度内） |
| Neon serverless 冷启动延迟 | 中 | 低 | 用 postgres.js 直连 + 池化；探针路由先暴露延迟问题 |
| Resend 域名验证滞后 | 中 | 低 | 假发送器兜底开发（任务 2 验收已含）；上线前才需真发 |
| 签名 URL TTL 与 CLI 120s 下载超时不匹配 | 低 | 中 | TTL ≥ 10 分钟，远超单包下载时长 |
| 令牌/验证码哈希遗漏直出路径 | 低 | 高 | security-review 在任务 2/3/5 强制触发；输出遮盖自查 |
