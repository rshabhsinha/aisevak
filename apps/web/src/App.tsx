import {
  Activity,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Bot,
  Calendar,
  ChatsIcon,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleDashed,
  CircleX,
  Clock,
  Copy,
  Eye,
  FolderGit2,
  Github,
  Hammer,
  Info,
  KeyRound,
  LayoutDashboard,
  ListIcon,
  Loader2,
  LockKeyhole,
  LogOut,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  SettingsIcon,
  Square,
  Terminal,
  Trash2,
  Wrench,
  X
} from "./components/icons";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactElement, ReactNode } from "react";
import { AnimatedIcon } from "./components/animated-icon";
import { AgentAvatar } from "./components/agent-avatar";
import { AgentOrb, ThinkingReasoning, FileDiff, DotMatrixLoader } from "./components/aicss";
import { MarkdownContent } from "./components/markdown";
import { OpenAILogo } from "./components/openai-logo";
import { CursorLogo, HarnessMark, OpenCodeLogo } from "./components/harness-logos";
import { PromptComposer } from "./components/prompt-composer";
import { ThemeToggle } from "./components/theme-toggle";
import { cn } from "./lib/utils";
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
import { mergeRefreshedAgentThreads, updateAgentThreadInPlace } from "./agentThreads";
import { DEFAULT_AGENT_MODEL, reconcileSelectedAgent } from "./agentModels";
import { appPath, parseAppRoute, type AppView as View } from "./appRouting";
import { isThreadScrollNearBottom, shouldShowThreadScrollDown } from "./threadScroll";
import { createTaskAndQueueRun } from "./taskCreation";
import { createThreadLoadGuard } from "./threadLoadGuard";
import {
  threadDetailFailed,
  threadDetailIdle,
  threadDetailLoading,
  threadDetailReady,
  type ThreadDetailState
} from "./threadDetailState";

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
  provider_instance_id: string;
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
  driver: "codex" | "cursor" | "opencode";
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
  provider_driver: "codex" | "cursor" | "opencode";
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
  work_scope?: string | null;
  work_key?: string | null;
  parent_task_id?: string | null;
  parent_task_number?: number | null;
  active_child_count?: number;
  assignment_count?: number;
  active_assignment_count?: number;
  assignments?: TaskAssignment[];
  safety_event_count?: number;
  latest_safety_event?: {
    operation: string;
    work_scope?: string | null;
    work_key?: string | null;
    would_reject?: boolean;
    details?: unknown;
    created_at?: string;
  } | null;
  updated_at?: string;
  created_at?: string;
}

interface TaskAssignment {
  id: string;
  number: number;
  key?: string;
  assignment_key: string;
  status: string;
  attempt_count: number;
  assigned_agent_name?: string | null;
  created_by_agent_name?: string | null;
  active_delivery_id?: string | null;
  updated_at?: string;
}

interface ActivityReport {
  id: string;
  number: number;
  title: string;
  description: string;
  status: string;
  project_id: string | null;
  project_name: string | null;
  thread_id: string | null;
  thread_number: number | null;
  agent_thread_id: string | null;
  author_agent_id: string | null;
  author_agent_name: string | null;
  current_revision: number;
  markdown: string;
  created_at: string;
  updated_at: string;
}

interface Incident {
  id: string;
  number: number;
  title: string;
  description: string;
  status: string;
  severity: "low" | "medium" | "high" | "critical";
  project_id: string | null;
  project_name: string | null;
  thread_id: string | null;
  thread_number: number | null;
  agent_thread_id: string | null;
  commander_agent_id: string | null;
  commander_agent_name: string | null;
  created_by_agent_id: string | null;
  created_by_agent_name: string | null;
  markdown: string | null;
  latest_update_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
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
const RESOURCE_FEED_PAGE_SIZE = 15;

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
  const initialRoute = useMemo(() => parseAppRoute(window.location.pathname), []);
  const [user, setUser] = useState<User | null>(null);
  const [hasAdmin, setHasAdmin] = useState<boolean | null>(null);
  const [view, setView] = useState<View>(initialRoute.view);
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
  const [activityReports, setActivityReports] = useState<ActivityReport[]>([]);
  const [activityNextCursor, setActivityNextCursor] = useState<string | null>(null);
  const [activityHasMore, setActivityHasMore] = useState(false);
  const [loadingOlderActivity, setLoadingOlderActivity] = useState(false);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [incidentsNextCursor, setIncidentsNextCursor] = useState<string | null>(null);
  const [incidentsHasMore, setIncidentsHasMore] = useState(false);
  const [loadingOlderIncidents, setLoadingOlderIncidents] = useState(false);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [repos, setRepos] = useState<GithubRepository[]>([]);
  const [githubConnection, setGithubConnection] = useState<GithubConnection | null>(null);
  const [githubHostname, setGithubHostname] = useState("github.com");
  const [agentThreads, setAgentThreads] = useState<AgentThread[]>([]);
  const [nextThreadCursor, setNextThreadCursor] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(initialRoute.threadId);
  const [draftThread, setDraftThread] = useState(!initialRoute.threadId);
  const [selectedThreadRun, setSelectedThreadRun] = useState<AgentRunTimelineRun | null>(null);
  const [agentThreadEvents, setAgentThreadEvents] = useState<RunEvent[]>([]);
  const [agentThreadEventsTruncated, setAgentThreadEventsTruncated] = useState(false);
  const [threadDetailState, setThreadDetailState] = useState<ThreadDetailState>(threadDetailIdle());
  const [composerSelection, setComposerSelection] = useState<ModelSelection | null>(null);
  const [pendingThreadMessages, setPendingThreadMessages] = useState<AgentRunChatMessage[]>([]);
  const [taskComposerOpen, setTaskComposerOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [scheduleComposerOpen, setScheduleComposerOpen] = useState(false);
  const [scheduleComposerDate, setScheduleComposerDate] = useState<Date | null>(null);
  const [scheduleToEdit, setScheduleToEdit] = useState<Schedule | null>(null);
  const [query, setQuery] = useState("");
  const [loadingOlderThreads, setLoadingOlderThreads] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const threadLoadGuardRef = useRef(createThreadLoadGuard(initialRoute.threadId));

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

  const filteredActivityReports = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return activityReports;
    return activityReports.filter((report) =>
      [
        report.title,
        report.description,
        report.markdown,
        report.author_agent_name ?? "",
        report.project_name ?? "",
        `REPORT-${report.number}`
      ].join(" ").toLowerCase().includes(needle)
    );
  }, [activityReports, query]);

  const filteredIncidents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return incidents;
    return incidents.filter((incident) =>
      [
        incident.title,
        incident.description,
        incident.markdown ?? "",
        incident.created_by_agent_name ?? "",
        incident.commander_agent_name ?? "",
        incident.project_name ?? "",
        incident.severity,
        `INC-${incident.number}`
      ].join(" ").toLowerCase().includes(needle)
    );
  }, [incidents, query]);

  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => {
    if (window.location.pathname !== initialRoute.path) {
      window.history.replaceState(null, "", initialRoute.path);
    }
    const handlePopState = () => {
      const route = parseAppRoute(window.location.pathname);
      setView(route.view);
      setQuery("");
      setMessage(null);
      if (route.view !== "runs") return;
      threadLoadGuardRef.current.select(route.threadId);
      setSelectedThreadId(route.threadId);
      setDraftThread(!route.threadId);
      setSelectedThreadRun(null);
      setAgentThreadEvents([]);
      setThreadDetailState(route.threadId ? threadDetailLoading() : threadDetailIdle());
      setPendingThreadMessages([]);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [initialRoute.path]);

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
    if (!user) return;
    if (view === "activity") {
      const timer = setTimeout(() => {
        void reloadActivityReports();
      }, 250);
      return () => clearTimeout(timer);
    }
    if (view === "incidents") {
      const timer = setTimeout(() => {
        void reloadIncidents();
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [user, view, query]);

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
    if (!user) return;
    if (!selectedThreadId) {
      setSelectedThreadRun(null);
      setAgentThreadEvents([]);
      setThreadDetailState(threadDetailIdle());
      return;
    }
    void loadAgentThread(selectedThreadId);
    if (!isActiveRun(selectedThread?.latest_status)) return;
    const timer = window.setInterval(() => {
      void loadAgentThread(selectedThreadId);
      void reloadAgentThreads();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [user?.id, selectedThreadId, selectedThread?.latest_status]);

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
    setComposerSelection(readStickyModelSelection(providerInstances));
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
      reloadActivityReports(),
      reloadIncidents(),
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

  async function reloadActivityReports(cursor?: string, append = false) {
    if (append) {
      setLoadingOlderActivity(true);
    }
    try {
      const params = new URLSearchParams();
      params.set("limit", String(RESOURCE_FEED_PAGE_SIZE));
      if (cursor) params.set("cursor", cursor);
      if (query.trim()) params.set("query", query.trim());
      const data = await api<{ reports: ActivityReport[]; nextCursor: string | null; hasMore?: boolean }>(
        `/api/reports?${params.toString()}`
      );
      setActivityReports((prev) => (append ? [...prev, ...data.reports] : data.reports));
      setActivityNextCursor(data.nextCursor ?? null);
      setActivityHasMore(Boolean(data.hasMore));
    } finally {
      if (append) {
        setLoadingOlderActivity(false);
      }
    }
  }

  async function reloadIncidents(cursor?: string, append = false) {
    if (append) {
      setLoadingOlderIncidents(true);
    }
    try {
      const params = new URLSearchParams();
      params.set("limit", String(RESOURCE_FEED_PAGE_SIZE));
      if (cursor) params.set("cursor", cursor);
      if (query.trim()) params.set("query", query.trim());
      const data = await api<{ incidents: Incident[]; nextCursor: string | null; hasMore?: boolean }>(
        `/api/incidents?${params.toString()}`
      );
      setIncidents((prev) => (append ? [...prev, ...data.incidents] : data.incidents));
      setIncidentsNextCursor(data.nextCursor ?? null);
      setIncidentsHasMore(Boolean(data.hasMore));
    } finally {
      if (append) {
        setLoadingOlderIncidents(false);
      }
    }
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
      return mergeRefreshedAgentThreads(current, data.threads);
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
    if (!isCurrentRequest()) return;
    setThreadDetailState(threadDetailLoading());
    let data: {
      thread: AgentThread;
      run?: AgentRunTimelineRun | null;
      events: RunEvent[];
      eventsTruncated?: boolean;
    };
    try {
      data = await api<{
        thread: AgentThread;
        run?: AgentRunTimelineRun | null;
        events: RunEvent[];
        eventsTruncated?: boolean;
      }>(`/api/agent-threads/${threadId}`);
    } catch (error) {
      if (isCurrentRequest()) setThreadDetailState(threadDetailFailed(error));
      return;
    }
    if (!isCurrentRequest()) return;
    setAgentThreads((current) => updateAgentThreadInPlace(current, data.thread));
    setSelectedThreadRun(data.run ?? null);
    setAgentThreadEvents(data.events);
    setAgentThreadEventsTruncated(Boolean(data.eventsTruncated));
    setThreadDetailState(threadDetailReady());
  }

  function selectAgentThread(threadId: string) {
    threadLoadGuardRef.current.select(threadId);
    setSelectedThreadId(threadId);
    setDraftThread(false);
    setSelectedThreadRun(null);
    setAgentThreadEvents([]);
    setAgentThreadEventsTruncated(false);
    setThreadDetailState(threadDetailLoading());
    setPendingThreadMessages([]);
    navigateToView("runs", threadId);
  }

  function navigateToView(nextView: View, threadId: string | null = null) {
    const path = appPath(nextView, nextView === "runs" ? threadId : null);
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
    setView(nextView);
    setQuery("");
  }

  function createAgentThread() {
    threadLoadGuardRef.current.select(null);
    setSelectedThreadId(null);
    setDraftThread(true);
    setSelectedThreadRun(null);
    setAgentThreadEvents([]);
    setAgentThreadEventsTruncated(false);
    setThreadDetailState(threadDetailIdle());
    setPendingThreadMessages([]);
    setComposerSelection(readStickyModelSelection(providerInstances));
    navigateToView("runs");
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
      setAgentThreads((current) => updateAgentThreadInPlace(current, thread));
      selectAgentThread(thread.id);
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
        setAgentThreads((current) => updateAgentThreadInPlace(current, data.thread));
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
        setAgentThreads((current) => updateAgentThreadInPlace(current, data.thread));
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
    setAgentThreads((current) => updateAgentThreadInPlace(current, data.thread));
  }

  if (hasAdmin === null) return <Splash />;
  if (!hasAdmin) return <Onboarding onDone={boot} />;
  if (!user) return <Login onDone={boot} />;

  return (
    <TooltipProvider delayDuration={220}>
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">
            <Terminal size={17} weight="fill" />
          </span>
          <div className="brand-copy">
            <strong>Aisevak</strong>
          </div>
        </div>

        <nav className="sidebar-nav">
          <span className="nav-label">Overview</span>
          <NavButton icon={<LayoutDashboard />} label="Tasks" active={view === "tasks"} onClick={() => navigateToView("tasks")} />
          <NavButton className="nav-item-threads" icon={<ChatsIcon />} label="Threads" active={view === "runs"} onClick={() => { selectAgentThread(""); navigateToView("runs"); }} />
          <NavButton icon={<Activity />} label="Activity" active={view === "activity"} onClick={() => navigateToView("activity")} />
          <NavButton icon={<CircleAlert />} label="Incidents" active={view === "incidents"} onClick={() => navigateToView("incidents")} />
          <NavButton icon={<Bot />} label="Agent setup" active={view === "agents"} onClick={() => { if (window.innerWidth <= 700) setEditingAgent(null); navigateToView("agents"); }} />
          <NavButton icon={<BookOpen />} label="Skills" active={view === "skills"} onClick={() => { if (window.innerWidth <= 700) setEditingSkill(null); navigateToView("skills"); }} />
          <NavButton icon={<Calendar />} label="Schedule" active={view === "schedules"} onClick={() => navigateToView("schedules")} />
          <NavButton className="nav-item-settings" icon={<SettingsIcon />} label="Settings" active={isSettingsView(view)} onClick={() => navigateToView(user.role !== "member" ? "codex" : "api")} />

          <div className="sidebar-agent-heading">
            <span className="nav-label">Threads</span>
            <Button
              variant="ghost"
              size="icon"
              className="sidebar-new-thread"
              title="New thread"
              aria-label="New thread"
              onClick={createAgentThread}
            >
              <Plus size={13} weight="bold" />
            </Button>
          </div>

          <div className="sidebar-agent-runs">
            {view === "runs" ? (
              <div className="sidebar-thread-search">
                <Search size={12} />
                <input
                  value={query}
                  placeholder="Search tasks"
                  aria-label="Search agent tasks"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            ) : null}

            {draftThread && view === "runs" ? (
              <button
                type="button"
                className="sidebar-run-item selected"
                onClick={() => navigateToView("runs", null)}
              >
                <div className="sidebar-run-avatar">
                  <Plus size={12} weight="bold" />
                </div>
                <div className="sidebar-run-copy">
                  <span className="sidebar-run-title">New thread</span>
                  <span className="sidebar-run-meta">Draft</span>
                </div>
              </button>
            ) : null}

            {(view === "runs" ? filteredThreads : agentThreads).map((thread) => {
              const isSelected = view === "runs" && selectedThreadId === thread.id;
              return (
                <button
                  type="button"
                  className={`sidebar-run-item ${isSelected ? "selected" : ""}`}
                  key={thread.id}
                  onClick={async () => {
                    selectAgentThread(thread.id);
                    await loadAgentThread(thread.id);
                  }}
                  title={`${thread.title || "Untitled"} (${thread.agent_name || "Agent"})`}
                >
                  <AgentAvatar
                    agentId={thread.agent_id || "default"}
                    agentName={thread.agent_name || "Agent"}
                    className="sidebar-run-avatar"
                    motion={isActiveRun(thread.latest_status) ? "always" : "hover"}
                    orbVariant={isActiveRun(thread.latest_status) ? "working" : undefined}
                  />
                  <div className="sidebar-run-copy">
                    <span className="sidebar-run-title">{thread.title || "Untitled task"}</span>
                    <span className="sidebar-run-meta">
                      <span className="sidebar-run-agent truncate">{thread.agent_name || "Agent"}</span>
                      <span className="sidebar-run-dot">·</span>
                      <span className="sidebar-run-time shrink-0">{formatSidebarRunTime(thread.last_activity_at)}</span>
                    </span>
                  </div>
                  {isActiveRun(thread.latest_status) ? (
                    <DotMatrixLoader size={11} className="text-primary shrink-0" />
                  ) : null}
                </button>
              );
            })}

            {(view === "runs" ? filteredThreads : agentThreads).length === 0 && !draftThread ? (
              <div className="sidebar-runs-empty">
                {view === "runs" && query ? "No matching threads" : "No threads yet"}
              </div>
            ) : null}

            {nextThreadCursor ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="agent-thread-load-more"
                disabled={loadingOlderThreads}
                onClick={() => void loadOlderAgentThreads()}
              >
                {loadingOlderThreads ? <Loader2 className="spin" size={12} /> : <ChevronDown size={12} />}
                Load older threads
              </Button>
            ) : null}
          </div>
        </nav>

        <div className="sidebar-footer">
          <div className="user-chip">
            <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
            <span className="user-details">
              <strong>{user.name}</strong>
              <small>{user.role}</small>
            </span>
          </div>
          <div className="sidebar-footer-actions">
            <Button
              variant={isSettingsView(view) ? "secondary" : "ghost"}
              size="icon"
              className="sidebar-footer-btn"
              title="Settings"
              aria-label="Settings"
              onClick={() => navigateToView(user.role !== "member" ? "codex" : "api")}
            >
              <SettingsIcon size={15} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="sidebar-footer-btn"
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
        </div>
      </aside>

      <div className={`main-content ${view === "runs" ? "agent-chat-mode" : ""}`}>
        {view !== "runs" ? <header className="top-header">
          <div className="header-title">{viewTitle(view)}</div>
          <div className="header-actions">
            {view === "tasks" ? (
              <Popover open={taskComposerOpen} onOpenChange={setTaskComposerOpen}>
                <PopoverTrigger asChild>
                  <Button size="sm" className="gap-1.5 font-medium">
                    <Plus size={14} />
                    <span>New task</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="task-composer-popover"
                  side="bottom"
                  align="end"
                  sideOffset={8}
                >
                  <TaskComposer
                    projects={projects}
                    agents={agents}
                    onCancel={() => setTaskComposerOpen(false)}
                    onCreate={async (payload) => {
                      const result = await createTaskAndQueueRun<Task>(api, payload);
                      await Promise.all([reloadTasks(), reloadAgentThreads()]);
                      if (result.enqueueError) {
                        setMessage(`Task created, but it could not be started: ${friendlyError(result.enqueueError.message)}`);
                      } else {
                        setMessage(null);
                      }
                      setTaskComposerOpen(false);
                    }}
                  />
                </PopoverContent>
              </Popover>
            ) : null}
            {view === "agents" ? (
              <Button
                size="sm"
                className="gap-1.5 font-medium"
                onClick={() => setEditingAgent(emptyAgent(providerInstances))}
              >
                <Plus size={14} />
                <span>New agent</span>
              </Button>
            ) : null}
            {view === "skills" ? (
              <Button
                size="sm"
                className="gap-1.5 font-medium"
                onClick={() => setEditingSkill(emptySkill())}
              >
                <Plus size={14} />
                <span>New skill</span>
              </Button>
            ) : null}
            {view === "schedules" ? (
              <Button
                size="sm"
                className="gap-1.5 font-medium"
                onClick={() => {
                  setScheduleComposerDate(null);
                  setScheduleToEdit(null);
                  setScheduleComposerOpen(true);
                }}
              >
                <Plus size={14} />
                <span>New schedule</span>
              </Button>
            ) : null}
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
              onSelect={(task) => void openTaskThread(task)}
            />
          ) : null}

          {view === "activity" ? (
            <ActivityView
              reports={filteredActivityReports}
              hasMore={activityHasMore}
              loadingMore={loadingOlderActivity}
              onLoadMore={() => {
                if (activityNextCursor) void reloadActivityReports(activityNextCursor, true);
              }}
              onOpenThread={selectAgentThread}
            />
          ) : null}

          {view === "incidents" ? (
            <IncidentsView
              incidents={filteredIncidents}
              hasMore={incidentsHasMore}
              loadingMore={loadingOlderIncidents}
              onLoadMore={() => {
                if (incidentsNextCursor) void reloadIncidents(incidentsNextCursor, true);
              }}
              onOpenThread={selectAgentThread}
            />
          ) : null}

          {view === "runs" ? (
            <>
              <div className={`mobile-threads-view ${selectedThreadId || draftThread ? "mobile-hide-threads" : ""}`}>
                <MobileThreadListView
                  threads={filteredThreads}
                  query={query}
                  hasMore={Boolean(nextThreadCursor)}
                  loadingMore={loadingOlderThreads}
                  onQueryChange={setQuery}
                  onLoadMore={() => void loadOlderAgentThreads()}
                  onCreateThread={createAgentThread}
                  onSelectThread={async (threadId) => {
                    selectAgentThread(threadId);
                    await loadAgentThread(threadId);
                  }}
                />
              </div>
              <div className={`chat-view-container ${!selectedThreadId && !draftThread ? "mobile-hide-chat" : ""}`}>
                <AgentChatsView
                  thread={selectedThread}
                  draft={draftThread}
                  run={selectedThreadRun}
                  events={agentThreadEvents}
                  eventsTruncated={agentThreadEventsTruncated}
                  detailState={threadDetailState}
                  pendingMessages={pendingThreadMessages}
                  providers={providerInstances}
                  selection={composerSelection}
                  onSelectionChange={selectComposerModel}
                  harnessLocked={Boolean(selectedThread && !draftThread)}
                  onSendMessage={sendAgentThreadMessage}
                  onBack={() => {
                    selectAgentThread("");
                    navigateToView("runs", null);
                  }}
                  onRetry={() => {
                    if (selectedThreadId) void loadAgentThread(selectedThreadId);
                  }}
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
              </div>
            </>
          ) : null}

          {view === "agents" ? (
            <AgentsView
              agents={agents}
              skills={skills}
              tasks={tasks}
              providers={providerInstances}
              editing={editingAgent}
              onSelectAgent={setEditingAgent}
              onSaved={reloadAgents}
            />
          ) : null}

          {view === "schedules" ? (
            <SchedulesView
              schedules={filteredSchedules}
              threads={agentThreads}
              agents={agents}
              skills={skills}
              tasks={tasks}
              composerOpen={scheduleComposerOpen}
              onComposerOpenChange={setScheduleComposerOpen}
              composerDate={scheduleComposerDate}
              onComposerDateChange={setScheduleComposerDate}
              editingSchedule={scheduleToEdit}
              onEditingScheduleChange={setScheduleToEdit}
              onSaved={reloadSchedules}
              onOpenThread={async (threadId) => {
                selectAgentThread(threadId);
                await loadAgentThread(threadId);
              }}
            />
          ) : null}

          {view === "skills" ? (
            <SkillsView
              skills={filteredSkills}
              root={skillsRoot}
              errors={skillCatalogErrors}
              editing={editingSkill}
              onSelectSkill={setEditingSkill}
              onSaved={reloadSkills}
            />
          ) : null}

          {isSettingsView(view) ? (
            <SettingsView
              activeTab={
                view === "api"
                  ? "api"
                  : view === "credentials"
                  ? "credentials"
                  : view === "projects"
                  ? "projects"
                  : view === "connectors"
                  ? "connectors"
                  : view === "cursor"
                  ? "cursor"
                  : view === "opencode"
                  ? "opencode"
                  : "codex"
              }
              onTabChange={(tab) => navigateToView(tab)}
              userRole={user.role}
              apiKeys={apiKeys}
              onSavedApiKeys={reloadApiKeys}
              credentials={credentials}
              onSavedCredentials={reloadCredentials}
              projects={projects}
              onSavedProjects={reloadProjects}
              repos={repos}
              connection={githubConnection}
              hostname={githubHostname}
              onConnectGithub={async (token) => {
                await api("/api/github/connect", { method: "POST", body: JSON.stringify({ token }) });
                await reloadGithub();
              }}
              onRefreshGithub={async () => {
                await api("/api/github/sync", { method: "POST" });
                await reloadGithub();
              }}
              onDisconnectGithub={async () => {
                await api("/api/github/connection", { method: "DELETE" });
                await reloadGithub();
              }}
              onImportGithub={async (repoId) => {
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

function ActivityView(props: {
  reports: ActivityReport[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!props.hasMore || props.loadingMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          props.onLoadMore();
        }
      },
      { rootMargin: "250px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.hasMore, props.loadingMore, props.onLoadMore]);

  return (
    <div className="resource-feed-view">
      <div className="resource-feed-intro">
        <div>
          <h2>Activity</h2>
          <p>Recent execution reports, summaries, and updates generated by agents.</p>
        </div>
      </div>

      <div className="resource-card-list">
        {props.reports.map((report) => (
          <article className="resource-card" key={report.id}>
            <div className="agent-report-author-bar">
              <div className="agent-report-author-info">
                <AgentAvatar
                  agentId={report.author_agent_id || "default"}
                  agentName={report.author_agent_name || "Agent"}
                  className="agent-report-avatar"
                />
                <div className="agent-report-author-text">
                  <div className="agent-report-author-name-row">
                    <strong>{report.author_agent_name || "Agent"}</strong>
                    {report.project_name ? <span className="agent-report-project">{report.project_name}</span> : null}
                    {report.agent_thread_id ? (
                      <button
                        type="button"
                        className="agent-report-thread-chip"
                        onClick={() => props.onOpenThread(report.agent_thread_id!)}
                      >
                        Thread #{report.thread_number ?? ""}
                        <ChevronRight size={10} />
                      </button>
                    ) : null}
                  </div>
                  <span className="agent-report-time">{formatDateTime(report.updated_at)}</span>
                </div>
              </div>

              <div className="agent-report-badges">
                <span className="task-key">REPORT-{report.number}</span>
                <TaskStatus status={report.status} />
              </div>
            </div>

            <div className="agent-report-content">
              <h3 className="agent-report-title">{report.title}</h3>
              {report.description && report.description !== report.title ? (
                <p className="agent-report-summary">{report.description}</p>
              ) : null}

              {report.markdown ? (
                <div className="agent-report-body">
                  <CollapsibleText text={cleanReportMarkdown(report.markdown, report.title)} />
                </div>
              ) : null}
            </div>

            <div className="agent-report-footer">
              <span className="agent-report-version">Revision v{report.current_revision}</span>
              {report.agent_thread_id ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="agent-report-open-btn"
                  onClick={() => props.onOpenThread(report.agent_thread_id!)}
                >
                  <span>View Thread</span>
                  <ChevronRight size={12} />
                </Button>
              ) : null}
            </div>
          </article>
        ))}
        {props.reports.length === 0 ? (
          <div className="resource-feed-empty">
            <Activity size={24} className="empty-icon" />
            <strong>No recent activity</strong>
            <p>Agent reports, execution logs, and summaries will appear here as tasks run.</p>
          </div>
        ) : null}

        {props.hasMore ? (
          <div className="resource-feed-footer" ref={sentinelRef}>
            <Button
              variant="secondary"
              size="sm"
              disabled={props.loadingMore}
              onClick={props.onLoadMore}
              className="gap-2 font-medium"
            >
              {props.loadingMore ? <DotMatrixLoader size={13} /> : <ArrowDown size={14} />}
              <span>{props.loadingMore ? "Loading more activity..." : "Load more activity"}</span>
            </Button>
          </div>
        ) : props.reports.length > 0 ? (
          <div className="resource-feed-end-indicator">
            <span>All activity loaded ({props.reports.length})</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function IncidentsView(props: {
  incidents: Incident[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!props.hasMore || props.loadingMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          props.onLoadMore();
        }
      },
      { rootMargin: "250px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.hasMore, props.loadingMore, props.onLoadMore]);

  return (
    <div className="resource-feed-view">
      <div className="resource-feed-intro">
        <div>
          <h2>Incidents</h2>
          <p>Operational alerts, blockers, and issues flagged during agent execution.</p>
        </div>
      </div>

      <div className="resource-card-list">
        {props.incidents.map((incident) => (
          <article className={`resource-card incident severity-${incident.severity}`} key={incident.id}>
            <div className="agent-report-author-bar">
              <div className="agent-report-author-info">
                <AgentAvatar
                  agentId={incident.created_by_agent_id || "default"}
                  agentName={incident.created_by_agent_name || "Agent"}
                  className="agent-report-avatar"
                />
                <div className="agent-report-author-text">
                  <div className="agent-report-author-name-row">
                    <strong>{incident.created_by_agent_name || "Reporter"}</strong>
                    {incident.commander_agent_name ? (
                      <span className="agent-report-commander">Lead: {incident.commander_agent_name}</span>
                    ) : null}
                    {incident.project_name ? <span className="agent-report-project">{incident.project_name}</span> : null}
                    {incident.agent_thread_id ? (
                      <button
                        type="button"
                        className="agent-report-thread-chip"
                        onClick={() => props.onOpenThread(incident.agent_thread_id!)}
                      >
                        Thread #{incident.thread_number ?? ""}
                        <ChevronRight size={10} />
                      </button>
                    ) : null}
                  </div>
                  <span className="agent-report-time">{formatDateTime(incident.updated_at)}</span>
                </div>
              </div>

              <div className="agent-report-badges">
                <span className="task-key">INC-{incident.number}</span>
                <Badge variant={incidentSeverityVariant(incident.severity)} className="text-[10.5px] uppercase tracking-wide font-medium">
                  {incident.severity}
                </Badge>
                <TaskStatus status={incident.status} />
              </div>
            </div>

            <div className="agent-report-content">
              <h3 className="agent-report-title">{incident.title}</h3>
              {incident.description && incident.description !== incident.title ? (
                <p className="agent-report-summary">{incident.description}</p>
              ) : null}

              {incident.markdown ? (
                <div className="agent-report-body">
                  <CollapsibleText text={cleanReportMarkdown(incident.markdown, incident.title)} />
                </div>
              ) : null}
            </div>

            <div className="agent-report-footer">
              <span className="agent-report-version">Incident status: {incident.status}</span>
              {incident.agent_thread_id ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="agent-report-open-btn"
                  onClick={() => props.onOpenThread(incident.agent_thread_id!)}
                >
                  <span>Investigation Thread</span>
                  <ChevronRight size={12} />
                </Button>
              ) : null}
            </div>
          </article>
        ))}
        {props.incidents.length === 0 ? (
          <div className="resource-feed-empty">
            <CheckCircle2 size={24} className="empty-icon" />
            <strong>No open incidents</strong>
            <p>All agent operations and background workflows are running normally.</p>
          </div>
        ) : null}

        {props.hasMore ? (
          <div className="resource-feed-footer" ref={sentinelRef}>
            <Button
              variant="secondary"
              size="sm"
              disabled={props.loadingMore}
              onClick={props.onLoadMore}
              className="gap-2 font-medium"
            >
              {props.loadingMore ? <DotMatrixLoader size={13} /> : <ArrowDown size={14} />}
              <span>{props.loadingMore ? "Loading more incidents..." : "Load more incidents"}</span>
            </Button>
          </div>
        ) : props.incidents.length > 0 ? (
          <div className="resource-feed-end-indicator">
            <span>All incidents loaded ({props.incidents.length})</span>
          </div>
        ) : null}
      </div>
    </div>
  );
};

function ResourceAgentIdentity(props: {
  agentId: string | null;
  agentName: string | null;
  fallback: string;
  prefix: string;
}) {
  const agentId = props.agentId?.trim() ?? "";
  const agentName = props.agentName?.trim() ?? "";
  const hasAvatar = Boolean(agentId && agentName);

  return (
    <span className="resource-card-agent">
      {hasAvatar ? (
        <AgentAvatar
          agentId={agentId}
          agentName={agentName}
          className="resource-card-agent-avatar"
        />
      ) : null}
      <span>{agentName ? `${props.prefix}${agentName}` : props.fallback}</span>
    </span>
  );
}

function ResourceThreadLink(props: {
  agentThreadId: string | null;
  threadNumber: number | null;
  onOpenThread: (threadId: string) => void;
}) {
  const label = props.threadNumber ? `THREAD-${props.threadNumber}` : "Thread";
  if (!props.agentThreadId) return props.threadNumber ? <span>{label}</span> : null;
  return (
    <button
      type="button"
      className="resource-thread-link"
      onClick={() => props.onOpenThread(props.agentThreadId!)}
    >
      {label}
      <ChevronRight size={11} />
    </button>
  );
}

function incidentSeverityVariant(severity: Incident["severity"]): "secondary" | "warning" | "destructive" {
  if (severity === "critical" || severity === "high") return "destructive";
  if (severity === "medium") return "warning";
  return "secondary";
}

function TasksView(props: {
  tasks: Task[];
  onSelect: (task: Task) => void;
}) {
  return (
    <div className="board-layout">
      <div className="board-main">
        <div className="board-columns">
          {BOARD_COLUMNS.map((column) => {
            const tasks = props.tasks.filter((task) => taskBucket(task) === column.id);
            return (
              <div className={`kanban-col col-${column.id}`} key={column.id}>
                <div className="kanban-head">
                  <span className="kanban-head-title">
                    {column.id === "running" ? (
                      <AgentOrb variant="working" size={12} color="var(--primary)" />
                    ) : (
                      column.icon
                    )}
                    <span>{column.title}</span>
                  </span>
                  <span className="count-badge">{tasks.length}</span>
                </div>
                <div className="kanban-cards">
                  {tasks.map((task) => {
                    const status = task.latest_run_status ?? task.status;
                    const isBlocked = status === "blocked";
                    const isRunning = isActiveRun(status);
                    return (
                      <button
                        className={`kanban-card ${isBlocked ? "is-blocked" : ""} ${isRunning ? "is-running" : ""}`}
                        key={task.id}
                        onClick={() => props.onSelect(task)}
                      >
                        <div className="card-top">
                          <span className="task-key">TASK-{task.number}</span>
                          <TaskStatus status={status} />
                        </div>
                        <div className="card-title">{task.title}</div>
                        {task.work_key ? (
                          <div className="task-work-identity" title={`${task.work_scope ?? "task"}/${task.work_key}`}>
                            <KeyRound size={11} />
                            <span>{task.work_scope ? `${task.work_scope}/` : ""}{task.work_key}</span>
                          </div>
                        ) : null}
                        {((task.assignment_count ?? 0) > 0 || task.parent_task_number || (task.safety_event_count ?? 0) > 0) ? (
                          <div className="task-orchestration-summary">
                            {task.parent_task_number ? <span>Parent TASK-{task.parent_task_number}</span> : null}
                            {(task.assignment_count ?? 0) > 0 ? (
                              <span>{task.active_assignment_count ?? 0}/{task.assignment_count} assignments active</span>
                            ) : null}
                            {(task.safety_event_count ?? 0) > 0 ? (
                              <span>{task.safety_event_count} reuse/conflict event{task.safety_event_count === 1 ? "" : "s"}</span>
                            ) : null}
                            {task.latest_safety_event?.operation ? (
                              <span title={task.latest_safety_event.work_key ?? undefined}>Latest: {task.latest_safety_event.operation}</span>
                            ) : null}
                          </div>
                        ) : null}
                        {task.assignments && task.assignments.length > 0 ? (
                          <div className="task-assignment-strip" aria-label="Task assignments">
                            {task.assignments.slice(0, 3).map((assignment) => (
                              <span className={`task-assignment-pill ${runBucket(assignment.status)}`} key={assignment.id}>
                                {assignment.assignment_key} · {statusLabel(assignment.status)} · {assignment.attempt_count}×
                              </span>
                            ))}
                            {task.assignments.length > 3 ? <span className="task-assignment-more">+{task.assignments.length - 3}</span> : null}
                          </div>
                        ) : null}
                        {task.body && task.body !== task.title ? (
                          <div className="card-body-preview">{task.body}</div>
                        ) : null}
                        <div className="card-footer">
                          <div className="card-agent-author">
                            <AgentAvatar
                              agentId={task.agent_id || "default"}
                              agentName={task.agent_name || "Agent"}
                              className="card-agent-avatar"
                              motion={isRunning ? "always" : "hover"}
                              orbVariant={isRunning ? "working" : undefined}
                            />
                            <span className="card-agent-name">{task.agent_name || "Agent"}</span>
                          </div>
                          {task.project_name ? (
                            <span className="card-project-tag" title={task.project_name}>
                              <FolderGit2 size={11} className="shrink-0" />
                              <span className="truncate">{task.project_name}</span>
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                  {tasks.length === 0 ? (
                    <div className="kanban-column-empty">
                      <span>No {column.title.toLowerCase()}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TaskComposer(props: {
  projects: Project[];
  agents: Agent[];
  onCancel?: () => void;
  onCreate: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const [projectId, setProjectId] = useState("");
  const [agentId, setAgentId] = useState("auto");
  const [submitting, setSubmitting] = useState(false);
  const workerAgents = props.agents.filter((agent) => agent.kind !== "dispatcher");

  async function handleSubmit() {
    const trimmed = prompt.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      const lines = trimmed.split("\n");
      const title = lines[0]?.trim() || trimmed;
      const body = lines.slice(1).join("\n").trim();

      await props.onCreate({
        title,
        body,
        ...(projectId ? { projectId } : {}),
        ...(agentId === "auto" ? {} : { agentId })
      });
      setPrompt("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="task-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <div className="task-composer-surface">
        <Textarea
          autoFocus
          value={prompt}
          disabled={submitting}
          rows={3}
          placeholder="Assign a task or prompt to an agent… (e.g. Audit codebase, implement auth, refactor UI)"
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !event.shiftKey)) {
              if (event.shiftKey) return;
              event.preventDefault();
              void handleSubmit();
            }
          }}
        />
        <div className="task-composer-footer">
          <div className="task-composer-controls">
            <div className="task-control-item">
              {agentId !== "auto" ? (
                <AgentAvatar
                  agentId={agentId}
                  agentName={workerAgents.find((a) => a.id === agentId)?.name || "Agent"}
                  className="w-4 h-4 rounded-full"
                  motion="hover"
                />
              ) : (
                <Bot size={13} className="control-icon" />
              )}
              <NativeSelect
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
                disabled={submitting}
                className="task-control-select"
                aria-label="Select agent"
              >
                <option value="auto">Auto-route agent</option>
                {workerAgents.map((agent) => (
                  <option value={agent.id} key={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div className="task-control-item">
              <FolderGit2 size={13} className="control-icon" />
              <NativeSelect
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                disabled={submitting}
                className="task-control-select"
                aria-label="Select project"
              >
                <option value="">No project</option>
                {props.projects.map((project) => (
                  <option value={project.id} key={project.id}>
                    {project.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          <div className="task-composer-actions">
            {props.onCancel ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={props.onCancel}
                disabled={submitting}
              >
                Cancel
              </Button>
            ) : null}
            <span className="composer-hint">↵ to create</span>
            <Button
              type="submit"
              size="sm"
              disabled={!prompt.trim() || submitting}
              className="task-composer-submit"
            >
              {submitting ? <Loader2 className="spin" size={13} /> : <Plus size={13} />}
              <span>Create task</span>
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

function getCalendarMonthDays(year: number, month: number): Array<{ date: Date; isCurrentMonth: boolean; key: string }> {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startDayOfWeek = firstDay.getDay();
  const daysInMonth = lastDay.getDate();
  const result: Array<{ date: Date; isCurrentMonth: boolean; key: string }> = [];

  const prevMonthLastDay = new Date(year, month, 0).getDate();
  for (let i = startDayOfWeek - 1; i >= 0; i--) {
    const day = prevMonthLastDay - i;
    const d = new Date(year, month - 1, day);
    result.push({
      date: d,
      isCurrentMonth: false,
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    });
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month, day);
    result.push({
      date: d,
      isCurrentMonth: true,
      key: `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    });
  }

  const totalNeeded = result.length <= 35 ? 35 : 42;
  const daysToAdd = totalNeeded - result.length;
  for (let day = 1; day <= daysToAdd; day++) {
    const d = new Date(year, month + 1, day);
    result.push({
      date: d,
      isCurrentMonth: false,
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    });
  }

  return result;
}

function toDateKey(date: Date | string | null | undefined): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ModalBackdrop(props: {
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        props.onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = originalOverflow;
    };
  }, [props.onClose]);

  return (
    <div
      className={cn("calendar-modal-backdrop", props.className)}
      onClick={props.onClose}
    >
      {props.children}
    </div>
  );
}

function ScheduleComposer(props: {
  agents: Agent[];
  skills: Skill[];
  tasks: Task[];
  initialDate?: Date | null;
  scheduleToEdit?: Schedule | null;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const enabledAgents = props.agents.filter((agent) => agent.enabled);
  const [title, setTitle] = useState(props.scheduleToEdit?.title ?? "");
  const [prompt, setPrompt] = useState(props.scheduleToEdit?.prompt ?? "");
  const [agentId, setAgentId] = useState(
    props.scheduleToEdit?.agent_id ?? enabledAgents[0]?.id ?? ""
  );
  const [scheduleKind, setScheduleKind] = useState<"once" | "interval">(
    props.scheduleToEdit?.schedule_kind ?? "once"
  );
  const [nextRunAt, setNextRunAt] = useState(() => {
    if (props.scheduleToEdit?.next_run_at) {
      return localDateTimeInput(new Date(props.scheduleToEdit.next_run_at));
    }
    if (props.initialDate) {
      const d = new Date(props.initialDate);
      const now = new Date();
      d.setHours(now.getHours(), now.getMinutes() + 5, 0, 0);
      return localDateTimeInput(d);
    }
    return defaultScheduleDateTime();
  });
  const [intervalValue, setIntervalValue] = useState(() => {
    if (props.scheduleToEdit?.interval_seconds) {
      const s = props.scheduleToEdit.interval_seconds;
      if (s % 86400 === 0) return s / 86400;
      if (s % 3600 === 0) return s / 3600;
      return Math.max(1, Math.round(s / 60));
    }
    return 1;
  });
  const [intervalUnit, setIntervalUnit] = useState<"minutes" | "hours" | "days">(() => {
    if (props.scheduleToEdit?.interval_seconds) {
      const s = props.scheduleToEdit.interval_seconds;
      if (s % 86400 === 0) return "days";
      if (s % 3600 === 0) return "hours";
      return "minutes";
    }
    return "hours";
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabledAgents.some((agent) => agent.id === agentId)) {
      setAgentId(enabledAgents[0]?.id ?? "");
    }
  }, [props.agents, agentId]);

  return (
    <form
      className="schedule-composer-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!agentId || !title.trim() || !prompt.trim()) return;
        setBusy(true);
        setError(null);
        const unitSeconds = intervalUnit === "minutes" ? 60 : intervalUnit === "hours" ? 3600 : 86_400;
        try {
          if (props.scheduleToEdit) {
            await api(`/api/schedules/${props.scheduleToEdit.id}`, {
              method: "PATCH",
              body: JSON.stringify({
                title,
                prompt,
                agentId,
                scheduleKind,
                nextRunAt: new Date(nextRunAt).toISOString(),
                intervalSeconds: scheduleKind === "interval" ? intervalValue * unitSeconds : null
              })
            });
          } else {
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
          }
          await props.onSaved();
        } catch (saveError) {
          setError(friendlyError(saveError instanceof Error ? saveError.message : "Could not save schedule."));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="schedule-composer-header">
        <div className="flex items-center gap-2">
          <Calendar size={16} className="text-primary" />
          <span className="font-semibold text-[13.5px] text-foreground">
            {props.scheduleToEdit ? "Edit schedule" : "Schedule an agent"}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          aria-label="Close dialog"
          onClick={props.onCancel}
          disabled={busy}
        >
          <X size={15} />
        </Button>
      </div>

      <div className="schedule-composer-body">
        <label className="schedule-composer-field">
          <span>Title</span>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Daily operational brief, Nightly integration tests"
            required
          />
        </label>

        <div className="schedule-composer-row-2">
          <label className="schedule-composer-field">
            <span>Agent</span>
            <NativeSelect
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              required
            >
              {enabledAgents.map((agent) => (
                <option value={agent.id} key={agent.id}>
                  {agent.name}
                </option>
              ))}
            </NativeSelect>
          </label>

          <label className="schedule-composer-field">
            <span>Frequency</span>
            <NativeSelect
              value={scheduleKind}
              onChange={(e) => setScheduleKind(e.target.value as "once" | "interval")}
            >
              <option value="once">One time</option>
              <option value="interval">Repeating interval</option>
            </NativeSelect>
          </label>
        </div>

        <div className="schedule-composer-field">
          <label className="schedule-composer-field">
            <span>{scheduleKind === "once" ? "Run at" : "First run"}</span>
            <Input
              type="datetime-local"
              value={nextRunAt}
              onChange={(e) => setNextRunAt(e.target.value)}
              required
              className="font-mono"
            />
          </label>

          {scheduleKind === "interval" ? (
            <label className="schedule-composer-field mt-1">
              <span>Repeat every</span>
              <div className="schedule-composer-interval-row">
                <Input
                  type="number"
                  min={1}
                  max={10_000}
                  value={intervalValue}
                  onChange={(e) => setIntervalValue(Math.max(1, Number(e.target.value)))}
                  required
                  style={{ width: "90px" }}
                  className="font-mono"
                />
                <NativeSelect
                  value={intervalUnit}
                  onChange={(e) => setIntervalUnit(e.target.value as typeof intervalUnit)}
                  className="flex-1"
                >
                  <option value="minutes">Minutes</option>
                  <option value="hours">Hours</option>
                  <option value="days">Days</option>
                </NativeSelect>
              </div>
            </label>
          ) : null}
        </div>

        <div className="schedule-composer-field">
          <span>Task instructions</span>
          <PromptComposer
            value={prompt}
            onChange={setPrompt}
            agents={props.agents}
            skills={props.skills}
            tasks={props.tasks}
            minHeight={120}
            ariaLabel="Scheduled prompt"
            placeholder="What should the agent do on schedule? Type / to attach skills or reference tasks."
            disabled={busy}
          />
        </div>

        {error ? <div className="notice error">{error}</div> : null}
      </div>

      <div className="schedule-composer-footer">
        <Button type="button" variant="ghost" size="sm" onClick={props.onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy || !agentId || !title.trim() || !prompt.trim()}>
          {busy ? <Loader2 className="spin" size={14} /> : <Calendar size={14} />}
          <span>{props.scheduleToEdit ? "Save changes" : "Schedule agent"}</span>
        </Button>
      </div>
    </form>
  );
}

function SchedulesView(props: {
  schedules: Schedule[];
  threads: AgentThread[];
  agents: Agent[];
  skills: Skill[];
  tasks: Task[];
  composerOpen: boolean;
  onComposerOpenChange: (open: boolean) => void;
  composerDate: Date | null;
  onComposerDateChange: (date: Date | null) => void;
  editingSchedule: Schedule | null;
  onEditingScheduleChange: (schedule: Schedule | null) => void;
  onSaved: () => Promise<void>;
  onOpenThread: (threadId: string) => Promise<void>;
}) {
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [viewMode, setViewMode] = useState<"calendar" | "agenda">("calendar");
  const [selectedEventDetails, setSelectedEventDetails] = useState<{
    type: "schedule" | "thread";
    schedule?: Schedule;
    thread?: AgentThread;
  } | null>(null);
  const [calendarOverflow, setCalendarOverflow] = useState<{
    date: Date;
    schedules: Schedule[];
    threads: AgentThread[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const calendarDays = useMemo(() => getCalendarMonthDays(year, month), [year, month]);

  const monthLabel = useMemo(() => {
    return currentDate.toLocaleString("default", { month: "long", year: "numeric" });
  }, [currentDate]);

  const scheduledByDay = useMemo(() => {
    const map = new Map<string, Schedule[]>();
    for (const schedule of props.schedules) {
      if (!schedule.enabled && !schedule.next_run_at) continue;
      const key = toDateKey(schedule.next_run_at);
      if (key) {
        const existing = map.get(key) ?? [];
        existing.push(schedule);
        map.set(key, existing);
      }
    }
    return map;
  }, [props.schedules]);

  const threadsByDay = useMemo(() => {
    const map = new Map<string, AgentThread[]>();
    for (const thread of props.threads) {
      const key = toDateKey(thread.last_activity_at);
      if (key) {
        const existing = map.get(key) ?? [];
        existing.push(thread);
        map.set(key, existing);
      }
    }
    return map;
  }, [props.threads]);

  const todayKey = useMemo(() => toDateKey(new Date()), []);

  function handlePrevMonth() {
    setCurrentDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
  }

  function handleNextMonth() {
    setCurrentDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1));
  }

  function handleToday() {
    setCurrentDate(new Date());
  }

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

  async function deleteSchedule(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/schedules/${id}`, { method: "DELETE" });
      setDeleteArmed(null);
      setSelectedEventDetails(null);
      await props.onSaved();
    } catch (deleteErr) {
      setError(friendlyError(deleteErr instanceof Error ? deleteErr.message : "Could not delete schedule."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="schedules-calendar-view">
      <div className="calendar-toolbar">
        <div className="calendar-nav-group">
          <Button variant="outline" size="sm" onClick={handleToday} className="h-8 px-3 text-[12px] font-medium">
            Today
          </Button>
          <div className="calendar-chevron-buttons">
            <Button variant="ghost" size="icon" onClick={handlePrevMonth} className="h-8 w-8" aria-label="Previous month">
              <ChevronLeft size={16} />
            </Button>
            <Button variant="ghost" size="icon" onClick={handleNextMonth} className="h-8 w-8" aria-label="Next month">
              <ChevronRight size={16} />
            </Button>
          </div>
          <h2 className="calendar-month-title">{monthLabel}</h2>
        </div>

        <div className="calendar-toolbar-right">
          <div className="calendar-legend-pills">
            <span className="legend-pill scheduled">
              <span className="legend-dot" />
              <span>Scheduled</span>
              <span className="legend-count">{props.schedules.length}</span>
            </span>
            <span className="legend-pill activity">
              <span className="legend-dot" />
              <span>Activity</span>
              <span className="legend-count">{props.threads.length}</span>
            </span>
          </div>

          <div className="calendar-view-toggle">
            <button
              type="button"
              className={`toggle-btn ${viewMode === "calendar" ? "active" : ""}`}
              onClick={() => setViewMode("calendar")}
            >
              <Calendar size={13} />
              <span>Month</span>
            </button>
            <button
              type="button"
              className={`toggle-btn ${viewMode === "agenda" ? "active" : ""}`}
              onClick={() => setViewMode("agenda")}
            >
              <ListIcon size={13} />
              <span>Agenda</span>
            </button>
          </div>
        </div>
      </div>

      {viewMode === "calendar" ? (
        <div className="calendar-grid-container">
          <div className="calendar-weekdays-row">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
              <div className="calendar-weekday-header" key={day}>
                {day}
              </div>
            ))}
          </div>

          <div className="calendar-month-grid">
            {calendarDays.map(({ date, isCurrentMonth, key }) => {
              const daySchedules = scheduledByDay.get(key) ?? [];
              const dayThreads = threadsByDay.get(key) ?? [];
              const isToday = key === todayKey;
              const allEventsCount = daySchedules.length + dayThreads.length;
              const maxDisplay = 3;

              return (
                <div
                  className={`calendar-day-cell ${!isCurrentMonth ? "other-month" : ""} ${isToday ? "today" : ""}`}
                  key={key}
                >
                  <div className="day-cell-top">
                    <span className={`day-number ${isToday ? "today-badge" : ""}`}>
                      {date.getDate()}
                    </span>
                    <button
                      type="button"
                      className="day-add-button"
                      title={`Schedule run for ${date.toLocaleDateString()}`}
                      onClick={() => {
                        props.onEditingScheduleChange(null);
                        props.onComposerDateChange(date);
                        props.onComposerOpenChange(true);
                      }}
                    >
                      <Plus size={12} />
                    </button>
                  </div>

                  <div className="day-events-list">
                    {daySchedules.slice(0, maxDisplay).map((schedule) => (
                      <button
                        type="button"
                        className={`calendar-event-chip scheduled ${!schedule.enabled ? "paused" : ""}`}
                        key={schedule.id}
                        onClick={() => setSelectedEventDetails({ type: "schedule", schedule })}
                        title={`${schedule.title} (${schedule.agent_name})`}
                      >
                        <AgentAvatar
                          agentId={schedule.agent_id}
                          agentName={schedule.agent_name}
                          className="chip-avatar"
                        />
                        <span className="chip-time">{formatTimestamp(schedule.next_run_at)}</span>
                        <span className="chip-title">{schedule.title}</span>
                      </button>
                    ))}

                    {dayThreads.slice(0, Math.max(0, maxDisplay - daySchedules.length)).map((thread) => (
                      <button
                        type="button"
                        className={`calendar-event-chip ran status-${thread.latest_status ?? "running"}`}
                        key={thread.id}
                        onClick={() => void props.onOpenThread(thread.id)}
                        title={`Ran thread: ${thread.title || "Agent task"} (${thread.latest_status ?? "active"})`}
                      >
                        <AgentAvatar
                          agentId={thread.agent_id || "default"}
                          agentName={thread.agent_name || "Agent"}
                          className="chip-avatar"
                        />
                        <span className="chip-time">{formatTimestamp(thread.last_activity_at)}</span>
                        <span className="chip-title">{thread.title || thread.agent_name || "Task"}</span>
                      </button>
                    ))}

                    {allEventsCount > maxDisplay ? (
                      <button
                        type="button"
                        className="calendar-more-events"
                        onClick={() => setCalendarOverflow({ date, schedules: daySchedules, threads: dayThreads })}
                      >
                        +{allEventsCount - maxDisplay} more
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="calendar-agenda-view">
          {props.schedules.length === 0 && props.threads.length === 0 ? (
            <div className="resource-feed-empty">
              <Calendar size={24} className="empty-icon" />
              <strong>No scheduled runs or thread activity</strong>
              <p>Create a schedule to automate agent workflows on a recurring cadence.</p>
            </div>
          ) : (
            <div className="agenda-list">
              {props.schedules.map((schedule) => (
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
                    <Badge variant={schedule.enabled ? "success" : "secondary"}>
                      {schedule.enabled ? "Scheduled" : "Paused"}
                    </Badge>
                  </div>
                  <p className="schedule-prompt-preview">{schedule.prompt}</p>
                  <div className="schedule-card-meta">
                    <span>Next run: {formatDateTime(schedule.next_run_at)}</span>
                    <span>{schedule.run_count} run{schedule.run_count === 1 ? "" : "s"}</span>
                    {schedule.last_run_status ? <TaskStatus status={schedule.last_run_status} /> : null}
                  </div>
                  <div className="schedule-card-actions">
                    {schedule.last_agent_thread_id ? (
                      <Button type="button" variant="secondary" size="sm" onClick={() => void props.onOpenThread(schedule.last_agent_thread_id!)}>
                        <Activity size={13} />
                        Open latest thread
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        props.onEditingScheduleChange(schedule);
                        props.onComposerDateChange(null);
                        props.onComposerOpenChange(true);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void updateSchedule(schedule.id, { enabled: !schedule.enabled })}
                    >
                      {schedule.enabled ? <Pause size={13} /> : <Play size={13} />}
                      {schedule.enabled ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Delete schedule"
                      onClick={() => deleteSchedule(schedule.id)}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      {props.composerOpen ? (
        <ModalBackdrop
          onClose={() => {
            props.onComposerOpenChange(false);
            props.onEditingScheduleChange(null);
          }}
        >
          <div className="calendar-modal-content" onClick={(e) => e.stopPropagation()}>
            <ScheduleComposer
              agents={props.agents}
              skills={props.skills}
              tasks={props.tasks}
              initialDate={props.composerDate}
              scheduleToEdit={props.editingSchedule}
              onSaved={async () => {
                await props.onSaved();
                props.onComposerOpenChange(false);
                props.onEditingScheduleChange(null);
              }}
              onCancel={() => {
                props.onComposerOpenChange(false);
                props.onEditingScheduleChange(null);
              }}
            />
          </div>
        </ModalBackdrop>
      ) : null}

      {calendarOverflow ? (
        <ModalBackdrop onClose={() => setCalendarOverflow(null)}>
          <div className="calendar-modal-content max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="day-overview-dialog">
              <div className="day-overview-header">
                <div className="day-overview-header-copy">
                  <span className="day-overview-subtitle">
                    Day Overview
                  </span>
                  <h3 className="day-overview-title">
                    {calendarOverflow.date.toLocaleDateString(undefined, {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                      year: "numeric"
                    })}
                  </h3>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  aria-label="Close calendar day"
                  onClick={() => setCalendarOverflow(null)}
                >
                  <X size={15} />
                </Button>
              </div>

              <div className="day-overview-body">
                {calendarOverflow.schedules.length > 0 ? (
                  <div className="calendar-modal-section">
                    <div className="calendar-modal-section-title">
                      Scheduled Runs ({calendarOverflow.schedules.length})
                    </div>
                    <div className="calendar-modal-items-list">
                      {calendarOverflow.schedules.map((schedule) => (
                        <div
                          className="calendar-modal-card scheduled"
                          key={`schedule-${schedule.id}`}
                          onClick={() => {
                            setCalendarOverflow(null);
                            setSelectedEventDetails({ type: "schedule", schedule });
                          }}
                        >
                          <AgentAvatar agentId={schedule.agent_id} agentName={schedule.agent_name} className="w-6 h-6 flex-shrink-0" />
                          <div className="calendar-modal-card-text">
                            <div className="calendar-modal-card-top">
                              <strong>{schedule.title}</strong>
                              <Badge variant={schedule.enabled ? "success" : "secondary"} className="text-[10px] py-0 px-1.5 font-medium">
                                {schedule.enabled ? "Scheduled" : "Paused"}
                              </Badge>
                            </div>
                            <div className="calendar-modal-card-sub">
                              <span>{schedule.agent_name}</span>
                              <span>·</span>
                              <span>{formatDateTime(schedule.next_run_at)}</span>
                              <span>·</span>
                              <span>{formatScheduleCadence(schedule)}</span>
                            </div>
                          </div>
                          <ChevronRight size={14} className="text-muted-foreground flex-shrink-0" />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {calendarOverflow.threads.length > 0 ? (
                  <div className="calendar-modal-section">
                    <div className="calendar-modal-section-title">
                      Executed Tasks & Activity ({calendarOverflow.threads.length})
                    </div>
                    <div className="calendar-modal-items-list">
                      {calendarOverflow.threads.map((thread) => (
                        <div
                          className="calendar-modal-card ran"
                          key={`thread-${thread.id}`}
                          onClick={() => {
                            setCalendarOverflow(null);
                            void props.onOpenThread(thread.id);
                          }}
                        >
                          <AgentAvatar
                            agentId={thread.agent_id || "default"}
                            agentName={thread.agent_name || "Agent"}
                            className="w-6 h-6 flex-shrink-0"
                          />
                          <div className="calendar-modal-card-text">
                            <div className="calendar-modal-card-top">
                              <strong>{thread.title || thread.agent_name || "Agent Task"}</strong>
                              <TaskStatus status={thread.latest_status ?? "running"} />
                            </div>
                            <div className="calendar-modal-card-sub">
                              <span>{thread.agent_name || "Agent"}</span>
                              <span>·</span>
                              <span>{formatDateTime(thread.last_activity_at)}</span>
                            </div>
                          </div>
                          <ChevronRight size={14} className="text-muted-foreground flex-shrink-0" />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {calendarOverflow.schedules.length === 0 && calendarOverflow.threads.length === 0 ? (
                  <div className="day-overview-empty">
                    No events or activity on this day.
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </ModalBackdrop>
      ) : null}

      {selectedEventDetails && selectedEventDetails.schedule ? (
        <ModalBackdrop onClose={() => setSelectedEventDetails(null)}>
          <div className="calendar-modal-content max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="event-details-dialog">
              <div className="event-details-header">
                <div className="event-details-header-copy">
                  <span className="event-details-subtitle">
                    Scheduled Agent Run
                  </span>
                  <h3 className="event-details-title">
                    {selectedEventDetails.schedule.title}
                  </h3>
                </div>
                <div className="event-details-header-actions">
                  <Badge variant={selectedEventDetails.schedule.enabled ? "success" : "secondary"} className="text-[10.5px] font-medium">
                    {selectedEventDetails.schedule.enabled ? "Scheduled" : "Paused"}
                  </Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    aria-label="Close details"
                    onClick={() => setSelectedEventDetails(null)}
                  >
                    <X size={15} />
                  </Button>
                </div>
              </div>

              <div className="event-details-info-box">
                <div className="event-details-info-row">
                  <span className="event-details-info-label">Agent</span>
                  <span className="event-details-info-value">
                    <AgentAvatar agentId={selectedEventDetails.schedule.agent_id} agentName={selectedEventDetails.schedule.agent_name} className="w-4 h-4" />
                    <span>{selectedEventDetails.schedule.agent_name}</span>
                  </span>
                </div>
                <div className="event-details-info-row">
                  <span className="event-details-info-label">Next run</span>
                  <span className="event-details-info-value font-mono">{formatDateTime(selectedEventDetails.schedule.next_run_at)}</span>
                </div>
                <div className="event-details-info-row">
                  <span className="event-details-info-label">Cadence</span>
                  <span className="event-details-info-value">{formatScheduleCadence(selectedEventDetails.schedule)}</span>
                </div>
                <div className="event-details-info-row">
                  <span className="event-details-info-label">Total runs</span>
                  <span className="event-details-info-value font-mono">{selectedEventDetails.schedule.run_count}</span>
                </div>
              </div>

              <div className="event-details-prompt-box">
                {selectedEventDetails.schedule.prompt}
              </div>

              <div className="event-details-actions">
                <div className="event-details-actions-left">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const s = selectedEventDetails.schedule!;
                      setSelectedEventDetails(null);
                      props.onEditingScheduleChange(s);
                      props.onComposerDateChange(null);
                      props.onComposerOpenChange(true);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      const s = selectedEventDetails.schedule!;
                      await updateSchedule(s.id, { enabled: !s.enabled });
                      setSelectedEventDetails(null);
                    }}
                  >
                    {selectedEventDetails.schedule.enabled ? "Pause" : "Resume"}
                  </Button>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => deleteSchedule(selectedEventDetails.schedule!.id)}
                >
                  <Trash2 size={13} />
                  <span>Delete</span>
                </Button>
              </div>
            </div>
          </div>
        </ModalBackdrop>
      ) : null}
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
    <aside className="agent-thread-sidebar" aria-label="Agent threads">
      <div className="agent-thread-sidebar-header">
        <div>
          <h2>Threads</h2>
          <p>Agent conversations</p>
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

function MobileThreadListView(props: {
  threads: AgentThread[];
  query: string;
  hasMore: boolean;
  loadingMore: boolean;
  onQueryChange: (query: string) => void;
  onLoadMore: () => void;
  onCreateThread: () => void;
  onSelectThread: (threadId: string) => void;
}) {
  return (
    <div className="mobile-thread-list-view">
      <div className="mobile-thread-list-header">
        <div className="mobile-thread-list-title-row">
          <div>
            <h2>Threads</h2>
            <p>Agent conversations & tasks</p>
          </div>
          <Button
            size="sm"
            className="gap-1.5 font-medium"
            onClick={props.onCreateThread}
          >
            <Plus size={14} />
            <span>New thread</span>
          </Button>
        </div>
        <div className="mobile-thread-search-box">
          <Search size={14} className="text-muted-foreground" />
          <Input
            value={props.query}
            onChange={(e) => props.onQueryChange(e.target.value)}
            placeholder="Search threads…"
            aria-label="Search threads"
          />
        </div>
      </div>

      <div className="mobile-thread-list-scroll">
        {props.threads.map((thread) => {
          const active = isActiveRun(thread.latest_status);
          return (
            <button
              type="button"
              className="mobile-thread-item"
              key={thread.id}
              onClick={() => props.onSelectThread(thread.id)}
            >
              <AgentAvatar
                agentId={thread.agent_id || "default"}
                agentName={thread.agent_name || "Agent"}
                className="mobile-thread-item-avatar"
                motion={active ? "always" : "hover"}
                orbVariant={active ? "working" : undefined}
              />
              <div className="mobile-thread-item-copy">
                <div className="mobile-thread-item-top">
                  <strong className="mobile-thread-item-title truncate">{thread.title || "Untitled task"}</strong>
                  <span className="mobile-thread-item-time shrink-0">{formatSidebarRunTime(thread.last_activity_at)}</span>
                </div>
                <div className="mobile-thread-item-meta">
                  <span className="mobile-thread-item-agent truncate">{thread.agent_name || "Agent"}</span>
                  {thread.project_name ? (
                    <>
                      <span>·</span>
                      <span className="mobile-thread-item-project truncate">{thread.project_name}</span>
                    </>
                  ) : null}
                  {thread.latest_status ? <TaskStatus status={thread.latest_status} /> : null}
                </div>
              </div>
              {active ? (
                <DotMatrixLoader size={12} className="text-primary shrink-0" />
              ) : (
                <ChevronRight size={14} className="text-muted-foreground shrink-0" />
              )}
            </button>
          );
        })}

        {props.threads.length === 0 ? (
          <div className="resource-feed-empty">
            <ChatsIcon size={24} className="empty-icon" />
            <strong>{props.query ? "No matching threads" : "No threads yet"}</strong>
            <p>Start a new thread to run tasks and coordinate agent workflows.</p>
            <Button size="sm" onClick={props.onCreateThread} className="mt-2 gap-1.5">
              <Plus size={14} /> New thread
            </Button>
          </div>
        ) : null}

        {props.hasMore ? (
          <div className="mobile-thread-list-footer">
            <Button
              variant="ghost"
              size="sm"
              disabled={props.loadingMore}
              onClick={props.onLoadMore}
              className="gap-1.5"
            >
              {props.loadingMore ? <Loader2 className="spin" size={13} /> : <ChevronDown size={13} />}
              <span>Load older threads</span>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AgentChatsView(props: {
  thread: AgentThread | null;
  draft: boolean;
  run: AgentRunTimelineRun | null;
  events: RunEvent[];
  eventsTruncated: boolean;
  detailState: ThreadDetailState;
  pendingMessages: AgentRunChatMessage[];
  providers: ProviderInstance[];
  selection: ModelSelection | null;
  harnessLocked?: boolean;
  onSelectionChange: (selection: ModelSelection) => Promise<void>;
  onSendMessage: (message: string, selection: ModelSelection) => Promise<void>;
  onBack?: () => void;
  onRetry: () => void;
  onCancel: () => Promise<void>;
}) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  const previousThreadRef = useRef<string | null>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const active = isActiveRun(props.thread?.latest_status);
  const title = props.draft ? "New thread" : (props.thread?.title ?? "Agent thread");
  const agentName = props.thread?.agent_name ?? "Orchestrator";
  const projectName = props.thread?.project_name ?? null;
  const latestError = props.thread?.latest_error ? friendlyError(props.thread.latest_error) : null;
  const threadKey = props.thread?.id ?? (props.draft ? "draft" : "loading");
  const hasTimelineData = Boolean(props.run || props.events.length || props.pendingMessages.length);

  const [draftMessage, setDraftMessage] = useState("");

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
          {props.onBack ? (
            <Button
              variant="ghost"
              size="icon"
              className="agent-chat-mobile-back"
              onClick={props.onBack}
              title="Back to threads"
              aria-label="Back to threads"
            >
              <ChevronLeft size={16} />
            </Button>
          ) : null}
          <AgentAvatar
            agentId={props.thread?.agent_id || "default"}
            agentName={agentName || "Agent"}
            className="agent-chat-avatar"
            motion="always"
            orbVariant={active ? "working" : undefined}
          />
          <div className="agent-chat-title-group">
            <div className="agent-chat-breadcrumb">
              {projectName ? (
                <>
                  <span className="agent-chat-crumb-project">{projectName}</span>
                  <span className="agent-chat-crumb-divider">/</span>
                </>
              ) : null}
              <span className="agent-chat-crumb-agent">{agentName}</span>
            </div>
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
            <div className="hero-mark">
              <AgentOrb variant="thinking" size={20} color="var(--primary)" />
            </div>
            <h2>What should your agent build?</h2>
            <p>Start a durable thread to assign tasks, inspect code, or coordinate multi-agent workflows.</p>

            <div className="hero-prompt-grid">
              <button
                type="button"
                className="hero-prompt-card"
                onClick={() => setDraftMessage("Audit repository dependencies & check for security vulnerabilities")}
              >
                <strong>Audit repository security</strong>
                <span>Inspect dependencies, auth boundaries, and vulnerabilities</span>
              </button>
              <button
                type="button"
                className="hero-prompt-card"
                onClick={() => setDraftMessage("Write automated unit and integration tests with vitest")}
              >
                <strong>Generate automated test suite</strong>
                <span>Create unit and integration test coverage for core modules</span>
              </button>
              <button
                type="button"
                className="hero-prompt-card"
                onClick={() => setDraftMessage("Refactor UI components to a clean, minimal, accessible design")}
              >
                <strong>Refactor UI components</strong>
                <span>Modernize layouts to clean, minimal, accessible design</span>
              </button>
              <button
                type="button"
                className="hero-prompt-card"
                onClick={() => setDraftMessage("Analyze performance bottlenecks and optimize query speed")}
              >
                <strong>Analyze performance</strong>
                <span>Identify slow queries, redundant rerenders, and bundle size</span>
              </button>
            </div>
          </div>
        ) : props.detailState.status === "loading" && !hasTimelineData ? (
          <div className="agent-chat-detail-state" aria-busy="true">
            <DotMatrixLoader size={20} className="text-primary" />
            <span>Loading thread…</span>
          </div>
        ) : props.detailState.status === "error" && !hasTimelineData ? (
          <div className="agent-chat-detail-state agent-chat-detail-error" role="alert">
            <CircleAlert size={18} weight="fill" />
            <div>
              <strong>Could not load this thread</strong>
              <p>{props.detailState.error}</p>
              <Button variant="secondary" size="sm" onClick={props.onRetry}>
                <RefreshCw size={13} /> Retry
              </Button>
            </div>
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
            {props.eventsTruncated ? (
              <div className="text-muted" style={{ padding: "12px 18px", textAlign: "center", fontSize: 12 }}>
                Showing the latest 2,000 events to keep this thread responsive.
              </div>
            ) : null}
            <CodexSessionTimeline
              run={props.run}
              events={props.events}
              pendingMessages={props.pendingMessages}
            />
            {props.detailState.status === "error" ? (
              <div className="agent-run-failure" role="alert">
                <span className="agent-run-failure-icon"><CircleAlert size={15} weight="fill" /></span>
                <span>
                  <strong>Thread details could not be refreshed</strong>
                  <small>{props.detailState.error}</small>
                  <Button variant="ghost" size="sm" onClick={props.onRetry}>Retry</Button>
                </span>
              </div>
            ) : null}
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
            harnessLocked={props.harnessLocked}
            message={draftMessage}
            onMessageChange={setDraftMessage}
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
  harnessLocked?: boolean;
  message?: string;
  onMessageChange?: (msg: string) => void;
  onSelectionChange: (selection: ModelSelection) => Promise<void>;
  onSend: (message: string, selection: ModelSelection) => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const [internalMessage, setInternalMessage] = useState("");
  const message = props.message !== undefined ? props.message : internalMessage;
  const setMessage = props.onMessageChange ?? setInternalMessage;
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
          placeholder={props.active ? "Send guidance to the active turn…" : "Ask the agent to build, inspect, or change something"}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            void submit();
          }}
        />
        <div className="agent-composer-footer">
          <div className="agent-composer-controls">
            <Select
              value={provider?.id}
              disabled={!provider || props.harnessLocked}
              onValueChange={(providerId) => {
                const nextProvider = props.providers.find((entry) => entry.id === providerId);
                if (!nextProvider) return;
                const nextModel =
                  nextProvider.models.find((entry) => entry.id === selection?.model) ??
                  nextProvider.models.find((entry) => entry.id === nextProvider.defaultModel) ??
                  nextProvider.models[0];
                if (!nextModel) return;
                void props.onSelectionChange(selectionForModel(nextProvider, nextModel, selection));
              }}
            >
              <SelectTrigger className="agent-harness-trigger" aria-label="Choose a harness" title={props.harnessLocked ? "Harness is locked for this thread" : "Choose a harness"}>
                <SelectValue placeholder="Harness" />
                {props.harnessLocked ? <LockKeyhole size={11} /> : null}
              </SelectTrigger>
              <SelectContent side="top" align="start">
                <SelectGroup>
                  <SelectLabel>Harness</SelectLabel>
                  {props.providers.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      <span className="agent-harness-option">
                        <HarnessMark driver={entry.driver} size={13} />
                        {entry.display_name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>

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
                  <span>{model?.label ?? selection?.model ?? "Choose model"}</span>
                  <ChevronDown size={11} />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="agent-model-popover"
                side="top"
                align="start"
                sideOffset={8}
                aria-label="Choose a model"
              >
                <Command>
                  <CommandInput
                    value={modelQuery}
                    placeholder="Search models…"
                    onValueChange={setModelQuery}
                  />
                  <CommandList>
                    <CommandEmpty>No matching models.</CommandEmpty>
                    <CommandGroup heading={provider?.display_name ?? "Models"}>
                      {(provider?.models ?? []).map((modelEntry) => {
                        const isSelected = modelEntry.id === selection?.model;
                        return (
                          <CommandItem
                            value={`${modelEntry.label} ${modelEntry.id} ${modelEntry.description}`}
                            className={isSelected ? "is-selected" : ""}
                            key={modelEntry.id}
                            onSelect={() => {
                              if (!provider) return;
                              void props.onSelectionChange(selectionForModel(provider, modelEntry, selection));
                              setPickerOpen(false);
                              setModelQuery("");
                            }}
                          >
                            <div className="model-row-copy">
                              <span className="model-row-label">{modelEntry.label}</span>
                              {modelEntry.description ? (
                                <span className="model-row-desc">{modelEntry.description}</span>
                              ) : null}
                            </div>
                            {isSelected ? <Check size={14} className="text-primary shrink-0 ml-2" /> : null}
                          </CommandItem>
                        );
                      })}
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
  providers: ProviderInstance[];
  editing: Agent | null;
  onSelectAgent: (agent: Agent | null) => void;
  onSaved: () => Promise<void>;
}) {
  const { editing, onSelectAgent: setEditing } = props;
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth <= 700) {
      if (editing?.id) {
        setEditing(props.agents.find((a) => a.id === editing.id) ?? null);
      }
      return;
    }
    setEditing(reconcileSelectedAgent(editing, props.agents));
  }, [props.agents]);

  return (
    <div className={`master-detail ${editing ? "has-selection" : ""}`}>
      <aside className="master-list">
        <div className="master-header">
          <h3>Agents</h3>
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
                <span className="list-item-desc">{agentSummary(agent, props.providers)}</span>
              </div>
              <ChevronRight size={14} className="mobile-chevron-indicator" />
            </button>
          ))}
        </div>
      </aside>
      <main className="detail-view">
        {editing ? (
          <div className="form-view">
            <div className="mobile-master-back-bar">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mobile-master-back-btn gap-1 text-muted-foreground hover:text-foreground"
                onClick={() => setEditing(null)}
              >
                <ChevronLeft size={14} />
                <span>Back to agents</span>
              </Button>
            </div>
            <AgentEditor
              agent={editing}
              agents={props.agents}
              skills={props.skills}
              tasks={props.tasks}
              providers={props.providers}
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
  providers: ProviderInstance[];
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
  const provider =
    props.providers.find((entry) => entry.id === draft.provider_instance_id) ?? props.providers[0];
  const selectedModel = provider?.models.find((model) => model.id === draft.model) ?? provider?.models.find((model) => model.id === provider.defaultModel);
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
            body: JSON.stringify({
              name: draft.name,
              description: draft.description,
              instructions: draft.instructions,
              enabled: draft.enabled,
              providerInstanceId: draft.provider_instance_id || provider?.id,
              model: selectedModel?.id ?? draft.model,
              modelOptions: resolvedModelOptions
            })
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
          motion="always"
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
          Harness
          <NativeSelect
            value={provider?.id ?? ""}
            onChange={(event) => {
              const nextProvider = props.providers.find((entry) => entry.id === event.target.value);
              const nextModel =
                nextProvider?.models.find((entry) => entry.id === draft.model) ??
                nextProvider?.models.find((entry) => entry.id === nextProvider.defaultModel) ??
                nextProvider?.models[0];
              setDraft({
                ...draft,
                provider_instance_id: event.target.value,
                model: nextModel?.id ?? draft.model,
                model_options: nextModel ? optionsForModel(nextModel) : []
              });
            }}
          >
            {props.providers.map((entry) => (
              <option value={entry.id} key={entry.id}>
                {entry.display_name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label>
          Model
          <NativeSelect
            value={selectedModel?.id ?? draft.model}
            onChange={(event) => {
              const model = provider?.models.find((entry) => entry.id === event.target.value);
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
            {(provider?.models ?? []).map((model) => (
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
        {(provider?.models ?? []).map((model) => (
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
            <h4>Enter one-time code</h4>
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
                : "Aisevak uses OpenAI’s device-code flow so authentication can finish in your browser while the runner stays on AWS."}
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

function CursorConnectionView() {
  const [status, setStatus] = useState({
    connected: false,
    activeMethod: null as "subscription" | "api_key" | null,
    installed: true,
    version: null as string | null,
    email: null as string | null,
    subscription: null as string | null,
    needsLogin: true,
    lastError: null as string | null
  });
  const [login, setLogin] = useState<{ loginId: string; verificationUrl: string | null; userCode: string | null; intervalSeconds: number; expiresAt: number } | null>(null);
  const [apiKey, setApiKey] = useState("");
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
        setError("The Cursor login request expired. Start a new login.");
        setLogin(null);
        return;
      }
      try {
        const result = await api<{ status: "pending" | "connected"; auth: typeof status }>(
          `/api/cursor-auth/login/${encodeURIComponent(login.loginId)}`
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
        setError(friendlyError(pollError instanceof Error ? pollError.message : "Cursor authorization failed."));
        setLogin(null);
      }
    };
    timer = window.setTimeout(poll, 2000);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [login?.loginId]);

  async function loadStatus() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api("/api/cursor-auth"));
    } catch (statusError) {
      setError(friendlyError(statusError instanceof Error ? statusError.message : "Could not read Cursor status."));
    } finally {
      setBusy(false);
    }
  }

  async function importHost() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api("/api/cursor-auth/import-host", { method: "POST" }));
    } catch (importError) {
      setError(
        friendlyError(
          importError instanceof Error
            ? importError.message
            : "Could not import portable Cursor CLI credentials from this host."
        )
      );
    } finally {
      setBusy(false);
    }
  }

  async function startLogin() {
    setBusy(true);
    setError(null);
    try {
      const started = await api<{ loginId: string; verificationUrl: string | null; userCode: string | null; intervalSeconds: number; expiresAt: number }>(
        "/api/cursor-auth/login",
        { method: "POST" }
      );
      setLogin(started);
      if (started.verificationUrl) window.open(started.verificationUrl, "_blank", "noopener,noreferrer");
    } catch (loginError) {
      setError(friendlyError(loginError instanceof Error ? loginError.message : "Could not start Cursor login."));
    } finally {
      setBusy(false);
    }
  }

  async function saveApiKey() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api("/api/cursor-auth/api-key", { method: "POST", body: JSON.stringify({ apiKey }) }));
      setApiKey("");
    } catch (saveError) {
      setError(friendlyError(saveError instanceof Error ? saveError.message : "Could not save Cursor API key."));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api("/api/cursor-auth", { method: "DELETE" }));
      setLogin(null);
    } catch (disconnectError) {
      setError(friendlyError(disconnectError instanceof Error ? disconnectError.message : "Could not disconnect Cursor."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flat-list-view api-view codex-connection-view">
      <div className="flat-header">
        <h3>Cursor</h3>
      </div>
      <section className="codex-connection-hero">
        <div className="codex-connection-heading">
          <div className="codex-connection-mark"><CursorLogo size={25} /></div>
          <div>
            <h4>Connect Cursor to Aisevak</h4>
            <p>Worker turns require a Cursor API key. Host subscription sign-in alone is not enough on a VM: macOS/keychain tokens cannot be copied into isolated worker homes.</p>
          </div>
        </div>
        <Badge variant={status.connected ? "success" : "warning"}>{status.connected ? "Connected" : "Login required"}</Badge>
      </section>
      <section className="codex-connection-grid">
        <div>
          <span>Active method</span>
          <strong>{status.activeMethod === "subscription" ? "Cursor subscription" : status.activeMethod === "api_key" ? "Cursor API key" : "None"}</strong>
        </div>
        <div>
          <span>Account</span>
          <strong>{status.email ?? "Not connected"}</strong>
        </div>
        <div>
          <span>CLI</span>
          <strong>{status.version ?? (status.installed ? "Installed" : "Missing")}</strong>
        </div>
      </section>
      {login ? (
        <section className="codex-login-panel">
          <div>
            <h4>Finish Cursor sign-in</h4>
            <p>Complete the browser login. Aisevak copies any portable CLI files from this host into encrypted secrets for isolated worker homes.</p>
          </div>
          {login.verificationUrl ? (
            <a href={login.verificationUrl} target="_blank" rel="noopener noreferrer" className="codex-auth-link">
              Open Cursor authorization <ArrowUp size={14} />
            </a>
          ) : (
            <span><Loader2 className="spin" size={13} /> Waiting for a login URL…</span>
          )}
        </section>
      ) : null}
      <section className="api-section codex-connection-actions">
        <div className="section-title-row">
          <div>
            <h4>{status.connected ? "Connection is ready" : "Connect Cursor"}</h4>
            <p>Save a CURSOR_API_KEY to enable worker turns. Host sign-in or credential import only helps if Cursor wrote portable CLI files; keychain-bound subscriptions never reach worker homes.</p>
          </div>
          <div className="row-actions">
            {status.connected ? (
              <>
                <Button variant="outline" disabled={busy} onClick={() => void loadStatus()}>
                  <RefreshCw className={busy ? "spin" : ""} size={14} /> Refresh
                </Button>
                <Button variant="destructive" disabled={busy} onClick={() => void disconnect()}>
                  Disconnect
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" disabled={busy || Boolean(login)} onClick={() => void importHost()}>
                  Import host credentials
                </Button>
                <Button disabled={busy || Boolean(login)} onClick={() => void startLogin()}>
                  {busy ? <Loader2 className="spin" size={14} /> : <CursorLogo size={14} />}
                  Sign in with Cursor
                </Button>
              </>
            )}
          </div>
        </div>
        {!status.connected ? (
          <form
            className="row-actions"
            onSubmit={(event) => {
              event.preventDefault();
              void saveApiKey();
            }}
          >
            <Input
              type="password"
              value={apiKey}
              placeholder="CURSOR_API_KEY"
              onChange={(event) => setApiKey(event.target.value)}
            />
            <Button type="submit" variant="outline" disabled={busy || !apiKey.trim()}>
              Save API key
            </Button>
          </form>
        ) : null}
        {error || status.lastError ? <div className="notice error codex-inline-notice">{error ?? status.lastError}</div> : null}
      </section>
    </div>
  );
}

function OpenCodeConnectionView() {
  const [status, setStatus] = useState({
    connected: false,
    installed: true,
    providerIds: [] as string[],
    needsLogin: true,
    lastError: null as string | null
  });
  const [login, setLogin] = useState<{ loginId: string; verificationUrl: string | null; intervalSeconds: number; expiresAt: number } | null>(null);
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
        setError("The OpenCode login request expired. Start a new login.");
        setLogin(null);
        return;
      }
      try {
        const result = await api<{ status: "pending" | "connected"; auth: typeof status }>(
          `/api/opencode-auth/login/${encodeURIComponent(login.loginId)}`
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
        setError(friendlyError(pollError instanceof Error ? pollError.message : "OpenCode authorization failed."));
        setLogin(null);
      }
    };
    timer = window.setTimeout(poll, 2000);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [login?.loginId]);

  async function loadStatus() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api("/api/opencode-auth"));
    } catch (statusError) {
      setError(friendlyError(statusError instanceof Error ? statusError.message : "Could not read OpenCode status."));
    } finally {
      setBusy(false);
    }
  }

  async function importHost() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api("/api/opencode-auth/import-host", { method: "POST" }));
    } catch (importError) {
      setError(friendlyError(importError instanceof Error ? importError.message : "Could not import host OpenCode credentials."));
    } finally {
      setBusy(false);
    }
  }

  async function startLogin() {
    setBusy(true);
    setError(null);
    try {
      const started = await api<{ loginId: string; verificationUrl: string | null; intervalSeconds: number; expiresAt: number }>(
        "/api/opencode-auth/login",
        { method: "POST" }
      );
      setLogin(started);
      if (started.verificationUrl) window.open(started.verificationUrl, "_blank", "noopener,noreferrer");
    } catch (loginError) {
      setError(friendlyError(loginError instanceof Error ? loginError.message : "Could not start OpenCode login."));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api("/api/opencode-auth", { method: "DELETE" }));
      setLogin(null);
    } catch (disconnectError) {
      setError(friendlyError(disconnectError instanceof Error ? disconnectError.message : "Could not disconnect OpenCode."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flat-list-view api-view codex-connection-view">
      <div className="flat-header">
        <h3>OpenCode</h3>
      </div>
      <section className="codex-connection-hero">
        <div className="codex-connection-heading">
          <div className="codex-connection-mark"><OpenCodeLogo size={25} /></div>
          <div>
            <h4>Connect OpenCode to Aisevak</h4>
            <p>Import this machine’s OpenCode credentials or sign in so worker threads can run the OpenCode harness.</p>
          </div>
        </div>
        <Badge variant={status.connected ? "success" : "warning"}>{status.connected ? "Connected" : "Login required"}</Badge>
      </section>
      <section className="codex-connection-grid">
        <div>
          <span>Providers</span>
          <strong>{status.providerIds.length > 0 ? status.providerIds.join(", ") : "None"}</strong>
        </div>
        <div>
          <span>CLI</span>
          <strong>{status.installed ? "Installed" : "Missing"}</strong>
        </div>
      </section>
      {login ? (
        <section className="codex-login-panel">
          <div>
            <h4>Finish OpenCode sign-in</h4>
            <p>Complete the provider login. Aisevak stores the resulting auth.json for later runs.</p>
          </div>
          {login.verificationUrl ? (
            <a href={login.verificationUrl} target="_blank" rel="noopener noreferrer" className="codex-auth-link">
              Open OpenCode authorization <ArrowUp size={14} />
            </a>
          ) : (
            <span><Loader2 className="spin" size={13} /> Waiting for a login URL…</span>
          )}
        </section>
      ) : null}
      <section className="api-section codex-connection-actions">
        <div className="section-title-row">
          <div>
            <h4>{status.connected ? "Connection is ready" : "Connect OpenCode"}</h4>
            <p>Host import copies ~/.local/share/opencode/auth.json into Aisevak’s encrypted secrets.</p>
          </div>
          <div className="row-actions">
            {status.connected ? (
              <>
                <Button variant="outline" disabled={busy} onClick={() => void loadStatus()}>
                  <RefreshCw className={busy ? "spin" : ""} size={14} /> Refresh
                </Button>
                <Button variant="destructive" disabled={busy} onClick={() => void disconnect()}>
                  Disconnect
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" disabled={busy} onClick={() => void importHost()}>
                  Import host credentials
                </Button>
                <Button disabled={busy || Boolean(login)} onClick={() => void startLogin()}>
                  {busy ? <Loader2 className="spin" size={14} /> : <OpenCodeLogo size={14} />}
                  Sign in with OpenCode
                </Button>
              </>
            )}
          </div>
        </div>
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
  editing: Skill | null;
  onSelectSkill: (skill: Skill | null) => void;
  onSaved: () => Promise<void>;
}) {
  const { editing, onSelectSkill: setEditing } = props;
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth <= 700) {
      if (editing?.id) {
        setEditing(props.skills.find((s) => s.id === editing.id) ?? null);
      }
      return;
    }
    if (!editing) {
      if (props.skills[0]) setEditing(props.skills[0]);
      return;
    }
    if (!editing.id) return;
    setEditing(props.skills.find((skill) => skill.id === editing.id) ?? props.skills[0] ?? null);
  }, [props.skills]);

  return (
    <div className={`master-detail ${editing ? "has-selection" : ""}`}>
      <aside className="master-list">
        <div className="master-header">
          <h3>Skills</h3>
        </div>
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
              <ChevronRight size={14} className="mobile-chevron-indicator" />
            </button>
          ))}
          {props.skills.length === 0 ? <div className="empty-list">No skills</div> : null}
        </div>
      </aside>
      <main className="detail-view">
        {editing ? (
          <div className="form-view">
            <div className="mobile-master-back-bar">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mobile-master-back-btn gap-1 text-muted-foreground hover:text-foreground"
                onClick={() => setEditing(null)}
              >
                <ChevronLeft size={14} />
                <span>Back to skills</span>
              </Button>
            </div>
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
      {props.root || draft.platform_managed ? (
        <div className="info-callout">
          <Info size={15} className="shrink-0 text-muted-foreground mt-0.5" />
          <div className="flex flex-col gap-1">
            {props.root ? (
              <div>
                Installed at <code>{props.root}/{draft.name}</code>.
                {draft.platform_managed ? " Aisevak updates this skill automatically with application releases." : " Changes here sync back to the local installed directory."}
              </div>
            ) : null}
            {draft.platform_managed ? (
              <div className="text-[11.5px] opacity-80">
                This skill is available to every agent by default. Only its availability can be changed.
              </div>
            ) : null}
          </div>
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
    <div className="master-detail connectors-master-detail">
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

type SettingsTab = "codex" | "cursor" | "opencode" | "api" | "credentials" | "projects" | "connectors";

function SettingsView(props: {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  userRole: string;
  apiKeys: ExternalApiKey[];
  onSavedApiKeys: () => Promise<void>;
  credentials: Credential[];
  onSavedCredentials: () => Promise<void>;
  projects: Project[];
  onSavedProjects: () => Promise<void>;
  repos: GithubRepository[];
  connection: GithubConnection | null;
  hostname: string;
  onConnectGithub: (token: string) => Promise<void>;
  onRefreshGithub: () => Promise<void>;
  onDisconnectGithub: () => Promise<void>;
  onImportGithub: (repoId: string) => Promise<void>;
}) {
  const tabs: Array<{ id: SettingsTab; label: string; icon: ReactElement; restricted?: boolean }> = [
    { id: "codex", label: "ChatGPT", icon: <OpenAILogo size={14} />, restricted: true },
    { id: "cursor", label: "Cursor", icon: <CursorLogo size={14} />, restricted: true },
    { id: "opencode", label: "OpenCode", icon: <OpenCodeLogo size={14} />, restricted: true },
    { id: "api", label: "API Keys", icon: <KeyRound size={14} /> },
    { id: "credentials", label: "Credentials", icon: <LockKeyhole size={14} />, restricted: true },
    { id: "projects", label: "Projects", icon: <FolderGit2 size={14} /> },
    { id: "connectors", label: "Connectors", icon: <Github size={14} /> }
  ];

  const visibleTabs = tabs.filter((t) => !t.restricted || props.userRole !== "member");

  return (
    <div className="settings-container">
      <div className="settings-tabs-bar">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`settings-tab-btn ${props.activeTab === tab.id ? "active" : ""}`}
            onClick={() => props.onTabChange(tab.id)}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="settings-content-pane">
        {props.activeTab === "codex" && props.userRole !== "member" ? (
          <CodexConnectionView />
        ) : null}
        {props.activeTab === "cursor" && props.userRole !== "member" ? (
          <CursorConnectionView />
        ) : null}
        {props.activeTab === "opencode" && props.userRole !== "member" ? (
          <OpenCodeConnectionView />
        ) : null}
        {props.activeTab === "api" ? (
          <ApiView apiKeys={props.apiKeys} onSaved={props.onSavedApiKeys} />
        ) : null}
        {props.activeTab === "credentials" && props.userRole !== "member" ? (
          <CredentialsView credentials={props.credentials} onSaved={props.onSavedCredentials} />
        ) : null}
        {props.activeTab === "projects" ? (
          <ProjectsView projects={props.projects} onSaved={props.onSavedProjects} />
        ) : null}
        {props.activeTab === "connectors" ? (
          <ConnectorsView
            repos={props.repos}
            connection={props.connection}
            hostname={props.hostname}
            onConnect={props.onConnectGithub}
            onRefresh={props.onRefreshGithub}
            onDisconnect={props.onDisconnectGithub}
            onImport={props.onImportGithub}
          />
        ) : null}
      </div>
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
  const isDiff = Boolean(
    workEntry.detail &&
      (workEntry.detail.includes("--- a/") ||
        workEntry.detail.includes("+++ b/") ||
        (workEntry.detail.includes("@@") && workEntry.detail.includes("\n+")))
  );

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
      {expanded && hasDetail ? (
        isDiff ? (
          <div className="px-2 pb-2">
            <FileDiff filename={preview || heading} diff={workEntry.detail!} defaultExpanded={true} />
          </div>
        ) : (
          <pre className="work-entry-detail">{workEntry.detail}</pre>
        )
      ) : null}
    </div>
  );
}

function WorkingTimelineRow({ row }: { row: Extract<AgentRunTimelineRow, { kind: "working" }> }) {
  return (
    <div className="working-row py-1 max-w-fit">
      <ThinkingReasoning
        label="Agent active"
        isStreaming={true}
        defaultExpanded={false}
        liveElapsed={row.createdAt ? <LiveElapsed createdAt={row.createdAt} /> : undefined}
        rawText={row.createdAt ? `Run in progress · Started at ${new Date(row.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : undefined}
      />
    </div>
  );
}

function cleanReportMarkdown(markdown: string, title?: string): string {
  if (!markdown) return "";
  let clean = markdown.trim();
  if (title) {
    const cleanTitle = title.replace(/[—–-].*$/, "").trim().toLowerCase();
    const lines = clean.split("\n");
    const firstLine = (lines[0] || "").replace(/^#+\s*/, "").trim().toLowerCase();
    if (firstLine && (firstLine.includes(cleanTitle) || cleanTitle.includes(firstLine))) {
      clean = lines.slice(1).join("\n").trim();
    }
  }
  return clean;
}

function CollapsibleText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = text.length > 500 || text.split("\n").length > 7;
  const collapsed = shouldCollapse && !expanded;

  return (
    <div className="agent-collapsible-container">
      <div className={`collapsible-message ${collapsed ? "collapsed" : ""}`}>
        <MarkdownContent text={text} plain />
      </div>
      {shouldCollapse ? (
        <button
          className="collapsible-toggle-btn"
          type="button"
          onClick={() => setExpanded((value) => !value)}
        >
          <span>{expanded ? "Show less" : "Show full report"}</span>
          <ChevronDown
            size={12}
            style={{
              transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform 140ms ease"
            }}
          />
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
      {duration ? ` · ${duration}` : ""}
    </span>
  );
}

function LiveElapsed({ createdAt }: { createdAt: string }) {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className="font-mono text-[10.5px] text-muted-foreground/75 tabular-nums">
      {formatElapsed(createdAt, now) ?? "0s"}
    </span>
  );
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
  return (
    <Badge className={`status ${bucket} inline-flex items-center gap-1.5`} variant={variant}>
      {bucket === "running" ? <AgentOrb variant="thinking" size={9} color="currentColor" /> : null}
      <span>{statusLabel(status)}</span>
    </Badge>
  );
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
            setError(onboardingError instanceof Error ? onboardingError.message : "Could not create account.");
          }
        }}
      >
        <h1>Set up Aisevak</h1>
        <p>Set up the first owner account.</p>
        <div className="stack">
          <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Your name" required />
          <Input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="Email address" type="email" required />
          <Input value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="Password · 8+ characters" type="password" minLength={8} required />
          <Input value={form.openaiApiKey} onChange={(event) => setForm({ ...form, openaiApiKey: event.target.value })} placeholder="OpenAI API key · optional" type="password" />
          {error ? <div className="notice error">{friendlyError(error)}</div> : null}
          <Button type="submit" size="lg" style={{ width: "100%" }}>Get started</Button>
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
      <DotMatrixLoader size={26} className="text-primary" />
    </div>
  );
}

function NavButton({ icon, label, active, onClick, className }: { icon: ReactNode; label: string; active: boolean; onClick: () => void; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" className={`nav-item ${active ? "active" : ""} ${className ?? ""}`} aria-current={active ? "page" : undefined} onClick={onClick}>
          <AnimatedIcon icon={icon as ReactElement} active={active} />
          <span>{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function emptyAgent(providers: ProviderInstance[]): Agent {
  const provider = providers[0];
  const model = provider
    ? (provider.models.find((entry) => entry.id === provider.defaultModel) ?? provider.models[0])
    : undefined;
  return {
    id: "",
    kind: "worker",
    name: "New Agent",
    description: "",
    provider_instance_id: provider?.id ?? "codex-local",
    model: model?.id ?? "",
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
  if (["succeeded", "done", "completed", "active", "enabled", "published", "resolved"].includes(status ?? "")) return "completed";
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

function isSettingsView(view: View): boolean {
  return ["settings", "codex", "cursor", "opencode", "api", "credentials", "projects", "connectors"].includes(view);
}

function viewTitle(view: View): string {
  if (isSettingsView(view)) return "Settings";
  return {
    tasks: "Tasks",
    runs: "Threads",
    activity: "Activity",
    incidents: "Incidents",
    agents: "Agents",
    skills: "Skills",
    schedules: "Schedule",
    settings: "Settings",
    codex: "Settings",
    cursor: "Settings",
    opencode: "Settings",
    api: "Settings",
    credentials: "Settings",
    projects: "Settings",
    connectors: "Settings"
  }[view];
}

function formatSidebarRunTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24 && date.toDateString() === now.toDateString()) {
    return `${diffHours}h ago`;
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

function agentSummary(agent: Agent, providers: ProviderInstance[]): string {
  const provider = providers.find((entry) => entry.id === agent.provider_instance_id);
  const model = provider?.models.find((entry) => entry.id === agent.model);
  const reasoningOption = model?.options?.find((option) => option.id === "reasoningEffort");
  const reasoning = normalizeComposerOptions(agent.model_options)
    .find((option) => option.id === "reasoningEffort")?.value ?? reasoningOption?.defaultValue;
  return [provider?.display_name ?? agent.kind, agent.model, reasoning ? String(reasoning) : null].filter(Boolean).join(" / ");
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

function readStickyModelSelection(providers: ProviderInstance[]): ModelSelection | null {
  if (providers.length === 0) return null;
  try {
    const raw = window.localStorage.getItem("aisevak.agent-model-selection.v2");
    if (raw) {
      const parsed = JSON.parse(raw) as ModelSelection;
      const selectedProvider = providers.find((entry) => entry.id === parsed.providerInstanceId);
      if (selectedProvider?.models.some((model) => model.id === parsed.model)) {
        return { ...parsed, options: normalizeComposerOptions(parsed.options) };
      }
    }
  } catch {
    // Ignore corrupt local preferences and use the live provider default.
  }
  const provider = providers[0]!;
  const model = provider.models.find((entry) => entry.id === provider.defaultModel) ?? provider.models[0];
  return model
    ? selectionForModel(provider, model)
    : { providerInstanceId: provider.id, model: provider.defaultModel, options: [] };
}

function writeStickyModelSelection(selection: ModelSelection): void {
  try {
    window.localStorage.setItem("aisevak.agent-model-selection.v2", JSON.stringify(selection));
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
