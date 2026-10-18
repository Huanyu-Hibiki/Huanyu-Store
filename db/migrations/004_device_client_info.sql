-- 设备签发限频与确认页防钓鱼（任务 3 审查修复）：
-- ip 记录签发来源（每 IP 10 次/小时限频计数）；client_name/platform 为 CLI 自述（非机密），
-- 供 /cli 确认卡回显「申请方」，帮助用户识别钓鱼确认请求。均可空。
alter table device_grants add column if not exists client_name text;
alter table device_grants add column if not exists platform text;
alter table device_grants add column if not exists ip text;
