import type { SqlDb } from "@revealyst/db";
import { createEventsRepo } from "./events.js";
import { createFeedbackRepo } from "./feedback.js";
import { createInvitesRepo } from "./invites.js";
import { createLibraryRepo } from "./library.js";
import { createMagicRepo } from "./magic.js";
import { createTeamsRepo } from "./teams.js";
import { createUsersRepo } from "./users.js";

/** All repositories bound to one SqlDb connection. */
export function createRepos(db: SqlDb) {
  return {
    users: createUsersRepo(db),
    teams: createTeamsRepo(db),
    invites: createInvitesRepo(db),
    events: createEventsRepo(db),
    library: createLibraryRepo(db),
    feedback: createFeedbackRepo(db),
    magic: createMagicRepo(db),
  };
}

export type Repos = ReturnType<typeof createRepos>;

export * from "./schema.js";
