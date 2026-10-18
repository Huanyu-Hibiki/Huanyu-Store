/** 邮件发送实现：真发（Resend REST）与假发送器共用同一形状。实现放 .mjs 供 node:test 直测（catalog.mjs 先例）。 */
import { appendFile } from 'node:fs/promises';

export const SENDER_FROM='焕羽 Skills 商店 <noreply@skills.huanyu.dev>';

/** Resend REST API 直调（fetch 即可，不引 SDK）。 @param {{from:string,to:string,subject:string,text:string}} mail */
async function sendViaResend(mail){
 const key=process.env.RESEND_API_KEY;
 const res=await fetch('https://api.resend.com/emails',{
  method:'POST',
  headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},
  body:JSON.stringify({from:mail.from,to:[mail.to],subject:mail.subject,text:mail.text}),
 });
 if(!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

/** 假发送器：不发真信。控制台可见待发内容（本地开发）；设 FAKE_MAIL_OUTBOX 时追加 JSON 行供集成测试断言。 */
async function fakeSend(mail){
 console.log(`[email:fake] -> ${mail.to} | ${mail.subject}\n${mail.text}\n`);
 const outbox=process.env.FAKE_MAIL_OUTBOX;
 if (outbox) await appendFile(outbox,JSON.stringify(mail)+'\n','utf8');
}

/** 未配 RESEND_API_KEY 时一律走假发送器：测试与本地开发不依赖发信域名。 @returns {(mail:object)=>Promise<void>} */
export function mailSender(){
 return process.env.RESEND_API_KEY?sendViaResend:fakeSend;
}
