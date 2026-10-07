export const MOBILE_BREAKPOINT = 920;

export function startsWithThreadDraft(threadId: string | null, width: number): boolean {
  return !threadId && width > MOBILE_BREAKPOINT;
}

export function shouldSubmitComposer(
  event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean },
  touchKeyboard: boolean
): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing &&
    (!touchKeyboard || event.ctrlKey || event.metaKey);
}

export function viewportFrame(layoutHeight: number, viewport?: { height: number; offsetTop: number }) {
  const top = Math.max(0, viewport?.offsetTop ?? 0);
  const height = Math.min(layoutHeight, viewport?.height ?? layoutHeight);
  return { height, top, bottom: Math.max(0, layoutHeight - height - top) };
}

// iOS can resize/pan only the visual viewport when its keyboard opens. Keep the
// app and portalled sheets in that visible area, without interfering with zoom.
export function trackVisualViewport(target: Window): () => void {
  const viewport = target.visualViewport;
  const root = target.document.documentElement;
  const style = root.style;
  const update = () => {
    if (viewport && viewport.scale !== 1) return;
    const frame = viewportFrame(target.innerHeight, viewport ?? undefined);
    style.setProperty("--app-height", `${frame.height}px`);
    style.setProperty("--app-top", `${frame.top}px`);
    style.setProperty("--viewport-bottom", `${frame.bottom}px`);
    root.toggleAttribute("data-short-viewport", frame.height <= 420);
  };
  update();
  target.addEventListener("resize", update);
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  return () => {
    target.removeEventListener("resize", update);
    viewport?.removeEventListener("resize", update);
    viewport?.removeEventListener("scroll", update);
    ["--app-height", "--app-top", "--viewport-bottom"].forEach((name) => style.removeProperty(name));
    root.removeAttribute("data-short-viewport");
  };
}
