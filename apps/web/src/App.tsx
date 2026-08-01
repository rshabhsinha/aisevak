import {
  Activity,
  ArrowUp,
  BookOpen,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleDashed,
  CircleX,
  Copy,
  Eye,
  FolderGit2,
  Github,
  Hammer,
  KeyRound,
  LayoutDashboard,
  Loader2,
  LockOpen,
  LockKeyhole,
  LogOut,
  Play,
  Plus,
  RefreshCw,
  Search,
  Square,
  Terminal,
  Trash2,
  Wrench,
  X
} from "./components/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactElement, ReactNode } from "react";
import { AnimatedIcon } from "./components/animated-icon";
import { ThemeToggle } from "./components/theme-toggle";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { NativeSelect } from "./components/ui/native-select";
import { Switch } from "./components/ui/switch";
import { Textarea } from "./components/ui/textarea";
import {
  deriveAgentRunTimelineRows,
  formatElapsed,
  normalizeCompactToolLabel,
  type AgentRunChatMessage,
  type AgentRunTimelineRun,
  type AgentRunTimelineRow,
  type AgentRunWorkLogEntry
} from "./agentRunTimeline";

type View = "tasks" | "agents" | "projects" | "connectors" | "runs" | "skills" | "api" | "credentials";

interface User {
  id: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "member";
}

interface Project {
  id: string;
  name: string;
  source: "local_path" | "github";
  local_path: string;
  workspace_mode: "direct" | "git_worktree";
  github_owner?: string | null;
  github_repo?: string | null;
  default_branch?: string | null;
}

interface Agent {
  id: string;
  kind: "worker" | "dispatcher";
  name: string;
  description: string;
  model: string;
  instructions: string;
  enabled: boolean;
}

interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  files: Record<string, string>;
  enabled: boolean;
}

interface CodexModel {
  id: string;
  label: string;
  description: string;
  badge?: string;
}

interface Task {
  id: string;
  number: number;
  title: string;
  body: string;
  status: string;
  project_id: string | null;
  agent_id: string;
  project_name: string | null;
  agent_name: string;
  agent_kind: "worker" | "dispatcher";
  latest_run_status?: string | null;
  latest_run_id?: string | null;
  has_runs?: boolean;
  open_pr_on_success: boolean;
  updated_at?: string;
  created_at?: string;
}

interface GithubRepository {
  id: string;
  full_name: string;
  default_branch: string;
  imported_project_id?: string | null;
  connection_name: string;
}

interface RunEvent {
  id: string;
  seq: number;
  event_type: string;
  text?: string | null;
  payload: unknown;
  created_at?: string;
}

interface Run {
  id: string;
  status: string;
  kind?: "worker" | "dispatcher";
}

interface AgentRun {
  id: string;
  kind: "worker" | "dispatcher";
  trigger: string;
  status: string;
  model: string;
  task_id?: string | null;
  task_number?: number | null;
  task_title?: string | null;
  project_name?: string | null;
  agent_name: string;
  prompt?: string | null;
  queued_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
}

interface ExternalApiKey {
  id: string;
  name: string;
  token_prefix: string;
  expires_at: string;
  last_used_at?: string | null;
  revoked_at?: string | null;
  created_at: string;
}

interface Credential {
  id: string;
  name: string;
  description: string;
  agent_accessible: boolean;
  last_used_at?: string | null;
  created_at: string;
  updated_at: string;
}

const BOARD_COLUMNS = [
  { id: "open", title: "Todo", icon: <Circle size={15} /> },
  { id: "running", title: "Running", icon: <CircleDashed size={15} /> },
  { id: "completed", title: "Completed", icon: <CheckCircle2 size={15} /> },
  { id: "failed", title: "Needs attention", icon: <CircleX size={15} /> }
] as const;

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [hasAdmin, setHasAdmin] = useState<boolean | null>(null);
  const [view, setView] = useState<View>("runs");
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [defaultModel, setDefaultModel] = useState("gpt-5.5");
  const [apiKeys, setApiKeys] = useState<ExternalApiKey[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [repos, setRepos] = useState<GithubRepository[]>([]);
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<AgentRun | null>(null);
  const [agentRunEvents, setAgentRunEvents] = useState<RunEvent[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTaskRun, setSelectedTaskRun] = useState<AgentRunTimelineRun | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [pendingTaskMessages, setPendingTaskMessages] = useState<Record<string, AgentRunChatMessage[]>>({});
  const [pendingRunMessages, setPendingRunMessages] = useState<Record<string, AgentRunChatMessage[]>>({});
  const [query, setQuery] = useState("");
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selectedTask = useMemo(
    () => (selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) : undefined),
    [selectedTaskId, tasks]
  );

  const filteredTasks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tasks;
    return tasks.filter((task) =>
      [task.title, task.body, task.project_name, task.agent_name, `#${task.number}`]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [query, tasks]);

  const displayedAgentRuns = useMemo(() => collapseAgentRuns(agentRuns), [agentRuns]);

  const filteredSkills = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) =>
      [skill.name, skill.description, skill.instructions].join(" ").toLowerCase().includes(needle)
    );
  }, [query, skills]);

  const filteredRuns = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return displayedAgentRuns;
    return displayedAgentRuns.filter((run) =>
      [
        run.kind,
        run.trigger,
        run.status,
        run.model,
        run.agent_name,
        run.project_name ?? "",
        run.task_title ?? "",
        run.task_number ? `TASK-${run.task_number}` : ""
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [displayedAgentRuns, query]);

  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", handleSearchShortcut);
    return () => window.removeEventListener("keydown", handleSearchShortcut);
  }, []);

  useEffect(() => {
    if (user) void reloadAll();
  }, [user]);

  useEffect(() => {
    if (!selectedTask) {
      setEvents([]);
      setSelectedTaskRun(null);
      return;
    }
    void loadTaskSession(selectedTask.id);
    if (!isActiveRun(selectedTask.latest_run_status)) return;

    const timer = window.setInterval(() => {
      void loadTaskSession(selectedTask.id);
      void reloadTasks();
      void reloadAgentRuns();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [selectedTask?.id, selectedTask?.latest_run_id, selectedTask?.latest_run_status]);

  useEffect(() => {
    if (!selectedRun) {
      setAgentRunEvents([]);
      return;
    }
    void loadAgentRunEvents(selectedRun);
    if (!isActiveRun(selectedRun.status)) return;
    const timer = window.setInterval(() => {
      void loadAgentRunEvents(selectedRun);
      void reloadAgentRuns();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [selectedRun?.id, selectedRun?.kind, selectedRun?.status]);

  async function boot() {
    const status = await api<{ hasAdmin: boolean }>("/api/onboarding/status");
    setHasAdmin(status.hasAdmin);
    const me = await api<{ user: User | null }>("/api/me");
    setUser(me.user);
  }

  async function reloadAll() {
    await Promise.all([
      reloadProjects(),
      reloadAgents(),
      reloadSkills(),
      reloadApiKeys(),
      reloadCredentials(),
      reloadTasks(),
      reloadModels(),
      reloadAgentRuns(),
      reloadRepos(false)
    ]);
  }

  async function reloadProjects() {
    const data = await api<{ projects: Project[] }>("/api/projects");
    setProjects(data.projects);
  }

  async function reloadAgents() {
    const data = await api<{ agents: Agent[] }>("/api/agents");
    setAgents(data.agents);
  }

  async function reloadSkills() {
    const data = await api<{ skills: Skill[] }>("/api/skills");
    setSkills(data.skills);
  }

  async function reloadApiKeys() {
    const data = await api<{ apiKeys: ExternalApiKey[] }>("/api/api-keys");
    setApiKeys(data.apiKeys);
  }

  async function reloadCredentials() {
    if (!user || user.role === "member") {
      setCredentials([]);
      return;
    }
    const data = await api<{ credentials: Credential[] }>("/api/credentials");
    setCredentials(data.credentials);
  }

  async function reloadModels() {
    const data = await api<{ defaultModel: string; models: CodexModel[] }>("/api/codex/models");
    setDefaultModel(data.defaultModel);
    setModels(data.models);
  }

  async function reloadTasks() {
    const data = await api<{ tasks: Task[] }>("/api/tasks");
    setTasks(data.tasks);
    if (selectedTaskId && !data.tasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(null);
    }
  }

  async function reloadAgentRuns(): Promise<AgentRun[]> {
    const data = await api<{ runs: AgentRun[] }>("/api/agent-runs");
    setAgentRuns(data.runs);
    if (selectedRun && !data.runs.some((run) => run.id === selectedRun.id && run.kind === selectedRun.kind)) {
      setSelectedRun(null);
    }
    return data.runs;
  }

  async function reloadRepos(refresh: boolean) {
    if (!user || user.role === "member") return;
    const data = await api<{ repositories: GithubRepository[] }>(
      `/api/github/repositories${refresh ? "?refresh=true" : ""}`
    );
    setRepos(data.repositories);
  }

  async function loadTaskSession(taskId: string) {
    const data = await api<{ run?: AgentRunTimelineRun | null; events: RunEvent[] }>(
      `/api/tasks/${taskId}/session`
    );
    setSelectedTaskRun(data.run ?? null);
    setEvents(data.events);
  }

  async function loadAgentRunEvents(run: AgentRun) {
    const data = await api<{ run?: Partial<AgentRun> | null; events: RunEvent[] }>(
      `/api/agent-runs/${run.kind}/${run.id}/events`
    );
    if (data.run) {
      setSelectedRun((current) =>
        current && isSameAgentRunConversation(current, run) ? { ...current, ...data.run } : current
      );
    }
    setAgentRunEvents(data.events);
  }

  async function runTask(task: Task) {
    setBusyRunId(task.id);
    try {
      const data = await api<{ run: Run; kind: "worker" | "dispatcher" }>(`/api/tasks/${task.id}/runs`, {
        method: "POST"
      });
      setMessage(`${data.kind === "dispatcher" ? "Dispatcher" : "Run"} queued: ${shortId(data.run.id)}`);
      setSelectedTaskId(task.id);
      await Promise.all([reloadTasks(), reloadAgentRuns()]);
    } finally {
      setBusyRunId(null);
    }
  }

  async function sendTaskMessage(task: Task, messageText: string) {
    const optimistic = optimisticMessage(messageText);
    setPendingTaskMessages((current) => appendPendingMessage(current, task.id, optimistic));
    setBusyRunId(task.id);
    try {
      const data = await api<{ run: Run; kind: "worker" | "dispatcher" }>(`/api/tasks/${task.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ message: messageText })
      });
      setMessage(`${data.kind === "dispatcher" ? "Dispatcher" : "Turn"} queued: ${shortId(data.run.id)}`);
      setSelectedTaskId(task.id);
      await Promise.all([reloadTasks(), reloadAgentRuns(), loadTaskSession(task.id)]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to send message.");
      throw error;
    } finally {
      setPendingTaskMessages((current) => removePendingMessage(current, task.id, optimistic.id));
      setBusyRunId(null);
    }
  }

  async function sendAgentRunMessage(run: AgentRun, messageText: string) {
    const key = agentRunConversationKey(run);
    const optimistic = optimisticMessage(messageText);
    setPendingRunMessages((current) => appendPendingMessage(current, key, optimistic));
    try {
      const data = await api<{ run: Run; kind: "worker" | "dispatcher" }>(
        `/api/agent-runs/${run.kind}/${run.id}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ message: messageText })
        }
      );
      setMessage(`${data.kind === "dispatcher" ? "Dispatcher" : "Turn"} queued: ${shortId(data.run.id)}`);
      const [runs] = await Promise.all([reloadAgentRuns(), reloadTasks()]);
      const nextRun = findUpdatedConversationRun(runs, run, data.run.id, data.kind);
      if (nextRun) {
        setSelectedRun(nextRun);
        await loadAgentRunEvents(nextRun);
      } else {
        await loadAgentRunEvents(run);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to send message.");
      throw error;
    } finally {
      setPendingRunMessages((current) => removePendingMessage(current, key, optimistic.id));
    }
  }

  if (hasAdmin === null) return <Splash />;
  if (!hasAdmin) return <Onboarding onDone={boot} />;
  if (!user) return <Login onDone={boot} />;

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">
            <Terminal size={17} weight="fill" />
          </span>
          <div className="brand-copy">
            <strong>Aisevak</strong>
            <small>Agent workspace</small>
          </div>
        </div>

        <nav className="sidebar-nav">
          <span className="nav-label">Workspace</span>
          <NavButton icon={<LayoutDashboard />} label="Tasks" active={view === "tasks"} onClick={() => setView("tasks")} />
          <NavButton icon={<Activity />} label="Agent Runs" active={view === "runs"} onClick={() => setView("runs")} />
          <NavButton icon={<Bot />} label="Agents" active={view === "agents"} onClick={() => setView("agents")} />
          <NavButton icon={<BookOpen />} label="Skills" active={view === "skills"} onClick={() => setView("skills")} />
          <span className="nav-label nav-label-spaced">Manage</span>
          <NavButton icon={<KeyRound />} label="API" active={view === "api"} onClick={() => setView("api")} />
          {user.role !== "member" ? (
            <NavButton icon={<LockKeyhole />} label="Credentials" active={view === "credentials"} onClick={() => setView("credentials")} />
          ) : null}
          <NavButton icon={<FolderGit2 />} label="Projects" active={view === "projects"} onClick={() => setView("projects")} />
          <NavButton icon={<Github />} label="Connectors" active={view === "connectors"} onClick={() => setView("connectors")} />
        </nav>

        <div className="sidebar-footer">
          <div className="user-chip">
            <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
            <span className="user-details">
              <strong>{user.name}</strong>
              <small>{user.role}</small>
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            title="Log out"
            aria-label="Log out"
            onClick={async () => {
              await api("/api/logout", { method: "POST" });
              setUser(null);
            }}
          >
            <LogOut size={14} />
          </Button>
        </div>
      </aside>

      <div className="main-content">
        <header className="top-header">
          <div className="header-title">{viewTitle(view)}</div>
          <div className="header-actions">
            <div className="search-bar">
              <Search size={14} className="text-muted" />
              <Input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${viewTitle(view).toLowerCase()}`} />
              <kbd>⌘K</kbd>
            </div>
            <ThemeToggle />
            <Button variant="ghost" size="icon" onClick={() => void reloadAll()} title="Refresh" aria-label="Refresh">
              <RefreshCw size={14} />
            </Button>
          </div>
        </header>

        {message ? <div className="notice">{message}</div> : null}

        <main className="view-container">
          {view === "tasks" ? (
            <TasksView
              tasks={filteredTasks}
              agents={agents}
              projects={projects}
              selectedTask={selectedTask}
              selectedTaskRun={selectedTaskRun}
              events={events}
              pendingMessages={selectedTask ? (pendingTaskMessages[selectedTask.id] ?? []) : []}
              busyRunId={busyRunId}
              onCreate={async (payload) => {
                await api<{ task: Task }>("/api/tasks", {
                  method: "POST",
                  body: JSON.stringify(payload)
                });
                await reloadTasks();
              }}
              onSelect={setSelectedTaskId}
              onClose={() => setSelectedTaskId(null)}
              onRun={runTask}
              onSendMessage={sendTaskMessage}
              onCancel={async (runId) => {
                await api(`/api/runs/${runId}/cancel`, { method: "POST" });
                await Promise.all([reloadTasks(), reloadAgentRuns()]);
              }}
            />
          ) : null}

          {view === "runs" ? (
            <AgentRunsView
              runs={filteredRuns}
              selectedRun={selectedRun}
              events={agentRunEvents}
              pendingMessages={selectedRun ? (pendingRunMessages[agentRunConversationKey(selectedRun)] ?? []) : []}
              onSelect={(run) => {
                setSelectedRun(run);
                void loadAgentRunEvents(run);
              }}
              onSendMessage={sendAgentRunMessage}
            />
          ) : null}

          {view === "agents" ? (
            <AgentsView agents={agents} models={models} defaultModel={defaultModel} onSaved={reloadAgents} />
          ) : null}

          {view === "skills" ? <SkillsView skills={filteredSkills} onSaved={reloadSkills} /> : null}

          {view === "api" ? <ApiView apiKeys={apiKeys} onSaved={reloadApiKeys} /> : null}

          {view === "credentials" ? <CredentialsView credentials={credentials} onSaved={reloadCredentials} /> : null}

          {view === "projects" ? <ProjectsView projects={projects} onSaved={reloadProjects} /> : null}

          {view === "connectors" ? (
            <ConnectorsView
              repos={repos}
              onConnect={async (payload) => {
                await api("/api/github/pat", { method: "POST", body: JSON.stringify(payload) });
                await reloadRepos(true);
              }}
              onRefresh={() => reloadRepos(true)}
              onImport={async (repoId) => {
                await api(`/api/github/repositories/${repoId}/import`, { method: "POST" });
                setMessage("Import queued");
              }}
            />
          ) : null}
        </main>
      </div>
    </div>
  );
}

function TasksView(props: {
  tasks: Task[];
  projects: Project[];
  agents: Agent[];
  selectedTask?: Task;
  selectedTaskRun: AgentRunTimelineRun | null;
  events: RunEvent[];
  pendingMessages: AgentRunChatMessage[];
  busyRunId: string | null;
  onCreate: (payload: Record<string, unknown>) => Promise<void>;
  onSelect: (id: string) => void;
  onClose: () => void;
  onRun: (task: Task) => Promise<void>;
  onSendMessage: (task: Task, message: string) => Promise<void>;
  onCancel: (runId: string) => Promise<void>;
}) {
  return (
    <div className={`board-layout ${props.selectedTask ? "has-detail" : ""}`}>
      <div className="board-main">
        <div className="board-toolbar">
          <TaskForm projects={props.projects} agents={props.agents} onCreate={props.onCreate} />
        </div>
        <div className="board-columns">
          {BOARD_COLUMNS.map((column) => {
            const tasks = props.tasks.filter((task) => taskBucket(task) === column.id);
            return (
              <div className="kanban-col" key={column.id}>
                <div className="kanban-head">
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {column.icon} {column.title}
                  </span>
                  <span className="count-badge">{tasks.length}</span>
                </div>
                <div className="kanban-cards">
                  {tasks.map((task) => (
                    <button
                      className={`kanban-card ${props.selectedTask?.id === task.id ? "selected" : ""}`}
                      key={task.id}
                      onClick={() => props.onSelect(task.id)}
                    >
                      <div className="card-top">
                        <span className="task-key">TASK-{task.number}</span>
                        <TaskStatus status={task.latest_run_status ?? task.status} />
                      </div>
                      <div className="card-title">{task.title}</div>
                      <div className="card-desc">{task.project_name ?? "No project"}</div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {props.selectedTask ? (
        <TaskDetail
          task={props.selectedTask}
          run={props.selectedTaskRun}
          events={props.events}
          pendingMessages={props.pendingMessages}
          busyRunId={props.busyRunId}
          onClose={props.onClose}
          onRun={props.onRun}
          onSendMessage={props.onSendMessage}
          onCancel={props.onCancel}
        />
      ) : null}
    </div>
  );
}

function TaskForm(props: {
  projects: Project[];
  agents: Agent[];
  onCreate: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [projectId, setProjectId] = useState("");
  const [agentId, setAgentId] = useState("auto");
  const workerAgents = props.agents.filter((agent) => agent.kind !== "dispatcher");

  return (
    <form
      className="task-create-form"
      onSubmit={async (event) => {
        event.preventDefault();
        await props.onCreate({
          title,
          body,
          ...(projectId ? { projectId } : {}),
          ...(agentId === "auto" ? {} : { agentId })
        });
        setTitle("");
        setBody("");
        setAgentId("auto");
      }}
    >
      <div className="inline-create">
        <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What needs to be done?" required />
        <Input value={body} onChange={(event) => setBody(event.target.value)} placeholder="Add a short brief" />
        <NativeSelect value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">No project</option>
          {props.projects.map((project) => (
            <option value={project.id} key={project.id}>
              {project.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect value={agentId} onChange={(event) => setAgentId(event.target.value)} required>
          <option value="auto">Auto-route</option>
          {workerAgents.map((agent) => (
            <option value={agent.id} key={agent.id}>
              {agent.name}
            </option>
          ))}
        </NativeSelect>
        <Button type="submit">
          <Plus size={15} />
          New task
        </Button>
      </div>
    </form>
  );
}

function TaskDetail(props: {
  task?: Task;
  run: AgentRunTimelineRun | null;
  events: RunEvent[];
  pendingMessages: AgentRunChatMessage[];
  busyRunId: string | null;
  onClose: () => void;
  onRun: (task: Task) => Promise<void>;
  onSendMessage: (task: Task, message: string) => Promise<void>;
  onCancel: (runId: string) => Promise<void>;
}) {
  if (!props.task) {
    return (
      <aside className="side-panel">
        <div className="empty-state">Select a task</div>
      </aside>
    );
  }

  const active = isActiveRun(props.task.latest_run_status);
  const hasRun = Boolean(props.task.has_runs || props.task.latest_run_id || props.task.latest_run_status);
  const showRun = !hasRun;
  const showStop = active && Boolean(props.task.latest_run_id);
  const canStartRun = props.task.agent_kind === "dispatcher" || Boolean(props.task.project_id);
  const taskRun =
    props.run ??
    (props.task.latest_run_id || props.events.length > 0
      ? {
          id: props.task.latest_run_id ?? props.task.id,
          kind: "worker" as const,
          status: props.task.latest_run_status ?? props.task.status,
          agent_name: props.task.agent_name,
          prompt: props.task.body || props.task.title,
          queued_at: props.task.created_at ?? props.task.updated_at ?? null,
          started_at: props.task.updated_at ?? null,
          finished_at: active ? null : props.task.updated_at ?? null
        }
      : null);
  return (
    <aside className="side-panel">
      <div className="detail-header-flat">
        <div className="flex-between">
          <span className="task-key">TASK-{props.task.number}</span>
          <Button variant="ghost" size="icon" onClick={props.onClose} title="Close task" aria-label="Close task">
            <X size={15} />
          </Button>
        </div>
        <h2>{props.task.title}</h2>
        <p className="text-muted">{props.task.project_name ?? "No project"} / {props.task.agent_name}</p>
        <div className="mt-2">
          <TaskStatus status={props.task.latest_run_status ?? props.task.status} />
        </div>
      </div>
      <div className="detail-body">
        <div className="task-body-text">{props.task.body || "No description."}</div>
        {showRun || showStop ? (
          <div className="action-row">
            {showRun ? (
              <Button
                disabled={props.busyRunId === props.task.id || !canStartRun}
                title={canStartRun ? "Run" : "Assign a project before starting a worker run"}
                onClick={() => props.onRun(props.task!)}
              >
                {props.busyRunId === props.task.id ? <Loader2 className="spin" size={15} /> : <Play size={15} />}
                Run
              </Button>
            ) : null}
            {showStop ? (
              <Button variant="secondary" onClick={() => props.onCancel(props.task!.latest_run_id!)}>
                <Square size={15} />
                Stop
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="detail-chat">
        <CodexSessionTimeline run={taskRun} events={props.events} pendingMessages={props.pendingMessages} />
        <SessionComposer
          disabled={props.busyRunId === props.task.id}
          modelLabel={taskRun?.model}
          onSend={(message) => props.onSendMessage(props.task!, message)}
          placeholder="Message this Codex session"
        />
      </div>
    </aside>
  );
}

function AgentRunsView(props: {
  runs: AgentRun[];
  selectedRun: AgentRun | null;
  events: RunEvent[];
  pendingMessages: AgentRunChatMessage[];
  onSelect: (run: AgentRun) => void;
  onSendMessage: (run: AgentRun, message: string) => Promise<void>;
}) {
  return (
    <div className="master-detail">
      <aside className="master-list">
        <div className="master-header flex-between">
          <h3>Agent Runs</h3>
          <span className="count-badge">{props.runs.length}</span>
        </div>
        <div className="list-scroll">
          {props.runs.map((run) => (
            <button
              className={`list-item ${isSameAgentRunConversation(props.selectedRun, run) ? "selected" : ""}`}
              key={`${run.kind}-${run.id}`}
              onClick={() => props.onSelect(run)}
            >
              <div className="list-item-icon">
                {run.kind === "dispatcher" ? <Activity size={15} /> : <Bot size={15} />}
              </div>
              <div className="list-item-main">
                <span className="list-item-title">{runTitle(run)}</span>
                <span className="list-item-desc">{run.agent_name} / {run.trigger}</span>
              </div>
              <div>
                <TaskStatus status={run.status} />
              </div>
            </button>
          ))}
          {props.runs.length === 0 ? <div className="empty-list">No agent runs</div> : null}
        </div>
      </aside>
      <main className="detail-view">
        {props.selectedRun ? (
          <div className="detail-scroll">
            <div className="detail-header-flat">
              <span className="meta-badge">{props.selectedRun.kind}</span>
              <h2>{runTitle(props.selectedRun)}</h2>
              <p className="text-muted">
                {props.selectedRun.agent_name} / {props.selectedRun.model} / {props.selectedRun.trigger}
              </p>
              <div className="mt-2">
                <TaskStatus status={props.selectedRun.status} />
              </div>
            </div>
            {props.selectedRun.error ? <div className="notice error">{props.selectedRun.error}</div> : null}
            <div className="detail-chat">
              <CodexSessionTimeline
                run={props.selectedRun}
                events={props.events}
                pendingMessages={props.pendingMessages}
              />
              <SessionComposer
                modelLabel={props.selectedRun.model}
                onSend={(message) => props.onSendMessage(props.selectedRun!, message)}
                placeholder="Message this Codex session"
              />
            </div>
          </div>
        ) : (
          <div className="empty-state">Select a run</div>
        )}
      </main>
    </div>
  );
}

function AgentsView(props: {
  agents: Agent[];
  models: CodexModel[];
  defaultModel: string;
  onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Agent | null>(props.agents[0] ?? null);
  useEffect(() => {
    if (!editing && props.agents[0]) setEditing(props.agents[0]);
  }, [props.agents, editing]);

  return (
    <div className="master-detail">
      <aside className="master-list">
        <div className="master-header flex-between">
          <h3>Agents</h3>
          <Button variant="ghost" size="icon" onClick={() => setEditing(emptyAgent(props.defaultModel))} aria-label="New agent">
            <Plus size={14} />
          </Button>
        </div>
        <div className="list-scroll">
          {props.agents.map((agent) => (
            <button
              className={`list-item ${editing?.id === agent.id ? "selected" : ""}`}
              key={agent.id}
              onClick={() => setEditing(agent)}
            >
              <div className="list-item-icon">
                <Bot size={15} />
              </div>
              <div className="list-item-main">
                <span className="list-item-title">{agent.name}</span>
                <span className="list-item-desc">{agent.kind} / {agent.model}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>
      <main className="detail-view">
        {editing ? (
          <div className="form-view">
            <AgentEditor
              agent={editing}
              models={props.models}
              defaultModel={props.defaultModel}
              onSaved={props.onSaved}
            />
          </div>
        ) : (
          <div className="empty-state">Select an agent</div>
        )}
      </main>
    </div>
  );
}

function AgentEditor(props: {
  agent: Agent;
  models: CodexModel[];
  defaultModel: string;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(props.agent);
  useEffect(() => setDraft(props.agent), [props.agent]);

  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        const path = draft.id ? `/api/agents/${draft.id}` : "/api/agents";
        await api(path, { method: draft.id ? "PATCH" : "POST", body: JSON.stringify(draft) });
        await props.onSaved();
      }}
    >
      <div className="form-grid">
        <label>
          Name
          <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
        <label>
          Model
          <NativeSelect value={draft.model || props.defaultModel} onChange={(event) => setDraft({ ...draft, model: event.target.value })}>
            {props.models.map((model) => (
              <option value={model.id} key={model.id}>
                {model.label}{model.badge ? ` - ${model.badge}` : ""}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>
      <label>
        Description
        <Input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
      </label>
      <label>
        Prompt
        <Textarea
          style={{ minHeight: 300, fontFamily: "monospace", fontSize: 13 }}
          value={draft.instructions}
          onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
        />
      </label>
      <div className="model-list">
        {props.models.map((model) => (
          <span className="model-pill" key={model.id}>
            {model.id}
          </span>
        ))}
      </div>
      <div style={{ marginTop: 16 }}>
        <Button type="submit">
          <CheckCircle2 size={15} />
          Save agent
        </Button>
      </div>
    </form>
  );
}

function ApiView(props: { apiKeys: ExternalApiKey[]; onSaved: () => Promise<void> }) {
  const [name, setName] = useState("External integration");
  const [expiresAt, setExpiresAt] = useState(() => localDateTimeInput(addDays(new Date(), 30)));
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flat-list-view api-view">
      <div className="flat-header">
        <h3>API</h3>
      </div>

      <section className="api-section">
        <div className="section-title-row">
          <div>
            <h4>API Keys</h4>
            <p>Keys authenticate as your user account and inherit your current role.</p>
          </div>
        </div>
        <form
          className="api-key-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            setCreatedSecret(null);
            try {
              const data = await api<{ apiKey: ExternalApiKey; secret: string }>("/api/api-keys", {
                method: "POST",
                body: JSON.stringify({
                  name,
                  expiresAt: new Date(expiresAt).toISOString()
                })
              });
              setCreatedSecret(data.secret);
              setName("External integration");
              setExpiresAt(localDateTimeInput(addDays(new Date(), 30)));
              await props.onSaved();
            } catch (createError) {
              setError(friendlyError(createError instanceof Error ? createError.message : "Could not create API key."));
            }
          }}
        >
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Key name" required />
          <Input
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
            type="datetime-local"
            required
          />
          <Button type="submit">
            <Plus size={15} />
            Create key
          </Button>
        </form>
        {error ? <div className="notice error">{error}</div> : null}
        {createdSecret ? (
          <div className="api-secret-box">
            <div>
              <strong>Copy this key now.</strong>
              <p>It will not be shown again.</p>
            </div>
            <code>{createdSecret}</code>
            <CopyButton text={createdSecret} label="Copy API key" />
          </div>
        ) : null}
        <div className="api-key-list">
          {props.apiKeys.map((key) => (
            <div className="data-row" key={key.id}>
              <div className="data-row-main">
                <div className="data-icon">
                  <KeyRound size={16} />
                </div>
                <div>
                  <div className="data-title">{key.name}</div>
                  <div className="data-subtitle">
                    {key.token_prefix}... / expires {formatDateTime(key.expires_at)}
                    {key.last_used_at ? ` / used ${formatDateTime(key.last_used_at)}` : ""}
                  </div>
                </div>
              </div>
              <div className="row-actions">
                <TaskStatus status={apiKeyStatus(key)} />
                {!key.revoked_at ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Revoke key"
                    aria-label="Revoke key"
                    onClick={async () => {
                      await api(`/api/api-keys/${key.id}`, { method: "DELETE" });
                      await props.onSaved();
                    }}
                  >
                    <Trash2 size={14} />
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          {props.apiKeys.length === 0 ? <div className="empty-list">No API keys</div> : null}
        </div>
      </section>

      <section className="api-section">
        <div className="section-title-row">
          <div>
            <h4>Docs</h4>
            <p>Use the key as a bearer token with the existing Aisevak API.</p>
          </div>
          <CopyButton text={apiDocsText(apiBaseUrl())} label="Copy API docs" />
        </div>
        <ApiDocs />
      </section>
    </div>
  );
}

function ApiDocs() {
  const docs = apiDocs(apiBaseUrl());
  return (
    <div className="api-docs">
      <div className="api-doc-block">
        <h5>List projects, agents, and skills</h5>
        <CodeBlock language="bash" code={docs.list} />
      </div>
      <div className="api-doc-block">
        <h5>Create a task with optional skills</h5>
        <CodeBlock language="bash" code={docs.createTask} />
      </div>
      <div className="api-doc-block">
        <h5>Start a run</h5>
        <CodeBlock language="bash" code={docs.startRun} />
      </div>
    </div>
  );
}

function apiBaseUrl(): string {
  return window.location.origin.replace("5173", "8787");
}

function apiDocs(baseUrl: string): { list: string; createTask: string; startRun: string } {
  return {
    list: `curl -H "Authorization: Bearer $AISEVAK_API_KEY" \\
  ${baseUrl}/api/projects

curl -H "Authorization: Bearer $AISEVAK_API_KEY" \\
  ${baseUrl}/api/agents

curl -H "Authorization: Bearer $AISEVAK_API_KEY" \\
  ${baseUrl}/api/skills`,
    createTask: `curl -X POST ${baseUrl}/api/tasks \\
  -H "Authorization: Bearer $AISEVAK_API_KEY" \\
	  -H "Content-Type: application/json" \\
	  -d '{
	    "title": "Add regression test",
	    "body": "Use the existing test style.",
	    "agentId": "AGENT_UUID"
	  }'`,
    startRun: `curl -X POST ${baseUrl}/api/tasks/TASK_UUID/runs \\
  -H "Authorization: Bearer $AISEVAK_API_KEY"`
  };
}

function apiDocsText(baseUrl: string): string {
  const docs = apiDocs(baseUrl);
  return [
    "# Aisevak API Quickstart",
    "",
    "Set your API key:",
    "export AISEVAK_API_KEY=avk_...",
    "",
    "## List projects, agents, and skills",
    "```bash",
    docs.list,
    "```",
    "",
    "## Create a task with optional skills",
    "```bash",
    docs.createTask,
    "```",
    "",
    "## Start a run",
    "```bash",
    docs.startRun,
    "```"
  ].join("\n");
}

function CredentialsView(props: { credentials: Credential[]; onSaved: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flat-list-view api-view">
      <div className="flat-header">
        <h3>Credentials</h3>
      </div>

      <section className="api-section">
        <div className="section-title-row">
          <div>
            <h4>Agent Credentials</h4>
            <p>Store service API keys and secrets that agents can fetch by name only when needed.</p>
          </div>
        </div>
        <form
          className="credential-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            try {
              await api("/api/credentials", {
                method: "POST",
                body: JSON.stringify({
                  name,
                  description,
                  value
                })
              });
              setName("");
              setDescription("");
              setValue("");
              await props.onSaved();
            } catch (createError) {
              setError(friendlyError(createError instanceof Error ? createError.message : "Could not save credential."));
            }
          }}
        >
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name, e.g. stripe_api_key" required />
          <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Service or purpose" />
          <Input value={value} onChange={(event) => setValue(event.target.value)} placeholder="Secret value" type="password" required />
          <Button type="submit">
            <Plus size={15} />
            Add
          </Button>
        </form>
        {error ? <div className="notice error">{error}</div> : null}
        <div className="api-key-list">
          {props.credentials.map((credential) => (
            <div className="data-row" key={credential.id}>
              <div className="data-row-main">
                <div className="data-icon">
                  <LockKeyhole size={16} />
                </div>
                <div>
                  <div className="data-title">{credential.name}</div>
                  <div className="data-subtitle">
                    {credential.description || "No description"}
                    {credential.last_used_at ? ` / used ${formatDateTime(credential.last_used_at)}` : ""}
                  </div>
                </div>
              </div>
              <div className="row-actions">
                <TaskStatus status="active" />
                <Button
                  variant="ghost"
                  size="icon"
                  title="Delete credential"
                  aria-label="Delete credential"
                  onClick={async () => {
                    await api(`/api/credentials/${credential.id}`, { method: "DELETE" });
                    await props.onSaved();
                  }}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </div>
          ))}
          {props.credentials.length === 0 ? <div className="empty-list">No credentials</div> : null}
        </div>
      </section>

      <section className="api-section">
        <div className="section-title-row">
          <div>
            <h4>Agent Access</h4>
            <p>Agents use the injected Aisevak CLI. Values are redacted from stored transcripts when echoed.</p>
          </div>
          <CopyButton text={credentialDocsText()} label="Copy credential docs" />
        </div>
        <CodeBlock language="bash" code={credentialDocsText()} />
      </section>
    </div>
  );
}

function credentialDocsText(): string {
  return [
    "aisevak credential list",
    "aisevak credential get <name>",
    "printf %s \"$SECRET_VALUE\" | aisevak credential add <name> --value-stdin",
    "",
    "Example:",
    "aisevak credential get stripe_api_key",
    "printf %s \"$STRIPE_API_KEY\" | aisevak credential add stripe_api_key --value-stdin --description \"Stripe API key\""
  ].join("\n");
}

function SkillsView(props: { skills: Skill[]; onSaved: () => Promise<void> }) {
  const [editing, setEditing] = useState<Skill | null>(props.skills[0] ?? null);
  useEffect(() => {
    if (!editing && props.skills[0]) setEditing(props.skills[0]);
  }, [props.skills, editing]);

  return (
    <div className="master-detail">
      <aside className="master-list">
        <div className="master-header flex-between">
          <h3>Skills</h3>
          <Button variant="ghost" size="icon" onClick={() => setEditing(emptySkill())} title="New skill" aria-label="New skill">
            <Plus size={14} />
          </Button>
        </div>
        <div className="list-scroll">
          {props.skills.map((skill) => (
            <button
              className={`list-item ${editing?.id === skill.id ? "selected" : ""}`}
              key={skill.id}
              onClick={() => setEditing(skill)}
            >
              <div className="list-item-icon">
                <BookOpen size={15} />
              </div>
              <div className="list-item-main">
                <span className="list-item-title">${skill.name}</span>
                <span className="list-item-desc">{skill.description}</span>
              </div>
              <TaskStatus status={skill.enabled ? "enabled" : "disabled"} />
            </button>
          ))}
          {props.skills.length === 0 ? <div className="empty-list">No skills</div> : null}
        </div>
      </aside>
      <main className="detail-view">
        {editing ? (
          <div className="form-view">
            <SkillEditor skill={editing} onSaved={props.onSaved} />
          </div>
        ) : (
          <div className="empty-state">Select a skill</div>
        )}
      </main>
    </div>
  );
}

function SkillEditor(props: { skill: Skill; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState(props.skill);
  const [filesJson, setFilesJson] = useState(() => JSON.stringify(props.skill.files ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(props.skill);
    setFilesJson(JSON.stringify(props.skill.files ?? {}, null, 2));
    setError(null);
  }, [props.skill]);

  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        let files: Record<string, string>;
        try {
          const parsed = JSON.parse(filesJson || "{}") as unknown;
          files = normalizeFilesDraft(parsed);
        } catch (parseError) {
          setError(parseError instanceof Error ? parseError.message : "Files must be valid JSON.");
          return;
        }
        const path = draft.id ? `/api/skills/${draft.id}` : "/api/skills";
        try {
          await api(path, {
            method: draft.id ? "PATCH" : "POST",
            body: JSON.stringify({ ...draft, files })
          });
          await props.onSaved();
        } catch (saveError) {
          setError(saveError instanceof Error ? saveError.message : "Failed to save skill.");
        }
      }}
    >
      <div className="form-grid">
        <label>
          Name
          <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
        <label className="toggle-field">
          Enabled
          <Switch
            checked={draft.enabled}
            onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })}
          />
        </label>
      </div>
      <label>
        Description
        <Input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
      </label>
      <label>
        Instructions
        <Textarea
          className="textarea-mono"
          style={{ minHeight: 260 }}
          value={draft.instructions}
          onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
        />
      </label>
      <label>
        Files JSON
        <Textarea
          className="textarea-mono"
          style={{ minHeight: 150 }}
          value={filesJson}
          onChange={(event) => setFilesJson(event.target.value)}
        />
      </label>
      {error ? <div className="notice error">{error}</div> : null}
      <div>
        <Button type="submit">
          <CheckCircle2 size={15} />
          Save skill
        </Button>
      </div>
    </form>
  );
}

function ProjectsView({
  projects,
  onSaved
}: {
  projects: Project[];
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState<"direct" | "git_worktree">("direct");

  return (
    <div className="flat-list-view">
      <div className="flat-header">
        <h3>Projects</h3>
      </div>
      <form
        className="stack"
        style={{ marginBottom: 32 }}
        onSubmit={async (event) => {
          event.preventDefault();
          await api("/api/projects", {
            method: "POST",
            body: JSON.stringify({ name, localPath, workspaceMode })
          });
          setName("");
          setLocalPath("");
          await onSaved();
        }}
      >
        <div className="wide-form-row">
          <Input style={{ flex: 1 }} value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" required />
          <Input style={{ flex: 2 }} value={localPath} onChange={(event) => setLocalPath(event.target.value)} placeholder="/absolute/path/to/repo" required />
          <NativeSelect className="project-mode-select" value={workspaceMode} onChange={(event) => setWorkspaceMode(event.target.value as "direct" | "git_worktree")}>
            <option value="direct">Direct folder</option>
            <option value="git_worktree">Git worktree</option>
          </NativeSelect>
          <Button type="submit" style={{ flex: "0 0 auto" }}>
            <Plus size={15} />
            Add
          </Button>
        </div>
      </form>
      <div>
        {projects.map((project) => (
          <div className="data-row" key={project.id}>
            <div className="data-row-main">
              <div className="data-icon"><FolderGit2 size={16}/></div>
                <div>
                  <div className="data-title">{project.name}</div>
                  <div className="data-subtitle">{project.local_path}</div>
                </div>
            </div>
            <div className="data-subtitle" style={{ textTransform: "capitalize" }}>{project.source}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectorsView(props: {
  repos: GithubRepository[];
  onConnect: (payload: { name: string; token: string }) => Promise<void>;
  onRefresh: () => Promise<void>;
  onImport: (repoId: string) => Promise<void>;
}) {
  const [name, setName] = useState("GitHub");
  const [token, setToken] = useState("");

  return (
    <div className="master-detail">
      <aside className="master-list">
        <div className="master-header">
          <h3>Connections</h3>
        </div>
        <div style={{ padding: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
            <Github size={24} />
            <div>
              <div style={{ fontWeight: 600 }}>GitHub</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Repository import</div>
            </div>
          </div>
          <form
            className="stack"
            onSubmit={async (event) => {
              event.preventDefault();
              await props.onConnect({ name, token });
              setToken("");
            }}
          >
            <Input value={name} onChange={(event) => setName(event.target.value)} />
            <Input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Fine-grained PAT" type="password" />
            <div style={{ display: "flex", gap: 8 }}>
              <Button type="submit">
                <Github size={14} /> Connect
              </Button>
              <Button variant="secondary" type="button" onClick={props.onRefresh}>
                <RefreshCw size={14} /> Refresh
              </Button>
            </div>
          </form>
        </div>
      </aside>
      <main className="detail-view">
        <div className="detail-scroll">
          <div className="flat-header">
            <h3>Repositories</h3>
          </div>
          <div>
            {props.repos.map((repo) => (
              <div className="data-row" key={repo.id}>
                <div className="data-row-main">
                  <div className="data-icon"><Github size={16} /></div>
                  <div>
                    <div className="data-title">{repo.full_name}</div>
                    <div className="data-subtitle">{repo.connection_name} / {repo.default_branch}</div>
                  </div>
                </div>
                <Button variant="secondary" onClick={() => props.onImport(repo.id)} disabled={Boolean(repo.imported_project_id)}>
                  {repo.imported_project_id ? "Imported" : "Import"}
                </Button>
              </div>
            ))}
            {props.repos.length === 0 ? <div className="empty-list">No repositories</div> : null}
          </div>
        </div>
      </main>
    </div>
  );
}

function CodexSessionTimeline({
  run,
  events,
  pendingMessages = []
}: {
  run: AgentRunTimelineRun | null;
  events: RunEvent[];
  pendingMessages?: AgentRunChatMessage[];
}) {
  const rows = useMemo(
    () => deriveAgentRunTimelineRows({ run, events, pendingMessages }),
    [events, pendingMessages, run]
  );

  if (!run && events.length === 0 && pendingMessages.length === 0) {
    return (
      <div className="chat-timeline empty-chat">
        <span className="text-muted">No run events yet.</span>
      </div>
    );
  }

  return (
    <div className="chat-timeline">
      {rows.length === 0 ? <span className="text-muted">No run events yet.</span> : null}
      {rows.map((row) => (
        <TimelineRow row={row} key={row.id} />
      ))}
    </div>
  );
}

function SessionComposer(props: {
  disabled?: boolean;
  modelLabel?: string | null;
  placeholder: string;
  onSend: (message: string) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = message.trim();
  async function submitMessage() {
    if (!trimmed || sending || props.disabled) return;
    setError(null);
    setSending(true);
    try {
      await props.onSend(trimmed);
      setMessage("");
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Failed to send message.");
    } finally {
      setSending(false);
    }
  }
  return (
    <form
      className="session-composer"
      data-chat-composer-form="true"
      onSubmit={async (event) => {
        event.preventDefault();
        await submitMessage();
      }}
    >
      <div className="session-composer-frame">
        <div className="session-composer-box" data-chat-composer-surface="true">
          <div className="session-composer-editor">
            <Textarea
              value={message}
              disabled={sending || props.disabled}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey) return;
                event.preventDefault();
                void submitMessage();
              }}
              placeholder={props.placeholder}
              rows={3}
            />
          </div>
          <div className="session-composer-footer" data-chat-composer-footer="true">
            <div className="composer-left-actions">
              <span className="composer-chip">
                <Bot size={14} />
                Build
              </span>
              <span className="composer-chip">
                <LockOpen size={14} />
                Full access
              </span>
              {props.modelLabel ? <span className="composer-chip">{props.modelLabel}</span> : null}
            </div>
            <div className="composer-right-actions" data-chat-composer-actions="right">
              <span className="composer-shortcut">Shift Enter</span>
              <button
                className="composer-send-button"
                type="submit"
                disabled={!trimmed || sending || props.disabled}
                aria-label={sending ? "Sending" : "Send message"}
                title={sending ? "Sending" : "Send message"}
              >
                {sending ? <Loader2 className="spin" size={15} /> : <ArrowUp size={16} />}
              </button>
            </div>
          </div>
        </div>
      </div>
      {error ? <div className="composer-error">{error}</div> : null}
    </form>
  );
}

function TimelineRow({ row }: { row: AgentRunTimelineRow }) {
  if (row.kind === "comment") return <TaskCommentTimelineRow row={row} />;
  if (row.kind === "work") return <WorkGroupSection groupedEntries={row.groupedEntries} />;
  if (row.kind === "working") return <WorkingTimelineRow row={row} />;
  if (row.message.role === "user") return <UserTimelineRow row={row} />;
  if (row.message.role === "assistant") return <AssistantTimelineRow row={row} />;
  return <SystemTimelineRow row={row} />;
}

function TaskCommentTimelineRow({ row }: { row: Extract<AgentRunTimelineRow, { kind: "comment" }> }) {
  return (
    <div className="task-comment-row">
      <div className="task-comment-bubble">
        <div className="task-comment-label">Task comment</div>
        <BasicMarkdown text={row.text} plain />
        <TimelineMeta createdAt={row.createdAt} />
      </div>
    </div>
  );
}

function UserTimelineRow({ row }: { row: Extract<AgentRunTimelineRow, { kind: "message" }> }) {
  return (
    <div className="timeline-user-row">
      <div className="user-bubble">
        <CollapsibleText text={row.message.text} />
        <TimelineMeta createdAt={row.message.createdAt} completedAt={row.message.completedAt} />
      </div>
    </div>
  );
}

function AssistantTimelineRow({ row }: { row: Extract<AgentRunTimelineRow, { kind: "message" }> }) {
  return (
    <div className="timeline-assistant-row">
      <div className="assistant-message group-assistant">
        <BasicMarkdown text={row.message.text || (row.message.streaming ? "" : "(empty response)")} />
        <div className="assistant-meta-row">
          <TimelineMeta
            createdAt={row.message.createdAt}
            completedAt={row.message.completedAt}
            durationStart={row.durationStart}
          />
          {!row.message.streaming && row.message.text.trim() ? (
            <CopyButton text={row.message.text} label="Copy message" />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SystemTimelineRow({ row }: { row: Extract<AgentRunTimelineRow, { kind: "message" }> }) {
  return (
    <div className="system-row">
      <span>{row.message.text}</span>
    </div>
  );
}

function WorkGroupSection({ groupedEntries }: { groupedEntries: AgentRunWorkLogEntry[] }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const maxVisible = 6;
  const hasOverflow = groupedEntries.length > maxVisible;
  const visibleEntries =
    hasOverflow && !isExpanded ? groupedEntries.slice(-maxVisible) : groupedEntries;
  const hiddenCount = groupedEntries.length - visibleEntries.length;
  const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");

  return (
    <div className="work-group">
      {hasOverflow || !onlyToolEntries ? (
        <div className="work-group-head">
          <span>{onlyToolEntries ? "Tool calls" : "Work log"} ({groupedEntries.length})</span>
          {hasOverflow ? (
            <button type="button" onClick={() => setIsExpanded((value) => !value)}>
              {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="work-group-rows">
        {visibleEntries.map((entry) => (
          <SimpleWorkEntryRow workEntry={entry} key={entry.id} />
        ))}
      </div>
    </div>
  );
}

function SimpleWorkEntryRow({ workEntry }: { workEntry: AgentRunWorkLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const preview = workEntryPreview(workEntry);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasDetail = Boolean(workEntry.detail?.trim());

  return (
    <div className={`work-entry ${workEntry.tone}`}>
      <button
        type="button"
        className="work-entry-main"
        onClick={() => setExpanded((value) => !value)}
        title={displayText}
      >
        <span className="work-entry-icon">
          <Icon size={13} />
        </span>
        <span className="work-entry-text">
          <strong>{heading}</strong>
          {preview ? <span> - {preview}</span> : null}
        </span>
        {hasDetail ? (
          <span className="work-entry-chevron">
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        ) : null}
      </button>
      {expanded && hasDetail ? <pre className="work-entry-detail">{workEntry.detail}</pre> : null}
    </div>
  );
}

function WorkingTimelineRow({ row }: { row: Extract<AgentRunTimelineRow, { kind: "working" }> }) {
  return (
    <div className="working-row">
      <span className="working-dots">
        <i />
        <i />
        <i />
      </span>
      <span>{row.createdAt ? <>Working for <LiveElapsed createdAt={row.createdAt} /></> : "Working..."}</span>
    </div>
  );
}

function CollapsibleText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = text.length > 600 || text.split("\n").length > 8;
  const collapsed = shouldCollapse && !expanded;

  return (
    <div>
      <div className={`collapsible-message ${collapsed ? "collapsed" : ""}`}>
        <BasicMarkdown text={text} plain />
      </div>
      {shouldCollapse ? (
        <button className="text-button" type="button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : "Show full message"}
        </button>
      ) : null}
    </div>
  );
}

function BasicMarkdown({ text, plain = false }: { text: string; plain?: boolean }) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  return (
    <div className={`basic-markdown ${plain ? "plain" : ""}`}>
      {blocks.map((block, index) =>
        block.type === "code" ? (
          <CodeBlock code={block.content} language={block.language} key={`${block.type}-${index}`} />
        ) : (
          <p key={`${block.type}-${index}`}>{block.content}</p>
        )
      )}
    </div>
  );
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span>{language || "text"}</span>
        <CopyButton text={code} label="Copy code" />
      </div>
      <pre>{code}</pre>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      className="copy-button"
      variant="ghost"
      size="icon"
      type="button"
      title={copied ? "Copied" : label}
      onClick={async () => {
        await navigator.clipboard?.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
    </Button>
  );
}

function TimelineMeta(props: {
  createdAt: string;
  completedAt?: string;
  durationStart?: string;
}) {
  const duration = props.durationStart ? formatElapsed(props.durationStart, props.completedAt) : null;
  return (
    <span className="timeline-meta">
      {formatTimestamp(props.createdAt)}
      {duration ? ` - ${duration}` : ""}
    </span>
  );
}

function LiveElapsed({ createdAt }: { createdAt: string }) {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span>{formatElapsed(createdAt, now) ?? "0s"}</span>;
}

function workEntryIcon(workEntry: AgentRunWorkLogEntry) {
  if (workEntry.itemType === "command_execution" || workEntry.itemType === "commandExecution" || workEntry.command) {
    return Terminal;
  }
  if (workEntry.itemType === "web_search" || workEntry.itemType === "webSearch") return Eye;
  if (workEntry.itemType === "mcp_tool_call" || workEntry.itemType === "mcpToolCall") return Wrench;
  if (workEntry.itemType === "dynamic_tool_call" || workEntry.itemType === "dynamicToolCall") return Hammer;
  if (workEntry.tone === "error") return CircleAlert;
  if (workEntry.tone === "thinking") return Bot;
  if (workEntry.tone === "info") return CheckCircle2;
  return Activity;
}

function toolWorkEntryHeading(workEntry: AgentRunWorkLogEntry): string {
  const raw = workEntry.toolTitle || workEntry.label;
  const normalized = normalizeCompactToolLabel(raw);
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function workEntryPreview(workEntry: AgentRunWorkLogEntry): string | null {
  const preview = workEntry.command || workEntry.detail;
  if (!preview) return null;
  const normalizedPreview = normalizeCompactToolLabel(preview).toLowerCase();
  const normalizedHeading = normalizeCompactToolLabel(toolWorkEntryHeading(workEntry)).toLowerCase();
  if (normalizedPreview === normalizedHeading) return null;
  return preview.replace(/\s+/g, " ").trim();
}

function parseMarkdownBlocks(text: string): Array<{ type: "text" | "code"; content: string; language?: string }> {
  const blocks: Array<{ type: "text" | "code"; content: string; language?: string }> = [];
  const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text))) {
    if (match.index > cursor) {
      pushTextBlocks(blocks, text.slice(cursor, match.index));
    }
    blocks.push({ type: "code", language: match[1]?.trim() || undefined, content: match[2] ?? "" });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    pushTextBlocks(blocks, text.slice(cursor));
  }
  return blocks.length > 0 ? blocks : [{ type: "text", content: "" }];
}

function pushTextBlocks(
  blocks: Array<{ type: "text" | "code"; content: string; language?: string }>,
  text: string
): void {
  const chunks = text
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  for (const chunk of chunks) {
    blocks.push({ type: "text", content: chunk });
  }
}

function TaskStatus({ status }: { status?: string | null }) {
  const bucket = runBucket(status);
  const variant = bucket === "completed" ? "success" : bucket === "running" ? "warning" : bucket === "failed" ? "destructive" : "secondary";
  return <Badge className={`status ${bucket}`} variant={variant}>{statusLabel(status)}</Badge>;
}

function Onboarding({ onDone }: { onDone: () => Promise<void> }) {
  const [form, setForm] = useState({ name: "", email: "", password: "", openaiApiKey: "" });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="auth-container">
      <div className="auth-theme-toggle"><ThemeToggle /></div>
      <form
        className="auth-box"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          const openaiApiKey = form.openaiApiKey.trim();
          try {
            await api("/api/onboarding/admin", {
              method: "POST",
              body: JSON.stringify({
                name: form.name,
                email: form.email,
                password: form.password,
                ...(openaiApiKey ? { openaiApiKey } : {})
              })
            });
            await onDone();
          } catch (onboardingError) {
            setError(onboardingError instanceof Error ? onboardingError.message : "Could not create workspace.");
          }
        }}
      >
        <h1>Create workspace</h1>
        <p>Set up the first owner account.</p>
        <div className="stack">
          <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Your name" required />
          <Input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="Email address" type="email" required />
          <Input value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="Password · 8+ characters" type="password" minLength={8} required />
          <Input value={form.openaiApiKey} onChange={(event) => setForm({ ...form, openaiApiKey: event.target.value })} placeholder="OpenAI API key · optional" type="password" />
          {error ? <div className="notice error">{friendlyError(error)}</div> : null}
          <Button type="submit" size="lg" style={{ width: "100%" }}>Create workspace</Button>
        </div>
      </form>
    </div>
  );
}

function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <div className="auth-container">
      <div className="auth-theme-toggle"><ThemeToggle /></div>
      <form
        className="auth-box"
        onSubmit={async (event: FormEvent) => {
          event.preventDefault();
          await api("/api/login", { method: "POST", body: JSON.stringify({ email, password }) });
          await onDone();
        }}
      >
        <h1>Sign in</h1>
        <p>Open the task board.</p>
        <div className="stack">
          <Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email address" type="email" required />
          <Input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" type="password" required />
          <Button type="submit" size="lg" style={{ width: "100%" }}>Sign in</Button>
        </div>
      </form>
    </div>
  );
}

function Splash() {
  return (
    <div className="auth-container">
      <Loader2 className="spin" size={24} style={{ color: "var(--text-muted)" }} />
    </div>
  );
}

function NavButton({ icon, label, active, onClick }: { icon: ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <Button variant="ghost" className={`nav-item ${active ? "active" : ""}`} aria-current={active ? "page" : undefined} title={label} onClick={onClick}>
      <AnimatedIcon icon={icon as ReactElement} active={active} />
      <span>{label}</span>
    </Button>
  );
}

function emptyAgent(defaultModel: string): Agent {
  return {
    id: "",
    kind: "worker",
    name: "New Agent",
    description: "",
    model: defaultModel,
    instructions: "You are a focused coding agent. Complete the task, verify it, and summarize the result.",
    enabled: true
  };
}

function emptySkill(): Skill {
  return {
    id: "",
    name: "new-skill",
    description: "Use when this repeatable workflow is relevant.",
    instructions: "Describe the workflow Codex should follow when this skill is used.",
    files: {},
    enabled: true
  };
}

function normalizeFilesDraft(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Files JSON must be an object of relative paths to text content.");
  }
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(value)) {
    if (typeof content !== "string") {
      throw new Error(`File ${path} must contain text.`);
    }
    files[path] = content;
  }
  return files;
}

function taskBucket(task: Task): (typeof BOARD_COLUMNS)[number]["id"] {
  return runBucket(task.latest_run_status ?? task.status);
}

function runBucket(status?: string | null): (typeof BOARD_COLUMNS)[number]["id"] {
  if (["queued", "running", "cancel_requested"].includes(status ?? "")) return "running";
  if (["succeeded", "done", "completed", "active", "enabled"].includes(status ?? "")) return "completed";
  if (["failed", "cancelled", "canceled", "needs_attention", "blocked", "expired", "revoked", "disabled"].includes(status ?? "")) return "failed";
  return "open";
}

function isActiveRun(status?: string | null): boolean {
  return ["queued", "running", "cancel_requested"].includes(status ?? "");
}

function statusLabel(status?: string | null): string {
  if (!status || status === "open") return "Open";
  if (status === "needs_attention") return "Needs attention";
  if (status === "cancel_requested") return "Stopping";
  return status.replace(/_/g, " ");
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function localDateTimeInput(date: Date): string {
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function apiKeyStatus(key: ExternalApiKey): string {
  if (key.revoked_at) return "revoked";
  if (new Date(key.expires_at).getTime() <= Date.now()) return "expired";
  return "active";
}

function viewTitle(view: View): string {
  return {
    tasks: "Tasks",
    runs: "Agent Runs",
    agents: "Agents",
    skills: "Skills",
    api: "API",
    credentials: "Credentials",
    projects: "Projects",
    connectors: "Connectors"
  }[view];
}

function runTitle(run: AgentRun): string {
  if (run.kind === "dispatcher") {
    return run.task_number ? `Dispatch TASK-${run.task_number}` : "Heartbeat dispatch";
  }
  return run.task_number ? `TASK-${run.task_number} ${run.task_title ?? ""}` : "Worker run";
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

type AgentRunRef = Pick<AgentRun, "kind" | "id"> & { task_id?: string | null };

function collapseAgentRuns(runs: AgentRun[]): AgentRun[] {
  const workerRunsByTask = new Map<string, AgentRun>();
  const ungroupedRuns: AgentRun[] = [];

  for (const run of runs) {
    if (run.kind !== "worker" || !run.task_id) {
      ungroupedRuns.push(run);
      continue;
    }
    const current = workerRunsByTask.get(run.task_id);
    if (!current || compareRunRecency(run, current) > 0) {
      workerRunsByTask.set(run.task_id, run);
    }
  }

  return [...workerRunsByTask.values(), ...ungroupedRuns].sort((left, right) =>
    compareRunRecency(right, left)
  );
}

function findUpdatedConversationRun(
  runs: AgentRun[],
  previousRun: AgentRun,
  queuedRunId: string,
  queuedRunKind: "worker" | "dispatcher"
): AgentRun | undefined {
  if (previousRun.kind === "worker" && previousRun.task_id) {
    return collapseAgentRuns(runs).find((run) => isSameAgentRunConversation(run, previousRun));
  }
  return runs.find((run) => run.kind === queuedRunKind && run.id === queuedRunId);
}

function isSameAgentRunConversation(left: AgentRunRef | null | undefined, right: AgentRunRef | null | undefined): boolean {
  if (!left || !right) return false;
  return agentRunConversationKey(left) === agentRunConversationKey(right);
}

function agentRunConversationKey(run: AgentRunRef): string {
  if (run.kind === "worker" && run.task_id) return `task:${run.task_id}`;
  return `${run.kind}:${run.id}`;
}

function compareRunRecency(left: AgentRun, right: AgentRun): number {
  return runTime(left).localeCompare(runTime(right)) || left.id.localeCompare(right.id);
}

function runTime(run: AgentRun): string {
  return run.queued_at ?? run.started_at ?? run.finished_at ?? "";
}

function optimisticMessage(text: string): AgentRunChatMessage {
  return {
    id: `optimistic:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    role: "user",
    text,
    createdAt: new Date().toISOString(),
    streaming: false
  };
}

function appendPendingMessage(
  current: Record<string, AgentRunChatMessage[]>,
  key: string,
  message: AgentRunChatMessage
): Record<string, AgentRunChatMessage[]> {
  return {
    ...current,
    [key]: [...(current[key] ?? []), message]
  };
}

function removePendingMessage(
  current: Record<string, AgentRunChatMessage[]>,
  key: string,
  messageId: string
): Record<string, AgentRunChatMessage[]> {
  const nextMessages = (current[key] ?? []).filter((message) => message.id !== messageId);
  if (nextMessages.length === (current[key] ?? []).length) return current;
  const next = { ...current };
  if (nextMessages.length === 0) {
    delete next[key];
  } else {
    next[key] = nextMessages;
  }
  return next;
}

function friendlyError(message: string): string {
  try {
    const payload = JSON.parse(message) as { message?: unknown; error?: unknown };
    if (typeof payload.message === "string") return payload.message;
    if (typeof payload.error === "string") return payload.error;
  } catch {
    return message;
  }
  return message;
}

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as T;
}
