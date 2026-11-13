-- Reverse 20261114030100_private_by_default.sql: restore PostgreSQL's own
-- default, which grants EXECUTE on every new function to PUBLIC.
do $$
begin
  execute format(
    'alter default privileges for role %I grant execute on functions to public',
    current_user);
end
$$;
