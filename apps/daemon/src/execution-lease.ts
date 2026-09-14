import { readdirSync, readFileSync } from "node:fs";

export interface ProcessIdentity {
  pid: number;
  processGroup: number;
  startTicks: string;
  bootId: string;
}

export interface ProcessObservation {
  state: "alive" | "absent" | "unverifiable";
  members: number[];
  reason: string | null;
}

interface ProcStat {
  pid: number;
  processGroup: number;
  startTicks: string;
}

function readBootId(): string | null {
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

export function parseProcStat(value: string): ProcStat | null {
  const end = value.lastIndexOf(")");
  if (end < 0) return null;
  const pid = Number(value.slice(0, value.indexOf(" ")));
  const fields = value.slice(end + 1).trim().split(/\s+/);
  // The suffix begins at field 3. Process group is field 5 and start time is field 22.
  if (!Number.isSafeInteger(pid) || !fields[2] || !fields[19]) return null;
  const processGroup = Number(fields[2]);
  return Number.isSafeInteger(processGroup) && /^\d+$/.test(fields[19])
    ? { pid, processGroup, startTicks: fields[19] }
    : null;
}

function readProcStat(pid: number): ProcStat | null {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

export function readProcessIdentity(pid: number | undefined): ProcessIdentity | null {
  if (process.platform !== "linux" || !pid || !Number.isSafeInteger(pid) || pid < 1) return null;
  const bootId = readBootId();
  const stat = readProcStat(pid);
  return bootId && stat ? { ...stat, bootId } : null;
}

export function inspectProcessGroup(identity: ProcessIdentity): ProcessObservation {
  if (process.platform !== "linux") return { state: "unverifiable", members: [], reason: "Process identity checks require Linux /proc" };
  const bootId = readBootId();
  if (!bootId) return { state: "unverifiable", members: [], reason: "Kernel boot identity is unavailable" };
  if (bootId !== identity.bootId) return { state: "absent", members: [], reason: "The host rebooted after this lease was recorded" };
  try {
    process.kill(-identity.processGroup, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return { state: "absent", members: [], reason: null };
    return { state: "unverifiable", members: [], reason: "Cannot verify the recorded process group" };
  }
  const leader = readProcStat(identity.pid);
  if (leader && (leader.processGroup !== identity.processGroup || leader.startTicks !== identity.startTicks)) {
    return { state: "unverifiable", members: [], reason: "The recorded leader PID no longer has the recorded identity" };
  }
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry));
  } catch {
    return { state: "alive", members: [], reason: "Process group is live; member enumeration is unavailable" };
  }
  const members = pids
    .map((entry) => readProcStat(Number(entry)))
    .filter((stat): stat is ProcStat => stat !== null && stat.processGroup === identity.processGroup)
    .map((stat) => stat.pid);
  return { state: "alive", members, reason: null };
}
