import { integer, positional, required } from "../args.mjs";
const input = (c, index) => ({ consumerId: positional(c.positionals, index, "Consumer ID"), ...(typeof c.options.get("room") === "string" ? { roomId: c.options.get("room") } : {}), ...(c.options.has("limit") ? { limit: integer(required(c.options, "limit"), "--limit", { min: 1, max: 100 }) } : {}) });
export const events = [
  { names: ["events"], usage: "events peek|take CONSUMER [--room ROOM --limit N]", summary: "peek or take durable events", run: async (c) => { const explicit = c.positionals[1]; const action = explicit === "peek" || explicit === "take" ? explicit : "peek"; return { method: action === "peek" ? "events.peek" : "events.consume", params: input(c, action === "peek" && explicit === "peek" ? 2 : action === "take" ? 2 : 1), mutation: action === "take" }; } },
  { names: ["events-ack"], usage: "events-ack CONSUMER --through ID", summary: "ack delivered events", run: async (c) => ({ method: "events.ack", params: { consumerId: positional(c.positionals, 1, "Consumer ID"), throughId: integer(required(c.options, "through"), "--through") }, mutation: true }) },
];
