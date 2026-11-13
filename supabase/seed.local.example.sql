-- Our Family Hub — LOCAL seed overlay (example).
--
-- Copy this file to `supabase/seed.local.sql` and put your household's real
-- names in the copy. `seed.local.sql` is gitignored and must never be
-- committed: the repository is public because GitHub Pages' free tier requires
-- it, so nothing identifying the household belongs in git (HAL-1538
-- requirement 1 and §5 Privacy).
--
-- Apply it after a reset:
--     npm run db:reset          # schema + the generic committed seed
--     npm run db:seed:local     # renames to your household, if the file exists
--
-- Only display names change. The structure, the criteria, the requirement
-- groups and the D1 decision all come from the committed seed, so the tests
-- and the real household stay in step.

begin;

-- The household itself.
update households
   set name = 'Our Family Hub'
 where name = 'Example Household';

-- People. Parents are shown as Mom and Dad rather than by their own names
-- (HAL-1538 I4); the children are shown by the first names the family uses.
update family_members set display_name = 'Dad',     avatar_emoji = '🧔' where display_name = 'Parent One';
update family_members set display_name = 'Mom',     avatar_emoji = '👩' where display_name = 'Parent Two';
update family_members set display_name = 'Eldest',  avatar_emoji = '🎨' where display_name = 'Child One';
update family_members set display_name = 'Middle',  avatar_emoji = '⚽' where display_name = 'Child Two';
update family_members set display_name = 'Youngest', avatar_emoji = '🦖' where display_name = 'Child Three';

-- The pet.
update pets set name = 'Dog' where name = 'Dog';

-- Rooms. The three bedrooms are the ones that carry real names; the rest are
-- already generic. Keep the mapping, not the meaning:
--   'Shared Bedroom'      -> the bedroom an adult shares with a child
--   'Children''s Bedroom' -> the children's own room  (gates activities, per D1)
--   'Adult Bedroom'       -> an adult's own room      (does NOT gate activities)
update household_spaces set name = 'Shared Bedroom'      where name = 'Shared Bedroom';
update household_spaces set name = 'Children''s Bedroom' where name = 'Children''s Bedroom';
update household_spaces set name = 'Adult Bedroom'       where name = 'Adult Bedroom';

commit;

-- A note on D1, so a future edit does not undo a deliberate decision:
-- renaming a room does NOT change which rooms gate the children's activities.
-- That lives in requirement_group_items, and by Cameron's decision on
-- 2026-11-13 neither adult-shared bedroom is a prerequisite. If you ever want
-- to change it, do it in Settings rather than here.
