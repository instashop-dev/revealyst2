-- 003_teams_personal_library.sql — spec §5.5 identifiable-mode opt-in,
-- personal-dashboard identity (own events), and library governance (§5.6).
-- Applied after 002; recorded in schema_migrations by the runner.

-- Personal dashboard identity: authenticated events are stamped with the
-- user id so /api/history and /api/stats can serve the user's own data.
-- Anonymous events keep user_id NULL (privacy-first default).
ALTER TABLE prompt_events ADD COLUMN user_id UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_prompt_events_user ON prompt_events (user_id, created_at);

-- Identifiable mode (spec §5.5): each member must explicitly opt in before
-- the dashboard may show real (first name + last initial) identities.
ALTER TABLE team_members ADD COLUMN opt_in_identifiable BOOLEAN NOT NULL DEFAULT false;

-- Library governance (spec §5.6): manager notes, Team Standard flag, and
-- last-used tracking for card metadata.
ALTER TABLE library_prompts ADD COLUMN notes TEXT;
ALTER TABLE library_prompts ADD COLUMN is_standard BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE library_prompts ADD COLUMN last_used_at TIMESTAMPTZ;
