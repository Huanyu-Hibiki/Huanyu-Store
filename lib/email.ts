/** 发送接口的类型化门面：实现与单测见 lib/email.mjs。 */
export type OutgoingMail = { from: string; to: string; subject: string; text: string };
export type MailSender = (mail: OutgoingMail) => Promise<void>;
export { SENDER_FROM, mailSender } from "./email.mjs";
