begin;

create extension if not exists pgcrypto;

create table if not exists public.member_segments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_segments_name_not_blank check (char_length(trim(name)) > 0)
);

create unique index if not exists member_segments_name_lower_uniq
  on public.member_segments ((lower(trim(name))));

create table if not exists public.member_segment_assignments (
  member_id bigint not null references public.loyalty_members(id) on delete cascade,
  segment_id uuid not null references public.member_segments(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (member_id, segment_id)
);

create index if not exists member_segment_assignments_segment_idx
  on public.member_segment_assignments (segment_id, assigned_at desc);

create or replace function public.set_member_segments_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_member_segments_updated_at on public.member_segments;
create trigger trg_member_segments_updated_at
before update on public.member_segments
for each row
execute function public.set_member_segments_updated_at();

insert into public.member_segments (name, description, is_system)
values
  ('High Value', 'System-defined high value members', true),
  ('Active', 'System-defined active members', true),
  ('At Risk', 'System-defined at-risk members', true),
  ('Inactive', 'System-defined inactive members', true)
on conflict ((lower(trim(name)))) do update
set is_system = excluded.is_system,
    updated_at = now();

insert into public.member_segment_assignments (member_id, segment_id)
select m.id, s.id
from public.loyalty_members m
join public.member_segments s
  on lower(trim(s.name)) = lower(trim(m.manual_segment))
where m.manual_segment is not null
on conflict (member_id, segment_id) do nothing;

create or replace function public.loyalty_member_segments()
returns table (
  member_id bigint,
  member_number text,
  auto_segment text,
  manual_segment text,
  effective_segment text,
  last_activity_at timestamptz
)
language sql
stable
as $$
  with latest_activity as (
    select
      t.member_id,
      max(t.transaction_date) as last_activity_at
    from public.loyalty_transactions t
    group by t.member_id
  ),
  system_manual as (
    select
      msa.member_id,
      max(msa.assigned_at) as last_assigned_at
    from public.member_segment_assignments msa
    join public.member_segments ms
      on ms.id = msa.segment_id
     and ms.is_system = true
    group by msa.member_id
  ),
  latest_system_manual as (
    select
      msa.member_id,
      ms.name as manual_segment
    from public.member_segment_assignments msa
    join public.member_segments ms
      on ms.id = msa.segment_id
     and ms.is_system = true
    join system_manual sm
      on sm.member_id = msa.member_id
     and sm.last_assigned_at = msa.assigned_at
  )
  select
    m.id as member_id,
    m.member_number::text as member_number,
    case
      when m.points_balance >= 2500 or (lower(coalesce(m.tier, 'bronze')) = 'gold' and m.points_balance >= 1200) then 'High Value'
      when coalesce((current_date - coalesce(la.last_activity_at::date, m.enrollment_date)), 99999) <= 30 then 'Active'
      when coalesce((current_date - coalesce(la.last_activity_at::date, m.enrollment_date)), 99999) <= 90 then 'At Risk'
      else 'Inactive'
    end as auto_segment,
    coalesce(lsm.manual_segment, m.manual_segment) as manual_segment,
    coalesce(
      lsm.manual_segment,
      m.manual_segment,
      case
        when m.points_balance >= 2500 or (lower(coalesce(m.tier, 'bronze')) = 'gold' and m.points_balance >= 1200) then 'High Value'
        when coalesce((current_date - coalesce(la.last_activity_at::date, m.enrollment_date)), 99999) <= 30 then 'Active'
        when coalesce((current_date - coalesce(la.last_activity_at::date, m.enrollment_date)), 99999) <= 90 then 'At Risk'
        else 'Inactive'
      end
    ) as effective_segment,
    la.last_activity_at
  from public.loyalty_members m
  left join latest_activity la on la.member_id = m.id
  left join latest_system_manual lsm on lsm.member_id = m.id;
$$;

commit;
