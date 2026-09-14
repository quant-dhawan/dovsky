import { readFileSync } from "node:fs";

import { PROVIDERS, TIERS, type Provider, type Tier } from "@dovsky/protocol";

export type Rung = { provider: Provider; tier: Tier };

/** A charter's routing ladder: cheapest rung first, and the rung a fresh job enters at. */
export type CharterLadder = { rungs: Rung[]; startIndex: number; fixed?: boolean };

class LadderError extends Error {}

function parseRung(text: string, file: string): Rung {
  const [provider, tier, ...rest] = text.split("/");
  if (rest.length > 0 || !provider || !tier) {
    throw new LadderError(`${file}: bus rung must be provider/tier, got "${text}"`);
  }
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new LadderError(`${file}: unknown provider "${provider}" in rung "${text}"`);
  }
  if (!(TIERS as readonly string[]).includes(tier)) {
    throw new LadderError(`${file}: unknown tier "${tier}" in rung "${text}"`);
  }
  return { provider: provider as Provider, tier: tier as Tier };
}

/**
 * The `bus:` block of a charter's frontmatter. `allowed` is an ordered list of provider/tier rungs, cheapest first,
 * written either as a flow list (`[a, b]`) or a block list (`- a`); `start` names the rung a fresh job enters at and
 * defaults to the first. Optional `fixed: true` disables single-rung widening; omission means false and
 * preserves the legacy return shape. Returns null when the charter has no `bus:` block, so charters that predate this keep
 * behaving exactly as they did. Anything malformed throws, naming the file and the offending text.
 */
export function parseCharterLadder(text: string, file: string): CharterLadder | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const lines = text.slice(4, end).split("\n");
  const open = lines.findIndex((line) => /^bus:\s*$/.test(line));
  if (open === -1) return null;

  let allowed: string[] | null = null;
  let collecting = false; // inside a block list under `allowed:`
  let start: string | null = null;
  let fixed: boolean | undefined;
  for (let index = open + 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break; // dedented back to a sibling frontmatter key
    const item = /^\s+-\s*(.+?)\s*$/.exec(line);
    if (item) {
      if (!collecting) throw new LadderError(`${file}: list item "${item[1]}" does not follow bus.allowed`);
      (allowed as string[]).push(item[1] as string);
      continue;
    }
    const key = /^\s+([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!key) throw new LadderError(`${file}: cannot read bus line "${line.trim()}"`);
    collecting = false;
    const [, name, value] = key as unknown as [string, string, string];
    if (name === "allowed") {
      if (allowed !== null) throw new LadderError(`${file}: bus.allowed is given twice`);
      const inline = value.trim();
      if (inline === "") {
        allowed = [];
        collecting = true;
      } else if (inline.startsWith("[") && inline.endsWith("]")) {
        allowed = inline.slice(1, -1).split(",").map((part) => part.trim()).filter((part) => part !== "");
      } else {
        throw new LadderError(`${file}: bus.allowed must be a list, got "${inline}"`);
      }
    } else if (name === "start") {
      start = value.trim();
    } else if (name === "fixed") {
      if (fixed !== undefined) throw new LadderError(`${file}: bus.fixed is given twice`);
      if (value.trim() !== "true" && value.trim() !== "false") {
        throw new LadderError(`${file}: bus.fixed must be a boolean, got "${value.trim()}"`);
      }
      fixed = value.trim() === "true";
    } else {
      throw new LadderError(`${file}: unknown key "${name}" under bus:`);
    }
  }

  if (allowed === null) throw new LadderError(`${file}: bus: has no allowed list`);
  if (allowed.length === 0) throw new LadderError(`${file}: bus.allowed is empty`);
  const rungs = allowed.map((entry) => parseRung(entry, file));
  const written = rungs.map((rung) => `${rung.provider}/${rung.tier}`);
  const duplicate = written.find((rung, index) => written.indexOf(rung) !== index);
  if (duplicate) throw new LadderError(`${file}: bus.allowed repeats ${duplicate}`);
  const startIndex = start === null ? 0 : written.indexOf(start);
  if (startIndex === -1) throw new LadderError(`${file}: bus.start ${start} is not in allowed [${written.join(", ")}]`);
  return { rungs, startIndex, ...(fixed === undefined ? {} : { fixed }) };
}

/** The ladder of the charter at `path`, or null when the file has none. Throws when the file cannot be read. */
export function readCharterLadder(path: string): CharterLadder | null {
  return parseCharterLadder(readFileSync(path, "utf8"), path);
}

export { LadderError };
