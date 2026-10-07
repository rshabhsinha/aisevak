import { describe, expect, it } from "vitest";
import { shouldSubmitComposer, startsWithThreadDraft, trackVisualViewport, viewportFrame } from "./mobileLayout";

describe("mobile thread entry", () => {
  it("opens the list on phones and the draft on desktop, preserving deep links", () => {
    expect(startsWithThreadDraft(null, 320)).toBe(false);
    expect(startsWithThreadDraft(null, 920)).toBe(false);
    expect(startsWithThreadDraft(null, 921)).toBe(true);
    expect(startsWithThreadDraft("thread-1", 375)).toBe(false);
    expect(startsWithThreadDraft("thread-1", 1440)).toBe(false);
  });
});

describe("composer keyboards", () => {
  const enter = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false };
  it("allows newlines from the phone keyboard and desktop Shift Enter", () => {
    expect(shouldSubmitComposer(enter, true)).toBe(false);
    expect(shouldSubmitComposer(enter, false)).toBe(true);
    expect(shouldSubmitComposer({ ...enter, shiftKey: true }, false)).toBe(false);
    expect(shouldSubmitComposer({ ...enter, ctrlKey: true }, true)).toBe(true);
    expect(shouldSubmitComposer({ ...enter, metaKey: true }, true)).toBe(true);
  });
  it("never submits while an IME is composing", () => {
    expect(shouldSubmitComposer({ ...enter, isComposing: true }, false)).toBe(false);
    expect(shouldSubmitComposer({ ...enter, isComposing: true, ctrlKey: true }, true)).toBe(false);
  });
});

describe("visual viewport", () => {
  it("accounts for keyboard overlays, viewport panning, and missing browser support", () => {
    expect(viewportFrame(812)).toEqual({ height: 812, top: 0, bottom: 0 });
    expect(viewportFrame(812, { height: 450, offsetTop: 62 })).toEqual({ height: 450, top: 62, bottom: 300 });
    expect(viewportFrame(400, { height: 420, offsetTop: -20 })).toEqual({ height: 400, top: 0, bottom: 0 });
  });
  it("responds to keyboard changes, preserves pinch zoom, and removes listeners", () => {
    const viewport = Object.assign(new EventTarget(), { height: 812, offsetTop: 0, scale: 1 });
    const values = new Map<string, string>();
    const attributes = new Set<string>();
    const target = Object.assign(new EventTarget(), { innerHeight: 812, visualViewport: viewport,
      document: { documentElement: {
        toggleAttribute: (name: string, enabled: boolean) => enabled ? attributes.add(name) : attributes.delete(name),
        removeAttribute: (name: string) => attributes.delete(name),
        style: {
        setProperty: (key: string, value: string) => values.set(key, value),
        removeProperty: (key: string) => values.delete(key)
      } } }
    });
    const cleanup = trackVisualViewport(target as unknown as Window);
    viewport.height = 450;
    viewport.offsetTop = 62;
    viewport.dispatchEvent(new Event("resize"));
    expect(values.get("--app-height")).toBe("450px");
    expect(values.get("--viewport-bottom")).toBe("300px");
    expect(attributes.has("data-short-viewport")).toBe(false);
    // Keyboard overlays can leave a short visual viewport without changing
    // innerHeight, so a CSS max-height media query alone cannot handle them.
    viewport.height = 280;
    viewport.dispatchEvent(new Event("resize"));
    expect(attributes.has("data-short-viewport")).toBe(true);
    viewport.height = 450;
    viewport.dispatchEvent(new Event("resize"));
    expect(attributes.has("data-short-viewport")).toBe(false);
    viewport.scale = 2;
    viewport.height = 225;
    viewport.dispatchEvent(new Event("resize"));
    expect(values.get("--app-height")).toBe("450px");
    cleanup();
    viewport.scale = 1;
    viewport.dispatchEvent(new Event("scroll"));
    target.dispatchEvent(new Event("resize"));
    expect(values.size).toBe(0);
    expect(attributes.size).toBe(0);
  });
});
