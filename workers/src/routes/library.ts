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
  is_standard: z.boolean(),
  notes: z.string().nullable(),
  last_used_at: z.string().nullable(),
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
      sort: z.enum(["most_used", "highest_score", "newest"]).optional(),
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
            version: z.number(),
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

const patchRequest = z.object({
  title: z.string().max(200).optional(),
  tags: z.array(z.string().max(40)).max(10).optional(),
  notes: z.string().max(2000).nullable().optional(),
  is_standard: z.boolean().optional(),
  prompt_text: z.string().min(1).max(20_000).optional(),
  score: z.number().int().min(0).max(100).optional(),
});

const patchRoute = createRoute({
  method: "patch",
  path: "/api/library/{id}",
  middleware: [requireAuth],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: patchRequest } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: libraryCard } },
      description: "Prompt updated (edits create a new version)",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: errorResponse } },
      description: "Not a team member / manager action denied",
    },
    404: { content: { "application/json": { schema: errorResponse } }, description: "Not found" },
  },
});

const versionsRoute = createRoute({
  method: "get",
  path: "/api/library/{id}/versions",
  middleware: [requireAuth],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            versions: z.array(
              z.object({
                id: z.string(),
                version: z.number(),
                title: z.string().nullable(),
                created_at: z.string(),
                is_standard: z.boolean(),
              }),
            ),
          }),
        },
      },
      description: "Version history (spec §5.6)",
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
    sort: query.sort,
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
        is_standard: p.is_standard,
        notes: p.notes,
        last_used_at: p.last_used_at,
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
      is_standard: saved.is_standard,
      notes: saved.notes,
      last_used_at: saved.last_used_at,
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
  return c.json(
    { id: prompt.id, prompt_text: plaintext, title: prompt.title, version: prompt.version },
    200,
  );
});

libraryRoutes.openapi(patchRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const { repos } = await memberRepos(c);
  const prompt = await repos.library.findById(id);
  if (!prompt) return c.json({ error: "not_found", message: "Prompt not found" }, 404);
  const member = await repos.teams.findMember(prompt.team_id, c.var.userId);
  if (!member)
    return c.json({ error: "forbidden", message: "You are not a member of this team" }, 403);

  // Editing the prompt body creates a new version, preserving the original
  // (spec §5.6 version history).
  if (body.prompt_text !== undefined) {
    const promptHash = await sha256Hex(body.prompt_text);
    const encrypted = await encryptPrompt(body.prompt_text, c.env.LIBRARY_ENC_KEY);
    let updated = await repos.library.createVersion(prompt, {
      encryptedPrompt: encrypted,
      promptHash,
      title: body.title ?? prompt.title,
      tags: body.tags ?? prompt.tags ?? [],
      score: body.score ?? prompt.score ?? 0,
      createdBy: c.var.userId,
    });
    // Carry manager governance fields onto the new version (a manager may
    // edit the text and the notes/standard in the same request).
    if (member.role === "manager" && (body.notes !== undefined || body.is_standard !== undefined)) {
      const meta = await repos.library.updateMeta(updated.id, {
        notes: body.notes,
        isStandard: body.is_standard,
      });
      if (meta) updated = meta;
    }
    const memberAliases = new Map(
      (await repos.teams.listMembers(prompt.team_id)).map((m) => [m.user_id, m.anon_alias]),
    );
    return c.json(
      {
        id: updated.id,
        title: updated.title,
        tags: updated.tags ?? [],
        score: updated.score,
        usage_count: updated.usage_count,
        version: updated.version,
        is_standard: updated.is_standard,
        notes: updated.notes,
        last_used_at: updated.last_used_at,
        created_at: updated.created_at,
        contributor: memberAliases.get(updated.created_by ?? "") ?? "Member",
      },
      200,
    );
  }

  // Manager-only governance: notes + Team Standard (spec §5.5/§5.6).
  if (body.notes !== undefined || body.is_standard !== undefined) {
    if (member.role !== "manager") {
      return c.json(
        { error: "forbidden", message: "Only managers can edit notes or Team Standard" },
        403,
      );
    }
  }
  const updated = await repos.library.updateMeta(id, {
    title: body.title,
    tags: body.tags,
    notes: body.notes,
    isStandard: body.is_standard,
  });
  if (!updated) return c.json({ error: "not_found", message: "Prompt not found" }, 404);
  const memberAliases = new Map(
    (await repos.teams.listMembers(prompt.team_id)).map((m) => [m.user_id, m.anon_alias]),
  );
  return c.json(
    {
      id: updated.id,
      title: updated.title,
      tags: updated.tags ?? [],
      score: updated.score,
      usage_count: updated.usage_count,
      version: updated.version,
      is_standard: updated.is_standard,
      notes: updated.notes,
      last_used_at: updated.last_used_at,
      created_at: updated.created_at,
      contributor: memberAliases.get(updated.created_by ?? "") ?? "Member",
    },
    200,
  );
});

libraryRoutes.openapi(versionsRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { repos } = await memberRepos(c);
  const prompt = await repos.library.findById(id);
  if (!prompt) return c.json({ error: "not_found", message: "Prompt not found" }, 404);
  const member = await repos.teams.findMember(prompt.team_id, c.var.userId);
  if (!member)
    return c.json({ error: "forbidden", message: "You are not a member of this team" }, 403);
  const versions = await repos.library.listVersions(id);
  return c.json(
    {
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        title: v.title,
        created_at: v.created_at,
        is_standard: v.is_standard,
      })),
    },
    200,
  );
});
