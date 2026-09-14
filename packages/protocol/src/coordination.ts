import type { Provider } from "./index.js";

export const TASK_STATES = ["working", "checkpointed", "awaiting_decision", "blocked", "completed", "unknown", "cancelled"] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const CONTROL_KINDS = ["instruction", "decision", "pause", "resume"] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

export interface TaskView {
  id: string;
  roomId: string;
  provider: Provider;
  latestJobId: string;
  state: TaskState;
  phase: string;
  blocker: string | null;
  nextAction: string | null;
  workdir: string | null;
  updatedAt: string;
  createdAt: string;
  revision: number;
}

/** A pending task plus the room it belongs to. */
export interface PendingTaskView extends TaskView {
  roomTitle: string;
}

/** Delivery is distinct from acknowledgement; neither grants release authority. */
export interface ControlView {
  deliveryActor?: "provider" | "coordinator" | null;
  acknowledgmentActor?: "provider" | "coordinator" | null;
  id: string;
  taskId: string;
  sequence: number;
  kind: ControlKind;
  body: string;
  createdAt: string;
  deliveredAt: string | null;
  deliveredJobId: string | null;
  acknowledgedAt: string | null;
  acknowledgedJobId: string | null;
}

export interface TaskDetail {
  task: TaskView;
  controls: ControlView[];
}

export interface TaskResult {
  outcome: TaskState;
  phase: string;
  blocker: string | null;
  nextAction: string | null;
  acknowledgedControls: string[];
}

/** Rebind fields are optional only for a same-worktree resume; they must be supplied together. */
export interface TaskResumeInput {
  taskId: string;
  cwd?: string;
  expectedFingerprint?: string;
}

export interface ControlInput {
  taskId: string;
  kind: ControlKind;
  body: string;
}
