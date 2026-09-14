import { readFileSync, realpathSync, statSync } from "node:fs";

export interface RuntimeSourceMetadata {
  entry: string | null;
  builtAt: string | null;
  error: string | null;
}

function bounded(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 400);
}

export function loadRuntimeSourceMetadata(entry: string, provenancePath: string): RuntimeSourceMetadata {
  try {
    const resolvedEntry = realpathSync(entry);
    if (!statSync(resolvedEntry).isFile()) throw new Error("Daemon entry is not a regular file");
    const parsed = JSON.parse(readFileSync(provenancePath, "utf8")) as { builtAt?: unknown };
    if (typeof parsed.builtAt !== "string" || new Date(parsed.builtAt).toISOString() !== parsed.builtAt) {
      throw new Error("Build provenance has an invalid builtAt timestamp");
    }
    return { entry: resolvedEntry, builtAt: parsed.builtAt, error: null };
  } catch (error) {
    return { entry: null, builtAt: null, error: bounded(error) };
  }
}
