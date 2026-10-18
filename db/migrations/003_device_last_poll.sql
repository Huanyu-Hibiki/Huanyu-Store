-- 设备码轮询限速（任务 3）：token 端点判定 slow_down（轮询快于 interval 一半）需要上次轮询时间。
alter table device_grants add column if not exists last_poll_at timestamptz;
