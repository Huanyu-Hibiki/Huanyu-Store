/** 验证码登录的纯逻辑（无 DB/运行时依赖），供 node:test 直接单测与 lib/auth.ts 复用。 */
import { createHash,randomBytes,randomInt } from 'node:crypto';

export const SESSION_COOKIE='__Host-huanyu_session'; // __Host- 前缀：浏览器强制 Secure+Path=/ 且禁 Domain
export const CODE_TTL_MINUTES=10;
export const CODE_MAX_ATTEMPTS=5;
export const EMAIL_HOURLY_LIMIT=5;
export const IP_HOURLY_LIMIT=20;
export const SESSION_TTL_DAYS=30;
export const VERIFY_IP_HOURLY_LIMIT=30; // verify 端点纵深限频：该 IP 名下码的累计失败尝试/小时
export const GLOBAL_DAILY_LIMIT=200;    // 全站发码日预算：防 Resend 配额被耗尽成全站登录 DoS

/** @param {string} input @returns {string} */
export function sha256Hex(input){
 return createHash('sha256').update(input).digest('hex');
}

/** 邮箱归一：去空白 + 小写，作为账号唯一键与哈希绑定输入。 @param {string} raw @returns {string} */
export function normalizeEmail(raw){
 return raw.trim().toLowerCase();
}

/** 验证码哈希绑定 email：同一验证码在不同邮箱下哈希不同，且不等于裸码哈希（防彩虹表对照）。 */
export function hashCode(email,code){
 return sha256Hex(`${normalizeEmail(email)}:${code}`);
}

/** 6 位数字验证码（补零），随机均匀取值。 @returns {string} */
export function generateCode(){
 return String(randomInt(0,1_000_000)).padStart(6,'0');
}

/** Web 会话令牌：32 字节 urlsafe 随机，cookie 存原值、库中只存 sha256。 @returns {string} */
export function generateSessionToken(){
 return randomBytes(32).toString('base64url');
}

/** @typedef {{code_hash:string,attempts:number,expires_at:Date,used_at:Date|null}} CodeRow @returns {'valid'|'mismatch'|'expired'|'used'|'exhausted'} */
export function checkCode(row,email,code,now=new Date()){
 if (row.used_at) return 'used';
 if (row.expires_at.getTime()<=now.getTime()) return 'expired';
 if (row.attempts>=CODE_MAX_ATTEMPTS) return 'exhausted'; // 尝试耗尽先于比对：正确码也作废
 return row.code_hash===hashCode(email,code)?'valid':'mismatch';
}

/** 发信限频判定：任一维度达到上限即拒。 @param {{emailCount:number,ipCount:number}} counts @returns {boolean} */
export function isSendRateLimited({emailCount,ipCount}){
 return emailCount>=EMAIL_HOURLY_LIMIT||ipCount>=IP_HOURLY_LIMIT;
}

/** 边界邮箱形状校验（快速失败，长度上限 RFC 上界 254）；送达性由验证码邮件本身承担。 @param {string} email @returns {boolean} */
export function isValidEmail(email){
 return email.length<=254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** 限频 IP 键归一：IPv4 原值（剥端口）；IPv6 取前 4 组归一到 /64（内嵌 v4 按 v4 记）。
 *  同 /64 前缀的客户端共享额度，防轮换低 64 位绕过每 IP 限额。 @param {string} raw @returns {string} */
export function normalizeIp(raw){
 const ip=raw.trim();
 if (/^(\d+\.){3}\d+(:\d+)?$/.test(ip)) return ip.replace(/:\d+$/,''); // IPv4（剥端口）原值
 if (!ip.includes(':')) return ip; // 非常规值（如无代理头哨兵 unknown）原值记账
 const bracket=ip.match(/^\[(.+)\](?::\d+)?$/); // [v6]:port 写法先剥壳
 const v6=(bracket?bracket[1]:ip).toLowerCase();
 const embedded=v6.match(/(\d+\.){3}\d+$/); // ::ffff:1.2.3.4 等 v4 映射：按等价 v4 客户端记
 if (embedded) return embedded[0];
 const halves=v6.split('::');
 const left=halves[0]?halves[0].split(':'):[];
 const right=halves.length>1&&halves[1]?halves[1].split(':'):[];
 const groups=[...left,...Array(Math.max(0,8-left.length-right.length)).fill('0'),...right];
 if (groups.length!==8||groups.some((g)=>!/^[0-9a-f]{1,4}$/.test(g))) return ip; // 非法形状不猜，按原值记账
 return groups.slice(0,4).map((g)=>parseInt(g,16).toString(16)).join(':')+'::/64';
}
