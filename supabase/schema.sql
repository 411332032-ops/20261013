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
    nickname !~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]'
  ),
  constraint messages_content_invisible check (
    content !~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]'
  )
);

-- 回覆/引用:reply_to 是被回覆那則的 id;代號和摘要由下面的觸發器依原訊息填入,
-- 使用者送來的值一律不採用(不能偽造「某人說過某句話」)。原訊息 7 天後被清除時,
-- reply_to 會變 null,但代號和摘要留著,所以引用仍然看得到。
alter table public.messages
  add column if not exists reply_to       uuid references public.messages(id) on delete set null,
  add column if not exists reply_nickname text,
  add column if not exists reply_excerpt  text;

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

  -- 回覆/引用:代號與摘要由原訊息決定。找不到原訊息時,就當作一般訊息
  if new.reply_to is not null then
    select m.id, m.nickname, left(regexp_replace(m.content, '\s+', ' ', 'g'), 80)
      into new.reply_to, new.reply_nickname, new.reply_excerpt
      from public.messages m
      where m.id = new.reply_to;
  else
    new.reply_nickname := null;
    new.reply_excerpt  := null;
  end if;

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
-- id、created_at、reply_nickname、reply_excerpt 一律由資料庫自己產生,使用者不能指定。
revoke all on public.messages from anon, authenticated;
grant select on public.messages to anon, authenticated;
grant insert (client_id, nickname, content, reply_to) on public.messages to anon, authenticated;

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

-- =========================================================
-- 6. 在線名單:資料表 + 心跳(不依賴 Realtime Presence)
-- =========================================================
-- 每個人進入後,每 3 秒呼叫一次 chat_tick:更新自己的「最後在線時間」並取回名單。
-- 超過 15 秒沒更新就當作離開(關掉分頁、斷網都會自動消失)。
-- 資料表本身不開放給公開金鑰,只能透過下面幾個函式操作。
create table if not exists public.presence (
  client_id text        primary key,
  nickname  text        not null,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  online    boolean     not null default true,

  constraint presence_client_id_len check (char_length(client_id) between 1 and 64),
  constraint presence_nickname_len  check (char_length(nickname)  between 1 and 12),
  constraint presence_nickname_trimmed  check (nickname = btrim(nickname)),
  constraint presence_nickname_spaces   check (nickname !~ E'[\t\n\r\f\v]' and nickname !~ '  '),
  constraint presence_nickname_reserved check (
    lower(nickname) not in ('系統', '管理員', '管理者', 'admin', 'administrator', 'system')
  ),
  constraint presence_nickname_invisible check (
    nickname !~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]'
  )
);

alter table public.presence enable row level security;
revoke all on public.presence from anon, authenticated;
-- 沒有任何 policy:公開金鑰無法直接讀寫這張表。

-- 進入聊天室:登記代號。同名且對方還在線,就拒絕(NICKNAME_TAKEN)。
-- advisory lock 讓「同一瞬間用同名進入」的兩個人排隊,一定只有一個成功。
create or replace function public.join_chat(p_client_id text, p_nickname text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext('join:' || p_nickname));

  if exists (
    select 1 from public.presence x
    where x.nickname = p_nickname
      and x.client_id <> p_client_id
      and x.online
      and x.last_seen > now() - interval '15 seconds'
  ) then
    raise exception 'NICKNAME_TAKEN';
  end if;

  insert into public.presence as p (client_id, nickname)
  values (p_client_id, p_nickname)
  on conflict (client_id) do update set
    nickname  = excluded.nickname,
    joined_at = case when p.online and p.last_seen > now() - interval '15 seconds'
                     then p.joined_at else now() end,
    online    = true,
    last_seen = now();
end;
$$;

-- 心跳 + 取回目前在線名單。p_client_id 傳空字串時只讀取名單(進入畫面的人數用)。
create or replace function public.chat_tick(p_client_id text)
returns table (cid text, nick text, joined_ms bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.presence p
  set joined_at = case when p.online and p.last_seen > now() - interval '15 seconds'
                       then p.joined_at else now() end,
      last_seen = now()
  where p.client_id = p_client_id
    and p.online;  -- 已主動離開的人,心跳不能把他復活(要重新 join_chat)

  return query
  select x.client_id, x.nickname, (extract(epoch from x.joined_at) * 1000)::bigint
  from public.presence x
  where x.online and x.last_seen > now() - interval '15 seconds'
  order by x.joined_at;
end;
$$;

-- 主動離開
create or replace function public.leave_chat(p_client_id text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.presence set online = false where client_id = p_client_id;
$$;

revoke all on function public.join_chat(text, text) from public;
revoke all on function public.chat_tick(text)       from public;
revoke all on function public.leave_chat(text)      from public;
grant execute on function public.join_chat(text, text) to anon, authenticated;
grant execute on function public.chat_tick(text)       to anon, authenticated;
grant execute on function public.leave_chat(text)      to anon, authenticated;

-- 名單資料只留一天
select cron.unschedule(jobid)
from cron.job
where jobname = 'delete-old-presence';

select cron.schedule(
  'delete-old-presence',
  '10 19 * * *',
  $$ delete from public.presence where last_seen < now() - interval '1 day' $$
);
