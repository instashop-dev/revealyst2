-- 004_rating.sql — spec §5.4: the personal Prompt History list shows a rating
-- per prompt (thumbs up/down from the extension). Stored only as -1/0/1
-- (down / neutral / up; validated by the API zod schema); anonymous events
-- keep NULL (no interaction recorded).
ALTER TABLE prompt_events ADD COLUMN rating SMALLINT;
