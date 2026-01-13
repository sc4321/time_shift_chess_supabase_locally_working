-- Supabase schema for Time‑Shift Chess (multiplayer, static hosting friendly)
--
-- How to apply:
-- Supabase Dashboard → SQL Editor → New query → paste this file → Run
 
create extension if not exists pgcrypto;
 
-- -----------------------------
-- Profiles (username + rating)
-- -----------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique,
  rating integer not null default 1200,
  created_at timestamptz not null default now()
);
 
alter table public.profiles enable row level security;
 
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_select_all_authed'
  ) then
    create policy profiles_select_all_authed
    on public.profiles
    for select
    to authenticated
    using (true);
  end if;
 
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_insert_self'
  ) then
    create policy profiles_insert_self
    on public.profiles
    for insert
    to authenticated
    with check (id = auth.uid());
  end if;
 
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_update_self'
  ) then
    create policy profiles_update_self
    on public.profiles
    for update
    to authenticated
    using (id = auth.uid())
    with check (id = auth.uid());
  end if;
end $$;
 
-- -----------------------------
-- Matches + players
-- -----------------------------
create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('solo','team')),
  time_control_ms integer not null,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  result text check (result in ('white','black','draw')),
  termination text check (termination in ('checkmate','timeout','resign'))
);
 
create table if not exists public.match_players (
  match_id uuid not null references public.matches (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  color text not null check (color in ('w','b')),
  board_role integer check (board_role in (1,2,3)),
  team_index integer not null check (team_index in (1,2)),
  primary key (match_id, user_id)
);
 
alter table public.matches enable row level security;
alter table public.match_players enable row level security;
 
do $$
begin
  -- Matches: only participants can select/update
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='matches' and policyname='matches_select_participants'
  ) then
    create policy matches_select_participants
    on public.matches
    for select
    to authenticated
    using (
      exists (
        select 1
        from public.match_players mp
        where mp.match_id = matches.id
          and mp.user_id = auth.uid()
      )
    );
  end if;
 
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='matches' and policyname='matches_update_participants'
  ) then
    create policy matches_update_participants
    on public.matches
    for update
    to authenticated
    using (
      exists (
        select 1
        from public.match_players mp
        where mp.match_id = matches.id
          and mp.user_id = auth.uid()
      )
    )
    with check (
      exists (
        select 1
        from public.match_players mp
        where mp.match_id = matches.id
          and mp.user_id = auth.uid()
      )
    );
  end if;
 
  -- Match players: participants can read, and each user can always read their own row
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='match_players' and policyname='match_players_select_participants_or_self'
  ) then
    create policy match_players_select_participants_or_self
    on public.match_players
    for select
    to authenticated
    using (
      user_id = auth.uid()
      or exists (
        select 1
        from public.match_players mp
        where mp.match_id = match_players.match_id
          and mp.user_id = auth.uid()
      )
    );
  end if;
end $$;
 
-- -----------------------------
-- Move log (clients replay)
-- -----------------------------
create table if not exists public.match_moves (
  id bigserial primary key,
  match_id uuid not null references public.matches (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  board_index integer not null check (board_index in (1,2,3)),
  from_square text not null,
  to_square text not null,
  promotion text,
  created_at timestamptz not null default now()
);
 
alter table public.match_moves enable row level security;
 
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='match_moves' and policyname='match_moves_select_participants'
  ) then
    create policy match_moves_select_participants
    on public.match_moves
    for select
    to authenticated
    using (
      exists (
        select 1
        from public.match_players mp
        where mp.match_id = match_moves.match_id
          and mp.user_id = auth.uid()
      )
    );
  end if;
 
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='match_moves' and policyname='match_moves_insert_self_participant'
  ) then
    create policy match_moves_insert_self_participant
    on public.match_moves
    for insert
    to authenticated
    with check (
      user_id = auth.uid()
      and exists (
        select 1
        from public.match_players mp
        where mp.match_id = match_moves.match_id
          and mp.user_id = auth.uid()
      )
    );
  end if;
end $$;
 
-- -----------------------------
-- Queue + matchmaking RPC
-- -----------------------------
create table if not exists public.queue_entries (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  mode text not null check (mode in ('solo','team')),
  time_control_ms integer not null,
  queued_at timestamptz not null default now()
);
 
alter table public.queue_entries enable row level security;
 
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='queue_entries' and policyname='queue_entries_self_access'
  ) then
    create policy queue_entries_self_access
    on public.queue_entries
    for all
    to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());
  end if;
end $$;
 
create or replace function public.queue_leave()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.queue_entries where user_id = auth.uid();
$$;
 
create or replace function public.queue_join(mode_in text, time_control_ms_in integer)
returns table(status text, match_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  needed integer;
  picked_ids uuid[];
  new_match_id uuid;
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;
 
  if mode_in not in ('solo','team') then
    raise exception 'invalid_mode';
  end if;
 
  if time_control_ms_in <= 0 then
    raise exception 'invalid_time_control';
  end if;
 
  perform pg_advisory_xact_lock(hashtext(mode_in || ':' || time_control_ms_in::text));
 
  insert into public.queue_entries(user_id, mode, time_control_ms, queued_at)
  values (uid, mode_in, time_control_ms_in, now())
  on conflict (user_id) do update
    set mode = excluded.mode,
        time_control_ms = excluded.time_control_ms,
        queued_at = excluded.queued_at;
 
  needed := case when mode_in = 'solo' then 2 else 6 end;
 
  select array_agg(q.user_id order by q.queued_at)
    into picked_ids
  from (
    select user_id, queued_at
    from public.queue_entries
    where mode = mode_in and time_control_ms = time_control_ms_in
    order by queued_at
    limit needed
    for update skip locked
  ) q;
 
  if picked_ids is null or array_length(picked_ids, 1) < needed then
    return query select 'queued'::text, null::uuid;
    return;
  end if;
 
  new_match_id := gen_random_uuid();
  insert into public.matches(id, mode, time_control_ms) values (new_match_id, mode_in, time_control_ms_in);
 
  with shuffled as (
    select unnest(picked_ids) as user_id
    order by random()
  ),
  numbered as (
    select user_id, row_number() over () as rn
    from shuffled
  )
  insert into public.match_players(match_id, user_id, color, board_role, team_index)
  select
    new_match_id,
    user_id,
    case
      when mode_in = 'solo' then case when rn = 1 then 'w' else 'b' end
      else case when rn <= 3 then 'w' else 'b' end
    end as color,
    case
      when mode_in = 'team' then ((rn - 1) % 3) + 1
      else null
    end as board_role,
    case
      when mode_in = 'solo' then case when rn = 1 then 1 else 2 end
      else case when rn <= 3 then 1 else 2 end
    end as team_index
  from numbered;
 
  delete from public.queue_entries where user_id = any(picked_ids);
 
  return query select 'matched'::text, new_match_id;
end;
$$;