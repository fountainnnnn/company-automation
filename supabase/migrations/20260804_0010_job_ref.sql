-- A record should be a THING with a number the worker can quote back to the
-- office ("check CL-20260804-007"), not an anonymous row.
alter table public.reports add column job_ref text unique;
create index reports_job_ref_idx on public.reports (job_ref);

-- Per-day sequence, assigned on insert: CL-YYYYMMDD-NNN
create or replace function public.tg_assign_job_ref()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  if new.job_ref is null then
    select count(*) + 1 into n
      from public.reports
     where report_date = new.report_date;
    new.job_ref := 'CL-' || to_char(new.report_date, 'YYYYMMDD') || '-' || lpad(n::text, 3, '0');
  end if;
  return new;
end $$;

create trigger reports_assign_job_ref
  before insert on public.reports
  for each row execute function public.tg_assign_job_ref();

revoke execute on function public.tg_assign_job_ref() from public, anon, authenticated;

with numbered as (
  select id, report_date,
         row_number() over (partition by report_date order by id) as rn
    from public.reports where job_ref is null
)
update public.reports r
   set job_ref = 'CL-' || to_char(n.report_date, 'YYYYMMDD') || '-' || lpad(n.rn::text, 3, '0')
  from numbered n where r.id = n.id;
