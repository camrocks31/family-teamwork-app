-- Our Family Hub — make a newly created function private by default, for real
-- this time.
--
-- RETRACTION. 20261114020000_function_grants.sql states, in its own comments
-- and in the test beside it, that PostgreSQL cannot be made to withhold the
-- built-in PUBLIC grant on new functions — that
-- `alter default privileges ... revoke execute on functions from public` is
-- silently discarded. That claim is WRONG, and independent review caught it.
--
-- What is true is narrower: the revocation is discarded when it is scoped to a
-- schema with `IN SCHEMA`, which is how it was written and how it was tested.
-- Issued GLOBALLY for the role — no `IN SCHEMA` — it works. Schema-scoped and
-- global default privileges are additive, and the global entry is the one that
-- can remove PUBLIC. Measured on PostgreSQL 17.11:
--
--   alter default privileges for role postgres
--     revoke execute on functions from public;
--   create function g1.probe() ...;
--   -> proacl {postgres=X/postgres}, has_function_privilege('anon', ...) = f
--
-- and in `public`, where the schema-scoped entry already strips anon and
-- authenticated, a new function comes out as
-- {postgres=X/postgres,service_role=X/postgres} with anon false.
--
-- So the gap the previous migration documented as unavoidable is in fact
-- closed here, and a function added by a later migration is private until
-- someone grants it deliberately. The exhaustive test in
-- tests/db/grants.test.ts stays, because a default is a safety net and a named
-- list is a decision — but it is no longer the only thing standing between a
-- forgotten revoke and an open function.

do $$
begin
  execute format(
    'alter default privileges for role %I revoke execute on functions from public',
    current_user);
end
$$;
