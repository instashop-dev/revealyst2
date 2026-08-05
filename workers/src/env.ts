import type { Hyperdrive, VectorizeIndex } from "@cloudflare/workers-types";
import type { SqlDb } from "@revealyst/db";

/** Worker bindings (wrangler.toml vars + secrets). */
export interface WorkerEnv {
  DATABASE_URL: string;
  JWT_SECRET: string;
  OPENAI_API_KEY: string;
  /** Base URL of the web app, used for magic-link redirects. */
  APP_URL: string;
  VECTORIZE_NAMESPACE: string;
  /** 32+ byte key material for AES-256-GCM library-prompt encryption. */
  LIBRARY_ENC_KEY: string;
  /** When truthy, magic links are returned in the API response (local dev). */
  DEV_MODE?: string;
  /** When truthy, in-memory rate limiting is disabled (tests). */
  RATE_LIMIT_DISABLED?: string;
  VECTORIZE?: VectorizeIndex;
  /** Hyperdrive proxy for the Supabase pooler; preferred over DATABASE_URL. */
  HYPERDRIVE?: Hyperdrive;
  /** Test seam: pre-built SqlDb overrides the postgres.js connection. */
  _DB?: SqlDb;
}

export type AppEnv = { Bindings: WorkerEnv; Variables: { userId: string } };
