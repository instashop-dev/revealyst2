-- 005_team_invites.sql — team invites (§5.8 onboarding: manager invites
-- members by email). Applied after 004; recorded in schema_migrations.
--
-- Invites are tracked so managers can see pending invites, re-send them, and
-- revoke a link before it is used. `status` lifecycle:
--   pending  → link active (jti lives in magic_link_tokens until consumed)
--   accepted → invitee verified the link and was auto-joined as `role`
--   revoked  → manager cancelled the invite; jti consumed so the link dies
--
-- One pending invite per (team, email) is enforced in app code (a resend
-- updates the same row) — a partial unique index is avoided for pg-mem
-- compatibility in tests.

CREATE TABLE IF NOT EXISTS team_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',      -- 'member' | 'manager'
    invited_by UUID REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'accepted' | 'revoked'
    jti TEXT,                                 -- active magic-link jti (revoke consumes it)
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_invites_team ON team_invites (team_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_team_invites_email ON team_invites (email);
