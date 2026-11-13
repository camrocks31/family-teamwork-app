-- Reverse of 20261114000100_actor_transitions.sql.
drop function if exists add_shopping_item(shopping_list_kind, text, text, integer, text, text);
drop function if exists mark_task_not_needed(uuid, uuid, integer, text);
drop function if exists exempt_task_instance(uuid, text, uuid, integer, text);
drop function if exists return_task_instance(uuid, text, uuid, integer, text);
drop function if exists approve_task_instance(uuid, uuid, integer, text);
drop function if exists complete_task_instance(uuid, uuid, integer, text);
drop function if exists submit_task_instance(uuid, uuid, integer, text);
drop function if exists start_task_instance(uuid, uuid, integer, text);
drop function if exists app_apply_transition(uuid, text, uuid, integer, text, text);
