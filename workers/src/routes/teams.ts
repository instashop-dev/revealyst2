import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRepos } from "../db/index.js";
import { getDb } from "../db.js";
import { requireAuth, signMagicToken } from "../auth.js";
import { sendTeamInviteEmail } from "../email.js";
import { createRateLimiter, rateLimit } from "../rate-limit.js";
import type { AppEnv } from "../env.js";

const errorResponse = z.object({ error: z.string(), message: z.string() });

const teamCard = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  anonymize_identities: z.boolean(),
});

const memberCard = z.object({
  user_id: z.string(),
  role: z.string(),
  anon_alias: z.string().nullable(),
  opt_in_identifiable: z.boolean(),
  /** First name + last initial (identifiable mode) or pseudonym. */
  display_name: z.string(),
});

const createTeamRoute = createRoute({
  method: "post",
  path: "/api/team",
  middleware: [requireAuth],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ name: z.string().trim().min(1).max(80) }),
        },
      },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: teamCard } },
      description: "Team created — creator becomes manager",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/api/teams",
  middleware: [requireAuth],
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ teams: z.array(teamCard) }) } },
      description: "Teams the user belongs to",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
  },
});

const inviteLimiter = rateLimit(createRateLimiter(5, 60_000), 5);

const inviteRoute = createRoute({
  method: "post",
  path: "/api/team/invite",
  middleware: [requireAuth, inviteLimiter],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ team_id: z.string().uuid(), email: z.string().email() }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ message: z.string(), dev_link: z.string().optional() }),
        },
      },
      description: "Invite sent (uniform 200 — delivery is server-side)",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: errorResponse } },
      description: "Not a team manager",
    },
  },
});

const membersRoute = createRoute({
  method: "get",
  path: "/api/team/members",
  middleware: [requireAuth],
  request: { query: z.object({ team_id: z.string().uuid() }) },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            members: z.array(memberCard),
            anonymize_identities: z.boolean(),
            identifiable_enabled: z.boolean(),
          }),
        },
      },
      description: "Team members (pseudonymised unless identifiable mode is fully opted in)",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: errorResponse } },
      description: "Not a team member",
    },
  },
});

const optInRoute = createRoute({
  method: "post",
  path: "/api/team/opt-in",
  middleware: [requireAuth],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ team_id: z.string().uuid(), enabled: z.boolean() }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ opt_in_identifiable: z.boolean(), identifiable_enabled: z.boolean() }),
        },
      },
      description: "Opt-in recorded",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: errorResponse } },
      description: "Not a team member",
    },
  },
});

const settingsRoute = createRoute({
  method: "patch",
  path: "/api/team/settings",
  middleware: [requireAuth],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            team_id: z.string().uuid(),
            anonymize_identities: z.boolean(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: teamCard } },
      description: "Settings updated (manager only)",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: errorResponse } },
      description: "Not a team manager",
    },
  },
});

export const teamRoutes = new OpenAPIHono<AppEnv>();

teamRoutes.openapi(createTeamRoute, async (c) => {
  const { name } = c.req.valid("json");
  const db = await getDb(c.env);
  const repos = createRepos(db);
  const team = await repos.teams.create(name, c.var.userId);
  await repos.teams.addMember(team.id, c.var.userId, "manager", "User_A");
  return c.json(
    {
      id: team.id,
      name: team.name,
      role: "manager",
      anonymize_identities: true,
    },
    201,
  );
});

teamRoutes.openapi(listRoute, async (c) => {
  const db = await getDb(c.env);
  const repos = createRepos(db);
  const memberships = await repos.teams.listForUser(c.var.userId);
  return c.json(
    {
      teams: memberships.map(({ team, member }) => ({
        id: team.id,
        name: team.name,
        role: member.role,
        anonymize_identities:
          (team.settings as { anonymize_identities?: boolean } | null)?.anonymize_identities !==
          false,
      })),
    },
    200,
  );
});

teamRoutes.openapi(inviteRoute, async (c) => {
  const { team_id, email: rawEmail } = c.req.valid("json");
  const email = rawEmail.trim().toLowerCase();
  const db = await getDb(c.env);
  const repos = createRepos(db);

  if (!(await repos.teams.isManager(team_id, c.var.userId))) {
    return c.json({ error: "forbidden", message: "Only managers can invite members" }, 403);
  }

  let user = await repos.users.findByEmail(email);
  if (!user) user = await repos.users.create(email);

  const magicToken = await signMagicToken(user.id, user.email, c.env.JWT_SECRET, team_id);
  try {
    await repos.magic.insert(magicToken.jti, user.id, magicToken.expiresAt);
  } catch (err) {
    console.error("[teams] invite magic link jti insert failed:", err);
  }
  const devLink = `${c.env.APP_URL}/auth/verify?token=${magicToken.token}`;

  if (c.env.DEV_MODE === "true") {
    console.log(`[teams] dev invite link for ${email}: ${devLink}`);
    return c.json({ message: "invite sent", dev_link: devLink }, 200);
  }

  if (c.env.SES_ACCESS_KEY_ID && c.env.SES_SECRET_ACCESS_KEY) {
    const team = await repos.teams.findById(team_id);
    try {
      await sendTeamInviteEmail(
        {
          region: c.env.SES_REGION ?? "us-east-1",
          accessKeyId: c.env.SES_ACCESS_KEY_ID,
          secretAccessKey: c.env.SES_SECRET_ACCESS_KEY,
          fromEmail: c.env.SES_FROM_EMAIL ?? "Revealyst <noreply@e.revealyst.com>",
        },
        { to: email, magicLink: devLink, teamName: team?.name ?? "your team" },
      );
      console.log("[teams] team invite emailed via SES");
    } catch (err) {
      console.error("[teams] team invite email send failed:", err);
    }
  } else {
    console.error("[teams] SES is not configured — cannot deliver team invite");
  }
  return c.json({ message: "invite sent" }, 200);
});

teamRoutes.openapi(membersRoute, async (c) => {
  const { team_id } = c.req.valid("query");
  const db = await getDb(c.env);
  const repos = createRepos(db);
  const member = await repos.teams.findMember(team_id, c.var.userId);
  if (!member)
    return c.json({ error: "forbidden", message: "You are not a member of this team" }, 403);

  const team = await repos.teams.findById(team_id);
  const anonymize =
    (team?.settings as { anonymize_identities?: boolean } | null)?.anonymize_identities !== false;
  const allOptedIn = await repos.teams.allOptedIn(team_id);
  const identifiable = !anonymize && allOptedIn;

  const members = await repos.teams.listMembersWithUsers(team_id);
  return c.json(
    {
      members: members.map((m) => ({
        user_id: m.user_id,
        role: m.role,
        anon_alias: m.anon_alias,
        opt_in_identifiable: m.opt_in_identifiable,
        display_name: identifiable
          ? displayNameFromEmail(m.email, m.anon_alias)
          : (m.anon_alias ?? "Member"),
      })),
      anonymize_identities: anonymize,
      identifiable_enabled: identifiable,
    },
    200,
  );
});

teamRoutes.openapi(optInRoute, async (c) => {
  const { team_id, enabled } = c.req.valid("json");
  const db = await getDb(c.env);
  const repos = createRepos(db);
  if (!(await repos.teams.findMember(team_id, c.var.userId))) {
    return c.json({ error: "forbidden", message: "You are not a member of this team" }, 403);
  }
  await repos.teams.setOptIn(team_id, c.var.userId, enabled);
  const allOptedIn = await repos.teams.allOptedIn(team_id);
  const team = await repos.teams.findById(team_id);
  const anonymize =
    (team?.settings as { anonymize_identities?: boolean } | null)?.anonymize_identities !== false;
  return c.json(
    { opt_in_identifiable: enabled, identifiable_enabled: !anonymize && allOptedIn },
    200,
  );
});

teamRoutes.openapi(settingsRoute, async (c) => {
  const { team_id, anonymize_identities } = c.req.valid("json");
  const db = await getDb(c.env);
  const repos = createRepos(db);
  if (!(await repos.teams.isManager(team_id, c.var.userId))) {
    return c.json({ error: "forbidden", message: "Only team managers can change settings" }, 403);
  }
  const team = await repos.teams.updateSettings(team_id, { anonymize_identities });
  return c.json(
    {
      id: team.id,
      name: team.name,
      role: "manager",
      anonymize_identities:
        (team.settings as { anonymize_identities?: boolean } | null)?.anonymize_identities !==
        false,
    },
    200,
  );
});

/**
 * Identifiable-mode display name: first name + last initial derived from the
 * email local part (spec §5.5: even identifiable mode shows only
 * "First LastInitial." — never a full email). Falls back to the pseudonym.
 */
export function displayNameFromEmail(email: string, fallback: string | null): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._\-+]+/).filter(Boolean);
  if (parts.length === 0) return fallback ?? "Member";
  const first = parts[0] ?? "";
  const initial = parts.length > 1 ? ((parts[1] ?? "")[0] ?? first[0] ?? "") : (first[0] ?? "");
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  return parts.length > 1 ? `${capitalize(first)} ${initial.toUpperCase()}.` : capitalize(first);
}
