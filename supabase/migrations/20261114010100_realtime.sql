-- Our Family Hub — publish the tables the dashboard listens to.
--
-- Supabase's realtime works off the `supabase_realtime` publication, and a
-- newly created table is NOT in it. Everything looked right without this —
-- the client subscribed, the channel reported SUBSCRIBED, no error anywhere —
-- and the iPad simply never heard about a completed task. Found by the
-- end-to-end test for the brief's first acceptance scenario, which is the only
-- thing that could have found it.
--
-- Row level security still applies to what each subscriber receives, so this
-- publishes the change, it does not widen who can see it.

do $$
declare
  t text;
begin
  foreach t in array array['task_instances', 'shopping_items', 'calendar_events']
  loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;

-- Realtime sends only the primary key for an UPDATE unless the table is set
-- to replicate the full row. The dashboard refetches rather than patching, so
-- the payload is not needed — but DELETE events carry nothing identifiable
-- without this, and a deleted task would go unnoticed.
alter table task_instances replica identity full;
alter table shopping_items replica identity full;
alter table calendar_events replica identity full;
