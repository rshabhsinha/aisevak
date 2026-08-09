import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  findSlashTrigger,
  promptReferenceToken,
  replaceSlashTrigger,
  type PromptReferenceKind
} from "../promptComposer";
import { Textarea } from "./ui/textarea";

interface ComposerAgent {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

interface ComposerSkill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

interface ComposerTask {
  id: string;
  number: number;
  title: string;
}

interface PromptComposerProps {
  value: string;
  onChange: (value: string) => void;
  agents: ComposerAgent[];
  skills: ComposerSkill[];
  tasks: ComposerTask[];
  minHeight?: number;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

interface ComposerOption {
  id: string;
  kind: PromptReferenceKind;
  label: string;
  detail: string;
  token?: string;
}

const COMMAND_OPTIONS: ComposerOption[] = [
  { id: "command-skill", kind: "skill", label: "/skill", detail: "Attach a skill to this prompt" },
  { id: "command-agent", kind: "agent", label: "/agent", detail: "Reference an available agent" },
  { id: "command-task", kind: "task", label: "/task", detail: "Reference an existing task" }
];

export function PromptComposer(props: PromptComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(props.value.length);
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const trigger = focused ? findSlashTrigger(props.value, cursor) : null;
  const options = useMemo(() => {
    if (!trigger) return [];
    const needle = trigger.query.trim().toLowerCase();
    if (trigger.mode === "command") {
      return COMMAND_OPTIONS.filter((option) => option.kind.startsWith(needle));
    }
    const resources = referencesFor(trigger.command, props);
    return resources.filter((option) =>
      `${option.label} ${option.detail}`.toLowerCase().includes(needle)
    );
  }, [props.agents, props.skills, props.tasks, trigger?.command, trigger?.mode, trigger?.query]);

  useEffect(() => setActiveIndex(0), [trigger?.command, trigger?.query, trigger?.mode]);

  function restoreCursor(nextCursor: number) {
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
      setCursor(nextCursor);
    });
  }

  function choose(option: ComposerOption) {
    if (!trigger) return;
    const replacement = option.token ? `${option.token} ` : `/${option.kind} `;
    const next = replaceSlashTrigger(props.value, trigger, replacement);
    props.onChange(next.value);
    restoreCursor(next.cursor);
  }

  function openCommand(kind: PromptReferenceKind) {
    const target = textareaRef.current;
    const insertionPoint = target?.selectionStart ?? props.value.length;
    const needsSpace = insertionPoint > 0 && !/\s/.test(props.value[insertionPoint - 1] ?? "");
    const replacement = `${needsSpace ? " " : ""}/${kind} `;
    const value = `${props.value.slice(0, insertionPoint)}${replacement}${props.value.slice(insertionPoint)}`;
    props.onChange(value);
    setFocused(true);
    restoreCursor(insertionPoint + replacement.length);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (options.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + options.length) % options.length);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      choose(options[activeIndex] ?? options[0]!);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setFocused(false);
    }
  }

  return (
    <div className="prompt-composer">
      <Textarea
        ref={textareaRef}
        value={props.value}
        disabled={props.disabled}
        aria-label={props.ariaLabel ?? "Prompt"}
        placeholder={props.placeholder}
        style={{ minHeight: props.minHeight ?? 180, fontFamily: "var(--font-mono)", fontSize: 13 }}
        onFocus={(event) => {
          setFocused(true);
          setCursor(event.currentTarget.selectionStart);
        }}
        onBlur={() => setFocused(false)}
        onClick={(event) => setCursor(event.currentTarget.selectionStart)}
        onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)}
        onKeyDown={handleKeyDown}
        onChange={(event) => {
          props.onChange(event.target.value);
          setCursor(event.target.selectionStart);
        }}
      />
      {trigger ? (
        <div className="prompt-command-menu" role="listbox" aria-label="Prompt references">
          <div className="prompt-command-heading">
            {trigger.mode === "command" ? "Commands" : `${trigger.command}s`}
          </div>
          {options.length > 0 ? (
            options.slice(0, 8).map((option, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={`prompt-command-option ${index === activeIndex ? "active" : ""}`}
                key={option.id}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
              >
                <span className="prompt-command-icon">{option.kind.slice(0, 1).toUpperCase()}</span>
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.detail}</small>
                </span>
              </button>
            ))
          ) : (
            <div className="prompt-command-empty">No matching {trigger.command ?? "command"}</div>
          )}
        </div>
      ) : null}
      <div className="prompt-composer-footer">
        <span>Type / to reference context</span>
        <span className="prompt-composer-shortcuts">
          {(["skill", "agent", "task"] as PromptReferenceKind[]).map((kind) => (
            <button type="button" key={kind} onClick={() => openCommand(kind)} disabled={props.disabled}>
              /{kind}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}

function referencesFor(
  kind: PromptReferenceKind | null,
  props: Pick<PromptComposerProps, "agents" | "skills" | "tasks">
): ComposerOption[] {
  if (kind === "skill") {
    return props.skills
      .filter((skill) => skill.enabled)
      .map((skill) => ({
        id: `skill-${skill.id}`,
        kind,
        label: skill.name,
        detail: skill.description,
        token: promptReferenceToken(kind, skill.name)
      }));
  }
  if (kind === "agent") {
    return props.agents
      .filter((agent) => agent.enabled)
      .map((agent) => ({
        id: `agent-${agent.id}`,
        kind,
        label: agent.name,
        detail: agent.description,
        token: promptReferenceToken(kind, agent.name)
      }));
  }
  if (kind === "task") {
    return props.tasks.map((task) => ({
      id: `task-${task.id}`,
      kind,
      label: `TASK-${task.number}`,
      detail: task.title,
      token: promptReferenceToken(kind, `TASK-${task.number}`)
    }));
  }
  return [];
}
