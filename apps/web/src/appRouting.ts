export type AppView =
  | "tasks"
  | "agents"
  | "projects"
  | "connectors"
  | "runs"
  | "activity"
  | "incidents"
  | "skills"
  | "schedules"
  | "api"
  | "credentials"
  | "codex"
  | "cursor"
  | "opencode"
  | "settings";

export interface AppRoute {
  view: AppView;
  threadId: string | null;
  path: string;
}

const VIEW_PATHS: Record<Exclude<AppView, "runs">, string> = {
  tasks: "/tasks",
  agents: "/agents",
  projects: "/settings/projects",
  connectors: "/settings/connectors",
  activity: "/activity",
  incidents: "/incidents",
  skills: "/skills",
  schedules: "/schedules",
  api: "/settings/api",
  credentials: "/settings/credentials",
  codex: "/settings/chatgpt",
  cursor: "/settings/cursor",
  opencode: "/settings/opencode",
  settings: "/settings"
};

const PATH_VIEWS = new Map<string, AppView>();
for (const [view, path] of Object.entries(VIEW_PATHS)) {
  PATH_VIEWS.set(path, view as AppView);
}
PATH_VIEWS.set("/projects", "projects");
PATH_VIEWS.set("/connectors", "connectors");
PATH_VIEWS.set("/settings", "codex");

export function appPath(view: AppView, threadId: string | null = null): string {
  if (view === "runs") {
    return threadId ? `/threads/${encodeURIComponent(threadId)}` : "/threads";
  }
  return VIEW_PATHS[view];
}

export function parseAppRoute(pathname: string): AppRoute {
  const normalized = normalizePath(pathname);
  if (normalized === "/" || normalized === "/threads") {
    return { view: "runs", threadId: null, path: "/threads" };
  }

  if (normalized.startsWith("/threads/")) {
    const encodedThreadId = normalized.slice("/threads/".length);
    if (encodedThreadId) {
      try {
        const threadId = decodeURIComponent(encodedThreadId);
        return { view: "runs", threadId, path: appPath("runs", threadId) };
      } catch {
        return { view: "runs", threadId: null, path: "/threads" };
      }
    }
  }

  const view = PATH_VIEWS.get(normalized);
  if (view) return { view, threadId: null, path: appPath(view) };
  return { view: "runs", threadId: null, path: "/threads" };
}

function normalizePath(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return withLeadingSlash.replace(/\/+$/, "") || "/";
}
