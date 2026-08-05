import type { SqlDb } from "@revealyst/db";
import { createEventsRepo } from "./events.js";
import { createFeedbackRepo } from "./feedback.js";
import { createLibraryRepo } from "./library.js";
import { createTeamsRepo } from "./teams.js";
import { createUsersRepo } from "./users.js";

/** All repositories bound to one SqlDb connection. */
export function createRepos(db: SqlDb) {
  return {
    users: createUsersRepo(db),
    teams: createTeamsRepo(db),
    events: createEventsRepo(db),
    library: createLibraryRepo(db),
    feedback: createFeedbackRepo(db),
  };
}

export type Repos = ReturnType<typeof createRepos>;

export * from "./schema.js";
