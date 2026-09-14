import { jobs } from "./commands/jobs.mjs";
import { rooms } from "./commands/rooms.mjs";
import { tasks } from "./commands/tasks.mjs";
import { releases } from "./commands/releases.mjs";
import { events } from "./commands/events.mjs";
import { admin } from "./commands/admin.mjs";
import { github } from "./commands/github.mjs";
import { explore } from "./commands/explore.mjs";
export const table = [...jobs, ...rooms, ...tasks, ...releases, ...events, ...admin, ...github, ...explore];
export function commandFor(name) { return table.find((entry) => entry.names.includes(name)); }
