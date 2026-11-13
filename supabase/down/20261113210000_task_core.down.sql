-- Reverse of 20261113210000_task_core.sql.
-- Policies go before the table; the function the policy references goes after.
drop policy if exists task_operations_select on task_operations;
drop table if exists task_operations;
drop function if exists ensure_day_materialized(uuid, date);
drop function if exists app_household_today(uuid);
drop function if exists app_current_member_id();
