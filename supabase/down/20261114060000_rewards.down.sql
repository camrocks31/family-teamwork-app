-- Reverse 20261114060000_rewards.sql.
drop function if exists evaluate_rewards(uuid, uuid, timestamptz);
drop table if exists rewards;
drop type if exists reward_period;
