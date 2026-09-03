import type { ReactElement } from "react";
import { CheckCircle2, Circle, CircleAlert } from "../icons";
import { AgentOrb } from "./agent-orbs";

export type TaskStatus = "pending" | "running" | "completed" | "failed";

export interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  duration?: string;
  detail?: string;
}

interface TaskListProps {
  tasks: TaskItem[];
  title?: string;
  className?: string;
}

export function TaskList({
  tasks,
  title = "Task Plan",
  className = ""
}: TaskListProps): ReactElement {
  return (
    <div className={`rounded-lg border border-white/10 bg-[#111114] p-3 my-2 ${className}`}>
      {title && (
        <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/5">
          <span className="text-xs font-semibold text-foreground tracking-tight">{title}</span>
          <span className="text-[11px] font-mono text-muted-foreground">
            {tasks.filter((t) => t.status === "completed").length}/{tasks.length}
          </span>
        </div>
      )}

      <div className="space-y-1.5">
        {tasks.map((task) => {
          return (
            <div key={task.id} className="flex items-start gap-2 py-1 text-xs">
              <span className="mt-0.5 shrink-0">
                {task.status === "completed" && (
                  <CheckCircle2 size={13} className="text-emerald-400" />
                )}
                {task.status === "running" && (
                  <AgentOrb variant="working" size={13} color="var(--primary)" />
                )}
                {task.status === "pending" && (
                  <Circle size={13} className="text-muted-foreground/40" />
                )}
                {task.status === "failed" && (
                  <CircleAlert size={13} className="text-rose-400" />
                )}
              </span>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`truncate font-sans ${
                      task.status === "completed"
                        ? "text-muted-foreground line-through opacity-80"
                        : task.status === "running"
                        ? "text-foreground font-medium"
                        : "text-muted-foreground"
                    }`}
                  >
                    {task.title}
                  </span>
                  {task.duration && (
                    <span className="text-[10.5px] font-mono text-muted-foreground shrink-0">
                      {task.duration}
                    </span>
                  )}
                </div>
                {task.detail && (
                  <p className="text-[11px] text-muted-foreground/80 mt-0.5 font-mono truncate">
                    {task.detail}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
