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

## 服务端 API（CLI 商店后端）

前台页面与账户弹窗保持演示态（上文说明的是前台），服务端已另行实现 CLI 契约的完整闭环：验证码登录、设备码授权、商品注册、版本发布、免费下载与生命周期维护。业务逻辑在 `lib/`（`db` / `auth` / `device` / `email` / `store` / `http`），`app/api/` 路由是薄壳；错误响应统一 `{error, message}` 形状。

### 端点总表

| 方法与路径 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/health` | 公开 | 探针：库连通 200，连不通 503 `database_unavailable` |
| `POST /api/auth/code` | 公开（Origin 校验） | 发 6 位验证码（10 分钟 TTL，哈希落库）；限频每邮箱 5 封/时、每 IP 20 封/时 |
| `POST /api/auth/verify` | 公开（Origin 校验） | 校验验证码 → Web 会话 cookie（httpOnly，30 天）；新邮箱即注册 |
| `POST /api/auth/logout` | Web 会话 | 撤销会话并清 cookie，幂等 |
| `GET /api/auth/session` | Web 会话 | 会话 hydration：有会话回 `{email}`，否则 401 |
| `GET /api/auth/me` | 🔒 Bearer 令牌 | CLI 契约：`{email, subscriptions: [], publisher}` |
| `POST /api/cli/device` | 公开 | 设备码签发（六字段；`expires_in`/`interval` 单位秒）；限频每 IP 10 次/时 + 全局日预算 |
| `POST /api/cli/token` | 公开 | 轮询换令牌；错误族 `authorization_pending` / `slow_down` / `access_denied` / `expired_token` |
| `POST /api/cli/approve` | Web 会话 | `/cli` 确认页批准/拒绝设备授权 |
| `POST /api/cli/logout` | 🔒 Bearer 令牌 | 撤销当前 CLI 令牌，幂等 |
| `POST /api/store/publish` | 🔒 publisher | 上传 tar.gz（≤4MB；gzip 魔数 + sha256 头比对；409 `version_exists` / `version_regression` / `version_limit`） |
| `GET /api/store/catalog` | 公开 | 目录 `{products: [...]}`，注册后即时可见（no-store） |
| `GET /api/store/versions` | 公开 | 版本表 `{skills: {name: {latest, history, sha256, download_url}}}`；全下架占位 |
| `GET /api/store/download/[name]` | 公开 | 免费包：无令牌 302 → 短时签名 URL，带令牌 200 直出（`X-Content-SHA256`）；付费 402 `inactive`；限频 60 次/分/IP |
| `PUT /api/store/products/[skill]` | 🔒 publisher | 商品注册与合并更新（按 id/free/paid 命中定位），响应完整商品对象 |
| `DELETE /api/store/releases/[skill]/[version]` | 🔒 publisher | yank 下架（幂等 200 `{skill, version, yanked: true}`）；latest 回落最高未下架版 |
| `PUT /api/store/releases/[skill]/[version]/notes` | 🔒 publisher | 版本说明修订（≤2000 字符），versions 立即反映 |
| `GET /api/store/blob-attest` | 公开 | 仅本地/测试（假 Blob 仓）：回环附件路由；生产与配置真仓 token 时恒 404 |

🔒 Bearer 令牌 = `POST /api/cli/token` 颁发的 `hy_` 令牌；publisher = 邮箱命中 `PUBLISHER_EMAILS` 白名单。

### 环境变量

| 变量 | 读取处 | 作用 | 生产必配 | 本地默认 |
|---|---|---|---|---|
| `DATABASE_URL` | `lib/db.ts`（服务端连接）、`scripts/migrate.mjs`（迁移目标）、`scripts/smoke.mjs`（清理） | Postgres 连接串（Vercel 一键接入 Neon） | 是 | `postgres://postgres:dev@localhost:5432/store`（`.env.local`，Docker 容器 huanyu-store-pg） |
| `TEST_DATABASE_URL` | `tests/*.test.mjs`（集成测试起服务、清场与跳过判定） | 独立测试库；未设置时全部 DB 集成测试组自动跳过（CI 非 Linux 腿即此模式） | 否 | `.env.local` 指向 `store_test` 库 |
| `BLOB_READ_WRITE_TOKEN` | `lib/blob.mjs`、`app/api/store/blob-attest/route.ts`（生产关闭闸） | Vercel Blob 私有仓令牌；未配且非生产走假存储（`FAKE_BLOB_DIR` 落盘），生产未配首次使用响亮失败；配了即关闭 blob-attest 回环端点 | 是 | 不配（假存储） |
| `RESEND_API_KEY` | `lib/email.mjs` | Resend REST 发信密钥；未配且非生产走假发送器（控制台掩码摘要），生产未配响亮失败 | 是 | 不配（假发送器） |
| `PUBLISHER_EMAILS` | `lib/http.ts`（写路由鉴权）、`app/api/auth/me` | 发布者白名单，逗号分隔；决定 `me.publisher` 与 publish/products/yank/notes 权限 | 是 | 测试注入 `publisher@example.com`；冒烟脚本自起模式自动注入 |
| `SITE_ORIGIN` | `lib/http.ts`（siteBase） | 下发 URL（publish 响应、download_url、verification_uri）的规范源；未配回落 Host/x-forwarded 头 | 建议配 `https://skills.huanyu.dev` | 不配（回落请求 Host；假仓回环 attest 依赖此回落，测试与冒烟刻意不设） |
| `FAKE_MAIL_OUTBOX` | `lib/email.mjs`（假发送器） | 验证码邮件 JSONL 落盘路径，供集成测试/冒烟读码断言 | 否（生产禁用假发送器） | 测试/冒烟各自的临时目录 |
| `FAKE_BLOB_DIR` | `lib/blob.mjs`（假存储） | 假 Blob 仓根目录（缺省系统临时目录 `huanyu-store-blob`） | 否（生产禁用假存储） | 测试/冒烟各自的临时目录 |
| `HY_CLI_BIN` | `tests/{device,store,publish,download,lifecycle}.test.mjs` | 真实 CLI 冒烟的 `hy` 入口路径；探测不到该组跳过（CI 无 CLI 仓库不假红） | 否 | 缺省探测 `C:\Huanyu-Hibiki\coding\Huanyu-CLI\bin\hy.js` |
| `HY_CLI_SRC` | `tests/cli-contract.test.mjs` | 跨仓库 semver 契约闸门的 CLI `src/skills.js` 路径；探测不到跳过 | 否 | 缺省探测相邻 `../Huanyu-CLI` 目录 |

UI 回归的 `STORE_URL` 见上文「本地运行」。

### 迁移与测试

```sh
# 幂等迁移：按文件名顺序应用 db/migrations/*.sql 并记入 schema_migrations（重复执行无副作用）
node --env-file=.env.local scripts/migrate.mjs

npm run check        # tsc --noEmit
npm run lint         # eslint
npm test             # 单测 + 集成（--test-concurrency=1）；TEST_DATABASE_URL 未设时 DB 集成组自动跳过

# 端到端冒烟：自起 dev server（假发送器/假 Blob/发布者白名单由脚本注入），
# 跑 验证码登录 → 设备码换令牌 → 商品注册 → publish 两版 → catalog/versions 对账 →
# 匿名下载 302 跟随 sha256 对账 → yank 回落 → notes 修订，跑完直连库自清理（可重复执行）。
node --env-file=.env.local scripts/smoke.mjs
# 或指向已在跑的服务（须以假发送器启动且 PUBLISHER_EMAILS 含 smoke@example.com）：
node --env-file=.env.local scripts/smoke.mjs --base http://127.0.0.1:3000
```

CI（`.github/workflows/ci.yml`）：windows/macos/ubuntu × Node 20/22 六格矩阵。postgres service container 仅支持 Linux runner，只有 ubuntu 腿设 `TEST_DATABASE_URL` 跑全量（先迁移）；windows/macos 腿不设，DB 集成组按既有机制跳过，CLI 冒烟用例按 `HY_CLI_BIN` 探测跳过。

### 运维备忘

- **un-yank 手工恢复**（安全审查 L-4 登记的 runbook，API 无恢复端点）：误下架需恢复时直连库执行
  ```sql
  update releases set yanked = false where skill = '<skill>' and version = '<version>';
  ```
  恢复后 `versions` 的 latest 按版本号自然回升；该操作绕过 API 审计面，执行前核对目标行。
- **过期数据惰性清理**（设计假设 #13）：验证码/会话/令牌/设备码在查询时比对 `expires_at`/`revoked_at` 判定，无定时清理任务；`login_codes` 与 `device_grants` 的过期行由发码/签发路径顺带清扫，其余历史行自然累积，数据量上来再评估 cron。
- **presigned 15 分钟尾巴**（设计假设 #16）：匿名下载 302 的签名 URL TTL 15 分钟（远超 CLI 120s 下载超时）；下载限频（60 次/分/IP）只封「签发」，已签发 URL 在 TTL 内可重放取字节——出现带宽滥用时按登记口径收紧（TTL 下压或 Vercel WAF）。
