export type ThreadDetailState =
  | { status: "idle"; error: null }
  | { status: "loading"; error: null }
  | { status: "ready"; error: null }
  | { status: "error"; error: string };

export function threadDetailIdle(): ThreadDetailState {
  return { status: "idle", error: null };
}

export function threadDetailLoading(): ThreadDetailState {
  return { status: "loading", error: null };
}

export function threadDetailReady(): ThreadDetailState {
  return { status: "ready", error: null };
}

export function threadDetailFailed(error: unknown): ThreadDetailState {
  return {
    status: "error",
    error: error instanceof Error ? error.message : "Failed to load this thread."
  };
}
