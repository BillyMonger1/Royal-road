-- The Royal Road — cloud relay.
-- Paste this whole file into Supabase > SQL Editor and press Run. It is safe to run again.
--
-- What it makes: one table that holds sealed dreams until the desktop collects them.
-- The table itself is locked to the public. The only way in or out is the three
-- functions below, and each needs the mailbox address derived from your pairing secret.
-- Dream text arrives already encrypted on the phone; this database cannot read it.

create table if not exists public.dream_inbox (
  id         uuid primary key default gen_random_uuid(),
  route      text not null,
  payload    text not null,
  created_at timestamptz not null default now()
);
create index if not exists dream_inbox_route on public.dream_inbox (route);

alter table public.dream_inbox enable row level security;
revoke all on public.dream_inbox from anon, authenticated;

-- Phone: leave a sealed dream.
create or replace function public.push_dream(p_route text, p_payload text)
returns uuid language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if p_route !~ '^[0-9a-f]{64}$' then raise exception 'bad route'; end if;
  if length(p_payload) < 24 or length(p_payload) > 12000000 then raise exception 'bad payload'; end if;  -- room for a few pictures
  if (select count(*) from dream_inbox where route = p_route) >= 500 then raise exception 'inbox full'; end if;
  insert into dream_inbox (route, payload) values (p_route, p_payload) returning id into new_id;
  return new_id;
end $$;

-- Desktop: read what is waiting.
create or replace function public.pull_dreams(p_route text)
returns table (id uuid, payload text, created_at timestamptz)
language sql security definer set search_path = public as $$
  select i.id, i.payload, i.created_at from dream_inbox i
  where i.route = p_route order by i.created_at asc limit 200;
$$;

-- Desktop: delete what has been safely filed.
create or replace function public.ack_dreams(p_route text, p_ids uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from dream_inbox where route = p_route and id = any (p_ids);
  get diagnostics n = row_count;
  return n;
end $$;

-- Phone: which of my dreams are still waiting? Anything not returned has reached the desktop.
create or replace function public.waiting_dreams(p_route text, p_ids uuid[])
returns setof uuid language sql security definer set search_path = public as $$
  select i.id from dream_inbox i where i.route = p_route and i.id = any (p_ids);
$$;

revoke all on function public.push_dream(text, text) from public;
revoke all on function public.pull_dreams(text) from public;
revoke all on function public.ack_dreams(text, uuid[]) from public;
grant execute on function public.push_dream(text, text) to anon, authenticated;
grant execute on function public.pull_dreams(text) to anon, authenticated;
grant execute on function public.ack_dreams(text, uuid[]) to anon, authenticated;
revoke all on function public.waiting_dreams(text, uuid[]) from public;
grant execute on function public.waiting_dreams(text, uuid[]) to anon, authenticated;
