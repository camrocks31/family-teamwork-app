-- Reverse of 20261114010100_realtime.sql.
do $$
declare t text;
begin
  foreach t in array array['task_instances', 'shopping_items', 'calendar_events']
  loop
    if exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end
$$;
alter table task_instances replica identity default;
alter table shopping_items replica identity default;
alter table calendar_events replica identity default;
