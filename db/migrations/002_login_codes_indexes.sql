-- 发信限频与验证码校验的查询索引：按 (email|ip, created_at) 计数近一小时发信量、
-- 按 email 取最新未用码。幂等，可重复执行。
create index if not exists login_codes_email_created_idx on login_codes (email, created_at);
create index if not exists login_codes_ip_created_idx on login_codes (ip, created_at);
