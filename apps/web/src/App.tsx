import {
  Activity,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Bot,
  Calendar,
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
  LockKeyhole,
  LogOut,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Square,
  Terminal,
  Trash2,
  Wrench
} from "./components/icons";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactElement, ReactNode } from "react";
import { AnimatedIcon } from "./components/animated-icon";
import { AgentAvatar } from "./components/agent-avatar";
import { MarkdownContent } from "./components/markdown";
import { OpenAILogo } from "./components/openai-logo";
import { PromptComposer } from "./components/prompt-composer";
import { ThemeToggle } from "./components/theme-toggle";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from "./components/ui/command";
import { Input } from "./components/ui/input";
import { NativeSelect } from "./components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { ScrollArea } from "./components/ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "./components/ui/select";
import { Switch } from "./components/ui/switch";
import { Textarea } from "./components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import {
  deriveAgentRunTimelineRows,
  formatElapsed,
  normalizeCompactToolLabel,
  type AgentRunChatMessage,
  type AgentRunTimelineRun,
  type AgentRunTimelineRow,
  type AgentRunWorkLogEntry
} from "./agentRunTimeline";
import { mergeRefreshedAgentThreads } from "./agentThreads";
import { DEFAULT_AGENT_MODEL, reconcileSelectedAgent } from "./agentModels";
import { isThreadScrollNearBottom, shouldShowThreadScrollDown } from "./threadScroll";
import { createTaskAndQueueRun } from "./taskCreation";
import { createThreadLoadGuard } from "./threadLoadGuard";

type View =
  | "tasks"
  | "agents"
  | "projects"
  | "connectors"
  | "runs"
  | "skills"
  | "schedules"
  | "api"
  | "credentials"
  | "codex";

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
  model_options: ModelOptionSelection[];
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
  platform_managed: boolean;
  default_for_agents: boolean;
}

interface SkillCatalogError {
  directory: string;
  message: string;
}

interface CodexModel {
  id: string;
  label: string;
  description: string;
  badge?: string;
  options?: CodexModelOption[];
}

interface CodexModelOption {
  id: string;
  label: string;
  values: Array<{ id: string; label: string; description?: string }>;
  defaultValue?: string;
}

interface ModelOptionSelection {
  id: string;
  value: string | number | boolean;
}

interface ModelSelection {
  providerInstanceId: string;
  model: string;
  options: ModelOptionSelection[];
}

interface ProviderInstance {
  id: string;
  driver: "codex";
  display_name: string;
  enabled: boolean;
  status: "ready" | "warning" | "error";
  capabilities: { sessionModelSwitch: "in-session" | "unsupported" };
  models: CodexModel[];
  defaultModel: string;
  modelSource: "live" | "fallback";
}

interface AgentThread {
  id: string;
  title: string;
  agent_id: string;
  agent_name: string;
  agent_kind: "worker" | "dispatcher";
  display_agent_identity: boolean;
  task_id: string | null;
  task_number: number | null;
  project_id: string | null;
  project_name: string | null;
  provider_instance_id: string;
  provider_driver: "codex";
  provider_name: string;
  model: string;
  model_options: ModelOptionSelection[];
  cwd: string;
  branch: string | null;
  provider_thread_id: string | null;
  last_activity_at: string;
  latest_run_id: string | null;
  latest_run_kind: "worker" | "dispatcher" | null;
  latest_status: string | null;
  latest_error: string | null;
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

interface Schedule {
  id: string;
  title: string;
  prompt: string;
  agent_id: string;
  agent_name: string;
  agent_kind: "worker" | "dispatcher";
  schedule_kind: "once" | "interval";
  next_run_at: string;
  interval_seconds: number | null;
  enabled: boolean;
  last_run_at: string | null;
  last_agent_thread_id: string | null;
  last_thread_title: string | null;
  last_run_status: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

interface GithubRepository {
  id: string;
  full_name: string;
  default_branch: string;
  imported_project_id?: string | null;
  connection_name: string;
  import_job_id?: string | null;
  import_status?: "queued" | "running" | "succeeded" | "failed" | null;
  import_error?: string | null;
}

interface GithubConnection {
  id: string;
  name: string;
  status: "pending" | "sync_requested" | "syncing" | "ready" | "failed" | "disconnect_requested" | "disconnecting" | "disconnected";
  account_login: string | null;
  error: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
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

const SIDEBAR_THREAD_PAGE_SIZE = 10;

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

interface CodexAuthStatus {
  connected: boolean;
  activeMethod: "chatgpt" | "api_key" | null;
  chatgptConnected: boolean;
  apiKeyConfigured: boolean;
  email: string | null;
  name: string | null;
  accountIdSuffix: string | null;
  expiresAt: number | null;
  lastRefresh: string | null;
  needsLogin: boolean;
  lastError: string | null;
}

interface CodexDeviceLogin {
  loginId: string;
  verificationUrl: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: number;
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
  const [skillsRoot, setSkillsRoot] = useState("");
  const [skillCatalogErrors, setSkillCatalogErrors] = useState<SkillCatalogError[]>([]);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [defaultModel, setDefaultModel] = useState(DEFAULT_AGENT_MODEL);
  const [providerInstances, setProviderInstances] = useState<ProviderInstance[]>([]);
  const [apiKeys, setApiKeys] = useState<ExternalApiKey[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [repos, setRepos] = useState<GithubRepository[]>([]);
  const [githubConnection, setGithubConnection] = useState<GithubConnection | null>(null);
  const [githubHostname, setGithubHostname] = useState("github.com");
  const [agentThreads, setAgentThreads] = useState<AgentThread[]>([]);
  const [nextThreadCursor, setNextThreadCursor] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [draftThread, setDraftThread] = useState(true);
  const [selectedThreadRun, setSelectedThreadRun] = useState<AgentRunTimelineRun | null>(null);
  const [agentThreadEvents, setAgentThreadEvents] = useState<RunEvent[]>([]);
  const [composerSelection, setComposerSelection] = useState<ModelSelection | null>(null);
  const [pendingThreadMessages, setPendingThreadMessages] = useState<AgentRunChatMessage[]>([]);
  const [query, setQuery] = useState("");
  const [loadingOlderThreads, setLoadingOlderThreads] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const threadLoadGuardRef = useRef(createThreadLoadGuard());

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

  const selectedThread = useMemo(
    () => agentThreads.find((thread) => thread.id === selectedThreadId) ?? null,
    [agentThreads, selectedThreadId]
  );

  const filteredSkills = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) =>
      [skill.name, skill.description, skill.instructions].join(" ").toLowerCase().includes(needle)
    );
  }, [query, skills]);

  const filteredThreads = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return agentThreads;
    return agentThreads.filter((thread) =>
      [
        thread.title,
        thread.agent_name,
        thread.provider_name,
        thread.model,
        thread.project_name ?? "",
        thread.task_number ? `TASK-${thread.task_number}` : ""
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [agentThreads, query]);

  const filteredSchedules = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return schedules;
    return schedules.filter((schedule) =>
      [schedule.title, schedule.prompt, schedule.agent_name, schedule.schedule_kind]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [query, schedules]);

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
    if (!user || user.role === "member") return;
    const connectionBusy = githubConnection
      ? ["pending", "sync_requested", "syncing", "disconnect_requested", "disconnecting"].includes(
          githubConnection.status
        )
      : false;
    const importBusy = repos.some((repo) => repo.import_status === "queued" || repo.import_status === "running");
    if (!connectionBusy && !importBusy) return;
    const timer = window.setInterval(() => {
      void reloadGithub();
      if (importBusy) void reloadProjects();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [user?.id, githubConnection?.status, repos.map((repo) => repo.import_status).join(",")]);

  useEffect(() => {
    if (!selectedThreadId) {
      setSelectedThreadRun(null);
      setAgentThreadEvents([]);
      return;
    }
    void loadAgentThread(selectedThreadId);
    if (!isActiveRun(selectedThread?.latest_status)) return;
    const timer = window.setInterval(() => {
      void loadAgentThread(selectedThreadId);
      void reloadAgentThreads();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [selectedThreadId, selectedThread?.latest_status]);

  useEffect(() => {
    if (selectedThread) {
      setComposerSelection({
        providerInstanceId: selectedThread.provider_instance_id,
        model: selectedThread.model,
        options: normalizeComposerOptions(selectedThread.model_options)
      });
      return;
    }
    if (!draftThread || composerSelection) return;
    const provider = providerInstances[0];
    if (!provider) return;
    const sticky = readStickyModelSelection(provider);
    setComposerSelection(sticky);
  }, [selectedThread?.id, selectedThread?.model, selectedThread?.model_options, draftThread, providerInstances]);

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
      reloadSchedules(),
      reloadProviderInstances(),
      reloadAgentThreads(),
      reloadGithub()
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
    const data = await api<{ skills: Skill[]; root: string; errors: SkillCatalogError[] }>("/api/skills");
    setSkills(data.skills);
    setSkillsRoot(data.root);
    setSkillCatalogErrors(data.errors);
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

  async function reloadProviderInstances() {
    const data = await api<{ instances: ProviderInstance[] }>("/api/provider-instances");
    setProviderInstances(data.instances);
    const codex = data.instances.find((instance) => instance.driver === "codex");
    if (codex) {
      setDefaultModel(codex.defaultModel);
      setModels(codex.models);
    }
  }

  async function reloadTasks() {
    const data = await api<{ tasks: Task[] }>("/api/tasks");
    setTasks(data.tasks);
  }

  async function reloadSchedules() {
    const data = await api<{ schedules: Schedule[] }>("/api/schedules");
    setSchedules(data.schedules);
  }

  async function reloadAgentThreads(cursor?: string): Promise<AgentThread[]> {
    const suffix = cursor
      ? `?limit=${SIDEBAR_THREAD_PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
      : `?limit=${SIDEBAR_THREAD_PAGE_SIZE}`;
    const data = await api<{ threads: AgentThread[]; nextCursor: string | null }>(
      `/api/agent-threads${suffix}`
    );
    setAgentThreads((current) => {
      if (!cursor) return mergeRefreshedAgentThreads(current, data.threads);
      const seen = new Set(current.map((thread) => thread.id));
      return [...current, ...data.threads.filter((thread) => !seen.has(thread.id))];
    });
    setNextThreadCursor(data.nextCursor);
    return data.threads;
  }

  async function reloadGithub() {
    if (!user || user.role === "member") {
      setGithubConnection(null);
      setRepos([]);
      return;
    }
    const [status, repositories] = await Promise.all([
      api<{ connection: GithubConnection | null; hostname: string }>("/api/github/status"),
      api<{ repositories: GithubRepository[] }>("/api/github/repositories")
    ]);
    setGithubConnection(status.connection);
    setGithubHostname(status.hostname);
    setRepos(repositories.repositories);
  }

  async function loadAgentThread(threadId: string) {
    const isCurrentRequest = threadLoadGuardRef.current.begin(threadId);
    const data = await api<{
      thread: AgentThread;
      run?: AgentRunTimelineRun | null;
      events: RunEvent[];
    }>(`/api/agent-threads/${threadId}`);
    if (!isCurrentRequest()) return;
    setAgentThreads((current) => [
      data.thread,
      ...current.filter((thread) => thread.id !== data.thread.id)
    ]);
    setSelectedThreadRun(data.run ?? null);
    setAgentThreadEvents(data.events);
  }

  function selectAgentThread(threadId: string) {
    threadLoadGuardRef.current.select(threadId);
    setSelectedThreadId(threadId);
    setDraftThread(false);
    setSelectedThreadRun(null);
    setAgentThreadEvents([]);
    setPendingThreadMessages([]);
  }

  function createAgentThread() {
    const provider = providerInstances[0];
    threadLoadGuardRef.current.select(null);
    setSelectedThreadId(null);
    setDraftThread(true);
    setSelectedThreadRun(null);
    setAgentThreadEvents([]);
    setPendingThreadMessages([]);
    setComposerSelection(provider ? readStickyModelSelection(provider) : null);
    setView("runs");
    setMessage(null);
  }

  async function loadOlderAgentThreads() {
    if (!nextThreadCursor || loadingOlderThreads) return;
    setLoadingOlderThreads(true);
    try {
      await reloadAgentThreads(nextThreadCursor);
    } finally {
      setLoadingOlderThreads(false);
    }
  }

  async function openTaskThread(task: Task) {
    try {
      const thread = (await api<{ thread: AgentThread }>(`/api/tasks/${task.id}/agent-thread`, {
        method: "POST"
      })).thread;
      setAgentThreads((current) => [thread, ...current.filter((entry) => entry.id !== thread.id)]);
      selectAgentThread(thread.id);
      setQuery("");
      setView("runs");
      setMessage(null);
      await loadAgentThread(thread.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to open the agent thread.");
    }
  }

  async function sendAgentThreadMessage(messageText: string, selection: ModelSelection) {
    const optimistic = optimisticMessage(messageText);
    setPendingThreadMessages((current) => [...current, optimistic]);
    try {
      const payload = JSON.stringify({ message: messageText, modelSelection: selection });
      if (draftThread || !selectedThreadId) {
        const data = await api<{ thread: AgentThread; turn: Run }>("/api/agent-threads", {
          method: "POST",
          body: payload
        });
        setAgentThreads((current) => [data.thread, ...current.filter((thread) => thread.id !== data.thread.id)]);
        selectAgentThread(data.thread.id);
        setMessage(null);
        writeStickyModelSelection(selection);
        await loadAgentThread(data.thread.id);
      } else if (selectedThread?.latest_status === "running") {
        await api(`/api/agent-threads/${selectedThreadId}/steer`, {
          method: "POST",
          body: payload
        });
        setMessage(null);
        await loadAgentThread(selectedThreadId);
      } else if (selectedThread?.latest_status === "cancel_requested") {
        throw new Error("This turn is stopping. Wait for it to finish before sending another message.");
      } else {
        const data = await api<{ thread: AgentThread; turn: Run }>(
          `/api/agent-threads/${selectedThreadId}/messages`,
          { method: "POST", body: payload }
        );
        setAgentThreads((current) =>
          current.map((thread) => (thread.id === data.thread.id ? data.thread : thread))
        );
        setMessage(null);
        writeStickyModelSelection(selection);
        await Promise.all([loadAgentThread(selectedThreadId), reloadAgentThreads(), reloadTasks()]);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to send message.");
      throw error;
    } finally {
      setPendingThreadMessages((current) => current.filter((message) => message.id !== optimistic.id));
    }
  }

  async function selectComposerModel(selection: ModelSelection) {
    setComposerSelection(selection);
    writeStickyModelSelection(selection);
    if (!selectedThreadId || draftThread) return;
    const data = await api<{ thread: AgentThread }>(`/api/agent-threads/${selectedThreadId}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: selection })
    });
    setAgentThreads((current) =>
      current.map((thread) => (thread.id === data.thread.id ? data.thread : thread))
    );
  }

  if (hasAdmin === null) return <Splash />;
  if (!hasAdmin) return <Onboarding onDone={boot} />;
  if (!user) return <Login onDone={boot} />;

  return (
    <TooltipProvider delayDuration={220}>
    <div className="app-layout">
      <aside className={`sidebar ${view === "runs" ? "is-chat-sidebar" : ""}`}>
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
          <NavButton icon={<Bot />} label="Agent setup" active={view === "agents"} onClick={() => setView("agents")} />
          <NavButton icon={<BookOpen />} label="Skills" active={view === "skills"} onClick={() => setView("skills")} />
          <NavButton icon={<Calendar />} label="Schedule" active={view === "schedules"} onClick={() => setView("schedules")} />
          <span className="nav-label nav-label-spaced">Manage</span>
          {user.role !== "member" ? (
            <NavButton icon={<OpenAILogo />} label="ChatGPT" active={view === "codex"} onClick={() => setView("codex")} />
          ) : null}
          <NavButton icon={<KeyRound />} label="API" active={view === "api"} onClick={() => setView("api")} />
          {user.role !== "member" ? (
            <NavButton icon={<LockKeyhole />} label="Credentials" active={view === "credentials"} onClick={() => setView("credentials")} />
          ) : null}
          <NavButton icon={<FolderGit2 />} label="Projects" active={view === "projects"} onClick={() => setView("projects")} />
          <NavButton icon={<Github />} label="Connectors" active={view === "connectors"} onClick={() => setView("connectors")} />
          <span className="nav-label nav-label-spaced">Agents</span>
          <NavButton icon={<Activity />} label="Threads" active={view === "runs"} onClick={() => setView("runs")} />
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

      {view === "runs" ? (
        <AgentThreadSidebar
          draft={draftThread}
          threads={filteredThreads}
          selectedThreadId={selectedThreadId}
          query={query}
          hasMore={Boolean(nextThreadCursor) && !query.trim()}
          loadingMore={loadingOlderThreads}
          onQueryChange={setQuery}
          onNewThread={createAgentThread}
          onLoadMore={() => void loadOlderAgentThreads()}
          onSelectThread={(threadId) => {
            selectAgentThread(threadId);
          }}
        />
      ) : null}

      <div className={`main-content ${view === "runs" ? "agent-chat-mode" : ""}`}>
        {view !== "runs" ? <header className="top-header">
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
        </header> : null}

        {message ? <div className="notice">{message}</div> : null}

        <main className="view-container">
          {view === "tasks" ? (
            <TasksView
              tasks={filteredTasks}
              agents={agents}
              projects={projects}
              onCreate={async (payload) => {
                await createTaskAndQueueRun<Task>(api, payload);
                await Promise.all([reloadTasks(), reloadAgentThreads()]);
              }}
              onSelect={(task) => void openTaskThread(task)}
            />
          ) : null}

          {view === "runs" ? (
            <AgentChatsView
              thread={selectedThread}
              draft={draftThread}
              run={selectedThreadRun}
              events={agentThreadEvents}
              pendingMessages={pendingThreadMessages}
              providers={providerInstances}
              selection={composerSelection}
              onSelectionChange={selectComposerModel}
              onSendMessage={sendAgentThreadMessage}
              onCancel={async () => {
                if (!selectedThreadId) return;
                try {
                  await api(`/api/agent-threads/${selectedThreadId}/cancel`, { method: "POST" });
                  await Promise.all([loadAgentThread(selectedThreadId), reloadAgentThreads()]);
                } catch (error) {
                  setMessage(error instanceof Error ? error.message : "Failed to stop the active turn.");
                }
              }}
            />
          ) : null}

          {view === "agents" ? (
            <AgentsView
              agents={agents}
              skills={skills}
              tasks={tasks}
              models={models}
              defaultModel={defaultModel}
              onSaved={reloadAgents}
            />
          ) : null}

          {view === "schedules" ? (
            <SchedulesView
              schedules={filteredSchedules}
              agents={agents}
              skills={skills}
              tasks={tasks}
              onSaved={reloadSchedules}
              onOpenThread={async (threadId) => {
                selectAgentThread(threadId);
                setQuery("");
                setView("runs");
                await loadAgentThread(threadId);
              }}
            />
          ) : null}

          {view === "skills" ? (
            <SkillsView
              skills={filteredSkills}
              root={skillsRoot}
              errors={skillCatalogErrors}
              onSaved={reloadSkills}
            />
          ) : null}

          {view === "api" ? <ApiView apiKeys={apiKeys} onSaved={reloadApiKeys} /> : null}

          {view === "codex" ? <CodexConnectionView /> : null}

          {view === "credentials" ? <CredentialsView credentials={credentials} onSaved={reloadCredentials} /> : null}

          {view === "projects" ? <ProjectsView projects={projects} onSaved={reloadProjects} /> : null}

          {view === "connectors" ? (
            <ConnectorsView
              repos={repos}
              connection={githubConnection}
              hostname={githubHostname}
              onConnect={async (token) => {
                await api("/api/github/connect", { method: "POST", body: JSON.stringify({ token }) });
                await reloadGithub();
              }}
              onRefresh={async () => {
                await api("/api/github/sync", { method: "POST" });
                await reloadGithub();
              }}
              onDisconnect={async () => {
                await api("/api/github/connection", { method: "DELETE" });
                await reloadGithub();
              }}
              onImport={async (repoId) => {
                await api(`/api/github/repositories/${repoId}/import`, { method: "POST" });
                setMessage("Import queued");
                await reloadGithub();
              }}
            />
          ) : null}
        </main>
      </div>
    </div>
    </TooltipProvider>
  );
}

function TasksView(props: {
  tasks: Task[];
  projects: Project[];
  agents: Agent[];
  onCreate: (payload: Record<string, unknown>) => Promise<void>;
  onSelect: (task: Task) => void;
}) {
  return (
    <div className="board-layout">
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
                      className="kanban-card"
                      key={task.id}
                      onClick={() => props.onSelect(task)}
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

function SchedulesView(props: {
  schedules: Schedule[];
  agents: Agent[];
  skills: Skill[];
  tasks: Task[];
  onSaved: () => Promise<void>;
  onOpenThread: (threadId: string) => Promise<void>;
}) {
  const enabledAgents = props.agents.filter((agent) => agent.enabled);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState(enabledAgents[0]?.id ?? "");
  const [scheduleKind, setScheduleKind] = useState<"once" | "interval">("once");
  const [nextRunAt, setNextRunAt] = useState(() => defaultScheduleDateTime());
  const [intervalValue, setIntervalValue] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState<"minutes" | "hours" | "days">("hours");
  const [busy, setBusy] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabledAgents.some((agent) => agent.id === agentId)) {
      setAgentId(enabledAgents[0]?.id ?? "");
    }
  }, [props.agents, agentId]);

  async function updateSchedule(id: string, payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
      await props.onSaved();
    } catch (updateError) {
      setError(friendlyError(updateError instanceof Error ? updateError.message : "Could not update schedule."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="schedule-layout">
      <section className="schedule-create-card">
        <div className="section-heading">
          <div>
            <h2>Schedule an agent</h2>
            <p>A fresh agent task is created for every run, with its result preserved in Threads.</p>
          </div>
          <span className="schedule-heading-icon"><Calendar size={20} /></span>
        </div>
        <form
          className="schedule-form stack"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!agentId) return;
            setBusy(true);
            setError(null);
            const unitSeconds = intervalUnit === "minutes" ? 60 : intervalUnit === "hours" ? 3600 : 86_400;
            try {
              await api("/api/schedules", {
                method: "POST",
                body: JSON.stringify({
                  title,
                  prompt,
                  agentId,
                  scheduleKind,
                  nextRunAt: new Date(nextRunAt).toISOString(),
                  intervalSeconds: scheduleKind === "interval" ? intervalValue * unitSeconds : null
                })
              });
              setTitle("");
              setPrompt("");
              setNextRunAt(defaultScheduleDateTime());
              await props.onSaved();
            } catch (createError) {
              setError(friendlyError(createError instanceof Error ? createError.message : "Could not create schedule."));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="schedule-form-grid">
            <label>
              Title
              <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Daily workspace brief" required />
            </label>
            <label>
              Agent
              <NativeSelect value={agentId} onChange={(event) => setAgentId(event.target.value)} required>
                {enabledAgents.map((agent) => (
                  <option value={agent.id} key={agent.id}>{agent.name}</option>
                ))}
              </NativeSelect>
            </label>
            <label>
              Frequency
              <NativeSelect value={scheduleKind} onChange={(event) => setScheduleKind(event.target.value as "once" | "interval")}>
                <option value="once">One time</option>
                <option value="interval">Repeating interval</option>
              </NativeSelect>
            </label>
            <label>
              {scheduleKind === "once" ? "Run at" : "First run"}
              <Input
                type="datetime-local"
                value={nextRunAt}
                min={defaultScheduleDateTime(1)}
                onChange={(event) => setNextRunAt(event.target.value)}
                required
              />
            </label>
          </div>
          {scheduleKind === "interval" ? (
            <label className="schedule-interval-field">
              Repeat every
              <span className="schedule-interval-inputs">
                <Input
                  type="number"
                  min={1}
                  max={10_000}
                  value={intervalValue}
                  onChange={(event) => setIntervalValue(Math.max(1, Number(event.target.value)))}
                  required
                />
                <NativeSelect value={intervalUnit} onChange={(event) => setIntervalUnit(event.target.value as typeof intervalUnit)}>
                  <option value="minutes">Minutes</option>
                  <option value="hours">Hours</option>
                  <option value="days">Days</option>
                </NativeSelect>
              </span>
            </label>
          ) : null}
          <div className="field-group">
            <span>Prompt</span>
            <PromptComposer
              value={prompt}
              onChange={setPrompt}
              agents={props.agents}
              skills={props.skills}
              tasks={props.tasks}
              minHeight={220}
              ariaLabel="Scheduled prompt"
              placeholder="What should the agent do? Type / to attach a skill or reference an agent or task."
              disabled={busy}
            />
          </div>
          {error ? <div className="notice error">{error}</div> : null}
          <div className="schedule-form-actions">
            <span>Times use your local timezone.</span>
            <Button type="submit" disabled={busy || !agentId || !title.trim() || !prompt.trim()}>
              <Calendar size={15} />
              Create schedule
            </Button>
          </div>
        </form>
      </section>

      <section className="schedule-list-section">
        <div className="schedule-list-heading">
          <div>
            <h3>Schedules</h3>
            <p>{props.schedules.length} configured</p>
          </div>
        </div>
        <div className="schedule-list">
          {props.schedules.length === 0 ? (
            <div className="empty-state schedule-empty">No schedules yet</div>
          ) : props.schedules.map((schedule) => {
            const completedOnce = schedule.schedule_kind === "once" && Boolean(schedule.last_run_at);
            return (
              <article className="schedule-card" key={schedule.id}>
                <div className="schedule-card-top">
                  <AgentAvatar
                    agentId={schedule.agent_id}
                    agentName={schedule.agent_name}
                    className="schedule-agent-avatar"
                  />
                  <div className="schedule-card-title">
                    <strong>{schedule.title}</strong>
                    <span>{schedule.agent_name} · {formatScheduleCadence(schedule)}</span>
                  </div>
                  <Badge variant={schedule.enabled ? "success" : completedOnce ? "secondary" : "warning"}>
                    {schedule.enabled ? "Scheduled" : completedOnce ? "Completed" : "Paused"}
                  </Badge>
                </div>
                <p className="schedule-prompt-preview">{schedule.prompt}</p>
                <div className="schedule-card-meta">
                  <span>{schedule.enabled ? "Next" : "Last"}: {formatDateTime(schedule.enabled ? schedule.next_run_at : schedule.last_run_at ?? schedule.next_run_at)}</span>
                  <span>{schedule.run_count} run{schedule.run_count === 1 ? "" : "s"}</span>
                  {schedule.last_run_status ? <TaskStatus status={schedule.last_run_status} /> : null}
                </div>
                <div className="schedule-card-actions">
                  {schedule.last_agent_thread_id ? (
                    <Button type="button" variant="secondary" size="sm" onClick={() => void props.onOpenThread(schedule.last_agent_thread_id!)}>
                      <Activity size={14} />
                      Open latest task
                    </Button>
                  ) : null}
                  {!completedOnce ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void updateSchedule(schedule.id, { enabled: !schedule.enabled })}
                    >
                      {schedule.enabled ? <Pause size={13} /> : <Play size={13} />}
                      {schedule.enabled ? "Pause" : "Resume"}
                    </Button>
                  ) : null}
                  {deleteArmed === schedule.id ? (
                    <>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setDeleteArmed(null)}>Cancel</Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          setError(null);
                          try {
                            await api(`/api/schedules/${schedule.id}`, { method: "DELETE" });
                            setDeleteArmed(null);
                            await props.onSaved();
                          } catch (deleteError) {
                            setError(friendlyError(deleteError instanceof Error ? deleteError.message : "Could not delete schedule."));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Confirm delete
                      </Button>
                    </>
                  ) : (
                    <Button type="button" variant="ghost" size="icon" aria-label={`Delete ${schedule.title}`} onClick={() => setDeleteArmed(schedule.id)}>
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function AgentThreadSidebar(props: {
  draft: boolean;
  threads: AgentThread[];
  selectedThreadId: string | null;
  query: string;
  hasMore: boolean;
  loadingMore: boolean;
  onQueryChange: (query: string) => void;
  onNewThread: () => void;
  onLoadMore: () => void;
  onSelectThread: (threadId: string) => void;
}) {
  return (
    <aside className="agent-thread-sidebar" aria-label="Agent tasks">
      <div className="agent-thread-sidebar-header">
        <div>
          <h2>Agents</h2>
          <p>Codex tasks</p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              className="agent-thread-new"
              aria-label="New agent task"
              onClick={props.onNewThread}
            >
              <Plus size={14} weight="bold" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">New task</TooltipContent>
        </Tooltip>
      </div>

      <div className="agent-thread-search">
        <Search size={13} />
        <input
          value={props.query}
          placeholder="Search tasks"
          aria-label="Search agent tasks"
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
      </div>

      <div className="agent-thread-list-label">Recent</div>
      <ScrollArea className="agent-thread-scroll">
        <div className="agent-thread-list">
          {props.draft ? (
            <button type="button" className="agent-thread-item selected" onClick={props.onNewThread}>
              <span className="thread-item-icon is-draft"><Plus size={13} weight="bold" /></span>
              <span className="sidebar-run-copy">
                <span className="sidebar-run-title">New task</span>
                <span className="sidebar-run-meta">Codex · Draft</span>
              </span>
            </button>
          ) : null}

          {props.threads.map((thread) => (
            <button
              type="button"
              className={`agent-thread-item ${props.selectedThreadId === thread.id ? "selected" : ""}`}
              key={thread.id}
              onClick={() => props.onSelectThread(thread.id)}
            >
              {thread.display_agent_identity ? (
                <AgentAvatar
                  agentId={thread.agent_id}
                  agentName={thread.agent_name}
                  className={`thread-agent-avatar status-${runBucket(thread.latest_status ?? "succeeded")}`}
                />
              ) : (
                <span className={`thread-item-icon status-${runBucket(thread.latest_status ?? "succeeded")}`}>
                  <OpenAILogo size={13} />
                </span>
              )}
              <span className="sidebar-run-copy">
                <span className="sidebar-run-title">{thread.title}</span>
                <span className="sidebar-run-meta">
                  {thread.display_agent_identity
                    ? `${thread.agent_name} · ${formatSidebarRunTime(thread.last_activity_at)}`
                    : `${formatSidebarRunTime(thread.last_activity_at)} · ${thread.model}`}
                </span>
              </span>
              {isActiveRun(thread.latest_status) ? <Loader2 className="spin thread-running" size={12} /> : null}
            </button>
          ))}

          {props.threads.length === 0 && !props.draft ? (
            <div className="agent-thread-empty">
              <OpenAILogo size={18} />
              <span>{props.query ? "No matching threads" : "No threads yet"}</span>
            </div>
          ) : null}

          {props.hasMore ? (
            <Button
              variant="ghost"
              size="sm"
              className="agent-thread-load-more"
              disabled={props.loadingMore}
              onClick={props.onLoadMore}
            >
              {props.loadingMore ? <Loader2 className="spin" size={12} /> : <ChevronDown size={12} />}
              Load older threads
            </Button>
          ) : null}
        </div>
      </ScrollArea>
    </aside>
  );
}

function AgentChatsView(props: {
  thread: AgentThread | null;
  draft: boolean;
  run: AgentRunTimelineRun | null;
  events: RunEvent[];
  pendingMessages: AgentRunChatMessage[];
  providers: ProviderInstance[];
  selection: ModelSelection | null;
  onSelectionChange: (selection: ModelSelection) => Promise<void>;
  onSendMessage: (message: string, selection: ModelSelection) => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  const previousThreadRef = useRef<string | null>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const active = isActiveRun(props.thread?.latest_status);
  const title = props.draft ? "New thread" : (props.thread?.title ?? "Agent thread");
  const agentName = props.thread?.agent_name ?? "Orchestrator";
  const projectName = props.thread?.project_name ?? "Aisevak workspace";
  const latestError = props.thread?.latest_error ? friendlyError(props.thread.latest_error) : null;
  const threadKey = props.thread?.id ?? (props.draft ? "draft" : "loading");

  useLayoutEffect(() => {
    if (previousThreadRef.current !== threadKey) {
      previousThreadRef.current = threadKey;
      pinnedToBottomRef.current = true;
      setShowScrollDown(false);
    }
    const timeline = timelineRef.current;
    if (!timeline) {
      setShowScrollDown(false);
      return;
    }
    if (pinnedToBottomRef.current) {
      timeline.scrollTop = timeline.scrollHeight;
      setShowScrollDown(false);
      return;
    }
    setShowScrollDown(shouldShowThreadScrollDown(timeline, pinnedToBottomRef.current));
  }, [threadKey, props.run, props.events, props.pendingMessages, latestError]);

  function scrollToLatest() {
    const timeline = timelineRef.current;
    if (!timeline) return;
    pinnedToBottomRef.current = true;
    setShowScrollDown(false);
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
  }

  return (
    <div className={`agent-chat-view ${props.draft ? "is-draft" : ""}`}>
      <header className="agent-chat-header">
        <div className="agent-chat-heading">
          {props.thread?.display_agent_identity ? (
            <AgentAvatar
              agentId={props.thread.agent_id}
              agentName={props.thread.agent_name}
              className="agent-chat-avatar"
            />
          ) : (
            <div className="agent-chat-avatar"><OpenAILogo size={16} /></div>
          )}
          <div className="agent-chat-title-group">
            <div className="agent-chat-breadcrumb">{projectName} <span>/</span> {agentName}</div>
            <h1>{title}</h1>
          </div>
        </div>
        <div className="agent-chat-header-actions">
          {!props.draft && props.thread?.latest_status ? <TaskStatus status={props.thread.latest_status} /> : null}
          {active ? (
            <Button variant="secondary" size="sm" onClick={() => void props.onCancel()}>
              <Square size={13} /> Stop
            </Button>
          ) : null}
          <ThemeToggle />
        </div>
      </header>

      <div className="agent-chat-stage">
        {props.draft && props.events.length === 0 && props.pendingMessages.length === 0 ? (
          <div className="agent-chat-hero">
            <div className="hero-mark"><OpenAILogo size={20} /></div>
            <h2>What should Codex work on?</h2>
            <p>Start a durable thread. You can switch models before sending or between turns.</p>
          </div>
        ) : (
          <div
            className="agent-chat-timeline-wrap"
            ref={timelineRef}
            role="log"
            aria-label="Thread messages"
            aria-live="polite"
            tabIndex={0}
            onScroll={(event) => {
              const nearBottom = isThreadScrollNearBottom(event.currentTarget);
              pinnedToBottomRef.current = nearBottom;
              setShowScrollDown(!nearBottom);
            }}
          >
            <CodexSessionTimeline
              run={props.run}
              events={props.events}
              pendingMessages={props.pendingMessages}
            />
            {latestError ? (
              <div className="agent-run-failure" role="status">
                <span className="agent-run-failure-icon"><CircleAlert size={15} weight="fill" /></span>
                <span>
                  <strong>Codex could not start this turn</strong>
                  <small>{latestError}</small>
                </span>
              </div>
            ) : null}
          </div>
        )}

        {showScrollDown ? (
          <button
            className="agent-chat-scroll-down"
            type="button"
            onClick={scrollToLatest}
            aria-label="Scroll to latest message"
            title="Scroll to latest message"
          >
            <ArrowDown size={16} weight="bold" />
          </button>
        ) : null}

        <div className="agent-chat-composer-wrap">
          <AgentChatComposer
            active={active}
            providers={props.providers}
            selection={props.selection}
            onSelectionChange={props.onSelectionChange}
            onSend={props.onSendMessage}
            onCancel={props.onCancel}
          />
        </div>
      </div>
    </div>
  );
}

function AgentChatComposer(props: {
  active: boolean;
  providers: ProviderInstance[];
  selection: ModelSelection | null;
  onSelectionChange: (selection: ModelSelection) => Promise<void>;
  onSend: (message: string, selection: ModelSelection) => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selection = props.selection;
  const provider =
    props.providers.find((entry) => entry.id === selection?.providerInstanceId) ?? props.providers[0];
  const model = provider?.models.find((entry) => entry.id === selection?.model) ?? provider?.models[0];
  const reasoningOption = model?.options?.find((option) => option.id === "reasoningEffort");
  const reasoningValue =
    selection?.options.find((option) => option.id === "reasoningEffort")?.value ??
    reasoningOption?.defaultValue ??
    "";

  async function submit() {
    const trimmed = message.trim();
    if (!trimmed || !selection || sending) return;
    setSending(true);
    setError(null);
    try {
      await props.onSend(trimmed, selection);
      setMessage("");
    } catch (sendError) {
      setError(sendError instanceof Error ? friendlyError(sendError.message) : "Failed to send message.");
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className="agent-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="agent-composer-surface">
        <Textarea
          value={message}
          disabled={sending}
          rows={2}
          placeholder={props.active ? "Send guidance to the active turn…" : "Ask Codex to build, inspect, or change something"}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            void submit();
          }}
        />
        <div className="agent-composer-footer">
          <div className="agent-composer-controls">
            <Popover
              open={pickerOpen}
              onOpenChange={(open) => {
                setPickerOpen(open);
                if (!open) setModelQuery("");
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="agent-model-trigger"
                  type="button"
                  disabled={!provider}
                >
                  <OpenAILogo size={14} />
                  <span>{model?.label ?? selection?.model ?? "Choose model"}</span>
                  <ChevronDown size={11} />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="agent-model-popover"
                side="top"
                align="start"
                sideOffset={9}
                aria-label="Choose a Codex model"
              >
                <div className="model-picker-heading">
                  <span className="model-harness-mark"><OpenAILogo size={14} /></span>
                  <div>
                    <strong>{provider?.display_name ?? "Codex"} models</strong>
                    <span className={`model-catalog-source is-${provider?.modelSource ?? "fallback"}`}>
                      <Circle size={6} weight="fill" />
                      {provider?.modelSource === "live" ? "Live catalog" : "Offline catalog"}
                    </span>
                  </div>
                </div>
                <Command>
                  <CommandInput
                    autoFocus
                    value={modelQuery}
                    placeholder="Search models…"
                    onValueChange={setModelQuery}
                  />
                  <CommandList>
                    <CommandEmpty>No matching models.</CommandEmpty>
                    <CommandGroup heading="Models">
                      {(provider?.models ?? []).map((entry) => (
                        <CommandItem
                          value={`${entry.label} ${entry.id} ${entry.description}`}
                          className={entry.id === selection?.model ? "is-selected" : ""}
                          key={entry.id}
                          onSelect={() => {
                            if (!provider) return;
                            void props.onSelectionChange(selectionForModel(provider, entry, selection));
                            setPickerOpen(false);
                            setModelQuery("");
                          }}
                        >
                          <span className="model-row-copy">
                            <strong>{entry.label}</strong>
                            <small>{entry.description}</small>
                          </span>
                          {entry.badge ? <span className="model-badge">{entry.badge}</span> : null}
                          {entry.id === selection?.model ? <CheckCircle2 size={15} weight="fill" /> : null}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            {reasoningOption && selection ? (
              <Select
                value={String(reasoningValue)}
                onValueChange={(value) => {
                    const options = [
                      ...selection.options.filter((option) => option.id !== reasoningOption.id),
                      { id: reasoningOption.id, value }
                    ];
                    void props.onSelectionChange({ ...selection, options });
                }}
              >
                <SelectTrigger className="reasoning-control" aria-label={reasoningOption.label}>
                  <span className="reasoning-label">Reasoning</span>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent side="top" align="start">
                  <SelectGroup>
                    <SelectLabel>{reasoningOption.label}</SelectLabel>
                    {reasoningOption.values.map((value) => (
                      <SelectItem key={value.id} value={value.id}>{value.label}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : null}
          </div>

          <div className="agent-composer-actions">
            <span>{props.active ? "Message the active turn" : "Enter to send"} · Shift Enter for newline</span>
            {props.active ? (
              <button className="agent-send-button stop" type="button" onClick={() => void props.onCancel()} aria-label="Stop Codex">
                <Square size={15} weight="fill" />
              </button>
            ) : null}
            <button
              className="agent-send-button"
              type="submit"
              disabled={!message.trim() || !selection || sending}
              aria-label={sending ? "Sending" : props.active ? "Send guidance" : "Send message"}
            >
              {sending ? <Loader2 className="spin" size={15} /> : <ArrowUp size={16} weight="bold" />}
            </button>
          </div>
        </div>
      </div>
      {error ? <div className="composer-error">{error}</div> : null}
    </form>
  );
}

function AgentsView(props: {
  agents: Agent[];
  skills: Skill[];
  tasks: Task[];
  models: CodexModel[];
  defaultModel: string;
  onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Agent | null>(props.agents[0] ?? null);
  useEffect(() => {
    setEditing((selected) => reconcileSelectedAgent(selected, props.agents));
  }, [props.agents]);

  return (
    <div className="master-detail">
      <aside className="master-list">
        <div className="master-header flex-between">
          <h3>Agents</h3>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setEditing(emptyAgent(props.defaultModel, props.models))}
            aria-label="New agent"
          >
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
              <AgentAvatar
                agentId={agent.id}
                agentName={agent.name}
                className="list-item-icon agent-list-avatar"
              />
              <div className="list-item-main">
                <span className="list-item-title">{agent.name}</span>
                <span className="list-item-desc">{agentSummary(agent, props.models)}</span>
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
              agents={props.agents}
              skills={props.skills}
              tasks={props.tasks}
              models={props.models}
              defaultModel={props.defaultModel}
              onSaved={async (agent) => {
                setEditing(agent);
                await props.onSaved();
              }}
              onDeleted={async () => {
                setEditing(null);
                await props.onSaved();
              }}
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
  agents: Agent[];
  skills: Skill[];
  tasks: Task[];
  models: CodexModel[];
  defaultModel: string;
  onSaved: (agent: Agent) => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(props.agent);
  const [busy, setBusy] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(props.agent);
    setDeleteArmed(false);
    setError(null);
  }, [props.agent]);
  const selectedModel = props.models.find((model) => model.id === (draft.model || props.defaultModel));
  const resolvedModelOptions = selectedModel
    ? optionsForModel(selectedModel, normalizeComposerOptions(draft.model_options))
    : normalizeComposerOptions(draft.model_options);
  const reasoningOption = selectedModel?.options?.find((option) => option.id === "reasoningEffort");
  const reasoningValue = resolvedModelOptions.find((option) => option.id === "reasoningEffort")?.value;

  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const path = draft.id ? `/api/agents/${draft.id}` : "/api/agents";
        try {
          const result = await api<{ agent: Agent }>(path, {
            method: draft.id ? "PATCH" : "POST",
            body: JSON.stringify({ ...draft, modelOptions: resolvedModelOptions })
          });
          await props.onSaved(result.agent);
        } catch (saveError) {
          setError(friendlyError(saveError instanceof Error ? saveError.message : "Could not save agent."));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="agent-editor-identity">
        <AgentAvatar
          agentId={draft.id}
          agentName={draft.name}
          className="agent-editor-avatar"
        />
        <div>
          <h2>{draft.name || "New Agent"}</h2>
          <p>This unique profile picture follows the agent across automatic threads and schedules.</p>
        </div>
      </div>
      <div className="agent-settings-grid">
        <label>
          Name
          <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
        <label>
          Model
          <NativeSelect
            value={draft.model || props.defaultModel}
            onChange={(event) => {
              const model = props.models.find((entry) => entry.id === event.target.value);
              setDraft({
                ...draft,
                model: event.target.value,
                model_options: model ? optionsForModel(model) : []
              });
            }}
          >
            {draft.model && !selectedModel ? (
              <option value={draft.model}>{draft.model} - unavailable</option>
            ) : null}
            {props.models.map((model) => (
              <option value={model.id} key={model.id}>
                {model.label}{model.badge ? ` - ${model.badge}` : ""}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label>
          Reasoning
          {reasoningOption ? (
            <Select
              value={String(reasoningValue ?? reasoningOption.defaultValue ?? reasoningOption.values[0]?.id ?? "")}
              onValueChange={(value) => {
                setDraft({
                  ...draft,
                  model_options: [
                    ...resolvedModelOptions.filter((option) => option.id !== reasoningOption.id),
                    { id: reasoningOption.id, value }
                  ]
                });
              }}
            >
              <SelectTrigger className="agent-setting-select" aria-label={reasoningOption.label}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectGroup>
                  <SelectLabel>{reasoningOption.label}</SelectLabel>
                  {reasoningOption.values.map((value) => (
                    <SelectItem key={value.id} value={value.id}>{value.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : (
            <Input value="Model default" disabled />
          )}
        </label>
      </div>
      <label>
        Description
        <Input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
      </label>
      <label>
        Prompt
        <PromptComposer
          value={draft.instructions}
          onChange={(instructions) => setDraft({ ...draft, instructions })}
          agents={props.agents}
          skills={props.skills}
          tasks={props.tasks}
          minHeight={300}
          ariaLabel="Agent prompt"
          placeholder="Describe how this agent should work. Type / to reference skills, agents, or tasks."
        />
      </label>
      <div className="model-list">
        {props.models.map((model) => (
          <span className="model-pill" key={model.id}>
            {model.id}
          </span>
        ))}
      </div>
      {error ? <div className="notice error">{error}</div> : null}
      <div style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "center" }}>
        <Button type="submit" disabled={busy}>
          <CheckCircle2 size={15} />
          Save agent
        </Button>
        {draft.id ? (
          deleteArmed ? (
            <>
              <Button type="button" variant="secondary" disabled={busy} onClick={() => setDeleteArmed(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await api(`/api/agents/${draft.id}`, { method: "DELETE" });
                    await props.onDeleted();
                  } catch (deleteError) {
                    setError(friendlyError(deleteError instanceof Error ? deleteError.message : "Could not delete agent."));
                    setDeleteArmed(false);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Trash2 size={15} />
                Confirm delete
              </Button>
            </>
          ) : (
            <Button type="button" variant="destructive" disabled={busy} onClick={() => setDeleteArmed(true)}>
              <Trash2 size={15} />
              Delete agent
            </Button>
          )
        ) : null}
      </div>
    </form>
  );
}

function CodexConnectionView() {
  const [status, setStatus] = useState<CodexAuthStatus>({
    connected: false,
    activeMethod: null,
    chatgptConnected: false,
    apiKeyConfigured: false,
    email: null,
    name: null,
    accountIdSuffix: null,
    expiresAt: null,
    lastRefresh: null,
    needsLogin: true,
    lastError: null
  });
  const [login, setLogin] = useState<CodexDeviceLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadStatus();
  }, []);

  useEffect(() => {
    if (!login) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      if (login.expiresAt <= Date.now()) {
        setError("The authorization code expired. Start a new login.");
        setLogin(null);
        return;
      }
      try {
        const result = await api<{ status: "pending" | "connected"; auth: CodexAuthStatus }>(
          `/api/codex-auth/login/${encodeURIComponent(login.loginId)}`
        );
        if (stopped) return;
        setStatus(result.auth);
        if (result.status === "connected") {
          setLogin(null);
          setError(null);
          return;
        }
        timer = window.setTimeout(poll, Math.max(2000, login.intervalSeconds * 1000));
      } catch (pollError) {
        if (stopped) return;
        setError(friendlyError(pollError instanceof Error ? pollError.message : "ChatGPT authorization failed."));
        setLogin(null);
      }
    };
    timer = window.setTimeout(poll, Math.max(1000, login.intervalSeconds * 1000));
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [login?.loginId]);

  async function loadStatus() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api<CodexAuthStatus>("/api/codex-auth"));
    } catch (statusError) {
      setError(friendlyError(statusError instanceof Error ? statusError.message : "Could not read ChatGPT status."));
    } finally {
      setBusy(false);
    }
  }

  async function startLogin() {
    setBusy(true);
    setError(null);
    window.open("https://auth.openai.com/codex/device", "_blank", "noopener,noreferrer");
    try {
      setLogin(await api<CodexDeviceLogin>("/api/codex-auth/login", { method: "POST" }));
    } catch (loginError) {
      setError(friendlyError(loginError instanceof Error ? loginError.message : "Could not start ChatGPT login."));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api<CodexAuthStatus>("/api/codex-auth", { method: "DELETE" }));
      setLogin(null);
    } catch (disconnectError) {
      setError(friendlyError(disconnectError instanceof Error ? disconnectError.message : "Could not disconnect ChatGPT."));
    } finally {
      setBusy(false);
    }
  }

  const accountLabel =
    status.email ?? status.name ?? (status.accountIdSuffix ? `Account •••${status.accountIdSuffix}` : "Not connected");
  const connectionLabel = status.chatgptConnected
    ? "ChatGPT connected"
    : status.apiKeyConfigured
      ? "API key active"
      : "Login required";

  return (
    <div className="flat-list-view api-view codex-connection-view">
      <div className="flat-header">
        <h3>ChatGPT</h3>
      </div>

      <section className="codex-connection-hero">
        <div className="codex-connection-heading">
          <div className="codex-connection-mark"><OpenAILogo size={25} /></div>
          <div>
            <span className="eyebrow">Codex authentication</span>
            <h4>Connect ChatGPT to Aisevak</h4>
            <p>One browser sign-in powers every Orchestrator and worker thread. The shared credential is encrypted in Aisevak’s database.</p>
          </div>
        </div>
        <Badge variant={status.connected ? "success" : "warning"}>{connectionLabel}</Badge>
      </section>

      <section className="codex-connection-grid">
        <div>
          <span>Active method</span>
          <strong>{status.activeMethod === "chatgpt" ? "ChatGPT subscription" : status.activeMethod === "api_key" ? "OpenAI API key" : "None"}</strong>
        </div>
        <div>
          <span>Account</span>
          <strong>{accountLabel}</strong>
        </div>
        <div>
          <span>Last refresh</span>
          <strong>{status.lastRefresh ? formatDateTime(status.lastRefresh) : "—"}</strong>
        </div>
      </section>

      {login ? (
        <section className="codex-login-panel">
          <div>
            <span className="eyebrow">Finish in ChatGPT</span>
            <h4>Enter this one-time code</h4>
            <p>The page will detect authorization automatically. The refresh token never enters browser storage.</p>
          </div>
          <button
            type="button"
            className="codex-device-code"
            title="Copy authorization code"
            onClick={() => void navigator.clipboard.writeText(login.userCode)}
          >
            {login.userCode}
            <Copy size={14} />
          </button>
          <div className="codex-login-actions">
            <a href={login.verificationUrl} target="_blank" rel="noopener noreferrer" className="codex-auth-link">
              Open ChatGPT authorization <ArrowUp size={14} />
            </a>
            <span><Loader2 className="spin" size={13} /> Waiting for authorization…</span>
          </div>
        </section>
      ) : null}

      <section className="api-section codex-connection-actions">
        <div className="section-title-row">
          <div>
            <h4>{status.chatgptConnected ? "Connection is ready" : "Connect your ChatGPT subscription"}</h4>
            <p>
              {status.chatgptConnected
                ? "Codex refreshes this session automatically, and Aisevak carries the refreshed login into future runs."
                : "Aisevak uses OpenAI’s device-code flow so authentication can finish in your browser while the runner stays on Azure."}
            </p>
          </div>
          <div className="row-actions">
            {status.chatgptConnected ? (
              <>
                <Button variant="outline" disabled={busy} onClick={() => void loadStatus()}>
                  <RefreshCw className={busy ? "spin" : ""} size={14} /> Refresh
                </Button>
                <Button variant="destructive" disabled={busy} onClick={() => void disconnect()}>
                  Disconnect
                </Button>
              </>
            ) : (
              <Button disabled={busy || Boolean(login)} onClick={() => void startLogin()}>
                {busy ? <Loader2 className="spin" size={14} /> : <OpenAILogo size={14} />}
                {busy ? "Starting…" : "Connect ChatGPT"}
              </Button>
            )}
          </div>
        </div>
        {status.apiKeyConfigured && !status.chatgptConnected ? (
          <div className="notice codex-inline-notice">An API key is currently configured as the fallback authentication method.</div>
        ) : null}
        {error || status.lastError ? <div className="notice error codex-inline-notice">{error ?? status.lastError}</div> : null}
      </section>
    </div>
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

function SkillsView(props: {
  skills: Skill[];
  root: string;
  errors: SkillCatalogError[];
  onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Skill | null>(props.skills[0] ?? null);
  useEffect(() => {
    if (!editing) {
      if (props.skills[0]) setEditing(props.skills[0]);
      return;
    }
    if (!editing.id) return;
    setEditing(props.skills.find((skill) => skill.id === editing.id) ?? props.skills[0] ?? null);
  }, [props.skills]);

  return (
    <div className="master-detail">
      <aside className="master-list">
        <div className="master-header flex-between">
          <h3>Skills</h3>
          <Button variant="ghost" size="icon" onClick={() => setEditing(emptySkill())} title="New skill" aria-label="New skill">
            <Plus size={14} />
          </Button>
        </div>
        {props.root ? <div className="skill-catalog-path" title={props.root}>{props.root}</div> : null}
        {props.errors.length > 0 ? (
          <div className="skill-catalog-errors" title={props.errors.map((error) => `${error.directory}: ${error.message}`).join("\n")}>
            {props.errors.length} invalid skill {props.errors.length === 1 ? "directory" : "directories"}
          </div>
        ) : null}
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
              <TaskStatus status={skill.enabled ? (skill.default_for_agents ? "default" : "enabled") : "disabled"} />
            </button>
          ))}
          {props.skills.length === 0 ? <div className="empty-list">No skills</div> : null}
        </div>
      </aside>
      <main className="detail-view">
        {editing ? (
          <div className="form-view">
            <SkillEditor skill={editing} root={props.root} onSaved={props.onSaved} />
          </div>
        ) : (
          <div className="empty-state">Select a skill</div>
        )}
      </main>
    </div>
  );
}

function SkillEditor(props: { skill: Skill; root: string; onSaved: () => Promise<void> }) {
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
        let files = draft.files;
        if (!draft.platform_managed) {
          try {
            const parsed = JSON.parse(filesJson || "{}") as unknown;
            files = normalizeFilesDraft(parsed);
          } catch (parseError) {
            setError(parseError instanceof Error ? parseError.message : "Files must be valid JSON.");
            return;
          }
        }
        const path = draft.id ? `/api/skills/${draft.id}` : "/api/skills";
        try {
          await api(path, {
            method: draft.id ? "PATCH" : "POST",
            body: JSON.stringify(draft.platform_managed ? { enabled: draft.enabled } : { ...draft, files })
          });
          await props.onSaved();
        } catch (saveError) {
          setError(saveError instanceof Error ? saveError.message : "Failed to save skill.");
        }
      }}
    >
      {props.root ? (
        <div className="notice">
          Installed at <code>{props.root}/{draft.name}</code>.
          {draft.platform_managed ? " Aisevak updates this skill with application releases." : " Changes here are written back to the installed-skill directory."}
        </div>
      ) : null}
      {draft.platform_managed ? (
        <div className="notice">
          This skill is available to every agent by default. Only its availability can be changed.
        </div>
      ) : null}
      <div className="form-grid">
        <label>
          Name
          <Input disabled={draft.platform_managed} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
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
        <Input disabled={draft.platform_managed} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
      </label>
      <label>
        Instructions
        <Textarea
          className="textarea-mono"
          style={{ minHeight: 260 }}
          disabled={draft.platform_managed}
          value={draft.instructions}
          onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
        />
      </label>
      <label>
        Files JSON
        <Textarea
          className="textarea-mono"
          style={{ minHeight: 150 }}
          disabled={draft.platform_managed}
          value={filesJson}
          onChange={(event) => setFilesJson(event.target.value)}
        />
      </label>
      {error ? <div className="notice error">{error}</div> : null}
      <div>
        <Button type="submit">
          <CheckCircle2 size={15} />
          {draft.platform_managed ? "Save availability" : "Save skill"}
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
  connection: GithubConnection | null;
  hostname: string;
  onConnect: (token: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onImport: (repoId: string) => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectionBusy = props.connection
    ? ["pending", "sync_requested", "syncing", "disconnect_requested", "disconnecting"].includes(
        props.connection.status
      )
    : false;
  const connected = props.connection?.status === "ready";

  async function perform(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "GitHub operation failed");
    } finally {
      setBusy(false);
    }
  }

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
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>CLI authentication and projects</div>
            </div>
          </div>
          {props.connection && props.connection.status !== "disconnected" ? (
            <div className="stack">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div>
                  <div className="data-title">
                    {props.connection.account_login ? `@${props.connection.account_login}` : props.hostname}
                  </div>
                  <div className="data-subtitle">
                    {connected ? "gh and git are authenticated" : githubConnectionStatus(props.connection.status)}
                  </div>
                </div>
                <Badge variant={connected ? "success" : props.connection.status === "failed" ? "destructive" : "warning"}>
                  {githubConnectionStatus(props.connection.status)}
                </Badge>
              </div>
              {props.connection.last_synced_at ? (
                <div className="data-subtitle">Repositories synced {formatDateTime(props.connection.last_synced_at)}</div>
              ) : null}
              {props.connection.error ? <div className="notice error">{props.connection.error}</div> : null}
              {connected ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={busy || connectionBusy}
                    onClick={() => void perform(props.onRefresh)}
                  >
                    <RefreshCw size={14} /> Refresh
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={busy || connectionBusy}
                    onClick={() => void perform(props.onDisconnect)}
                  >
                    Disconnect
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {!connected && !connectionBusy ? (
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(async () => {
                  await props.onConnect(token);
                  setToken("");
                });
              }}
            >
              <div className="data-subtitle">
                Enter a classic token with <code>repo</code>, <code>read:org</code>, and <code>gist</code> scopes.
                Aisevak uses it once to sign the host runner into <code>gh</code> and configure Git credentials.
              </div>
              <Input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="GitHub personal access token"
                type="password"
                autoComplete="off"
              />
              <Button type="submit" disabled={busy || token.trim().length < 10}>
                {busy ? <Loader2 size={14} className="spin" /> : <Github size={14} />} Connect GitHub
              </Button>
            </form>
          ) : null}
          {error ? <div className="notice error" style={{ marginTop: 12 }}>{error}</div> : null}
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
                    <div className="data-subtitle">
                      {repo.default_branch}
                      {repo.import_status === "failed" && repo.import_error ? ` · ${repo.import_error}` : ""}
                    </div>
                  </div>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => void perform(() => props.onImport(repo.id))}
                  disabled={Boolean(repo.imported_project_id) || repo.import_status === "queued" || repo.import_status === "running"}
                >
                  {repo.imported_project_id
                    ? "Imported"
                    : repo.import_status === "queued"
                      ? "Queued"
                      : repo.import_status === "running"
                        ? "Importing…"
                        : repo.import_status === "failed"
                          ? "Retry"
                          : "Import"}
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

function githubConnectionStatus(status: GithubConnection["status"]): string {
  switch (status) {
    case "pending":
      return "Waiting for runner";
    case "sync_requested":
      return "Refresh queued";
    case "syncing":
      return "Connecting";
    case "ready":
      return "Connected";
    case "failed":
      return "Needs attention";
    case "disconnect_requested":
    case "disconnecting":
      return "Disconnecting";
    case "disconnected":
      return "Disconnected";
  }
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
        <MarkdownContent text={row.text} plain />
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
        <MarkdownContent text={row.message.text || (row.message.streaming ? "" : "(empty response)")} />
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
        <MarkdownContent text={text} plain />
      </div>
      {shouldCollapse ? (
        <button className="text-button" type="button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : "Show full message"}
        </button>
      ) : null}
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
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" className={`nav-item ${active ? "active" : ""}`} aria-current={active ? "page" : undefined} onClick={onClick}>
          <AnimatedIcon icon={icon as ReactElement} active={active} />
          <span>{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function emptyAgent(defaultModel: string, models: CodexModel[]): Agent {
  const model = models.find((entry) => entry.id === defaultModel) ?? models[0];
  return {
    id: "",
    kind: "worker",
    name: "New Agent",
    description: "",
    model: model?.id ?? defaultModel,
    model_options: model ? optionsForModel(model) : [],
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
    enabled: true,
    platform_managed: false,
    default_for_agents: false
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

function defaultScheduleDateTime(minutesFromNow = 5): string {
  const date = new Date(Date.now() + minutesFromNow * 60_000);
  date.setSeconds(0, 0);
  return localDateTimeInput(date);
}

function formatScheduleCadence(schedule: Schedule): string {
  if (schedule.schedule_kind === "once" || !schedule.interval_seconds) return "One time";
  const seconds = schedule.interval_seconds;
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `Every ${days} day${days === 1 ? "" : "s"}`;
  }
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `Every ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = seconds / 60;
  return `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function apiKeyStatus(key: ExternalApiKey): string {
  if (key.revoked_at) return "revoked";
  if (new Date(key.expires_at).getTime() <= Date.now()) return "expired";
  return "active";
}

function viewTitle(view: View): string {
  return {
    tasks: "Tasks",
    runs: "Threads",
    agents: "Agents",
    skills: "Skills",
    schedules: "Schedule",
    codex: "ChatGPT",
    api: "API",
    credentials: "Credentials",
    projects: "Projects",
    connectors: "Connectors"
  }[view];
}

function formatSidebarRunTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function selectionForModel(
  provider: ProviderInstance,
  model: CodexModel,
  previous?: ModelSelection | null
): ModelSelection {
  return {
    providerInstanceId: provider.id,
    model: model.id,
    options: optionsForModel(model, previous?.options)
  };
}

function optionsForModel(
  model: CodexModel,
  previous: ModelOptionSelection[] = []
): ModelOptionSelection[] {
  return (model.options ?? []).flatMap((option): ModelOptionSelection[] => {
      const previousValue = previous.find((entry) => entry.id === option.id)?.value;
      const canReusePrevious = option.values.some((value) => value.id === String(previousValue));
      const value = canReusePrevious ? previousValue : (option.defaultValue ?? option.values[0]?.id);
      return value ? [{ id: option.id, value }] : [];
  });
}

function agentSummary(agent: Agent, models: CodexModel[]): string {
  const model = models.find((entry) => entry.id === agent.model);
  const reasoningOption = model?.options?.find((option) => option.id === "reasoningEffort");
  const reasoning = normalizeComposerOptions(agent.model_options)
    .find((option) => option.id === "reasoningEffort")?.value ?? reasoningOption?.defaultValue;
  return [agent.kind, agent.model, reasoning ? String(reasoning) : null].filter(Boolean).join(" / ");
}

function normalizeComposerOptions(value: unknown): ModelOptionSelection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ModelOptionSelection[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string") return [];
    if (!["string", "number", "boolean"].includes(typeof entry.value)) return [];
    return [{ id: entry.id, value: entry.value as string | number | boolean }];
  });
}

function readStickyModelSelection(provider: ProviderInstance): ModelSelection {
  try {
    const raw = window.localStorage.getItem("aisevak.agent-model-selection");
    if (raw) {
      const parsed = JSON.parse(raw) as ModelSelection;
      const selectedProvider = parsed.providerInstanceId === provider.id ? provider : null;
      if (selectedProvider?.models.some((model) => model.id === parsed.model)) {
        return { ...parsed, options: normalizeComposerOptions(parsed.options) };
      }
    }
  } catch {
    // Ignore corrupt local preferences and use the live provider default.
  }
  const model = provider.models.find((entry) => entry.id === provider.defaultModel) ?? provider.models[0];
  return model
    ? selectionForModel(provider, model)
    : { providerInstanceId: provider.id, model: provider.defaultModel, options: [] };
}

function writeStickyModelSelection(selection: ModelSelection): void {
  try {
    window.localStorage.setItem("aisevak.agent-model-selection", JSON.stringify(selection));
  } catch {
    // Local preferences are optional; server-backed thread state remains authoritative.
  }
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

function friendlyError(message: string): string {
  if (/spawn\s+codex\s+ENOENT/i.test(message)) {
    return "The Codex executable was not found. Restart Aisevak after updating its Codex binary setting.";
  }
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
