import { existsSync, readFileSync } from 'node:fs';

/** npm test 不会自动读取 .env.local；存在则补读。已设置的环境变量优先（CI 直接注入时不受影响）。 */
export function loadLocalEnv() {
 if (!existsSync('.env.local')) return;
 for (const line of readFileSync('.env.local','utf8').split(/\r?\n/)) {
  const match=line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (match && match[2]!=='' && process.env[match[1]]===undefined) process.env[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');
 }
}
