-- ============================================================
-- CENTRALPERK SPRINT 1 CONSOLIDATED SUPABASE SQL
-- Single authoritative file for the current project
-- Based on the current live schema shape plus verified Sprint 1 fixes
-- ============================================================

begin;

-- ============================================================
-- CORE TABLES
-- ============================================================

create table if not exists public.loyalty_members (
  id bigserial primary key,
  member_id bigint unique,
  member_number varchar(20) unique,
  first_name varchar(100),
  last_name varchar(100),
  email varchar(255) unique not null,
  phone varchar(20),
  birthdate date,
  points_balance int default 0,
  tier varchar(20) default 'Bronze',
  enrollment_date date default current_date,
  created_at timestamptz default now(),
  address text,
  profile_photo_url text
);

alter table public.loyalty_members
  add column if not exists manual_segment text,
  add column if not exists referral_code text,
  add column if not exists sms_enabled boolean not null default true,
  add column if not exists email_enabled boolean not null default true,
  add column if not exists push_enabled boolean not null default true,
  add column if not exists promotional_opt_in boolean not null default true,
  add column if not exists communication_frequency text not null default 'weekly';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'loyalty_members_manual_segment_check'
      and conrelid = 'public.loyalty_members'::regclass
  ) then
    alter table public.loyalty_members
      add constraint loyalty_members_manual_segment_check
      check (manual_segment is null or manual_segment in ('High Value', 'Active', 'At Risk', 'Inactive'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'loyalty_members_communication_frequency_check'
      and conrelid = 'public.loyalty_members'::regclass
  ) then
    alter table public.loyalty_members
      add constraint loyalty_members_communication_frequency_check
      check (communication_frequency in ('daily', 'weekly', 'never'));
  end if;
end $$;

create table if not exists public.app_user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text check (role in ('admin', 'customer')),
  updated_at timestamptz default now()
);

create table if not exists public.points_rules (
  id bigserial primary key,
  tier_label varchar(20) unique not null,
  min_points integer not null,
  is_active boolean default true
);

create table if not exists public.earning_rules (
  id bigserial primary key,
  tier_label varchar(20) not null,
  peso_per_point numeric(10, 2) not null,
  multiplier numeric(10, 2) not null default 1,
  is_active boolean not null default true,
  effective_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint earning_rules_tier_label_check check (
    tier_label in ('Bronze', 'Silver', 'Gold')
  ),
  constraint earning_rules_peso_per_point_check check (peso_per_point > 0),
  constraint earning_rules_multiplier_check check (multiplier > 0)
);

create table if not exists public.loyalty_transactions (
  id bigserial primary key,
  transaction_id bigint unique,
  member_id bigint references public.loyalty_members(id) on delete cascade,
  transaction_type varchar(50),
  points integer not null,
  amount_spent numeric(10, 2) default 0,
  reason text,
  receipt_id text unique,
  transaction_date timestamptz default now(),
  expiry_date timestamptz default (now() + interval '1 year')
);

create table if not exists public.notification_outbox (
  id bigserial primary key,
  user_id uuid references auth.users(id),
  channel text check (channel in ('email', 'sms', 'push')),
  subject text,
  message text,
  status text default 'pending',
  created_at timestamptz default now(),
  sent_at timestamptz
);

alter table public.notification_outbox
  add column if not exists is_promotional boolean not null default false;

create table if not exists public.member_feedback (
  id bigserial primary key,
  member_number text not null,
  member_name text not null,
  category text not null,
  rating integer not null,
  comment text not null,
  contact_opt_in boolean not null default false,
  contact_info text,
  created_at timestamptz not null default now(),
  constraint member_feedback_category_check check (category in ('points', 'rewards', 'service', 'app')),
  constraint member_feedback_rating_check check (rating between 1 and 5),
  constraint member_feedback_comment_length_check check (char_length(comment) <= 500)
);

create table if not exists public.member_referrals (
  id bigserial primary key,
  referrer_member_id bigint not null references public.loyalty_members(id) on delete cascade,
  referrer_code text not null,
  referee_email text,
  referee_email_normalized text,
  referee_member_id bigint references public.loyalty_members(id) on delete set null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  converted_at timestamptz,
  bonus_awarded boolean not null default false,
  referrer_bonus_txn_id bigint references public.loyalty_transactions(id) on delete set null,
  referee_bonus_txn_id bigint references public.loyalty_transactions(id) on delete set null,
  constraint member_referrals_status_check check (status in ('pending', 'joined', 'converted', 'rewarded', 'cancelled'))
);

create table if not exists public.member_birthday_rewards (
  id bigserial primary key,
  member_id bigint not null references public.loyalty_members(id) on delete cascade,
  reward_year integer not null,
  tier_at_award text not null,
  points_awarded integer not null,
  voucher_code text not null,
  voucher_expires_at timestamptz,
  source text not null default 'system',
  created_at timestamptz not null default now(),
  constraint member_birthday_rewards_tier_check check (tier_at_award in ('Bronze', 'Silver', 'Gold')),
  constraint member_birthday_rewards_unique_member_year unique (member_id, reward_year),
  constraint member_birthday_rewards_points_check check (points_awarded in (100, 500, 1000))
);

alter table public.member_referrals
  add column if not exists referrer_member_id bigint,
  add column if not exists referrer_code text,
  add column if not exists referee_email text,
  add column if not exists referee_email_normalized text;

alter table public.member_referrals
  add column if not exists referee_member_id bigint,
  add column if not exists status text not null default 'pending',
  add column if not exists bonus_awarded boolean not null default false,
  add column if not exists referrer_bonus_txn_id bigint,
  add column if not exists referee_bonus_txn_id bigint,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists converted_at timestamptz;

update public.member_referrals
set referee_email_normalized = lower(trim(referee_email))
where coalesce(trim(referee_email_normalized), '') = ''
  and coalesce(trim(referee_email), '') <> '';

alter table public.member_birthday_rewards
  add column if not exists member_id bigint,
  add column if not exists reward_year integer,
  add column if not exists tier_at_award text,
  add column if not exists points_awarded integer,
  add column if not exists voucher_code text,
  add column if not exists voucher_expires_at timestamptz,
  add column if not exists source text not null default 'system',
  add column if not exists created_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'member_birthday_rewards_tier_check'
      and conrelid = 'public.member_birthday_rewards'::regclass
  ) then
    alter table public.member_birthday_rewards
      add constraint member_birthday_rewards_tier_check
      check (tier_at_award in ('Bronze', 'Silver', 'Gold'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'member_birthday_rewards_unique_member_year'
      and conrelid = 'public.member_birthday_rewards'::regclass
  ) then
    alter table public.member_birthday_rewards
      add constraint member_birthday_rewards_unique_member_year
      unique (member_id, reward_year);
  end if;
end $$;

create table if not exists public.loyalty_member_profile_audit (
  id bigserial primary key,
  member_id bigint references public.loyalty_members(id),
  changed_by uuid references auth.users(id),
  old_data jsonb,
  new_data jsonb,
  changed_at timestamptz default now()
);

create table if not exists public.points_lots (
  id bigserial primary key,
  member_id bigint not null references public.loyalty_members(id) on delete cascade,
  source_transaction_id bigint unique references public.loyalty_transactions(id) on delete set null,
  original_points integer not null check (original_points > 0),
  remaining_points integer not null check (remaining_points >= 0),
  earned_at timestamptz not null default now(),
  expiry_date timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.rewards_catalog (
  id bigserial primary key,
  reward_id text unique not null,
  name text not null,
  description text,
  points_cost integer not null,
  category text,
  image_url text,
  is_active boolean default true,
  expiry_date timestamptz,
  created_at timestamptz default now()
);

create table if not exists public.earn_tasks (
  id bigserial primary key,
  task_code text unique not null,
  title text not null,
  description text,
  points integer not null,
  icon_key text,
  default_completed boolean default false,
  is_active boolean default true,
  created_at timestamptz default now()
);

create table if not exists public.tier_history (
  id bigserial primary key,
  member_id bigint not null references public.loyalty_members(id) on delete cascade,
  old_tier varchar(20) not null,
  new_tier varchar(20) not null,
  changed_at timestamptz not null default now(),
  reason text
);

create table if not exists public.redemption_settings (
  id bigserial primary key,
  redemption_value_per_point numeric(12, 6) not null default 0.01,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.liability_snapshots (
  id bigserial primary key,
  snapshot_month date not null unique,
  total_unredeemed_points bigint not null,
  monetary_liability numeric(14, 2) not null,
  created_at timestamptz not null default now()
);

create table if not exists public.member_login_activity (
  id bigserial primary key,
  member_id bigint not null references public.loyalty_members(id) on delete cascade,
  login_at timestamptz not null default now(),
  channel text not null default 'web',
  source text not null default 'customer_portal',
  created_at timestamptz not null default now(),
  constraint member_login_activity_channel_check check (
    channel in ('web', 'mobile', 'kiosk', 'system')
  )
);

create table if not exists public.member_reengagement_actions (
  id bigserial primary key,
  member_id bigint not null references public.loyalty_members(id) on delete cascade,
  initiated_by uuid references auth.users(id) on delete set null,
  risk_level text not null,
  action_type text not null,
  recommended_action text not null,
  action_notes text,
  status text not null default 'planned',
  success boolean,
  success_metric text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  completed_at timestamptz,
  follow_up_due_at timestamptz,
  constraint member_reengagement_actions_risk_level_check check (
    risk_level in ('Low', 'Medium', 'High')
  ),
  constraint member_reengagement_actions_status_check check (
    status in ('planned', 'sent', 'completed', 'dismissed')
  )
);

insert into storage.buckets (id, name, public)
values ('profile-photos', 'profile-photos', true)
on conflict (id) do update
set public = excluded.public;

-- ============================================================
-- INDEXES
-- ============================================================

create index if not exists idx_members_email on public.loyalty_members(lower(email));
create index if not exists idx_members_member_number on public.loyalty_members(member_number);
create unique index if not exists idx_loyalty_members_phone_unique
on public.loyalty_members (phone)
where phone is not null and length(trim(phone)) > 0;
create unique index if not exists idx_loyalty_members_referral_code_unique
on public.loyalty_members (lower(referral_code))
where referral_code is not null and length(trim(referral_code)) > 0;

create index if not exists idx_transactions_member on public.loyalty_transactions(member_id);
create index if not exists idx_transactions_date on public.loyalty_transactions(transaction_date desc);
create index if not exists idx_rewards_catalog_active on public.rewards_catalog(is_active);
create index if not exists idx_earn_tasks_active on public.earn_tasks(is_active);
create unique index if not exists uq_earning_rules_single_active_per_tier
on public.earning_rules (tier_label)
where is_active = true;
create index if not exists idx_earning_rules_active_tier
on public.earning_rules (tier_label, is_active, effective_at desc);
create index if not exists idx_points_lots_member_fifo
on public.points_lots (member_id, expiry_date asc, earned_at asc, id asc)
where remaining_points > 0;
create index if not exists idx_tier_history_member_date
on public.tier_history (member_id, changed_at desc);
create index if not exists idx_notification_outbox_user_created
on public.notification_outbox (user_id, created_at desc);
create index if not exists idx_notification_outbox_status_created
on public.notification_outbox (status, created_at desc);
create index if not exists idx_notification_outbox_user_channel_promotional
on public.notification_outbox (user_id, channel, created_at desc)
where is_promotional = true;
create index if not exists idx_member_feedback_created
on public.member_feedback (created_at desc);
create unique index if not exists idx_member_referrals_unique_referrer_email
on public.member_referrals (referrer_member_id, referee_email_normalized);
create unique index if not exists idx_member_referrals_unique_referee_email_joined
on public.member_referrals (referee_email_normalized)
where status = 'joined';
create unique index if not exists idx_member_referrals_unique_referee_member
on public.member_referrals (referee_member_id)
where referee_member_id is not null;
create unique index if not exists idx_member_referrals_unique_referrer_bonus_txn
on public.member_referrals (referrer_bonus_txn_id)
where referrer_bonus_txn_id is not null;
create unique index if not exists idx_member_referrals_unique_referee_bonus_txn
on public.member_referrals (referee_bonus_txn_id)
where referee_bonus_txn_id is not null;
create index if not exists idx_member_referrals_referrer_created
on public.member_referrals (referrer_member_id, created_at desc);
create index if not exists idx_member_referrals_status_created
on public.member_referrals (status, created_at desc);
create unique index if not exists idx_member_birthday_rewards_member_year
on public.member_birthday_rewards (member_id, reward_year);
create unique index if not exists idx_member_birthday_rewards_voucher_code
on public.member_birthday_rewards (voucher_code);
create index if not exists idx_member_login_activity_member_date
on public.member_login_activity (member_id, login_at desc);
create index if not exists idx_member_reengagement_actions_member_date
on public.member_reengagement_actions (member_id, created_at desc);
create index if not exists idx_member_reengagement_actions_status_date
on public.member_reengagement_actions (status, created_at desc);

-- ============================================================
-- SEED DATA
-- ============================================================

insert into public.points_rules (tier_label, min_points, is_active)
values
  ('Bronze', 0, true),
  ('Silver', 250, true),
  ('Gold', 750, true)
on conflict (tier_label) do update
set min_points = excluded.min_points,
    is_active = excluded.is_active;

insert into public.earning_rules (tier_label, peso_per_point, multiplier, is_active)
values
  ('Bronze', 10, 1.00, true),
  ('Silver', 10, 1.25, true),
  ('Gold', 10, 1.50, true)
on conflict do nothing;

insert into public.redemption_settings (redemption_value_per_point, is_active)
select 0.01, true
where not exists (
  select 1 from public.redemption_settings where is_active = true
);

insert into public.rewards_catalog (reward_id, name, description, points_cost, category, image_url, is_active, expiry_date)
values
  ('RW001', 'Free Regular Coffee', 'Any regular-sized hot or iced coffee', 120, 'beverage', 'https://images.unsplash.com/photo-1657048167114-0942f3a2dc93?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080', true, null),
  ('RW002', 'Free Pastry', 'Choose from croissant, muffin, or danish', 150, 'food', 'https://images.unsplash.com/photo-1751151856149-5ebf1d21586a?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080', true, null),
  ('RW003', 'Free Large Specialty Drink', 'Any large-sized specialty beverage', 280, 'beverage', 'https://images.unsplash.com/photo-1680381724318-c8ac9fe3a484?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080', true, null),
  ('RW004', 'Breakfast Combo', 'Coffee + breakfast sandwich or wrap', 350, 'food', 'https://images.unsplash.com/photo-1738682585466-c287db5404de?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080', true, null),
  ('RW005', 'Coffee Beans 250g', 'Premium roasted coffee beans', 500, 'merchandise', 'https://images.unsplash.com/photo-1561766858-62033ae40ec3?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080', true, null),
  ('RW006', 'ZUS Branded Tumbler', 'Reusable insulated tumbler - 16oz', 800, 'merchandise', 'https://images.unsplash.com/photo-1666447616947-cd26838cb88b?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080', true, null),
  ('RW007', '$10 Gift Voucher', 'Redeemable for any purchase', 1000, 'voucher', 'https://images.unsplash.com/photo-1637910116483-7efcc9480847?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080', true, null),
  ('RW008', 'Monthly Coffee Pass', '30 days of free regular coffee', 2500, 'voucher', 'https://images.unsplash.com/photo-1683888046273-38c106471115?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080', true, '2026-03-31T23:59:59Z')
on conflict (reward_id) do update
set
  name = excluded.name,
  description = excluded.description,
  points_cost = excluded.points_cost,
  category = excluded.category,
  image_url = excluded.image_url,
  is_active = excluded.is_active,
  expiry_date = excluded.expiry_date;

insert into public.earn_tasks (task_code, title, description, points, icon_key, default_completed, is_active)
values
  ('E001', 'Complete Your Profile', 'Add your birthday, phone number, and preferences', 100, 'user', true, true),
  ('E002', 'Download Mobile App', 'Get the ZUS Coffee app on your phone', 50, 'smartphone', true, true),
  ('E003', 'Monthly Survey', 'Share your feedback about our service', 50, 'clipboard', false, true),
  ('E004', 'Refer a Friend', 'Both get 250 points when they make first purchase', 250, 'users', false, true),
  ('E005', 'Follow on Social Media', 'Follow us on Instagram and Facebook', 30, 'share-2', false, true),
  ('E006', 'Leave a Review', 'Rate your experience on Google or App Store', 75, 'star', false, true)
on conflict (task_code) do update
set
  title = excluded.title,
  description = excluded.description,
  points = excluded.points,
  icon_key = excluded.icon_key,
  default_completed = excluded.default_completed,
  is_active = excluded.is_active;

-- ============================================================
-- MEMBER NUMBER FIX (LYL-002)
-- ============================================================

create table if not exists public.member_number_counter (
  counter_name text primary key,
  last_value bigint not null
);

insert into public.member_number_counter (counter_name, last_value)
values (
  'member_number',
  coalesce(
    (
      select max(
        coalesce(nullif(regexp_replace(member_number, '\D', '', 'g'), ''), '0')::bigint
      )
      from public.loyalty_members
    ),
    0
  )
)
on conflict (counter_name) do update
set last_value = greatest(public.member_number_counter.last_value, excluded.last_value);

create or replace function public.loyalty_generate_member_number()
returns text
language plpgsql
as $$
declare
  seq_value bigint;
begin
  update public.member_number_counter
  set last_value = last_value + 1
  where counter_name = 'member_number'
  returning last_value into seq_value;

  if seq_value is null then
    insert into public.member_number_counter (counter_name, last_value)
    values ('member_number', 1)
    on conflict (counter_name) do update
    set last_value = public.member_number_counter.last_value + 1
    returning last_value into seq_value;
  end if;

  return 'MEM-' || lpad(seq_value::text, 6, '0');
end;
$$;

create or replace function public.set_member_number()
returns trigger
language plpgsql
as $$
begin
  if new.member_number is null then
    new.member_number := public.loyalty_generate_member_number();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_member_number on public.loyalty_members;
create trigger trg_member_number
before insert on public.loyalty_members
for each row
execute function public.set_member_number();

-- ============================================================
-- SUPPORT FUNCTIONS
-- ============================================================

create or replace function public.app_current_role()
returns text
language sql
stable
as $$
  select role from public.app_user_roles where user_id = auth.uid()
$$;

create or replace function public.app_current_email()
returns text
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'email', '')
$$;

create or replace function public.app_is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(public.app_current_role() = 'admin', false)
    or lower(public.app_current_email()) like '%@admin.loyaltyhub.com'
$$;

-- ============================================================
-- RLS AND STORAGE POLICIES
-- ============================================================

alter table public.loyalty_members enable row level security;
alter table public.member_login_activity enable row level security;
alter table public.member_reengagement_actions enable row level security;
alter table public.member_feedback enable row level security;
alter table public.member_referrals enable row level security;
alter table public.member_birthday_rewards enable row level security;

drop policy if exists loyalty_members_select_own on public.loyalty_members;
create policy loyalty_members_select_own
on public.loyalty_members
for select
to authenticated
using (
  public.app_current_role() = 'admin'
  or lower(email) = lower(public.app_current_email())
);

drop policy if exists loyalty_members_update_own on public.loyalty_members;
create policy loyalty_members_update_own
on public.loyalty_members
for update
to authenticated
using (
  public.app_current_role() = 'admin'
  or lower(email) = lower(public.app_current_email())
)
with check (
  public.app_current_role() = 'admin'
  or lower(email) = lower(public.app_current_email())
);

drop policy if exists member_login_activity_select on public.member_login_activity;
create policy member_login_activity_select
on public.member_login_activity
for select
to authenticated
using (
  public.app_is_admin()
  or exists (
    select 1
    from public.loyalty_members m
    where m.id = member_login_activity.member_id
      and lower(m.email) = lower(public.app_current_email())
  )
);

drop policy if exists member_login_activity_insert on public.member_login_activity;
create policy member_login_activity_insert
on public.member_login_activity
for insert
to authenticated
with check (
  public.app_is_admin()
  or exists (
    select 1
    from public.loyalty_members m
    where m.id = member_login_activity.member_id
      and lower(m.email) = lower(public.app_current_email())
  )
);

drop policy if exists member_reengagement_actions_select on public.member_reengagement_actions;
create policy member_reengagement_actions_select
on public.member_reengagement_actions
for select
to authenticated
using (
  public.app_is_admin()
  or exists (
    select 1
    from public.loyalty_members m
    where m.id = member_reengagement_actions.member_id
      and lower(m.email) = lower(public.app_current_email())
  )
);

drop policy if exists member_reengagement_actions_insert_admin on public.member_reengagement_actions;
create policy member_reengagement_actions_insert_admin
on public.member_reengagement_actions
for insert
to authenticated
with check (public.app_is_admin());

drop policy if exists member_reengagement_actions_update_admin on public.member_reengagement_actions;
create policy member_reengagement_actions_update_admin
on public.member_reengagement_actions
for update
to authenticated
using (public.app_is_admin())
with check (public.app_is_admin());

drop policy if exists member_feedback_select on public.member_feedback;
create policy member_feedback_select
on public.member_feedback
for select
to authenticated
using (
  public.app_is_admin()
  or exists (
    select 1
    from public.loyalty_members m
    where m.member_number::text = member_feedback.member_number
      and lower(m.email) = lower(public.app_current_email())
  )
);

drop policy if exists member_feedback_insert on public.member_feedback;
create policy member_feedback_insert
on public.member_feedback
for insert
to authenticated
with check (
  public.app_is_admin()
  or exists (
    select 1
    from public.loyalty_members m
    where m.member_number::text = member_feedback.member_number
      and lower(m.email) = lower(public.app_current_email())
  )
);

drop policy if exists member_referrals_select on public.member_referrals;
create policy member_referrals_select
on public.member_referrals
for select
to authenticated
using (
  public.app_is_admin()
  or exists (
    select 1
    from public.loyalty_members m
    where (m.id = member_referrals.referrer_member_id or m.id = member_referrals.referee_member_id)
      and lower(m.email) = lower(public.app_current_email())
  )
);

drop policy if exists member_referrals_insert on public.member_referrals;
create policy member_referrals_insert
on public.member_referrals
for insert
to authenticated
with check (
  public.app_is_admin()
  or exists (
    select 1
    from public.loyalty_members m
    where m.id = member_referrals.referrer_member_id
      and lower(m.email) = lower(public.app_current_email())
  )
);

drop policy if exists member_referrals_update on public.member_referrals;
create policy member_referrals_update
on public.member_referrals
for update
to authenticated
using (
  public.app_is_admin()
  or exists (
    select 1
    from public.loyalty_members m
    where (m.id = member_referrals.referrer_member_id or m.id = member_referrals.referee_member_id)
      and lower(m.email) = lower(public.app_current_email())
  )
)
with check (
  public.app_is_admin()
  or exists (
    select 1
    from public.loyalty_members m
    where (m.id = member_referrals.referrer_member_id or m.id = member_referrals.referee_member_id)
      and lower(m.email) = lower(public.app_current_email())
  )
);

drop policy if exists member_birthday_rewards_select on public.member_birthday_rewards;
create policy member_birthday_rewards_select
on public.member_birthday_rewards
for select
to authenticated
using (
  public.app_is_admin()
  or exists (
    select 1
    from public.loyalty_members m
    where m.id = member_birthday_rewards.member_id
      and lower(m.email) = lower(public.app_current_email())
  )
);

drop policy if exists member_birthday_rewards_insert_admin on public.member_birthday_rewards;
create policy member_birthday_rewards_insert_admin
on public.member_birthday_rewards
for insert
to authenticated
with check (public.app_is_admin());

drop policy if exists profile_photos_read on storage.objects;
create policy profile_photos_read
on storage.objects
for select
to authenticated
using (bucket_id = 'profile-photos');

drop policy if exists profile_photos_insert on storage.objects;
create policy profile_photos_insert
on storage.objects
for insert
to authenticated
with check (bucket_id = 'profile-photos');

drop policy if exists profile_photos_update on storage.objects;
create policy profile_photos_update
on storage.objects
for update
to authenticated
using (bucket_id = 'profile-photos')
with check (bucket_id = 'profile-photos');

create or replace function public.loyalty_resolve_tier(p_points int)
returns text
language plpgsql
stable
as $$
declare
  v_tier text;
begin
  select tier_label
  into v_tier
  from public.points_rules
  where is_active = true
    and p_points >= min_points
  order by min_points desc
  limit 1;

  return coalesce(v_tier, 'Bronze');
end;
$$;

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
    m.manual_segment,
    coalesce(
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
  left join latest_activity la on la.member_id = m.id;
$$;

create or replace function public.loyalty_assign_referral_code()
returns trigger
language plpgsql
as $$
begin
  update public.loyalty_members
  set referral_code = 'REF' || regexp_replace(coalesce(member_number, ''), '\D', '', 'g')
  where id = new.id
    and coalesce(trim(referral_code), '') = ''
    and coalesce(trim(member_number), '') <> '';
  return new;
end;
$$;

drop trigger if exists trg_loyalty_assign_referral_code on public.loyalty_members;
create trigger trg_loyalty_assign_referral_code
after insert on public.loyalty_members
for each row
execute function public.loyalty_assign_referral_code();

update public.loyalty_members
set referral_code = 'REF' || regexp_replace(coalesce(member_number, ''), '\D', '', 'g')
where coalesce(trim(referral_code), '') = ''
  and coalesce(trim(member_number), '') <> '';

create or replace function public.loyalty_create_referral_invite(
  p_referrer_member_number text,
  p_referee_email text
)
returns public.member_referrals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referrer public.loyalty_members%rowtype;
  v_referral public.member_referrals%rowtype;
begin
  select *
  into v_referrer
  from public.loyalty_members
  where member_number = p_referrer_member_number
  limit 1;

  if v_referrer is null then
    raise exception 'Referrer member not found';
  end if;

  if lower(coalesce(v_referrer.email, '')) = lower(trim(coalesce(p_referee_email, ''))) then
    raise exception 'Self-referral is not allowed';
  end if;

  insert into public.member_referrals (
    referrer_member_id,
    referrer_code,
    referee_email,
    status
  )
  values (
    v_referrer.id,
    v_referrer.referral_code,
    lower(trim(p_referee_email)),
    'pending'
  )
  on conflict (referrer_member_id, referee_email_normalized)
  do update set
    referrer_code = excluded.referrer_code
  returning * into v_referral;

  return v_referral;
end;
$$;

create or replace function public.loyalty_apply_referral(
  p_referral_code text,
  p_referee_member_number text,
  p_referee_email text
)
returns table (
  applied boolean,
  referral_id bigint,
  referrer_member_number text,
  referrer_points integer,
  referee_points integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referrer public.loyalty_members%rowtype;
  v_referee public.loyalty_members%rowtype;
  v_referral public.member_referrals%rowtype;
  v_existing_bonus public.member_referrals%rowtype;
  v_referrer_tx_id bigint;
  v_referee_tx_id bigint;
begin
  select * into v_referrer
  from public.loyalty_members
  where lower(referral_code) = lower(trim(coalesce(p_referral_code, '')))
  limit 1;

  if v_referrer is null then
    return query select false, null::bigint, null::text, 0, 0;
    return;
  end if;

  select * into v_referee
  from public.loyalty_members
  where member_number = p_referee_member_number
     or lower(email) = lower(trim(coalesce(p_referee_email, '')))
  limit 1;

  if v_referee is null then
    return query select false, null::bigint, null::text, null::integer, null::integer;
    return;
  end if;

  if v_referrer.id = v_referee.id then
    return query select false, null::bigint, v_referrer.member_number::text, 0, 0;
    return;
  end if;

  select *
  into v_existing_bonus
  from public.member_referrals mr
  where (
      mr.referee_member_id = v_referee.id
      or mr.referee_email_normalized = lower(trim(v_referee.email))
    )
    and coalesce(mr.bonus_awarded, false) = true
  limit 1;

  if v_existing_bonus is not null then
    return query select false, v_existing_bonus.id, v_referrer.member_number::text, 0, 0;
    return;
  end if;

  insert into public.member_referrals (
    referrer_member_id,
    referrer_code,
    referee_email,
    referee_member_id,
    status,
    converted_at
  )
  values (
    v_referrer.id,
    v_referrer.referral_code,
    lower(trim(v_referee.email)),
    v_referee.id,
    'joined',
    now()
  )
  on conflict (referrer_member_id, referee_email_normalized)
  do update set
    referee_member_id = excluded.referee_member_id,
    status = 'joined',
    converted_at = coalesce(public.member_referrals.converted_at, now())
  returning * into v_referral;

  if coalesce(v_referral.bonus_awarded, false) = true then
    return query select true, v_referral.id, v_referrer.member_number::text, 0, 0;
    return;
  end if;

  insert into public.loyalty_transactions (member_id, transaction_type, points, reason, receipt_id)
  values (
    v_referrer.id,
    'MANUAL_AWARD',
    500,
    format('Referral bonus (referral #%s)', v_referral.id),
    format('REFERRAL-REFERRER-%s', v_referral.id)
  )
  on conflict (receipt_id) do nothing
  returning id into v_referrer_tx_id;

  insert into public.loyalty_transactions (member_id, transaction_type, points, reason, receipt_id)
  values (
    v_referee.id,
    'MANUAL_AWARD',
    200,
    format('Referral welcome bonus (referral #%s)', v_referral.id),
    format('REFERRAL-REFEREE-%s', v_referral.id)
  )
  on conflict (receipt_id) do nothing
  returning id into v_referee_tx_id;

  if v_referrer_tx_id is null then
    select id into v_referrer_tx_id
    from public.loyalty_transactions
    where receipt_id = format('REFERRAL-REFERRER-%s', v_referral.id)
    limit 1;
  end if;

  if v_referee_tx_id is null then
    select id into v_referee_tx_id
    from public.loyalty_transactions
    where receipt_id = format('REFERRAL-REFEREE-%s', v_referral.id)
    limit 1;
  end if;

  update public.member_referrals
  set bonus_awarded = (v_referrer_tx_id is not null and v_referee_tx_id is not null),
      referrer_bonus_txn_id = v_referrer_tx_id,
      referee_bonus_txn_id = v_referee_tx_id
  where id = v_referral.id;

  return query select true, v_referral.id, v_referrer.member_number::text, 500, 200;
end;
$$;

create or replace function public.loyalty_process_birthday_rewards(p_run_date date default current_date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year integer := extract(year from p_run_date)::integer;
  v_count integer := 0;
  v_points integer;
  v_voucher_code text;
  v_reward_id bigint;
  r record;
begin
  if extract(day from p_run_date)::integer <> 1 then
    return 0;
  end if;

  for r in
    select m.*
    from public.loyalty_members m
    where m.birthdate is not null
      and extract(month from m.birthdate)::integer = extract(month from p_run_date)::integer
      and not exists (
        select 1
        from public.member_birthday_rewards b
        where b.member_id = m.id
          and b.reward_year = v_year
      )
  loop
    v_points := case lower(coalesce(r.tier, 'bronze'))
      when 'gold' then 1000
      when 'silver' then 500
      else 100
    end;

    v_voucher_code := format('BDAY-%s-%s', v_year, lpad(r.id::text, 6, '0'));
    v_reward_id := null;

    insert into public.member_birthday_rewards (
      member_id, reward_year, tier_at_award, points_awarded, voucher_code, voucher_expires_at, source
    )
    values (
      r.id, v_year, coalesce(r.tier, 'Bronze'), v_points, v_voucher_code, (p_run_date + interval '30 days')::date, 'auto'
    )
    on conflict (member_id, reward_year) do nothing
    returning id into v_reward_id;

    if v_reward_id is null then
      continue;
    end if;

    insert into public.loyalty_transactions (member_id, transaction_type, points, reason, receipt_id)
    values (
      r.id,
      'MANUAL_AWARD',
      v_points,
      format('Birthday reward (%s)', v_year),
      format('BIRTHDAY-%s-%s', v_year, r.id)
    )
    on conflict (receipt_id) do nothing;

    insert into public.notification_outbox (user_id, channel, subject, message, is_promotional)
    select
      u.id,
      'email',
      'Happy Birthday from Central Perk!',
      format(
        'Hi %s! Happy birthday month. We credited %s bonus points and unlocked voucher %s (valid until %s).',
        coalesce(r.first_name, 'Member'),
        v_points,
        v_voucher_code,
        (p_run_date + interval '30 days')::date
      ),
      false
    from auth.users u
    where lower(u.email) = lower(r.email)
    on conflict do nothing;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

create or replace function public.loyalty_claim_birthday_reward(
  p_member_number text,
  p_fallback_email text default null
)
returns table (
  granted boolean,
  points_awarded integer,
  voucher_code text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.loyalty_members%rowtype;
  v_year integer := extract(year from current_date)::integer;
  v_points integer;
  v_voucher_code text;
  v_reward_id bigint;
begin
  select * into v_member
  from public.loyalty_members
  where member_number = p_member_number
     or (p_fallback_email is not null and lower(email) = lower(p_fallback_email))
  limit 1;

  if v_member is null or v_member.birthdate is null then
    return query select false, 0, null::text;
    return;
  end if;

  if extract(month from v_member.birthdate)::integer <> extract(month from current_date)::integer then
    return query select false, 0, null::text;
    return;
  end if;

  if exists (
    select 1 from public.member_birthday_rewards
    where member_id = v_member.id and reward_year = v_year
  ) then
    return query
    select true, b.points_awarded, b.voucher_code
    from public.member_birthday_rewards b
    where b.member_id = v_member.id and b.reward_year = v_year
    limit 1;
    return;
  end if;

  v_points := case lower(coalesce(v_member.tier, 'bronze'))
    when 'gold' then 1000
    when 'silver' then 500
    else 100
  end;
  v_voucher_code := format('BDAY-%s-%s', v_year, lpad(v_member.id::text, 6, '0'));
  v_reward_id := null;

  insert into public.member_birthday_rewards (
    member_id, reward_year, tier_at_award, points_awarded, voucher_code, voucher_expires_at, source
  )
  values (
    v_member.id, v_year, coalesce(v_member.tier, 'Bronze'), v_points, v_voucher_code, (current_date + interval '30 days')::date, 'manual'
  )
  on conflict (member_id, reward_year) do nothing
  returning id into v_reward_id;

  if v_reward_id is null then
    return query
    select true, b.points_awarded, b.voucher_code
    from public.member_birthday_rewards b
    where b.member_id = v_member.id and b.reward_year = v_year
    limit 1;
    return;
  end if;

  insert into public.loyalty_transactions (member_id, transaction_type, points, reason, receipt_id)
  values (
    v_member.id,
    'MANUAL_AWARD',
    v_points,
    format('Birthday reward (%s)', v_year),
    format('BIRTHDAY-%s-%s', v_year, v_member.id)
  )
  on conflict (receipt_id) do nothing;

  return query select true, v_points, v_voucher_code;
end;
$$;

-- ============================================================
-- NOTIFICATION TRIGGERS
-- ============================================================

create or replace function public.loyalty_enforce_notification_preferences()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  pref record;
  recent_promotional_count integer := 0;
begin
  if new.user_id is null then
    return new;
  end if;

  select
    m.sms_enabled,
    m.email_enabled,
    m.push_enabled,
    m.promotional_opt_in,
    m.communication_frequency
  into pref
  from auth.users u
  join public.loyalty_members m on lower(m.email) = lower(u.email)
  where u.id = new.user_id
  limit 1;

  if pref is null then
    return new;
  end if;

  if coalesce(new.is_promotional, false) = false then
    return new;
  end if;

  if new.channel = 'sms' and coalesce(pref.sms_enabled, true) = false then return null; end if;
  if new.channel = 'email' and coalesce(pref.email_enabled, true) = false then return null; end if;
  if new.channel = 'push' and coalesce(pref.push_enabled, true) = false then return null; end if;
  if coalesce(pref.promotional_opt_in, true) = false then return null; end if;
  if coalesce(pref.communication_frequency, 'weekly') = 'never' then return null; end if;

  if coalesce(pref.communication_frequency, 'weekly') = 'daily' then
    select count(*)
    into recent_promotional_count
    from public.notification_outbox n
    where n.user_id = new.user_id
      and n.channel = new.channel
      and coalesce(n.is_promotional, false) = true
      and n.created_at >= date_trunc('day', now());
  elsif coalesce(pref.communication_frequency, 'weekly') = 'weekly' then
    select count(*)
    into recent_promotional_count
    from public.notification_outbox n
    where n.user_id = new.user_id
      and n.channel = new.channel
      and coalesce(n.is_promotional, false) = true
      and n.created_at >= (now() - interval '7 days');
  end if;

  if recent_promotional_count > 0 then
    return null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_notification_preferences on public.notification_outbox;
create trigger trg_enforce_notification_preferences
before insert on public.notification_outbox
for each row
execute function public.loyalty_enforce_notification_preferences();

create or replace function public.loyalty_queue_welcome_notifications()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user_id uuid;
begin
  select id into target_user_id
  from auth.users
  where lower(email) = lower(new.email)
  limit 1;

  if target_user_id is not null then
    insert into public.notification_outbox (user_id, channel, subject, message)
    values
      (
        target_user_id,
        'sms',
        'Welcome',
        format('Welcome to GREENOVATE Rewards! Your Member ID is %s. You start with 0 points.', coalesce(new.member_number, 'Pending ID'))
      ),
      (
        target_user_id,
        'email',
        'Welcome to GREENOVATE Rewards',
        format(
          'Hi %s, welcome to GREENOVATE Rewards! Your Member ID is %s. Program basics: earn points on purchases, redeem rewards in-app, and monitor expiry alerts in your dashboard.',
          coalesce(new.first_name, 'Member'),
          coalesce(new.member_number, 'Pending ID')
        )
      );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_welcome_notification on public.loyalty_members;
create trigger trg_welcome_notification
after insert on public.loyalty_members
for each row
execute function public.loyalty_queue_welcome_notifications();

create or replace function public.loyalty_queue_profile_update_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user_id uuid;
begin
  if (
    old.first_name is distinct from new.first_name
    or old.last_name is distinct from new.last_name
    or old.email is distinct from new.email
    or old.phone is distinct from new.phone
    or old.birthdate is distinct from new.birthdate
    or old.address is distinct from new.address
    or old.profile_photo_url is distinct from new.profile_photo_url
  ) then
    select id into target_user_id
    from auth.users
    where lower(email) = lower(new.email)
    limit 1;

    insert into public.notification_outbox (user_id, channel, subject, message)
    values (
      coalesce(target_user_id, auth.uid()),
      'email',
      'Profile Updated',
      format('Hi %s, your loyalty profile was updated on %s.', coalesce(new.first_name, 'member'), now()::text)
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_profile_update_notification on public.loyalty_members;
create trigger trg_profile_update_notification
after update on public.loyalty_members
for each row
execute function public.loyalty_queue_profile_update_notification();

create or replace function public.loyalty_queue_transaction_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user_id uuid;
  target_email text;
  target_member_number text;
  action_word text;
begin
  select email, member_number
  into target_email, target_member_number
  from public.loyalty_members
  where id = new.member_id;

  select id into target_user_id
  from auth.users
  where lower(email) = lower(target_email)
  limit 1;

  if new.points > 0 then
    action_word := 'earned';
  else
    action_word := 'spent';
  end if;

  if target_user_id is not null then
    insert into public.notification_outbox (user_id, channel, subject, message)
    values (
      target_user_id,
      'push',
      'Points Update',
      format('You just %s %s points. Reason: %s', action_word, abs(new.points), coalesce(new.reason, 'Transaction'))
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_transaction_notification on public.loyalty_transactions;
create trigger trg_transaction_notification
after insert on public.loyalty_transactions
for each row
execute function public.loyalty_queue_transaction_notification();

-- ============================================================
-- BALANCE, AUDIT, FIFO, EXPIRY, AND TIER TRIGGERS
-- ============================================================

create or replace function public.loyalty_update_member_balance()
returns trigger
language plpgsql
as $$
declare
  new_balance int;
begin
  update public.loyalty_members
  set points_balance = points_balance + new.points
  where id = new.member_id
  returning points_balance into new_balance;

  update public.loyalty_members
  set tier = public.loyalty_resolve_tier(new_balance)
  where id = new.member_id;

  return new;
end;
$$;

drop trigger if exists trg_update_balance_on_tx on public.loyalty_transactions;
create trigger trg_update_balance_on_tx
after insert on public.loyalty_transactions
for each row
execute function public.loyalty_update_member_balance();

create or replace function public.loyalty_log_profile_update()
returns trigger
language plpgsql
as $$
begin
  insert into public.loyalty_member_profile_audit (member_id, changed_by, old_data, new_data)
  values (old.id, auth.uid(), to_jsonb(old), to_jsonb(new));
  return new;
end;
$$;

drop trigger if exists trg_profile_audit on public.loyalty_members;
create trigger trg_profile_audit
after update on public.loyalty_members
for each row
execute function public.loyalty_log_profile_update();

create or replace function public.loyalty_build_lot_on_earn()
returns trigger
language plpgsql
as $$
begin
  if new.points > 0 and upper(coalesce(new.transaction_type, '')) in ('PURCHASE', 'EARN', 'MANUAL_AWARD') then
    insert into public.points_lots (member_id, source_transaction_id, original_points, remaining_points, earned_at, expiry_date)
    values (
      new.member_id,
      new.id,
      new.points,
      new.points,
      coalesce(new.transaction_date, now()),
      coalesce(new.expiry_date, coalesce(new.transaction_date, now()) + interval '12 months')
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_points_lot_on_earn on public.loyalty_transactions;
create trigger trg_points_lot_on_earn
after insert on public.loyalty_transactions
for each row
execute function public.loyalty_build_lot_on_earn();

create or replace function public.loyalty_consume_lot_on_spend()
returns trigger
language plpgsql
as $$
declare
  remaining int := abs(new.points);
  lot record;
  consume_now int;
begin
  if new.points >= 0 then
    return new;
  end if;

  for lot in
    select id, remaining_points
    from public.points_lots
    where member_id = new.member_id
      and remaining_points > 0
    order by expiry_date asc, earned_at asc, id asc
  loop
    exit when remaining <= 0;
    consume_now := least(lot.remaining_points, remaining);

    update public.points_lots
    set remaining_points = remaining_points - consume_now
    where id = lot.id;

    remaining := remaining - consume_now;
  end loop;

  if remaining > 0 then
    raise exception 'Insufficient points for redemption.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_points_lot_on_spend on public.loyalty_transactions;
create trigger trg_points_lot_on_spend
before insert on public.loyalty_transactions
for each row
execute function public.loyalty_consume_lot_on_spend();

create or replace function public.loyalty_consume_points_fifo(
  p_member_id bigint,
  p_points_to_consume int,
  p_reason text default 'Reward Redemption'
)
returns int
language plpgsql
as $$
begin
  return 0;
end;
$$;

create or replace function public.loyalty_queue_expiry_warning_notifications()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  queued_count integer := 0;
begin
  with expiring_lots as (
    select
      l.member_id,
      m.email,
      sum(l.remaining_points)::integer as points_expiring,
      min(l.expiry_date)::date as nearest_expiry
    from public.points_lots l
    join public.loyalty_members m on m.id = l.member_id
    where l.remaining_points > 0
      and l.expiry_date::date = (current_date + interval '30 days')::date
    group by l.member_id, m.email
  ), inserted as (
    insert into public.notification_outbox (user_id, channel, subject, message)
    select
      u.id,
      'email',
      'Points Expiry Reminder',
      format('You have %s points expiring on %s. Redeem them before expiry.', e.points_expiring, e.nearest_expiry)
    from expiring_lots e
    left join auth.users u on lower(u.email) = lower(e.email)
    returning 1
  )
  select count(*) into queued_count from inserted;

  return queued_count;
end;
$$;

create extension if not exists pg_cron;

do $cron$
declare
  existing_job_id integer;
  birthday_job_id integer;
begin
  begin
    select jobid
    into existing_job_id
    from cron.job
    where jobname = 'loyalty_expiry_warning_30d_daily'
    limit 1;

    if existing_job_id is not null then
      perform cron.unschedule(existing_job_id);
    end if;

    perform cron.schedule(
      'loyalty_expiry_warning_30d_daily',
      '0 8 * * *',
      $job$select public.loyalty_queue_expiry_warning_notifications();$job$
    );
  exception
    when undefined_table then
      null;
  end;

  begin
    select jobid
    into birthday_job_id
    from cron.job
    where jobname = 'loyalty_birthday_rewards_daily'
    limit 1;

    if birthday_job_id is not null then
      perform cron.unschedule(birthday_job_id);
    end if;

    perform cron.schedule(
      'loyalty_birthday_rewards_daily',
      '5 8 * * *',
      $job$select public.loyalty_process_birthday_rewards(current_date);$job$
    );
  exception
    when undefined_table then
      null;
  end;
end;
$cron$;

create or replace function public.log_tier_change()
returns trigger
language plpgsql
as $$
begin
  if coalesce(old.tier, 'Bronze') is distinct from coalesce(new.tier, 'Bronze') then
    insert into public.tier_history (member_id, old_tier, new_tier, changed_at, reason)
    values (
      new.id,
      coalesce(old.tier, 'Bronze'),
      coalesce(new.tier, 'Bronze'),
      now(),
      'Auto tier recalculation'
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_log_tier_change on public.loyalty_members;
create trigger trg_log_tier_change
after update on public.loyalty_members
for each row
execute function public.log_tier_change();

commit;
