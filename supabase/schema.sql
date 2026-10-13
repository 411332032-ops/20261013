-- 匿名聊天室:階段二的資料庫設定(docs/architecture.md 第 9 章)
--
-- 使用方式:Supabase 後台 → SQL Editor → New query → 貼上整份 → Run。
-- 看到 Success 就完成。可以重複執行(已存在的東西會跳過或覆蓋)。
-- 注意:如果要修改 messages 的欄位規則,重複執行不會更新既有的規則,
--       要先 drop table 再重建(會清掉所有訊息)。

-- =========================================================
-- 1. 訊息資料表
-- =========================================================
create table if not exists public.messages (
  id         uuid        primary key default gen_random_uuid(),
  created_at timestamptz not null    default now(),
  client_id  text        not null,
  nickname   text        not null,
  content    text        not null,

  -- 長度(以「字」計算,和前端的 charLength 相同標準)
  constraint messages_client_id_len check (char_length(client_id) between 1 and 64),
  constraint messages_nickname_len  check (char_length(nickname)  between 1 and 12),
  constraint messages_content_len   check (char_length(content)   between 1 and 500),

  -- 內容不能只有空白或換行
  constraint messages_content_not_blank check (btrim(content, E' \t\n\r') <> ''),

  -- 代號:頭尾不能有空白、不能有換行或製表符、不能連續兩個空白、不能是保留字
  constraint messages_nickname_trimmed  check (nickname = btrim(nickname)),
  constraint messages_nickname_spaces   check (nickname !~ E'[\\t\\n\\r\\f\\v]' and nickname !~ '  '),
  constraint messages_nickname_reserved check (
    lower(nickname) not in ('系統', '管理員', '管理者', 'admin', 'administrator', 'system')
  ),

  -- 控制字元、零寬字元、方向控制字元(內容允許換行 \n,代號不允許任何控制字元)
  constraint messages_nickname_invisible check (
    nickname !~ '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]'
  ),
  constraint messages_content_invisible check (
    content !~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]'
  )
);

-- 載入最近 50 則、補斷線期間錯過的訊息,都是依時間查詢
create index if not exists messages_created_at_idx
  on public.messages (created_at desc);

-- 防洗版要查「同一個 client_id 最近 5 秒」
create index if not exists messages_client_recent_idx
  on public.messages (client_id, created_at desc);

-- =========================================================
-- 2. 寫入前的檢查:時間由伺服器填、防洗版
-- =========================================================
create or replace function public.messages_before_insert()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- 不信任使用者電腦的時鐘
  new.created_at := now();

  -- 同一個 client_id 在 5 秒內已有 3 則,就拒絕
  if (
    select count(*)
    from public.messages
    where client_id = new.client_id
      and created_at > now() - interval '5 seconds'
  ) >= 3 then
    raise exception 'RATE_LIMITED';
  end if;

  return new;
end;
$$;

drop trigger if exists messages_before_insert on public.messages;
create trigger messages_before_insert
  before insert on public.messages
  for each row execute function public.messages_before_insert();

-- =========================================================
-- 3. 安全規則(RLS):公開金鑰只能讀、能新增,不能改、不能刪
-- =========================================================
alter table public.messages enable row level security;

drop policy if exists "anyone can read messages"   on public.messages;
drop policy if exists "anyone can insert messages" on public.messages;

create policy "anyone can read messages"
  on public.messages for select
  to anon, authenticated
  using (true);

create policy "anyone can insert messages"
  on public.messages for insert
  to anon, authenticated
  with check (true);

-- 沒有 update、delete 的規則 = 一律拒絕。
-- 再從權限層面收緊一次(雙重保險),並且只允許寫入三個欄位:
-- id 與 created_at 一律由資料庫自己產生,使用者不能指定。
revoke all on public.messages from anon, authenticated;
grant select on public.messages to anon, authenticated;
grant insert (client_id, nickname, content) on public.messages to anon, authenticated;

-- =========================================================
-- 4. 即時通知:有新訊息時通知所有訂閱的人
-- =========================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end;
$$;

-- =========================================================
-- 5. 訊息只保留 7 天:每天自動清除
-- =========================================================
create extension if not exists pg_cron with schema pg_catalog;

-- 重複執行時,先移除舊的排程,避免重複
select cron.unschedule(jobid)
from cron.job
where jobname = 'delete-old-messages';

-- 每天 19:00(UTC)執行,相當於台灣時間凌晨 03:00
select cron.schedule(
  'delete-old-messages',
  '0 19 * * *',
  $$ delete from public.messages where created_at < now() - interval '7 days' $$
);
