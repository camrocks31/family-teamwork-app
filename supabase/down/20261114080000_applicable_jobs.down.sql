-- Reverse 20261114080000_applicable_jobs.sql. My jobs goes back to listing
-- tasks that do not apply, and the banner to claiming a school morning on a
-- Saturday.
drop function if exists list_my_jobs(uuid, timestamptz);
drop function if exists app_today_is_school_day();
