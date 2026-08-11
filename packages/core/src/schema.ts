import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  primaryKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", ["owner", "admin", "member"]);
export const projectSourceEnum = pgEnum("project_source", ["local_path", "github"]);
export const workspaceModeEnum = pgEnum("workspace_mode", ["direct", "git_worktree"]);
export const runStatusEnum = pgEnum("run_status", [
  "draft",
  "queued",
  "running",
  "cancel_requested",
  "cancelled",
  "succeeded",
  "failed"
]);
export const importJobStatusEnum = pgEnum("import_job_status", [
  "queued",
  "running",
  "succeeded",
  "failed"
]);
export const githubAuthModeEnum = pgEnum("github_auth_mode", ["app", "pat"]);

const id = uuid("id").defaultRandom().primaryKey();
const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  "users",
  {
    id,
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull().default("member"),
    createdAt,
    updatedAt
  },
  (table) => ({
    emailUnique: uniqueIndex("users_email_unique").on(table.email)
  })
);

export const sessions = pgTable("sessions", {
  id,
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id,
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
    updatedAt
  },
  (table) => ({
    tokenUnique: uniqueIndex("api_keys_token_hash_unique").on(table.tokenHash)
  })
);

export const invites = pgTable("invites", {
  id,
  email: text("email"),
  role: userRoleEnum("role").notNull().default("member"),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt
});

export const secrets = pgTable(
  "secrets",
  {
    id,
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    encryptedValue: text("encrypted_value").notNull(),
    agentAccessible: boolean("agent_accessible").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt,
    updatedAt
  },
  (table) => ({
    nameUnique: uniqueIndex("secrets_name_unique").on(table.name)
  })
);

export const projects = pgTable("projects", {
  id,
  name: text("name").notNull(),
  source: projectSourceEnum("source").notNull().default("local_path"),
  localPath: text("local_path").notNull(),
  workspaceMode: workspaceModeEnum("workspace_mode").notNull().default("direct"),
  githubOwner: text("github_owner"),
  githubRepo: text("github_repo"),
  defaultBranch: text("default_branch"),
  remoteUrl: text("remote_url"),
  githubRepositoryId: uuid("github_repository_id"),
  active: boolean("active").notNull().default(true),
  createdAt,
  updatedAt
});

export const agents = pgTable("agents", {
  id,
  kind: text("kind").notNull().default("worker"),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  model: text("model").notNull().default("gpt-5.6-luna"),
  modelOptions: jsonb("model_options").notNull().default([{ id: "reasoningEffort", value: "max" }]),
  capabilities: jsonb("capabilities").notNull().default([]),
  instructions: text("instructions").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt,
  updatedAt
});

export const skills = pgTable(
  "skills",
  {
    id,
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    instructions: text("instructions").notNull(),
    files: jsonb("files").notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    platformManaged: boolean("platform_managed").notNull().default(false),
    defaultForAgents: boolean("default_for_agents").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt,
    updatedAt
  },
  (table) => ({
    nameUnique: uniqueIndex("skills_name_unique").on(table.name)
  })
);

export const agentSkills = pgTable(
  "agent_skills",
  {
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
    createdAt
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.skillId] })
  })
);

export const projectSkills = pgTable(
  "project_skills",
  {
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
    createdAt
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.skillId] })
  })
);

export const agentVersions = pgTable("agent_versions", {
  id,
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  model: text("model").notNull(),
  modelOptions: jsonb("model_options").notNull().default([]),
  instructions: text("instructions").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt
});

export const tasks = pgTable("tasks", {
  id,
  number: integer("number").notNull().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  body: text("body").notNull().default(""),
  status: text("status").notNull().default("open"),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  openPrOnSuccess: boolean("open_pr_on_success").notNull().default(false),
  coordinationThreadId: uuid("coordination_thread_id"),
  createdAt,
  updatedAt
});

export const taskSkills = pgTable(
  "task_skills",
  {
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
    createdAt
  },
  (table) => ({
    pk: primaryKey({ columns: [table.taskId, table.skillId] })
  })
);

export const taskComments = pgTable("task_comments", {
  id,
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
  body: text("body").notNull(),
  createdAt
});

export const providerInstances = pgTable("provider_instances", {
  id: text("id").primaryKey(),
  driver: text("driver").notNull(),
  displayName: text("display_name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  config: jsonb("config").notNull().default({}),
  createdAt,
  updatedAt
});

export const agentThreads = pgTable(
  "agent_threads",
  {
    id,
    title: text("title").notNull().default("New thread"),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    providerInstanceId: text("provider_instance_id").notNull().references(() => providerInstances.id, {
      onDelete: "restrict"
    }),
    model: text("model").notNull(),
    modelOptions: jsonb("model_options").notNull().default([]),
    cwd: text("cwd").notNull(),
    branch: text("branch"),
    runtimeHome: text("runtime_home").notNull(),
    providerThreadId: text("provider_thread_id"),
    ownershipGeneration: integer("ownership_generation").notNull().default(0),
    coordinationThreadId: uuid("coordination_thread_id"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt,
    updatedAt
  },
  (table) => ({
    taskUnique: uniqueIndex("agent_threads_task_unique").on(table.taskId)
  })
);

export const taskSessions = pgTable(
  "task_sessions",
  {
    id,
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    agentVersionId: uuid("agent_version_id").references(() => agentVersions.id, {
      onDelete: "set null"
    }),
    agentSnapshot: jsonb("agent_snapshot").notNull(),
    codexHome: text("codex_home").notNull(),
    codexThreadId: text("codex_thread_id"),
    createdAt,
    updatedAt
  },
  (table) => ({
    taskUnique: uniqueIndex("task_sessions_task_unique").on(table.taskId)
  })
);

export const taskRuns = pgTable("task_runs", {
  id,
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  taskSessionId: uuid("task_session_id").notNull().references(() => taskSessions.id, {
    onDelete: "cascade"
  }),
  runKind: text("run_kind").notNull().default("worker"),
  trigger: text("trigger").notNull().default("manual"),
  parentRunId: uuid("parent_run_id"),
  agentThreadId: uuid("agent_thread_id").references(() => agentThreads.id, { onDelete: "set null" }),
  agentThreadGeneration: integer("agent_thread_generation").notNull().default(0),
  workspaceKey: text("workspace_key").notNull().default(""),
  workspaceMode: text("workspace_mode").notNull().default("unknown"),
  status: runStatusEnum("status").notNull().default("queued"),
  cwd: text("cwd").notNull(),
  branch: text("branch"),
  worktreePath: text("worktree_path"),
  codexThreadId: text("codex_thread_id"),
  model: text("model").notNull(),
  modelOptions: jsonb("model_options").notNull().default([]),
  prompt: text("prompt").notNull(),
  skillsSnapshot: jsonb("skills_snapshot").notNull().default([]),
  rawStdout: text("raw_stdout").notNull().default(""),
  rawStderr: text("raw_stderr").notNull().default(""),
  exitCode: integer("exit_code"),
  error: text("error"),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt,
  updatedAt
});

export const dispatcherRuns = pgTable("dispatcher_runs", {
  id,
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  trigger: text("trigger").notNull().default("heartbeat"),
  scope: text("scope").notNull().default("heartbeat"),
  agentThreadId: uuid("agent_thread_id").references(() => agentThreads.id, { onDelete: "set null" }),
  agentThreadGeneration: integer("agent_thread_generation").notNull().default(0),
  workspaceKey: text("workspace_key").notNull().default(""),
  workspaceMode: text("workspace_mode").notNull().default("unknown"),
  messageDeliveryId: uuid("message_delivery_id"),
  status: runStatusEnum("status").notNull().default("queued"),
  cwd: text("cwd").notNull(),
  codexHome: text("codex_home").notNull(),
  codexThreadId: text("codex_thread_id"),
  model: text("model").notNull(),
  modelOptions: jsonb("model_options").notNull().default([]),
  prompt: text("prompt").notNull(),
  skillsSnapshot: jsonb("skills_snapshot").notNull().default([]),
  rawStdout: text("raw_stdout").notNull().default(""),
  rawStderr: text("raw_stderr").notNull().default(""),
  exitCode: integer("exit_code"),
  error: text("error"),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt,
  updatedAt
});

export const schedules = pgTable("schedules", {
  id,
  number: integer("number").notNull().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
  scheduleKind: text("schedule_kind").notNull(),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
  intervalSeconds: integer("interval_seconds"),
  enabled: boolean("enabled").notNull().default(true),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastAgentThreadId: uuid("last_agent_thread_id").references(() => agentThreads.id, {
    onDelete: "set null"
  }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  idempotencyKey: text("idempotency_key"),
  createdAt,
  updatedAt
});

export const scheduleRuns = pgTable(
  "schedule_runs",
  {
    id,
    scheduleId: uuid("schedule_id").notNull().references(() => schedules.id, { onDelete: "cascade" }),
    agentThreadId: uuid("agent_thread_id").references(() => agentThreads.id, { onDelete: "set null" }),
    dispatcherRunId: uuid("dispatcher_run_id").references(() => dispatcherRuns.id, {
      onDelete: "set null"
    }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    createdAt
  },
  (table) => ({
    scheduledUnique: uniqueIndex("schedule_runs_schedule_scheduled_unique").on(
      table.scheduleId,
      table.scheduledFor
    )
  })
);

export const dispatcherRunEvents = pgTable("dispatcher_run_events", {
  id,
  dispatcherRunId: uuid("dispatcher_run_id").notNull().references(() => dispatcherRuns.id, {
    onDelete: "cascade"
  }),
  seq: integer("seq").notNull(),
  eventType: text("event_type").notNull(),
  text: text("text"),
  payload: jsonb("payload").notNull(),
  createdAt
});

export const runEvents = pgTable("run_events", {
  id,
  runId: uuid("run_id").notNull().references(() => taskRuns.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  eventType: text("event_type").notNull(),
  text: text("text"),
  payload: jsonb("payload").notNull(),
  createdAt
});

export const agentTurnInputs = pgTable("agent_turn_inputs", {
  id,
  agentThreadId: uuid("agent_thread_id").notNull().references(() => agentThreads.id, {
    onDelete: "cascade"
  }),
  taskRunId: uuid("task_run_id").references(() => taskRuns.id, { onDelete: "cascade" }),
  dispatcherRunId: uuid("dispatcher_run_id").references(() => dispatcherRuns.id, {
    onDelete: "cascade"
  }),
  messageDeliveryId: uuid("message_delivery_id").references(() => messageDeliveries.id, {
    onDelete: "cascade"
  }),
  message: text("message").notNull(),
  status: text("status").notNull().default("queued"),
  error: text("error"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt,
  updatedAt
});

export const agentToolTokens = pgTable(
  "agent_tool_tokens",
  {
    id,
    tokenHash: text("token_hash").notNull(),
    taskRunId: uuid("task_run_id").references(() => taskRuns.id, { onDelete: "cascade" }),
    dispatcherRunId: uuid("dispatcher_run_id").references(() => dispatcherRuns.id, {
      onDelete: "cascade"
    }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    agentThreadId: uuid("agent_thread_id").references(() => agentThreads.id, { onDelete: "cascade" }),
    coordinationThreadId: uuid("coordination_thread_id"),
    role: text("role").notNull().default("worker"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt
  },
  (table) => ({
    tokenUnique: uniqueIndex("agent_tool_tokens_token_hash_unique").on(table.tokenHash)
  })
);

export const coordinationThreads = pgTable("coordination_threads", {
  id,
  number: integer("number").notNull().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  purpose: text("purpose").notNull().default(""),
  status: text("status").notNull().default("active"),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  primaryAgentId: uuid("primary_agent_id").references(() => agents.id, { onDelete: "set null" }),
  callbackAgentId: uuid("callback_agent_id").references(() => agents.id, { onDelete: "set null" }),
  originThreadId: uuid("origin_thread_id"),
  originMessageId: uuid("origin_message_id"),
  completionInstructions: text("completion_instructions").notNull().default(""),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt,
  updatedAt
});

export const threadParticipants = pgTable(
  "thread_participants",
  {
    threadId: uuid("thread_id").notNull().references(() => coordinationThreads.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("participant"),
    createdAt
  },
  (table) => ({
    pk: primaryKey({ columns: [table.threadId, table.agentId] })
  })
);

export const threadMessages = pgTable(
  "thread_messages",
  {
    id,
    number: integer("number").notNull().generatedAlwaysAsIdentity(),
    threadId: uuid("thread_id").notNull().references(() => coordinationThreads.id, { onDelete: "cascade" }),
    senderAgentId: uuid("sender_agent_id").references(() => agents.id, { onDelete: "set null" }),
    senderUserId: uuid("sender_user_id").references(() => users.id, { onDelete: "set null" }),
    recipientAgentId: uuid("recipient_agent_id").references(() => agents.id, { onDelete: "set null" }),
    parentMessageId: uuid("parent_message_id"),
    messageType: text("message_type").notNull().default("message"),
    body: text("body").notNull(),
    idempotencyKey: text("idempotency_key"),
    createdAt
  },
  (table) => ({
    idempotencyUnique: uniqueIndex("thread_messages_sender_idempotency_unique").on(
      table.senderAgentId,
      table.idempotencyKey
    )
  })
);

export const messageDeliveries = pgTable(
  "message_deliveries",
  {
    id,
    messageId: uuid("message_id").notNull().references(() => threadMessages.id, { onDelete: "cascade" }),
    recipientAgentId: uuid("recipient_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    presentedAt: timestamp("presented_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
    createdAt,
    updatedAt
  },
  (table) => ({
    recipientUnique: uniqueIndex("message_deliveries_message_recipient_unique").on(
      table.messageId,
      table.recipientAgentId
    )
  })
);

export const reports = pgTable("reports", {
  id,
  number: integer("number").notNull().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("draft"),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  threadId: uuid("thread_id").references(() => coordinationThreads.id, { onDelete: "set null" }),
  authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
  currentRevision: integer("current_revision").notNull().default(1),
  createdAt,
  updatedAt
});

export const reportVersions = pgTable(
  "report_versions",
  {
    id,
    reportId: uuid("report_id").notNull().references(() => reports.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    markdown: text("markdown").notNull(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt
  },
  (table) => ({
    revisionUnique: uniqueIndex("report_versions_report_revision_unique").on(table.reportId, table.revision)
  })
);

export const incidents = pgTable("incidents", {
  id,
  number: integer("number").notNull().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("open"),
  severity: text("severity").notNull().default("medium"),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  threadId: uuid("thread_id").references(() => coordinationThreads.id, { onDelete: "set null" }),
  commanderAgentId: uuid("commander_agent_id").references(() => agents.id, { onDelete: "set null" }),
  createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt,
  updatedAt
});

export const incidentUpdates = pgTable("incident_updates", {
  id,
  incidentId: uuid("incident_id").notNull().references(() => incidents.id, { onDelete: "cascade" }),
  authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
  markdown: text("markdown").notNull(),
  createdAt
});

export const githubConnections = pgTable("github_connections", {
  id,
  authMode: githubAuthModeEnum("auth_mode").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("pending"),
  accountLogin: text("account_login"),
  error: text("error"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  appId: text("app_id"),
  clientId: text("client_id"),
  privateKeySecretId: uuid("private_key_secret_id").references(() => secrets.id, {
    onDelete: "set null"
  }),
  webhookSecretId: uuid("webhook_secret_id").references(() => secrets.id, {
    onDelete: "set null"
  }),
  patSecretId: uuid("pat_secret_id").references(() => secrets.id, { onDelete: "set null" }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt,
  updatedAt
});

export const githubInstallations = pgTable("github_installations", {
  id,
  connectionId: uuid("connection_id").notNull().references(() => githubConnections.id, {
    onDelete: "cascade"
  }),
  installationId: text("installation_id").notNull(),
  accountLogin: text("account_login").notNull(),
  repositorySelection: text("repository_selection").notNull().default("selected"),
  permissions: jsonb("permissions").notNull().default({}),
  createdAt,
  updatedAt
});

export const githubRepositories = pgTable(
  "github_repositories",
  {
    id,
    connectionId: uuid("connection_id").notNull().references(() => githubConnections.id, {
      onDelete: "cascade"
    }),
    installationId: uuid("installation_id").references(() => githubInstallations.id, {
      onDelete: "set null"
    }),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    cloneUrl: text("clone_url").notNull(),
    defaultBranch: text("default_branch").notNull(),
    importedProjectId: uuid("imported_project_id"),
    createdAt,
    updatedAt
  },
  (table) => ({
    repoUnique: uniqueIndex("github_repositories_connection_full_name_unique").on(
      table.connectionId,
      table.fullName
    )
  })
);

export const repoImportJobs = pgTable("repo_import_jobs", {
  id,
  githubRepositoryId: uuid("github_repository_id").notNull().references(() => githubRepositories.id, {
    onDelete: "cascade"
  }),
  status: importJobStatusEnum("status").notNull().default("queued"),
  localPath: text("local_path"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt,
  updatedAt
});

export const pullRequests = pgTable("pull_requests", {
  id,
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  branch: text("branch").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  number: integer("number"),
  url: text("url"),
  state: text("state").notNull().default("queued"),
  error: text("error"),
  createdAt,
  updatedAt
});
