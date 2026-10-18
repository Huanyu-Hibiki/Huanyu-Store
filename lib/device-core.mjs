/** 设备码授权的纯逻辑（无 DB/运行时依赖），供 node:test 直接单测与 lib/device.ts 复用。 */
import { randomBytes,randomInt } from 'node:crypto';

export const DEVICE_TTL_SECONDS=600;    // 设备码 TTL 10 分钟（CLI 契约 expires_in）
export const DEVICE_INTERVAL_SECONDS=5; // 轮询间隔秒数（CLI 契约 interval，自行换算毫秒）
export const CLI_TOKEN_PREFIX='hy_';
// user_code 字母表：大写字母数字，剔除易混淆字符 0/O/1/I/L
const USER_CODE_ALPHABET='ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 设备码：32 字节 urlsafe（43 字符高熵），落库只存 sha256。 @returns {string} */
export function generateDeviceCode(){
 return randomBytes(32).toString('base64url');
}

/** CLI 令牌：hy_ + 32 字节 urlsafe，落库只存 sha256。 @returns {string} */
export function generateCliToken(){
 return CLI_TOKEN_PREFIX+randomBytes(32).toString('base64url');
}

/** 人类友好 user_code：XXXX-XXXX，排除易混淆字符，明文展示/落库（非机密）。 @returns {string} */
export function generateUserCode(){
 const pick=()=>USER_CODE_ALPHABET[randomInt(0,USER_CODE_ALPHABET.length)];
 const chars=Array.from({length:8},pick).join('');
 return `${chars.slice(0,4)}-${chars.slice(4)}`;
}

/** user_code 输入归一：去分隔符与空白、大写、重组 XXXX-XXXX；长度/字母表非法返回 null。
 *  @param {string} raw @returns {string|null} */
export function normalizeUserCode(raw){
 if (typeof raw!=='string') return null;
 const compact=raw.replace(/[^A-Za-z0-9]/g,'').toUpperCase();
 if (compact.length!==8) return null;
 if (![...compact].every((char)=>USER_CODE_ALPHABET.includes(char))) return null;
 return `${compact.slice(0,4)}-${compact.slice(4)}`;
}

/** @typedef {{status:string,expires_at:Date,last_poll_at:Date|null,interval_seconds:number}} GrantRow
 *  轮询判定：过期优先于一切状态；pending 且距上次轮询不足 interval 一半 → slow_down。
 *  @param {GrantRow} row @param {Date} now @returns {'expired'|'denied'|'approved'|'slow_down'|'pending'} */
export function checkGrant(row,now=new Date()){
 if (row.expires_at.getTime()<=now.getTime()) return 'expired';
 if (row.status==='denied') return 'denied';
 if (row.status==='approved') return 'approved';
 if (row.last_poll_at&&now.getTime()-row.last_poll_at.getTime()<row.interval_seconds*500) return 'slow_down';
 return 'pending';
}

/** PUBLISHER_EMAILS 白名单判定：逗号分隔，忽略大小写与空白；未配置恒 false。
 *  @param {string} email @param {string|undefined} envValue @returns {boolean} */
export function isPublisher(email,envValue){
 if (!envValue) return false;
 const normalized=email.trim().toLowerCase();
 return envValue.split(',').some((entry)=>entry.trim().toLowerCase()===normalized);
}
