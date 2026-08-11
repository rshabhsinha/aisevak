import type { Pool } from "pg";
import { installedSkillsRoot, migrateAndSynchronizeInstalledSkills } from "./installedSkills.js";
import { normalizeCodexModel } from "./models.js";

const enumSql = `
DO $$ BEGIN CREATE TYPE user_role AS ENUM ('owner', 'admin', 'member'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE project_source AS ENUM ('local_path', 'github'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE workspace_mode AS ENUM ('direct', 'git_worktree'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE run_status AS ENUM ('draft', 'queued', 'running', 'cancel_requested', 'cancelled', 'succeeded', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
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

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_keys_token_hash_idx ON api_keys(token_hash);
CREATE INDEX IF NOT EXISTS api_keys_created_by_idx ON api_keys(created_by);

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
  description text NOT NULL DEFAULT '',
  encrypted_value text NOT NULL,
  agent_accessible boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  last_used_at timestamptz,
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
  model text NOT NULL DEFAULT 'gpt-5.6-luna',
  model_options jsonb NOT NULL DEFAULT '[{"id":"reasoningEffort","value":"max"}]'::jsonb,
  instructions text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  instructions text NOT NULL,
  files jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  platform_managed boolean NOT NULL DEFAULT false,
  default_for_agents boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, skill_id)
);

CREATE TABLE IF NOT EXISTS project_skills (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, skill_id)
);

CREATE TABLE IF NOT EXISTS agent_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  model text NOT NULL,
  model_options jsonb NOT NULL DEFAULT '[]'::jsonb,
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
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  open_pr_on_success boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_skills (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, skill_id)
);

CREATE TABLE IF NOT EXISTS task_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_instances (
  id text PRIMARY KEY,
  driver text NOT NULL,
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL DEFAULT 'New thread',
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  provider_instance_id text NOT NULL REFERENCES provider_instances(id) ON DELETE RESTRICT,
  model text NOT NULL,
  model_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  cwd text NOT NULL,
  branch text,
  runtime_home text NOT NULL,
  provider_thread_id text,
  ownership_generation integer NOT NULL DEFAULT 0,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_threads_task_unique
ON agent_threads(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_threads_activity_idx
ON agent_threads(last_activity_at DESC, id DESC);

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
  agent_thread_id uuid REFERENCES agent_threads(id) ON DELETE SET NULL,
  agent_thread_generation integer NOT NULL DEFAULT 0,
  workspace_key text NOT NULL DEFAULT '',
  workspace_mode text NOT NULL DEFAULT 'unknown',
  workspace_source text NOT NULL DEFAULT 'unknown',
  status run_status NOT NULL DEFAULT 'queued',
  cwd text NOT NULL,
  branch text,
  worktree_path text,
  codex_thread_id text,
  model text NOT NULL,
  model_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  prompt text NOT NULL,
  skills_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
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
  agent_thread_id uuid REFERENCES agent_threads(id) ON DELETE SET NULL,
  agent_thread_generation integer NOT NULL DEFAULT 0,
  workspace_key text NOT NULL DEFAULT '',
  workspace_mode text NOT NULL DEFAULT 'unknown',
  workspace_source text NOT NULL DEFAULT 'unknown',
  status run_status NOT NULL DEFAULT 'queued',
  cwd text NOT NULL,
  codex_home text NOT NULL,
  codex_thread_id text,
  model text NOT NULL,
  model_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  prompt text NOT NULL,
  skills_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
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
  status text NOT NULL DEFAULT 'pending',
  account_login text,
  error text,
  last_synced_at timestamptz,
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

export const additiveSql = `
ALTER TYPE run_status ADD VALUE IF NOT EXISTS 'draft' BEFORE 'queued';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'worker';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model_options jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '[]'::jsonb;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'skills' AND column_name = 'bundled'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'skills' AND column_name = 'platform_managed'
    ) THEN
      UPDATE skills SET platform_managed = platform_managed OR bundled;
      ALTER TABLE skills DROP COLUMN bundled;
    ELSE
      ALTER TABLE skills RENAME COLUMN bundled TO platform_managed;
    END IF;
  END IF;
END $$;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS platform_managed boolean NOT NULL DEFAULT false;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS default_for_agents boolean NOT NULL DEFAULT false;
ALTER TABLE agent_versions ADD COLUMN IF NOT EXISTS model_options jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents ALTER COLUMN model SET DEFAULT 'gpt-5.6-luna';
ALTER TABLE agents ALTER COLUMN model_options SET DEFAULT '[{"id":"reasoningEffort","value":"max"}]'::jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS coordination_thread_id uuid;
ALTER TABLE agent_threads ADD COLUMN IF NOT EXISTS coordination_thread_id uuid;
ALTER TABLE agent_threads ADD COLUMN IF NOT EXISTS ownership_generation integer NOT NULL DEFAULT 0;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS run_kind text NOT NULL DEFAULT 'worker';
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS trigger text NOT NULL DEFAULT 'manual';
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS parent_run_id uuid;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS agent_thread_id uuid REFERENCES agent_threads(id) ON DELETE SET NULL;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS agent_thread_generation integer NOT NULL DEFAULT 0;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS workspace_key text NOT NULL DEFAULT '';
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS workspace_mode text NOT NULL DEFAULT 'unknown';
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS workspace_source text NOT NULL DEFAULT 'unknown';
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS skills_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS model_options jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE dispatcher_runs ADD COLUMN IF NOT EXISTS agent_thread_id uuid REFERENCES agent_threads(id) ON DELETE SET NULL;
ALTER TABLE dispatcher_runs ADD COLUMN IF NOT EXISTS skills_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE dispatcher_runs ADD COLUMN IF NOT EXISTS model_options jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE dispatcher_runs ADD COLUMN IF NOT EXISTS message_delivery_id uuid;
ALTER TABLE dispatcher_runs ADD COLUMN IF NOT EXISTS agent_thread_generation integer NOT NULL DEFAULT 0;
ALTER TABLE dispatcher_runs ADD COLUMN IF NOT EXISTS workspace_key text NOT NULL DEFAULT '';
ALTER TABLE dispatcher_runs ADD COLUMN IF NOT EXISTS workspace_mode text NOT NULL DEFAULT 'unknown';
ALTER TABLE dispatcher_runs ADD COLUMN IF NOT EXISTS workspace_source text NOT NULL DEFAULT 'unknown';
WITH task_workspace_projects AS (
  SELECT task_runs.id,
         CASE WHEN count(DISTINCT projects.id) = 1 THEN max(projects.id::text) END AS workspace_key,
         CASE WHEN count(DISTINCT projects.id) = 1 THEN max(projects.workspace_mode::text) END AS workspace_mode,
         CASE WHEN count(DISTINCT projects.id) = 1 THEN max(projects.source::text) END AS workspace_source
  FROM task_runs
  LEFT JOIN projects
    ON projects.id::text = NULLIF(task_runs.workspace_key, '')
    OR projects.local_path = task_runs.cwd
  GROUP BY task_runs.id
)
UPDATE task_runs
SET workspace_key = CASE
      WHEN task_runs.workspace_key = '' THEN COALESCE(task_workspace_projects.workspace_key, '')
      ELSE task_runs.workspace_key
    END,
    workspace_mode = CASE
      WHEN task_runs.workspace_mode = 'unknown' THEN COALESCE(task_workspace_projects.workspace_mode, 'unknown')
      ELSE task_runs.workspace_mode
    END,
    workspace_source = CASE
      WHEN task_runs.workspace_source = 'unknown' THEN COALESCE(task_workspace_projects.workspace_source, 'unknown')
      ELSE task_runs.workspace_source
    END
FROM task_workspace_projects
WHERE task_runs.id = task_workspace_projects.id
  AND EXISTS (SELECT 1 FROM tasks WHERE tasks.id = task_runs.task_id)
  AND (
    task_runs.workspace_key = ''
    OR task_runs.workspace_mode = 'unknown'
    OR task_runs.workspace_source = 'unknown'
  );
WITH dispatcher_workspace_projects AS (
  SELECT dispatcher_runs.id,
         CASE WHEN count(DISTINCT projects.id) = 1 THEN max(projects.id::text) END AS workspace_key,
         CASE WHEN count(DISTINCT projects.id) = 1 THEN max(projects.workspace_mode::text) END AS workspace_mode,
         CASE WHEN count(DISTINCT projects.id) = 1 THEN max(projects.source::text) END AS workspace_source
  FROM dispatcher_runs
  LEFT JOIN projects
    ON projects.id::text = NULLIF(dispatcher_runs.workspace_key, '')
    OR projects.local_path = dispatcher_runs.cwd
  GROUP BY dispatcher_runs.id
)
UPDATE dispatcher_runs
SET workspace_key = CASE
      WHEN dispatcher_runs.workspace_key = '' THEN COALESCE(dispatcher_workspace_projects.workspace_key, '')
      ELSE dispatcher_runs.workspace_key
    END,
    workspace_mode = CASE
      WHEN dispatcher_runs.workspace_mode = 'unknown' THEN COALESCE(dispatcher_workspace_projects.workspace_mode, 'unknown')
      ELSE dispatcher_runs.workspace_mode
    END,
    workspace_source = CASE
      WHEN dispatcher_runs.workspace_source = 'unknown' THEN COALESCE(dispatcher_workspace_projects.workspace_source, 'unknown')
      ELSE dispatcher_runs.workspace_source
    END
FROM dispatcher_workspace_projects
WHERE dispatcher_runs.id = dispatcher_workspace_projects.id
  AND (
    dispatcher_runs.workspace_key = ''
    OR dispatcher_runs.workspace_mode = 'unknown'
    OR dispatcher_runs.workspace_source = 'unknown'
  );
CREATE INDEX IF NOT EXISTS task_runs_agent_thread_status_idx
ON task_runs(agent_thread_id, status, queued_at) WHERE agent_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dispatcher_runs_agent_thread_status_idx
ON dispatcher_runs(agent_thread_id, status, queued_at) WHERE agent_thread_id IS NOT NULL;
ALTER TABLE agent_tool_tokens ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents(id) ON DELETE CASCADE;
ALTER TABLE agent_tool_tokens ADD COLUMN IF NOT EXISTS agent_thread_id uuid REFERENCES agent_threads(id) ON DELETE CASCADE;
ALTER TABLE agent_tool_tokens ADD COLUMN IF NOT EXISTS coordination_thread_id uuid;
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS agent_accessible boolean NOT NULL DEFAULT false;
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
ALTER TABLE github_connections ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE github_connections ADD COLUMN IF NOT EXISTS account_login text;
ALTER TABLE github_connections ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE github_connections ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

CREATE TEMP TABLE aisevak_github_repository_rehomes ON COMMIT DROP AS
WITH canonical_github_connection AS (
  SELECT id
  FROM github_connections
  WHERE auth_mode = 'pat' AND status <> 'replaced'
  ORDER BY updated_at DESC, created_at DESC, id DESC
  LIMIT 1
), ranked_repositories AS (
  SELECT repository.id AS source_repository_id,
         repository.imported_project_id AS source_imported_project_id,
         repository.updated_at AS source_updated_at,
         first_value(repository.id) OVER (
           PARTITION BY repository.full_name
           ORDER BY (repository.connection_id = canonical_connection.id) DESC,
                    repository.updated_at DESC,
                    repository.created_at DESC,
                    repository.id DESC
         ) AS target_repository_id,
         canonical_connection.id AS canonical_connection_id
  FROM canonical_github_connection canonical_connection
  JOIN github_connections connection ON connection.auth_mode = 'pat'
  JOIN github_repositories repository ON repository.connection_id = connection.id
)
SELECT source_repository_id,
       source_imported_project_id,
       source_updated_at,
       target_repository_id,
       canonical_connection_id
FROM ranked_repositories
WHERE source_repository_id <> target_repository_id;

WITH legacy_imports AS (
  SELECT DISTINCT ON (target_repository_id)
         target_repository_id,
         source_imported_project_id
  FROM aisevak_github_repository_rehomes
  WHERE source_imported_project_id IS NOT NULL
  ORDER BY target_repository_id, source_updated_at DESC, source_repository_id DESC
)
UPDATE github_repositories target_repository
SET imported_project_id = COALESCE(
      target_repository.imported_project_id,
      legacy_imports.source_imported_project_id
    ),
    updated_at = now()
FROM legacy_imports
WHERE target_repository.id = legacy_imports.target_repository_id;

UPDATE projects
SET github_repository_id = rehome.target_repository_id,
    updated_at = now()
FROM aisevak_github_repository_rehomes rehome
WHERE projects.github_repository_id = rehome.source_repository_id;

UPDATE repo_import_jobs
SET github_repository_id = rehome.target_repository_id,
    updated_at = now()
FROM aisevak_github_repository_rehomes rehome
WHERE repo_import_jobs.github_repository_id = rehome.source_repository_id;

DELETE FROM github_repositories source_repository
USING aisevak_github_repository_rehomes rehome
WHERE source_repository.id = rehome.source_repository_id;

WITH canonical_github_connection AS (
  SELECT id
  FROM github_connections
  WHERE auth_mode = 'pat' AND status <> 'replaced'
  ORDER BY updated_at DESC, created_at DESC, id DESC
  LIMIT 1
)
UPDATE github_repositories repository
SET connection_id = canonical_connection.id,
    updated_at = now()
FROM canonical_github_connection canonical_connection,
     github_connections legacy_connection
WHERE repository.connection_id = legacy_connection.id
  AND legacy_connection.auth_mode = 'pat'
  AND legacy_connection.id <> canonical_connection.id;

CREATE TEMP TABLE aisevak_replaced_github_pat_secrets ON COMMIT DROP AS
WITH canonical_github_connection AS (
  SELECT id
  FROM github_connections
  WHERE auth_mode = 'pat' AND status <> 'replaced'
  ORDER BY updated_at DESC, created_at DESC, id DESC
  LIMIT 1
)
SELECT DISTINCT legacy_connection.pat_secret_id AS secret_id
FROM canonical_github_connection canonical_connection
JOIN github_connections legacy_connection
  ON legacy_connection.auth_mode = 'pat'
 AND legacy_connection.id <> canonical_connection.id
WHERE legacy_connection.pat_secret_id IS NOT NULL;

WITH canonical_github_connection AS (
  SELECT id
  FROM github_connections
  WHERE auth_mode = 'pat' AND status <> 'replaced'
  ORDER BY updated_at DESC, created_at DESC, id DESC
  LIMIT 1
)
UPDATE github_connections legacy_connection
SET pat_secret_id = NULL,
    updated_at = now()
FROM canonical_github_connection canonical_connection
WHERE legacy_connection.auth_mode = 'pat'
  AND legacy_connection.id <> canonical_connection.id
  AND legacy_connection.pat_secret_id IS NOT NULL;

DELETE FROM secrets candidate_secret
USING aisevak_replaced_github_pat_secrets candidate
WHERE candidate_secret.id = candidate.secret_id
  AND NOT EXISTS (
    SELECT 1
    FROM github_connections github_connection
    WHERE candidate_secret.id IN (
      github_connection.pat_secret_id,
      github_connection.private_key_secret_id,
      github_connection.webhook_secret_id
    )
  );

WITH canonical_github_connection AS (
  SELECT id
  FROM github_connections
  WHERE auth_mode = 'pat' AND status <> 'replaced'
  ORDER BY updated_at DESC, created_at DESC, id DESC
  LIMIT 1
)
UPDATE github_connections legacy
SET status = 'replaced', updated_at = now()
FROM canonical_github_connection canonical
WHERE legacy.auth_mode = 'pat'
  AND legacy.status <> 'replaced'
  AND legacy.id <> canonical.id;

CREATE UNIQUE INDEX IF NOT EXISTS github_connections_single_pat_identity
ON github_connections ((auth_mode))
WHERE auth_mode = 'pat' AND status <> 'replaced';

ALTER TABLE tasks ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_project_id_fkey;
ALTER TABLE tasks ADD CONSTRAINT tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

UPDATE tasks
SET description = left(COALESCE(NULLIF(btrim(regexp_replace(split_part(body, E'\n\n', 1), '\\s+', ' ', 'g')), ''), title), 280)
WHERE btrim(description) = '';

CREATE TABLE IF NOT EXISTS coordination_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  purpose text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  primary_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  callback_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  origin_thread_id uuid,
  origin_message_id uuid,
  completion_instructions text NOT NULL DEFAULT '',
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS coordination_threads_task_unique
ON coordination_threads(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS coordination_threads_activity_idx
ON coordination_threads(last_activity_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS thread_participants (
  thread_id uuid NOT NULL REFERENCES coordination_threads(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'participant',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, agent_id)
);

CREATE TABLE IF NOT EXISTS thread_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  thread_id uuid NOT NULL REFERENCES coordination_threads(id) ON DELETE CASCADE,
  sender_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  sender_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  recipient_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  parent_message_id uuid REFERENCES thread_messages(id) ON DELETE SET NULL,
  message_type text NOT NULL DEFAULT 'message',
  body text NOT NULL,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS thread_messages_sender_idempotency_unique
ON thread_messages(sender_agent_id, idempotency_key)
WHERE sender_agent_id IS NOT NULL AND idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS thread_messages_thread_page_idx
ON thread_messages(thread_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS message_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES thread_messages(id) ON DELETE CASCADE,
  recipient_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  presented_at timestamptz,
  completed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, recipient_agent_id)
);

CREATE INDEX IF NOT EXISTS message_deliveries_status_idx
ON message_deliveries(status, available_at, created_at);

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  thread_id uuid REFERENCES coordination_threads(id) ON DELETE SET NULL,
  author_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  current_revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  markdown text NOT NULL,
  created_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, revision)
);

CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  severity text NOT NULL DEFAULT 'medium',
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  thread_id uuid REFERENCES coordination_threads(id) ON DELETE SET NULL,
  commander_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  created_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incident_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  author_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  markdown text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  title text NOT NULL,
  prompt text NOT NULL,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  schedule_kind text NOT NULL CHECK (schedule_kind IN ('once', 'interval')),
  next_run_at timestamptz NOT NULL,
  interval_seconds integer CHECK (interval_seconds IS NULL OR interval_seconds >= 60),
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_agent_thread_id uuid REFERENCES agent_threads(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (schedule_kind = 'once' AND interval_seconds IS NULL)
    OR (schedule_kind = 'interval' AND interval_seconds IS NOT NULL)
  )
);

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS number integer GENERATED ALWAYS AS IDENTITY;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS created_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE INDEX IF NOT EXISTS schedules_due_idx
ON schedules(enabled, next_run_at) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS schedules_agent_idx ON schedules(agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS schedules_number_unique ON schedules(number);
CREATE UNIQUE INDEX IF NOT EXISTS schedules_agent_idempotency_unique
ON schedules(created_by_agent_id, idempotency_key)
WHERE created_by_agent_id IS NOT NULL AND idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS schedule_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  agent_thread_id uuid REFERENCES agent_threads(id) ON DELETE SET NULL,
  dispatcher_run_id uuid REFERENCES dispatcher_runs(id) ON DELETE SET NULL,
  scheduled_for timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, scheduled_for)
);

CREATE INDEX IF NOT EXISTS schedule_runs_schedule_idx
ON schedule_runs(schedule_id, scheduled_for DESC);

CREATE TABLE IF NOT EXISTS agent_turn_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_thread_id uuid NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  task_run_id uuid REFERENCES task_runs(id) ON DELETE CASCADE,
  dispatcher_run_id uuid REFERENCES dispatcher_runs(id) ON DELETE CASCADE,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'delivering', 'delivered', 'failed')),
  error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((task_run_id IS NOT NULL)::integer + (dispatcher_run_id IS NOT NULL)::integer = 1)
);

ALTER TABLE agent_turn_inputs ADD COLUMN IF NOT EXISTS message_delivery_id uuid;

CREATE INDEX IF NOT EXISTS agent_turn_inputs_task_run_idx
ON agent_turn_inputs(task_run_id, status, created_at) WHERE task_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_turn_inputs_dispatcher_run_idx
ON agent_turn_inputs(dispatcher_run_id, status, created_at) WHERE dispatcher_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_turn_inputs_delivery_idx
ON agent_turn_inputs(message_delivery_id) WHERE message_delivery_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_turn_inputs_delivery_unique
ON agent_turn_inputs(message_delivery_id) WHERE message_delivery_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE agent_turn_inputs ADD CONSTRAINT agent_turn_inputs_message_delivery_id_fkey
    FOREIGN KEY (message_delivery_id) REFERENCES message_deliveries(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE tasks ADD CONSTRAINT tasks_coordination_thread_id_fkey
    FOREIGN KEY (coordination_thread_id) REFERENCES coordination_threads(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE agent_threads ADD CONSTRAINT agent_threads_coordination_thread_id_fkey
    FOREIGN KEY (coordination_thread_id) REFERENCES coordination_threads(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE dispatcher_runs ADD CONSTRAINT dispatcher_runs_message_delivery_id_fkey
    FOREIGN KEY (message_delivery_id) REFERENCES message_deliveries(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE agent_tool_tokens ADD CONSTRAINT agent_tool_tokens_coordination_thread_id_fkey
    FOREIGN KEY (coordination_thread_id) REFERENCES coordination_threads(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE coordination_threads ADD CONSTRAINT coordination_threads_origin_thread_id_fkey
    FOREIGN KEY (origin_thread_id) REFERENCES coordination_threads(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE coordination_threads ADD CONSTRAINT coordination_threads_origin_message_id_fkey
    FOREIGN KEY (origin_message_id) REFERENCES thread_messages(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS agent_threads_coordination_agent_unique
ON agent_threads(coordination_thread_id, agent_id) WHERE coordination_thread_id IS NOT NULL;

UPDATE agents
SET kind = 'dispatcher', updated_at = now()
WHERE lower(name) IN ('dispatcher', 'orchestrator')
  AND kind <> 'dispatcher';

DELETE FROM agents duplicate
WHERE duplicate.kind = 'dispatcher'
  AND lower(duplicate.name) IN ('dispatcher', 'orchestrator')
  AND duplicate.id <> (
    SELECT canonical.id
    FROM agents canonical
    WHERE canonical.kind = 'dispatcher'
      AND lower(canonical.name) IN ('dispatcher', 'orchestrator')
    ORDER BY canonical.enabled DESC, canonical.created_at ASC, canonical.id ASC
    LIMIT 1
  )
  AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.agent_id = duplicate.id)
  AND NOT EXISTS (SELECT 1 FROM agent_threads WHERE agent_threads.agent_id = duplicate.id)
  AND NOT EXISTS (
    SELECT 1 FROM coordination_threads
    WHERE duplicate.id IN (created_by_agent_id, primary_agent_id, callback_agent_id)
  )
  AND NOT EXISTS (SELECT 1 FROM thread_participants WHERE thread_participants.agent_id = duplicate.id)
  AND NOT EXISTS (
    SELECT 1 FROM thread_messages
    WHERE duplicate.id IN (sender_agent_id, recipient_agent_id)
  )
  AND NOT EXISTS (SELECT 1 FROM message_deliveries WHERE message_deliveries.recipient_agent_id = duplicate.id)
  AND NOT EXISTS (SELECT 1 FROM reports WHERE reports.author_agent_id = duplicate.id)
  AND NOT EXISTS (SELECT 1 FROM report_versions WHERE report_versions.created_by_agent_id = duplicate.id)
  AND NOT EXISTS (
    SELECT 1 FROM incidents
    WHERE duplicate.id IN (commander_agent_id, created_by_agent_id)
  )
  AND NOT EXISTS (SELECT 1 FROM incident_updates WHERE incident_updates.author_agent_id = duplicate.id)
  AND NOT EXISTS (
    SELECT 1 FROM schedules
    WHERE duplicate.id IN (agent_id, created_by_agent_id)
  )
  AND NOT EXISTS (SELECT 1 FROM agent_tool_tokens WHERE agent_tool_tokens.agent_id = duplicate.id);

WITH canonical AS (
  SELECT id
  FROM agents
  WHERE kind = 'dispatcher'
    AND lower(name) IN ('dispatcher', 'orchestrator')
  ORDER BY enabled DESC, created_at ASC, id ASC
  LIMIT 1
)
UPDATE agents duplicate
SET name = 'Legacy Orchestrator ' || left(duplicate.id::text, 8),
    description = 'Disabled duplicate retained for historical references.',
    enabled = false,
    updated_at = now()
FROM canonical
WHERE duplicate.kind = 'dispatcher'
  AND lower(duplicate.name) IN ('dispatcher', 'orchestrator')
  AND duplicate.id <> canonical.id;

UPDATE agents
SET name = 'Orchestrator',
    description = 'Routes unassigned work and coordinates specialized agents across durable threads.',
    enabled = true,
    updated_at = now()
WHERE id = (
  SELECT canonical.id
  FROM agents canonical
  WHERE canonical.kind = 'dispatcher'
    AND lower(canonical.name) IN ('dispatcher', 'orchestrator')
  ORDER BY canonical.enabled DESC, canonical.created_at ASC, canonical.id ASC
  LIMIT 1
);

INSERT INTO agents (kind, name, description, model, model_options, instructions, enabled)
SELECT
  'dispatcher',
  'Orchestrator',
  'Routes unassigned work and coordinates specialized agents across durable threads.',
  COALESCE(NULLIF(current_setting('aisevak.default_model', true), ''), 'gpt-5.6-luna'),
  CASE
    WHEN current_setting('aisevak.default_model', true) = 'gpt-5.6-luna'
      THEN '[{"id":"reasoningEffort","value":"max"}]'::jsonb
    ELSE '[]'::jsonb
  END,
  'You are the Aisevak Orchestrator. Use the aisevak CLI to inspect work, route tasks, coordinate agents through durable threads, and request precise follow-up when work is ambiguous or blocked.',
  true
WHERE NOT EXISTS (SELECT 1 FROM agents WHERE kind = 'dispatcher' AND enabled = true);

CREATE TABLE IF NOT EXISTS app_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF current_setting('aisevak.default_model', true) = 'gpt-5.6-luna'
     AND NOT EXISTS (
       SELECT 1 FROM app_migrations WHERE name = '20260809_luna_max_agent_default'
     ) THEN
    WITH migrated AS (
      UPDATE agents
      SET model = 'gpt-5.6-luna',
          model_options = '[{"id":"reasoningEffort","value":"max"}]'::jsonb,
          updated_at = now()
      WHERE model IN ('gpt-5.5', 'gpt-5.6-sol')
        AND model_options = '[]'::jsonb
      RETURNING id, name, description, model, model_options, instructions
    )
    INSERT INTO agent_versions
      (agent_id, name, description, model, model_options, instructions, created_by)
    SELECT id, name, description, model, model_options, instructions, NULL
    FROM migrated;

    INSERT INTO app_migrations (name) VALUES ('20260809_luna_max_agent_default');
  END IF;
END $$;

INSERT INTO coordination_threads
  (title, description, purpose, status, project_id, task_id, primary_agent_id, completion_instructions,
   last_activity_at, created_at, updated_at)
SELECT tasks.title,
       tasks.description,
       tasks.body,
       CASE WHEN tasks.status = 'completed' THEN 'completed' ELSE 'active' END,
       tasks.project_id,
       tasks.id,
       tasks.agent_id,
       'When work is complete, run: aisevak threads complete THREAD-<number> --summary-stdin',
       tasks.updated_at,
       tasks.created_at,
       now()
FROM tasks
WHERE NOT EXISTS (
  SELECT 1 FROM coordination_threads WHERE coordination_threads.task_id = tasks.id
);

UPDATE coordination_threads
SET completion_instructions = 'When work is complete, run: aisevak threads complete THREAD-' || number || ' --summary-stdin'
WHERE task_id IS NOT NULL
  AND completion_instructions LIKE '%THREAD-<number>%';

UPDATE tasks
SET coordination_thread_id = coordination_threads.id
FROM coordination_threads
WHERE coordination_threads.task_id = tasks.id
  AND tasks.coordination_thread_id IS NULL;

UPDATE agent_threads
SET coordination_thread_id = tasks.coordination_thread_id
FROM tasks
WHERE agent_threads.task_id = tasks.id
  AND agent_threads.coordination_thread_id IS NULL;

INSERT INTO thread_participants (thread_id, agent_id, role)
SELECT coordination_threads.id, coordination_threads.primary_agent_id, 'assignee'
FROM coordination_threads
WHERE coordination_threads.primary_agent_id IS NOT NULL
ON CONFLICT (thread_id, agent_id) DO NOTHING;

INSERT INTO provider_instances (id, driver, display_name, enabled)
VALUES ('codex-local', 'codex', 'Codex', true)
ON CONFLICT (id) DO UPDATE
SET driver = EXCLUDED.driver,
    display_name = EXCLUDED.display_name,
    enabled = true,
    updated_at = now();

INSERT INTO agent_threads
  (title, agent_id, task_id, project_id, provider_instance_id, model, cwd, branch,
   runtime_home, provider_thread_id, last_activity_at, created_at, updated_at)
SELECT tasks.title,
       tasks.agent_id,
       tasks.id,
       tasks.project_id,
       'codex-local',
       COALESCE(latest.model, agents.model),
       COALESCE(latest.cwd, projects.local_path, current_setting('aisevak.managed_root', true), '/srv/aisevak'),
       latest.branch,
       task_sessions.codex_home,
       task_sessions.codex_thread_id,
       COALESCE(latest.activity_at, task_sessions.updated_at, task_sessions.created_at),
       task_sessions.created_at,
       now()
FROM task_sessions
JOIN tasks ON tasks.id = task_sessions.task_id
JOIN agents ON agents.id = tasks.agent_id
LEFT JOIN projects ON projects.id = tasks.project_id
LEFT JOIN LATERAL (
  SELECT task_runs.model,
         task_runs.cwd,
         task_runs.branch,
         COALESCE(task_runs.finished_at, task_runs.started_at, task_runs.queued_at, task_runs.created_at) AS activity_at
  FROM task_runs
  WHERE task_runs.task_session_id = task_sessions.id
  ORDER BY task_runs.created_at DESC
  LIMIT 1
) latest ON true
WHERE NOT EXISTS (SELECT 1 FROM agent_threads WHERE agent_threads.task_id = tasks.id);

UPDATE task_runs
SET agent_thread_id = agent_threads.id
FROM agent_threads
WHERE task_runs.task_id = agent_threads.task_id
  AND task_runs.agent_thread_id IS NULL;

INSERT INTO agent_threads
  (title, agent_id, provider_instance_id, model, cwd, runtime_home, provider_thread_id,
   last_activity_at, created_at, updated_at)
SELECT CASE
         WHEN btrim(first_run.prompt) = '' THEN 'New thread'
         ELSE left(split_part(btrim(first_run.prompt), E'\n', 1), 80)
       END,
       dispatcher.id,
       'codex-local',
       first_run.model,
       first_run.cwd,
       first_run.codex_home,
       latest.provider_thread_id,
       latest.activity_at,
       first_run.created_at,
       now()
FROM (
  SELECT DISTINCT ON (codex_home)
         codex_home, prompt, model, cwd, created_at
  FROM dispatcher_runs
  WHERE trigger = 'manual' AND scope = 'thread'
  ORDER BY codex_home, created_at ASC
) first_run
JOIN LATERAL (
  SELECT dispatcher_runs.codex_thread_id AS provider_thread_id,
         COALESCE(dispatcher_runs.finished_at, dispatcher_runs.started_at, dispatcher_runs.queued_at, dispatcher_runs.created_at) AS activity_at
  FROM dispatcher_runs
  WHERE dispatcher_runs.codex_home = first_run.codex_home
    AND dispatcher_runs.trigger = 'manual'
    AND dispatcher_runs.scope = 'thread'
  ORDER BY dispatcher_runs.created_at DESC
  LIMIT 1
) latest ON true
JOIN LATERAL (
  SELECT id FROM agents WHERE kind = 'dispatcher' AND enabled = true ORDER BY created_at ASC LIMIT 1
) dispatcher ON true
WHERE NOT EXISTS (
  SELECT 1 FROM agent_threads WHERE agent_threads.runtime_home = first_run.codex_home
);

UPDATE dispatcher_runs
SET agent_thread_id = agent_threads.id
FROM agent_threads
WHERE dispatcher_runs.codex_home = agent_threads.runtime_home
  AND dispatcher_runs.trigger = 'manual'
  AND dispatcher_runs.scope = 'thread'
  AND dispatcher_runs.agent_thread_id IS NULL;

UPDATE agent_threads
SET coordination_thread_id = tasks.coordination_thread_id
FROM tasks
WHERE agent_threads.task_id = tasks.id
  AND agent_threads.coordination_thread_id IS NULL;

UPDATE agent_threads
SET task_id = tasks.id,
    project_id = COALESCE(agent_threads.project_id, tasks.project_id),
    updated_at = now()
FROM coordination_threads, tasks
WHERE agent_threads.coordination_thread_id = coordination_threads.id
  AND coordination_threads.task_id = tasks.id
  AND agent_threads.agent_id = tasks.agent_id
  AND agent_threads.task_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM agent_threads existing_task_thread
    WHERE existing_task_thread.task_id = tasks.id
      AND existing_task_thread.id <> agent_threads.id
  );
`;

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query("SELECT set_config('aisevak.default_model', $1, false)", [
    normalizeCodexModel(process.env.CODEX_DEFAULT_MODEL)
  ]);
  await pool.query("SELECT set_config('aisevak.managed_root', $1, false)", [
    process.env.MANAGED_ROOT ?? "/srv/aisevak"
  ]);
  await pool.query(enumSql);
  await pool.query(tableSql);
  await pool.query(additiveSql);
  await migrateAndSynchronizeInstalledSkills(
    pool,
    installedSkillsRoot(process.env.MANAGED_ROOT ?? "/srv/aisevak")
  );
}
