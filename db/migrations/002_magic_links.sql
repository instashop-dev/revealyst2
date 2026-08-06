-- 002_magic_links.sql — single-use magic-link tracking (spec §6.2 auth).
-- Each magic token's jti is recorded at send time and consumed (deleted) on
-- first successful verify, so a leaked link cannot be replayed.
CREATE TABLE IF NOT EXISTS magic_link_tokens (
    jti TEXT PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_user ON magic_link_tokens (user_id);
