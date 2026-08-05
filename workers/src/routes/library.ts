import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRepos } from "../db/index.js";
import { getDb } from "../db.js";
import { decryptPrompt, encryptPrompt, sha256Hex } from "../crypto.js";
import { requireAuth } from "../auth.js";
import type { AppEnv } from "../env.js";
import type { Repos } from "../db/index.js";

const errorResponse = z.object({ error: z.string(), message: z.string() });

const libraryCard = z.object({
  id: z.string(),
  title: z.string().nullable(),
  tags: z.array(z.string()),
  score: z.number().nullable(),
  usage_count: z.number(),
  version: z.number(),
  created_at: z.string(),
  contributor: z.string(),
});

const listRoute = createRoute({
  method: "get",
  path: "/api/library",
  middleware: [requireAuth],
  request: {
    query: z.object({
      team_id: z.string().uuid(),
      search: z.string().optional(),
      tag: z.string().optional(),
      min_score: z.coerce.number().optional(),
      page: z.coerce.number().int().positive().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ prompts: z.array(libraryCard), total: z.number() }),
        },
      },
      description: "Team library prompts (metadata only — encrypted bodies are never listed)",
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

const saveRequest = z.object({
  team_id: z.string().uuid(),
  prompt_text: z.string().min(1).max(20_000),
  title: z.string().max(200).optional(),
  tags: z.array(z.string().max(40)).max(10).optional(),
  score: z.number().int().min(0).max(100).optional(),
});

const saveRoute = createRoute({
  method: "post",
  path: "/api/library",
  middleware: [requireAuth],
  request: { body: { content: { "application/json": { schema: saveRequest } } } },
  responses: {
    201: { content: { "application/json": { schema: libraryCard } }, description: "Prompt saved" },
    409: {
      content: { "application/json": { schema: errorResponse } },
      description: "Duplicate (already saved)",
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

const getRoute = createRoute({
  method: "get",
  path: "/api/library/{id}",
  middleware: [requireAuth],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            prompt_text: z.string(),
            title: z.string().nullable(),
          }),
        },
      },
      description: "Decrypted prompt body (copy/send-to-LLM)",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: errorResponse } },
      description: "Not a team member",
    },
    404: { content: { "application/json": { schema: errorResponse } }, description: "Not found" },
  },
});

export const libraryRoutes = new OpenAPIHono<AppEnv>();

type MemberContext = { repos: Repos };

async function memberRepos(c: {
  env: AppEnv["Bindings"];
  var: { userId: string };
}): Promise<MemberContext> {
  const db = await getDb(c.env);
  return { repos: createRepos(db) };
}

libraryRoutes.openapi(listRoute, async (c) => {
  const query = c.req.valid("query");
  const { repos } = await memberRepos(c);
  if (!(await repos.teams.findMember(query.team_id, c.var.userId))) {
    return c.json({ error: "forbidden", message: "You are not a member of this team" }, 403);
  }
  const result = await repos.library.list(query.team_id, {
    search: query.search,
    tag: query.tag,
    minScore: query.min_score,
    page: query.page,
  });
  const memberAliases = new Map(
    (await repos.teams.listMembers(query.team_id)).map((m) => [m.user_id, m.anon_alias]),
  );
  return c.json(
    {
      prompts: result.prompts.map((p) => ({
        id: p.id,
        title: p.title,
        tags: p.tags ?? [],
        score: p.score,
        usage_count: p.usage_count,
        version: p.version,
        created_at: p.created_at,
        contributor: memberAliases.get(p.created_by ?? "") ?? "Member",
      })),
      total: result.total,
    },
    200,
  );
});

libraryRoutes.openapi(saveRoute, async (c) => {
  const body = c.req.valid("json");
  const { repos } = await memberRepos(c);
  const member = await repos.teams.findMember(body.team_id, c.var.userId);
  if (!member)
    return c.json({ error: "forbidden", message: "You are not a member of this team" }, 403);

  const promptHash = await sha256Hex(body.prompt_text);
  const existing = await repos.library.countByTeamAndHash(body.team_id, promptHash);
  if (existing > 0) {
    return c.json(
      { error: "duplicate", message: "This prompt is already saved by a team member" },
      409,
    );
  }

  const encrypted = await encryptPrompt(body.prompt_text, c.env.LIBRARY_ENC_KEY);
  const saved = await repos.library.insert({
    teamId: body.team_id,
    title: body.title ?? null,
    encryptedPrompt: encrypted,
    promptHash,
    tags: body.tags ?? [],
    createdBy: c.var.userId,
    score: body.score ?? 0,
  });
  return c.json(
    {
      id: saved.id,
      title: saved.title,
      tags: saved.tags ?? [],
      score: saved.score,
      usage_count: saved.usage_count,
      version: saved.version,
      created_at: saved.created_at,
      contributor: member.anon_alias ?? "Member",
    },
    201,
  );
});

libraryRoutes.openapi(getRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { repos } = await memberRepos(c);
  const prompt = await repos.library.findById(id);
  if (!prompt) return c.json({ error: "not_found", message: "Prompt not found" }, 404);
  const member = await repos.teams.findMember(prompt.team_id, c.var.userId);
  if (!member)
    return c.json({ error: "forbidden", message: "You are not a member of this team" }, 403);

  const plaintext = await decryptPrompt(prompt.prompt_text_encrypted, c.env.LIBRARY_ENC_KEY);
  await repos.library.incrementUsage(id);
  return c.json({ id: prompt.id, prompt_text: plaintext, title: prompt.title }, 200);
});
