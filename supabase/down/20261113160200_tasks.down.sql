-- Reverse of 20261113160200_tasks.sql.
--
-- task_definitions and task_definition_revisions reference each other: a
-- definition points at its current revision, and a revision belongs to a
-- definition. The deferred constraint has to go before either table can be
-- dropped, which is why this is not a plain reverse-order list.

alter table task_definitions
  drop constraint if exists task_definitions_current_revision_fk;

drop table if exists task_photos;
drop table if exists task_events;
drop table if exists task_instances;
drop table if exists task_assignments;
drop table if exists task_definition_criteria;
drop table if exists task_definition_revisions;
drop table if exists task_definitions;
