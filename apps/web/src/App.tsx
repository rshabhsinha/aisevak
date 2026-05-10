import {
  Bot,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleX,
  FolderGit2,
  Github,
  LayoutDashboard,
  Loader2,
  LogOut,
  Play,
  Plus,
  RefreshCw,
  Search,
  Square,
  Terminal,
  UserCircle2
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";

type View = "tasks" | "agents" | "projects" | "connectors";

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
  name: string;
  description: string;
  model: string;
  instructions: string;
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
  project_id: string;
  agent_id: string;
  project_name: string;
  agent_name: string;
  latest_run_status?: string | null;
  latest_run_id?: string | null;
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
}

interface Run {
  id: string;
  status: string;
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
  const [view, setView] = useState<View>("tasks");
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [defaultModel, setDefaultModel] = useState("gpt-5.5");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [repos, setRepos] = useState<GithubRepository[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [query, setQuery] = useState("");
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? tasks[0],
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

  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => {
    if (user) void reloadAll();
  }, [user]);

  useEffect(() => {
    if (!selectedTask?.latest_run_id) {
      setEvents([]);
      return;
    }
    void loadEvents(selectedTask.latest_run_id);
    if (!isActiveRun(selectedTask.latest_run_status)) return;

    const source = new EventSource(`/api/runs/${selectedTask.latest_run_id}/stream`, {
      withCredentials: true
    });
    source.addEventListener("run_event", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as RunEvent;
      setEvents((current) =>
        current.some((existing) => existing.id === payload.id) ? current : [...current, payload]
      );
    });
    source.addEventListener("done", () => {
      source.close();
      void reloadTasks();
    });
    source.onerror = () => source.close();
    return () => source.close();
  }, [selectedTask?.latest_run_id, selectedTask?.latest_run_status]);

  async function boot() {
    const status = await api<{ hasAdmin: boolean }>("/api/onboarding/status");
    setHasAdmin(status.hasAdmin);
    const me = await api<{ user: User | null }>("/api/me");
    setUser(me.user);
  }

  async function reloadAll() {
    await Promise.all([reloadProjects(), reloadAgents(), reloadTasks(), reloadModels(), reloadRepos(false)]);
  }

  async function reloadProjects() {
    const data = await api<{ projects: Project[] }>("/api/projects");
    setProjects(data.projects);
  }

  async function reloadAgents() {
    const data = await api<{ agents: Agent[] }>("/api/agents");
    setAgents(data.agents);
  }

  async function reloadModels() {
    const data = await api<{ defaultModel: string; models: CodexModel[] }>("/api/codex/models");
    setDefaultModel(data.defaultModel);
    setModels(data.models);
  }

  async function reloadTasks() {
    const data = await api<{ tasks: Task[] }>("/api/tasks");
    setTasks(data.tasks);
    if (!selectedTaskId && data.tasks[0]) setSelectedTaskId(data.tasks[0].id);
  }

  async function reloadRepos(refresh: boolean) {
    if (!user || user.role === "member") return;
    const data = await api<{ repositories: GithubRepository[] }>(
      `/api/github/repositories${refresh ? "?refresh=true" : ""}`
    );
    setRepos(data.repositories);
  }

  async function loadEvents(runId: string) {
    const data = await api<{ events: RunEvent[] }>(`/api/runs/${runId}/events`);
    setEvents(data.events);
  }

  async function runTask(task: Task) {
    setBusyRunId(task.id);
    try {
      const data = await api<{ run: Run }>(`/api/tasks/${task.id}/runs`, { method: "POST" });
      setMessage(`Run queued: ${shortId(data.run.id)}`);
      setSelectedTaskId(task.id);
      await reloadTasks();
    } finally {
      setBusyRunId(null);
    }
  }

  if (hasAdmin === null) return <Splash />;
  if (!hasAdmin) return <Onboarding onDone={boot} />;
  if (!user) return <Login onDone={boot} />;

  return (
    <div className="workspace">
      <aside className="sidenav">
        <div className="brand">
          <span className="brand-mark">
            <Terminal size={17} />
          </span>
          <div>
            <strong>Aisevak</strong>
            <small>{user.name}</small>
          </div>
        </div>

        <nav className="nav-list">
          <NavButton icon={<LayoutDashboard />} label="Tasks" active={view === "tasks"} onClick={() => setView("tasks")} />
          <NavButton icon={<Bot />} label="Agents" active={view === "agents"} onClick={() => setView("agents")} />
          <NavButton icon={<FolderGit2 />} label="Projects" active={view === "projects"} onClick={() => setView("projects")} />
          <NavButton icon={<Github />} label="Connectors" active={view === "connectors"} onClick={() => setView("connectors")} />
        </nav>

        <div className="nav-footer">
          <div className="user-chip">
            <UserCircle2 size={18} />
            <span>{user.role}</span>
          </div>
          <button
            className="icon-button"
            title="Log out"
            onClick={async () => {
              await api("/api/logout", { method: "POST" });
              setUser(null);
            }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <div className="breadcrumb">Workspace / {viewTitle(view)}</div>
            <h1>{viewTitle(view)}</h1>
          </div>
          <div className="toolbar">
            <label className="search">
              <Search size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" />
            </label>
            <button className="button secondary" onClick={() => void reloadAll()} title="Refresh">
              <RefreshCw size={15} />
            </button>
          </div>
        </header>

        {message ? <div className="notice">{message}</div> : null}

        {view === "tasks" ? (
          <TasksView
            tasks={filteredTasks}
            agents={agents}
            projects={projects}
            selectedTask={selectedTask}
            events={events}
            busyRunId={busyRunId}
            onCreate={async (payload) => {
              const data = await api<{ task: Task }>("/api/tasks", {
                method: "POST",
                body: JSON.stringify(payload)
              });
              setSelectedTaskId(data.task.id);
              await reloadTasks();
            }}
            onSelect={setSelectedTaskId}
            onRun={runTask}
            onCancel={async (runId) => {
              await api(`/api/runs/${runId}/cancel`, { method: "POST" });
              await reloadTasks();
            }}
          />
        ) : null}

        {view === "agents" ? (
          <AgentsView agents={agents} models={models} defaultModel={defaultModel} onSaved={reloadAgents} />
        ) : null}

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
  );
}

function TasksView(props: {
  tasks: Task[];
  projects: Project[];
  agents: Agent[];
  selectedTask?: Task;
  events: RunEvent[];
  busyRunId: string | null;
  onCreate: (payload: Record<string, unknown>) => Promise<void>;
  onSelect: (id: string) => void;
  onRun: (task: Task) => Promise<void>;
  onCancel: (runId: string) => Promise<void>;
}) {
  return (
    <div className="tasks-page">
      <section className="task-create">
        <TaskForm projects={props.projects} agents={props.agents} onCreate={props.onCreate} />
      </section>
      <section className="task-board" aria-label="Tasks board">
        {BOARD_COLUMNS.map((column) => {
          const tasks = props.tasks.filter((task) => taskBucket(task) === column.id);
          return (
            <div className="board-column" key={column.id}>
              <div className="column-head">
                <span>
                  {column.icon}
                  {column.title}
                </span>
                <small>{tasks.length}</small>
              </div>
              <div className="cards">
                {tasks.map((task) => (
                  <button
                    className={`task-card ${props.selectedTask?.id === task.id ? "selected" : ""}`}
                    key={task.id}
                    onClick={() => props.onSelect(task.id)}
                  >
                    <span className="task-key">TASK-{task.number}</span>
                    <strong>{task.title}</strong>
                    <span>{task.project_name}</span>
                    <TaskStatus status={task.latest_run_status ?? task.status} />
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </section>
      <TaskDetail
        task={props.selectedTask}
        events={props.events}
        busyRunId={props.busyRunId}
        onRun={props.onRun}
        onCancel={props.onCancel}
      />
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
  const [agentId, setAgentId] = useState("");

  useEffect(() => {
    if (!projectId && props.projects[0]) setProjectId(props.projects[0].id);
    if (!agentId && props.agents[0]) setAgentId(props.agents[0].id);
  }, [props.projects, props.agents, projectId, agentId]);

  return (
    <form
      className="inline-create"
      onSubmit={async (event) => {
        event.preventDefault();
        await props.onCreate({ title, body, projectId, agentId });
        setTitle("");
        setBody("");
      }}
    >
      <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="New task" required />
      <input value={body} onChange={(event) => setBody(event.target.value)} placeholder="Details" />
      <select value={projectId} onChange={(event) => setProjectId(event.target.value)} required>
        {props.projects.map((project) => (
          <option value={project.id} key={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <select value={agentId} onChange={(event) => setAgentId(event.target.value)} required>
        {props.agents.map((agent) => (
          <option value={agent.id} key={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
      <button className="button" type="submit">
        <Plus size={15} />
        Add
      </button>
    </form>
  );
}

function TaskDetail(props: {
  task?: Task;
  events: RunEvent[];
  busyRunId: string | null;
  onRun: (task: Task) => Promise<void>;
  onCancel: (runId: string) => Promise<void>;
}) {
  if (!props.task) {
    return (
      <aside className="detail-panel empty-panel">
        <span>Select a task</span>
      </aside>
    );
  }

  const active = isActiveRun(props.task.latest_run_status);
  const hasRun = Boolean(props.task.latest_run_id || props.task.latest_run_status);
  const showRun = !hasRun;
  const showStop = active && Boolean(props.task.latest_run_id);
  return (
    <aside className="detail-panel">
      <div className="detail-top">
        <div>
          <span className="task-key">TASK-{props.task.number}</span>
          <h2>{props.task.title}</h2>
          <p>{props.task.project_name} / {props.task.agent_name}</p>
        </div>
        <TaskStatus status={props.task.latest_run_status ?? props.task.status} />
      </div>
      <p className="task-body">{props.task.body || "No description."}</p>
      {showRun || showStop ? (
        <div className="button-row">
          {showRun ? (
            <button
              className="button"
              disabled={props.busyRunId === props.task.id}
              onClick={() => props.onRun(props.task!)}
            >
              {props.busyRunId === props.task.id ? <Loader2 className="spin" size={15} /> : <Play size={15} />}
              Run
            </button>
          ) : null}
          {showStop ? (
            <button className="button secondary" onClick={() => props.onCancel(props.task!.latest_run_id!)}>
              <Square size={15} />
              Stop
            </button>
          ) : null}
        </div>
      ) : null}
      <RunTimeline events={props.events} />
    </aside>
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
    <div className="two-pane">
      <section className="panel">
        <div className="panel-head">
          <h2>Agents</h2>
          <button className="button secondary" onClick={() => setEditing(emptyAgent(props.defaultModel))}>
            <Plus size={15} />
            New
          </button>
        </div>
        <div className="rows">
          {props.agents.map((agent) => (
            <button
              className={`row-card ${editing?.id === agent.id ? "selected" : ""}`}
              key={agent.id}
              onClick={() => setEditing(agent)}
            >
              <Bot size={16} />
              <span>
                <strong>{agent.name}</strong>
                <small>{agent.model}</small>
              </span>
            </button>
          ))}
        </div>
      </section>
      <section className="panel">
        {editing ? (
          <AgentEditor agent={editing} models={props.models} defaultModel={props.defaultModel} onSaved={props.onSaved} />
        ) : (
          <EmptyState text="Select an agent" />
        )}
      </section>
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
          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
        <label>
          Model
          <select value={draft.model || props.defaultModel} onChange={(event) => setDraft({ ...draft, model: event.target.value })}>
            {props.models.map((model) => (
              <option value={model.id} key={model.id}>
                {model.label}{model.badge ? ` - ${model.badge}` : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Description
        <input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
      </label>
      <label>
        Prompt
        <textarea
          className="prompt"
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
      <button className="button" type="submit">
        <CheckCircle2 size={15} />
        Save agent
      </button>
    </form>
  );
}

function ProjectsView({ projects, onSaved }: { projects: Project[]; onSaved: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState<"direct" | "git_worktree">("direct");

  return (
    <div className="two-pane">
      <section className="panel">
        <div className="panel-head">
          <h2>Projects</h2>
        </div>
        <form
          className="stack"
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
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" required />
          <input value={localPath} onChange={(event) => setLocalPath(event.target.value)} placeholder="/absolute/path/to/repo" required />
          <select value={workspaceMode} onChange={(event) => setWorkspaceMode(event.target.value as "direct" | "git_worktree")}>
            <option value="direct">Direct folder</option>
            <option value="git_worktree">Git worktree</option>
          </select>
          <button className="button" type="submit">
            <Plus size={15} />
            Add project
          </button>
        </form>
      </section>
      <section className="panel">
        <div className="rows">
          {projects.map((project) => (
            <div className="data-card" key={project.id}>
              <FolderGit2 size={16} />
              <span>
                <strong>{project.name}</strong>
                <small>{project.local_path}</small>
              </span>
              <em>{project.source}</em>
            </div>
          ))}
        </div>
      </section>
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
    <div className="two-pane">
      <section className="panel">
        <div className="connector-card">
          <Github size={24} />
          <div>
            <h2>GitHub</h2>
            <p>Repository import and pull requests</p>
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
          <input value={name} onChange={(event) => setName(event.target.value)} />
          <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Fine-grained PAT" type="password" />
          <div className="button-row">
            <button className="button" type="submit">
              <Github size={15} />
              Connect
            </button>
            <button className="button secondary" type="button" onClick={props.onRefresh}>
              <RefreshCw size={15} />
              Refresh
            </button>
          </div>
        </form>
      </section>
      <section className="panel">
        <div className="rows">
          {props.repos.map((repo) => (
            <div className="data-card" key={repo.id}>
              <Github size={16} />
              <span>
                <strong>{repo.full_name}</strong>
                <small>{repo.connection_name} / {repo.default_branch}</small>
              </span>
              <button className="button secondary" onClick={() => props.onImport(repo.id)} disabled={Boolean(repo.imported_project_id)}>
                {repo.imported_project_id ? "Imported" : "Import"}
              </button>
            </div>
          ))}
          {props.repos.length === 0 ? <EmptyState text="No repositories" /> : null}
        </div>
      </section>
    </div>
  );
}

function RunTimeline({ events }: { events: RunEvent[] }) {
  return (
    <div className="run-log">
      {events.length === 0 ? <span className="muted">No run events yet.</span> : null}
      {events.map((event) => (
        <div className="log-line" key={event.id}>
          <span>{event.seq}</span>
          <strong>{event.event_type}</strong>
          <p>{eventText(event)}</p>
        </div>
      ))}
    </div>
  );
}

function TaskStatus({ status }: { status?: string | null }) {
  const bucket = runBucket(status);
  return <span className={`status ${bucket}`}>{statusLabel(status)}</span>;
}

function Onboarding({ onDone }: { onDone: () => Promise<void> }) {
  const [form, setForm] = useState({ name: "", email: "", password: "", openaiApiKey: "" });
  return (
    <AuthShell title="Create workspace" subtitle="Set up the first owner account.">
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          await api("/api/onboarding/admin", { method: "POST", body: JSON.stringify(form) });
          await onDone();
        }}
      >
        <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Name" required />
        <input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="Email" type="email" required />
        <input value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="Password" type="password" required />
        <input value={form.openaiApiKey} onChange={(event) => setForm({ ...form, openaiApiKey: event.target.value })} placeholder="OpenAI API key" type="password" />
        <button className="button" type="submit">
          <CheckCircle2 size={15} />
          Continue
        </button>
      </form>
    </AuthShell>
  );
}

function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <AuthShell title="Sign in" subtitle="Open the task board.">
      <form
        className="stack"
        onSubmit={async (event: FormEvent) => {
          event.preventDefault();
          await api("/api/login", { method: "POST", body: JSON.stringify({ email, password }) });
          await onDone();
        }}
      >
        <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" type="email" required />
        <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" type="password" required />
        <button className="button" type="submit">
          <Terminal size={15} />
          Sign in
        </button>
      </form>
    </AuthShell>
  );
}

function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="auth">
      <section className="auth-card">
        <span className="brand-mark">
          <Terminal size={18} />
        </span>
        <h1>{title}</h1>
        <p>{subtitle}</p>
        {children}
      </section>
    </main>
  );
}

function Splash() {
  return (
    <main className="auth">
      <Loader2 className="spin" />
    </main>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

function NavButton({ icon, label, active, onClick }: { icon: ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function emptyAgent(defaultModel: string): Agent {
  return {
    id: "",
    name: "New Agent",
    description: "",
    model: defaultModel,
    instructions: "You are a focused coding agent. Complete the task, verify it, and summarize the result.",
    enabled: true
  };
}

function taskBucket(task: Task): (typeof BOARD_COLUMNS)[number]["id"] {
  return runBucket(task.latest_run_status ?? task.status);
}

function runBucket(status?: string | null): (typeof BOARD_COLUMNS)[number]["id"] {
  if (["queued", "running", "cancel_requested"].includes(status ?? "")) return "running";
  if (["succeeded", "done", "completed"].includes(status ?? "")) return "completed";
  if (["failed", "cancelled", "canceled"].includes(status ?? "")) return "failed";
  return "open";
}

function isActiveRun(status?: string | null): boolean {
  return ["queued", "running", "cancel_requested"].includes(status ?? "");
}

function statusLabel(status?: string | null): string {
  if (!status || status === "open") return "Open";
  if (status === "cancel_requested") return "Stopping";
  return status.replace(/_/g, " ");
}

function eventText(event: RunEvent): string {
  if (event.text) return event.text;
  const raw = event.payload as { raw?: { item?: { text?: string; command?: string; aggregated_output?: string } } };
  return raw.raw?.item?.text ?? raw.raw?.item?.command ?? raw.raw?.item?.aggregated_output ?? JSON.stringify(event.payload);
}

function viewTitle(view: View): string {
  return {
    tasks: "Tasks",
    agents: "Agents",
    projects: "Projects",
    connectors: "Connectors"
  }[view];
}

function shortId(id: string): string {
  return id.slice(0, 8);
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
