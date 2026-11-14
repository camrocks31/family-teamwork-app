-- Reverse 20261114050000_save_task.sql.
drop function if exists set_task_active(uuid, boolean);
drop function if exists save_task(uuid, text, text[], uuid, uuid, occurrence_mode, recurrence_kind, date, text, boolean, boolean, boolean, uuid[]);
