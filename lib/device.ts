import { randomUUID } from "node:crypto";
import { sha256Hex } from "./auth-core.mjs";
import { getSql } from "./db";
import { DEVICE_INTERVAL_SECONDS, DEVICE_TTL_SECONDS, checkGrant, generateCliToken, generateDeviceCode, generateUserCode } from "./device-core.mjs";

export type PollError = "authorization_pending" | "slow_down" | "access_denied" | "expired_token";
export type PollResult = { ok: true; token: string; email: string } | { ok: false; error: PollError };

// checkGrant 域判定 → CLI 契约错误码（auth.js 逐字匹配）
const POLL_ERRORS = { expired: "expired_token", denied: "access_denied", pending: "authorization_pending", slow_down: "slow_down" } as const;

/** 签发设备码：device_code 只落哈希、user_code 明文（确认页要显示）。极小概率撞 user_code 唯一约束则重试。 */
export async function createDeviceGrant(): Promise<{ device_code: string; user_code: string; expires_in: number; interval: number }> {
  const sql = getSql();
  for (let attempt = 0; attempt < 3; attempt++) {
    const deviceCode = generateDeviceCode();
    const userCode = generateUserCode();
    const expiresAt = new Date(Date.now() + DEVICE_TTL_SECONDS * 1000);
    const [row] = await sql`
      insert into device_grants (device_code_hash, user_code, interval_seconds, expires_at)
      values (${sha256Hex(deviceCode)}, ${userCode}, ${DEVICE_INTERVAL_SECONDS}, ${expiresAt})
      on conflict do nothing
      returning user_code`;
    if (row) return { device_code: deviceCode, user_code: row.user_code, expires_in: DEVICE_TTL_SECONDS, interval: DEVICE_INTERVAL_SECONDS };
  }
  throw new Error("user_code 生成重试耗尽");
}

/** CLI 轮询换令牌。终态行（过期/已拒绝）惰性清理；一次批准恰发一枚令牌——
 *  消费 = 事务内对 approved 行 delete returning（并发后到者行已删，按 expired_token 回应）。
 *  只回 200/400 语义（5xx 绝不出现的契约由路由层兜住），错误码逐字对齐 CLI auth.js 的 400 错误族。 */
type GrantRow = { status: string; expires_at: Date; last_poll_at: Date | null; interval_seconds: number };

export async function pollDeviceToken(deviceCode: string): Promise<PollResult> {
  const sql = getSql();
  return sql.begin(async (tx) => {
    const hash = sha256Hex(deviceCode);
    const [grant] = await tx<GrantRow[]>`select status, expires_at, last_poll_at, interval_seconds
      from device_grants where device_code_hash = ${hash} for update`;
    if (!grant) return { ok: false, error: "expired_token" } as const; // 不存在（含已消费/已清理）
    const verdict = checkGrant(grant);
    if (verdict === "expired" || verdict === "denied") {
      await tx`delete from device_grants where device_code_hash = ${hash}`; // 惰性清理，user_code 可复用
      return { ok: false, error: POLL_ERRORS[verdict] } as const;
    }
    if (verdict === "pending" || verdict === "slow_down") {
      await tx`update device_grants set last_poll_at = now() where device_code_hash = ${hash}`;
      return { ok: false, error: POLL_ERRORS[verdict] } as const;
    }
    const [consumed] = await tx`delete from device_grants where device_code_hash = ${hash} returning user_id`;
    if (!consumed) return { ok: false, error: "expired_token" } as const; // 并发已被领走
    const token = generateCliToken();
    await tx`insert into cli_tokens (id, user_id, token_hash) values (${randomUUID()}, ${consumed.user_id}, ${sha256Hex(token)})`;
    const [user] = await tx`select email from users where id = ${consumed.user_id}`;
    return { ok: true, token, email: user.email } as const;
  });
}

/** Web 会话侧确认/拒绝：仅 pending 且未过期的 grant 可判定，绑定批准用户。
 *  不存在/过期/已判定统一模糊 not_found，不泄露 grant 状态。 */
export async function decideDeviceGrant(
  userCode: string,
  approve: boolean,
  email: string,
): Promise<{ ok: true; status: "approved" | "denied" } | { ok: false; error: "not_found" }> {
  const sql = getSql();
  const status = approve ? "approved" : "denied";
  const [row] = await sql`
    update device_grants set status = ${status},
      user_id = (select id from users where email = ${email} limit 1)
    where user_code = ${userCode} and status = 'pending' and expires_at > now()
    returning status`;
  if (!row) return { ok: false, error: "not_found" };
  return { ok: true, status: row.status };
}

/** Bearer 令牌 → 所属邮箱；sha256 查 cli_tokens 且未撤销（惰性过期 = revoked_at 判空）。
 *  best-effort 记 last_used_at，失败不影响判定。 */
export async function getCliTokenEmail(token: string): Promise<string | null> {
  const sql = getSql();
  const hash = sha256Hex(token);
  const [row] = await sql`
    select u.email from cli_tokens t join users u on u.id = t.user_id
    where t.token_hash = ${hash} and t.revoked_at is null limit 1`;
  if (!row) return null;
  await sql`update cli_tokens set last_used_at = now() where token_hash = ${hash}`.catch(() => {});
  return row.email;
}

/** 撤销 CLI 令牌，幂等；未知令牌返回 false（路由回 401）。 */
export async function revokeCliToken(token: string): Promise<boolean> {
  const sql = getSql();
  const hash = sha256Hex(token);
  await sql`update cli_tokens set revoked_at = now() where token_hash = ${hash} and revoked_at is null`;
  const [row] = await sql`select 1 from cli_tokens where token_hash = ${hash} limit 1`;
  return Boolean(row);
}
