-- Reverse of 20261113160000_enums.sql.
--
-- pgcrypto is deliberately NOT dropped: the forward migration used
-- `create extension if not exists`, so it may well have been present before
-- this schema existed. Dropping it would reverse more than this migration did.

drop type if exists schedule_rule_kind;
drop type if exists device_status;
drop type if exists calendar_visibility;
drop type if exists shopping_list_kind;
drop type if exists recurrence_kind;
drop type if exists requirement_target_kind;
drop type if exists evaluation_scope;
drop type if exists occurrence_mode;
drop type if exists not_applicable_reason;
drop type if exists task_state;
drop type if exists member_role;
