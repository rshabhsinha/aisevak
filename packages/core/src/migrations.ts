import type { Pool } from "pg";

const enumSql = `
DO $$ BEGIN CREATE TYPE user_role AS ENUM ('owner', 'admin', 'member'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE project_source AS ENUM ('local_path', 'github'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE workspace_mode AS ENUM ('direct', 'git_worktree'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE run_status AS ENUM ('queued', 'running', 'cancel_requested', 'cancelled', 'succeeded', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE import_job_status AS ENUM ('queued', 'running', 'succeeded', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE github_auth_mode AS ENUM ('app', 'pat'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`;

const tableSql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  role user_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions(token_hash);

CREATE TABLE IF NOT EXISTS invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  role user_role NOT NULL DEFAULT 'member',
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  encrypted_value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  source project_source NOT NULL DEFAULT 'local_path',
  local_path text NOT NULL,
  workspace_mode workspace_mode NOT NULL DEFAULT 'direct',
  github_owner text,
  github_repo text,
  default_branch text,
  remote_url text,
  github_repository_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'worker',
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT 'gpt-5.5',
  instructions text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  model text NOT NULL,
  instructions text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer GENERATED ALWAYS AS IDENTITY,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  open_pr_on_success boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  agent_version_id uuid REFERENCES agent_versions(id) ON DELETE SET NULL,
  agent_snapshot jsonb NOT NULL,
  codex_home text NOT NULL,
  codex_thread_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_session_id uuid NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
  run_kind text NOT NULL DEFAULT 'worker',
  trigger text NOT NULL DEFAULT 'manual',
  parent_run_id uuid,
  status run_status NOT NULL DEFAULT 'queued',
  cwd text NOT NULL,
  branch text,
  worktree_path text,
  codex_thread_id text,
  model text NOT NULL,
  prompt text NOT NULL,
  raw_stdout text NOT NULL DEFAULT '',
  raw_stderr text NOT NULL DEFAULT '',
  exit_code integer,
  error text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_runs_status_idx ON task_runs(status);

CREATE TABLE IF NOT EXISTS dispatcher_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  trigger text NOT NULL DEFAULT 'heartbeat',
  scope text NOT NULL DEFAULT 'heartbeat',
  status run_status NOT NULL DEFAULT 'queued',
  cwd text NOT NULL,
  codex_home text NOT NULL,
  codex_thread_id text,
  model text NOT NULL,
  prompt text NOT NULL,
  raw_stdout text NOT NULL DEFAULT '',
  raw_stderr text NOT NULL DEFAULT '',
  exit_code integer,
  error text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dispatcher_runs_status_idx ON dispatcher_runs(status);

CREATE TABLE IF NOT EXISTS dispatcher_run_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatcher_run_id uuid NOT NULL REFERENCES dispatcher_runs(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  event_type text NOT NULL,
  text text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dispatcher_run_id, seq)
);

CREATE TABLE IF NOT EXISTS run_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  event_type text NOT NULL,
  text text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE TABLE IF NOT EXISTS agent_tool_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  task_run_id uuid REFERENCES task_runs(id) ON DELETE CASCADE,
  dispatcher_run_id uuid REFERENCES dispatcher_runs(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  role text NOT NULL DEFAULT 'worker',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS github_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_mode github_auth_mode NOT NULL,
  name text NOT NULL,
  app_id text,
  client_id text,
  private_key_secret_id uuid REFERENCES secrets(id) ON DELETE SET NULL,
  webhook_secret_id uuid REFERENCES secrets(id) ON DELETE SET NULL,
  pat_secret_id uuid REFERENCES secrets(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS github_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES github_connections(id) ON DELETE CASCADE,
  installation_id text NOT NULL,
  account_login text NOT NULL,
  repository_selection text NOT NULL DEFAULT 'selected',
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS github_repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES github_connections(id) ON DELETE CASCADE,
  installation_id uuid REFERENCES github_installations(id) ON DELETE SET NULL,
  owner text NOT NULL,
  name text NOT NULL,
  full_name text NOT NULL,
  clone_url text NOT NULL,
  default_branch text NOT NULL,
  imported_project_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, full_name)
);

CREATE TABLE IF NOT EXISTS repo_import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_repository_id uuid NOT NULL REFERENCES github_repositories(id) ON DELETE CASCADE,
  status import_job_status NOT NULL DEFAULT 'queued',
  local_path text,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS repo_import_jobs_status_idx ON repo_import_jobs(status);

CREATE TABLE IF NOT EXISTS pull_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  number integer,
  url text,
  state text NOT NULL DEFAULT 'queued',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

const additiveSql = `
ALTER TABLE agents ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'worker';
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS run_kind text NOT NULL DEFAULT 'worker';
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS trigger text NOT NULL DEFAULT 'manual';
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS parent_run_id uuid;

UPDATE agents
SET kind = 'dispatcher', updated_at = now()
WHERE lower(name) IN ('dispatcher', 'orchestrator')
  AND kind <> 'dispatcher';

INSERT INTO agents (kind, name, description, model, instructions, enabled)
SELECT
  'dispatcher',
  'Dispatcher',
  'Routes Todo and Needs attention tasks to the right worker agent.',
  COALESCE(NULLIF(current_setting('aisevak.default_model', true), ''), 'gpt-5.5'),
  'You are the Aisevak Dispatcher. Review the task board, assign work to enabled worker agents, start worker runs with the aisevak CLI, and move ambiguous or blocked work to Needs attention with a precise comment.',
  true
WHERE NOT EXISTS (SELECT 1 FROM agents WHERE kind = 'dispatcher');
`;

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query("SELECT set_config('aisevak.default_model', $1, false)", [
    process.env.CODEX_DEFAULT_MODEL ?? "gpt-5.5"
  ]);
  await pool.query(enumSql);
  await pool.query(tableSql);
  await pool.query(additiveSql);
}
