# 焕羽 Skills 商店服务端 API 设计文档

日期：2026-10-18
状态：已批准（分段设计 + grill-me 逐题压测落定，2026-10-18）
上游契约：`Huanyu-CLI/docs/designs/2026-10-15-huanyu-cli-design.md`「接口设计」节（双方共建依据）
部署事实：Vercel（https://skills.huanyu.dev），Next.js 16 App Router，当前仅前台页面

## 目标

在已部署的 Next.js 商店里实现 CLI 契约的服务端：登录（设备码）+ 发布（含商品注册/下架/说明修订）+ 免费版安装下载的全自助闭环。支付不接入（付费版只进目录不出售），checkout/portal/订阅权益二期。

## 用户场景

- **发布者（作者本人）**：`hy login`（浏览器确认设备码）→ `hy product` 注册商品 → `hy publish --repo <Huanyu-Skills> --all` 批量上传 → `hy unpublish`/notes 修订维护生命周期，全程 CLI 自助，不手工改库。
- **消费者**：`hy install <skill>` 拉目录、查版本、下载免费版 tar.gz（302 → 公开附件）、校验 sha256 安装。
- **商店访客/发布者**：`/cli` 页自带完整登录（邮箱 → Resend 验证码 → 确认 user_code）；前台账户弹窗一期保持演示态不动（grill-me Q3 拍板）。

## 技术方案

**方案 A：Next.js App Router route handlers + postgres.js 直写 SQL + @vercel/blob（私有仓）+ Resend 发信**（对比过 B Drizzle ORM / C 独立后端后选定：运行时依赖 `postgres` / `@vercel/blob` / `resend` 三个包；Neon Postgres 经 Vercel 一键接入，与已部署 Vercel 同体；`lib/` 纯模块可脱离运行时单测）。

约束与应对：

- **Vercel Functions 请求/响应体硬上限 4.5MB**（Fluid Compute 不放宽）→ publish 包上限定 4MB，属契约假设 #2「服务端定稿」的自由度；带令牌下载 200 直出同样受此保护（4MB < 4.5MB）。
- **Vercel Blob 私有存储 + 签名 URL 已 GA**（`issueSignedToken`）→ 单一私有仓：免费下载 302 → 短时签名 URL（CLI 无令牌时 `redirect: 'follow'`）；付费/孤儿包体由函数私读后 200 直出。无「公开仓」。
- **Next.js 16 有破坏性变更** → 实现前读 `node_modules/next/dist/docs/` 相关章节（仓库 AGENTS.md 要求）。
- 业务逻辑全部在 `lib/`（db / auth / device / store / http），路由是薄壳：参数校验 → 调 lib → 统一错误形状。

```
app/api/cli/device/route.ts        POST  设备码签发
app/api/cli/token/route.ts         POST  轮询换令牌
app/api/cli/approve/route.ts       POST  授权确认（Web 会话）
app/api/cli/logout/route.ts        POST  令牌撤销
app/api/auth/code/route.ts         POST  发送验证码（Resend）
app/api/auth/verify/route.ts       POST  校验验证码 → Web 会话（新邮箱即注册）
app/api/auth/logout/route.ts       POST  退出 Web 会话
app/api/auth/session/route.ts      GET   会话 hydration
app/api/auth/me/route.ts           GET 🔒 CLI 契约
app/api/store/publish/route.ts     POST 🔒 publisher
app/api/store/catalog/route.ts     GET
app/api/store/versions/route.ts    GET
app/api/store/download/[name]/route.ts  GET
app/api/store/products/[skill]/route.ts  PUT 🔒 publisher
app/api/store/releases/[skill]/[version]/route.ts        DELETE 🔒 publisher（yank）
app/api/store/releases/[skill]/[version]/notes/route.ts  PUT 🔒 publisher
app/cli/page.tsx                   设备码授权页（登录 → 显示 user_code → 确认/拒绝）
lib/db.ts lib/auth.ts lib/device.ts lib/email.ts lib/store.ts lib/http.ts
scripts/migrate.mjs + db/migrations/*.sql
```

## 数据模型

```sql
users(id uuid pk, email text unique not null, created_at timestamptz, last_login_at)
login_codes(email text, code_hash text, ip text, expires_at timestamptz, used_at, attempts int, created_at)
web_sessions(id uuid pk, user_id uuid fk, token_hash text unique, created_at, expires_at)
cli_tokens(id uuid pk, user_id uuid fk, token_hash text unique not null, created_at, last_used_at, revoked_at null)
device_grants(device_code_hash text pk, user_code text unique, user_id uuid null,
              status text check in ('pending','approved','denied'),
              interval_seconds int, expires_at timestamptz, created_at)
products(id text pk, name text not null, summary text, repo text, page text,
         free_skill text null unique, paid_skill text null unique,
         prices jsonb not null default '{}', created_at, updated_at)
releases(skill text, version text, sha256 char(64), size int, notes text null,
         blob_path text, yanked boolean default false, published_at timestamptz,
         pk(skill, version))
```

- 令牌、设备码与验证码**只存 sha256 哈希**；`hy_` 令牌 = `hy_` + 32B urlsafe 随机。
- releases.skill 的合法性（必须是某商品的 free_skill/paid_skill）由应用层校验（跨两列无法复合外键）；允许「先 publish 后 product 注册」的孤儿版本存在——CLI 只按 catalog 里的名字取 versions，孤儿条目对其不可见。
- 二期预留（本期不建表）：subscriptions、checkout_sessions。

## 接口设计（对齐 CLI 契约，字段名逐字一致）

**设备码登录**
- `POST /api/cli/device`，体 `{client_name, platform, lang?}` → `{device_code, user_code, verification_uri, verification_uri_complete, expires_in: 600, interval: 5}`。`expires_in`/`interval` 单位**秒**（CLI 换算 ms）。verification_uri = `https://skills.huanyu.dev/cli`；complete 带验证过的 user_code。device_code 落库存哈希。
- `POST /api/cli/token`，体 `{device_code}` → 批准后 `{token, email}`；未批准/拒绝/过期/过快分别 400 `{error: 'authorization_pending' | 'access_denied' | 'expired_token' | 'slow_down'}`（CLI 收 slow_down 自动 interval += 5s）。
- `POST /api/cli/approve`（Web 会话 + user_code）→ 置 approved/denied。

**账号**
- `GET /api/auth/me` 🔒 → `{email, subscriptions: [], publisher: <邮箱 ∈ PUBLISHER_EMAILS>}`；令牌按哈希查、撤销/未知 → 401。
- `POST /api/cli/logout` 🔒 → 撤销当前令牌，幂等 200 `{revoked: true}`。
- Web 端 code/verify/logout/session（**无密码**，grill-me Q2 拍板）：输邮箱 → `POST /api/auth/code` 经 Resend 从 `noreply@skills.huanyu.dev` 发 6 位验证码（10 分钟 TTL，哈希落库，单码尝试上限 5 次）；`POST /api/auth/verify` 通过即注册或登录，发 httpOnly+secure+lax cookie（30 天）。发信限频走 DB 计数（每邮箱 5 封/小时、每 IP 20 封/小时）——serverless 无共享内存的替代。发信域名 `skills.huanyu.dev` 在 Resend 验证、Cloudflare 加 SPF/DKIM（建议加 DMARC）。

**发布端**
- `POST /api/store/publish` 🔒 publisher，体 = tar.gz 二进制，头 `X-Skill-Name`/`X-Skill-Version`/`X-Content-SHA256`/可选 `X-Notes`（百分号编码 ≤2000 字符）。管道：鉴权（403 `not_a_publisher`）→ 名称/semver/sha 格式校验（400 `invalid_package`）→ 尺寸 ≤4MB（413 `too_large`）→ 流式 sha256 与头比对 + gzip 魔数（400 `invalid_package`）→ (skill,version) 已存在 409 `version_exists`；低于 latest 409 `version_regression` → Blob 上传（私有仓）→ 插库 → `{skill, version, sha256, size, url}`。幂等按 (skill,version) 唯一拒绝，不比对历史 sha（跨机器重打包字节不同得 409 属契约预期）。
- `PUT /api/store/products/<skill>` 🔒 publisher：按 skill（= free 或 paid 规范名）合并更新 name/summary/repo/page/free/paid/prices，响应完整商品对象（catalog 形状）。删除方案/清空 summary 的语义二期评审（CLI 当前只能合并更新）。
- `DELETE /api/store/releases/<skill>/<version>` 🔒 publisher：置 `yanked=true`，幂等 200 `{skill, version, yanked: true}`。
- `PUT /api/store/releases/<skill>/<version>/notes` 🔒 publisher：体 `{notes}` → 更新说明。

**消费端**
- `GET /api/store/catalog` → `{products: [...]}`（契约容错数组/`{products}`/`{catalog}`，服务端固定 `{products}`）。
- `GET /api/store/versions` → `{skills: {<name>: {latest, history: [{version, published_at, notes, yanked?}], sha256, download_url}}}`；history 版本降序；`latest` = 最高未 yank 版本，全部下架时保留最高版本占位（形状完整 + 全 yanked，CLI 显示「全部版本已下架」）；sha256/download_url 指向 latest。
- `GET /api/store/download/<name>?version=&format=tar.gz` **重定向规则**：
  - 无 `Authorization` 头 + 免费版 → **302 → Blob 公开 URL**（此刻 CLI `redirect: 'follow'`）；
  - 带 `Authorization` 头（任何版本免费包）→ **绝不 302**（CLI 设了 `redirect: 'error'`），200 直出流 + `X-Content-SHA256` + `X-Skill-Version`；
  - 付费版 → 402 `inactive`（一期无购买通道）；
  - 未知 skill / yanked 目标 / 全部下架 → 404；version 缺省取 latest 未 yank；format 非 tar.gz → 400。
- 除上述免费下载 302 外，一切 API 不重定向（契约铁律）。

**错误形状**：`{error: <code>, message}` JSON；401 统一 `unauthorized`；CLI 读 `data.message` 展示、`error` 透传到 details。

## 错误处理

- 令牌/设备码过期靠查询时比对 `expires_at`/`revoked_at`（惰性过期，无需定时任务）。
- 设备码轮询 5xx/网络抖动由 CLI 重试兜底；服务端保证 token 端点只回 200/400 族。
- Blob 上传失败 → 500，不落库（无悬挂元数据）；库插入失败而 Blob 已写 → 孤儿 blob 无害（按路径不可发现），重试覆盖写。
- 迁移脚本幂等（IF NOT EXISTS / 记录版本表）。

## 测试策略

- **单元（node:test，不依赖 DB/运行时）**：设备码状态机（pending/approved/denied/expired/slow_down）、验证码校验与发信限频、版本排序与 yank 回落/占位、catalog 契约映射、publish 管道校验（魔数/尺寸/semver/409 族）。Resend 不真发：`lib/email.ts` 定义发送接口，测试注入假发送器。
- **集成**：`next dev` + fetch 全流程（沿用 `verify-ui.mjs` 起 dev server 的模式）；DB 用独立测试库——CI 用 GitHub Actions postgres service container，本地 `DATABASE_URL` 指任意可达 PG。覆盖：验证码登录全流程、设备码授权全流程、发布→目录→版本→下载 302（签名 URL）/200（私读直出）双路径、yank 后 404 与占位。
- **真联调冒烟**：`HY_API=http://localhost:3000`（CLI 契约允许 localhost HTTP）跑真实 `hy` 的 login→product→publish→install 闭环。
- 既有 `npm run check`/`lint`/`test`/`test:ui` 全绿不回退。

## 假设清单（技术默认值，已显式标注、可推翻）

| # | 假设 | 默认值 | 何时可推翻 |
|---|------|--------|-----------|
| 1 | 基础设施 | **已确认（grill Q1）**：Neon Postgres（Vercel 一键接入）+ Vercel Blob 私有仓 + Resend 发信 + Cloudflare DNS | — |
| 2 | 包上限 | 4MB（契约「服务端定稿」自由度；Vercel 硬限 4.5MB） | 出现大素材 skill 时改预签名直传（需小改契约） |
| 3 | Web 认证 | **已确认（grill Q2）**：无密码验证码登录，Resend 从 `noreply@skills.huanyu.dev` 发信 | — |
| 4 | 发布者 | `PUBLISHER_EMAILS` 环境变量白名单（值为用户私人邮箱，配在 Vercel env，不落仓库） | 需要多人协作时 |
| 5 | 支付 | 完全不接；付费版进目录但 download 402 | 二期 |
| 6 | 包存储 | **已升级（事实查证）**：单一私有 Blob 仓；免费下载 302 → 短时签名 URL，付费/孤儿私读 200 直出（真私有，无随机后缀妥协） | — |
| 7 | 付费下载尺寸 | >4.5MB 无法经函数流式回传，届时需签名 URL 方案 | 二期 |
| 8 | 前台数据源 | **已确认（grill Q3）**：一期前台与账户弹窗保持演示态不动，登录走 `/cli` 页；营销页继续用 `lib/skills.ts` 静态数据，与 DB 目录一致性人工维护 | 二期统一 |
| 9 | Next.js 16 | 实现前读 `node_modules/next/dist/docs/`（破坏性变更） | 实现期 |
| 10 | 速率限制 | 令牌轮询/发信限频走 DB 计数；其余依赖平台防护 | 二期评估 |
| 11 | 注册开放 | 任何人可用真实邮箱注册（无发布权）；OTP + 限频防滥用 | 视滥用情况 |
| 12 | 付费包发布 | 允许发布（私有存储），下载恒 402 直到二期接支付 | 二期 |
| 13 | 过期数据 | 惰性过期（查询时比对），不做主动清理任务 | 数据量上来再加 cron |
| 14 | 发信域名 | `skills.huanyu.dev` 作为 Resend 发信域（DKIM 对该子域签名，声誉与根域隔离） | — |

## 契约评审清单对照（release-checklist 第 6 项，一期相关）

- 上传幂等跨机器字节差异：按 (skill,version) 唯一 409，不比对历史 sha ✅（与 CLI 假设 #1 一致）
- 版本单调性：拒绝重复（409 `version_exists`）与低于 latest（409 `version_regression`），允许跳版本 ✅
- yank 占位语义：history 保留 + 标记、latest 回落、全下架占位、下载 404 ✅
- 订阅到期翻转 / portal 控制字符剥离 / products PUT 删除语义：**二期项**，本期不实现（付费不出售、portal 不存在、products 仅合并更新）
