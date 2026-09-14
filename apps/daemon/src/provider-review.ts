import { existsSync } from "node:fs";
import type { Provider } from "@dovsky/protocol";
import { readRegularFile } from "./file-state.js";

export const REVIEW_OUTPUT_MAX_BYTES = 1024 * 1024;
export type StructuredProviderValue = { found: false } | { found: true; value: unknown } | { found: true; error: string };
function parseJson(value: unknown): StructuredProviderValue { if (typeof value !== "string") return { found: true, value }; try { return { found: true, value: JSON.parse(value) }; } catch { return { found: true, error: "Provider structured verdict was not JSON" }; } }
function withoutOption(argv: readonly string[], option: string): string[] { const kept: string[] = []; for (let index = 0; index < argv.length; index++) { const item = argv[index]!; if (item === option) { index++; continue; } if (item.startsWith(`${option}=`)) continue; kept.push(item); } return kept; }

/** Provider-specific structured-output flags; caller supplies isolated private output paths. */
export function reviewArgv(provider: Provider, configuredArgv: readonly string[], schemaPath: string, lastMessagePath: string): string[] {
  if (!schemaPath || !lastMessagePath) throw new Error("Review schema and last-message paths are required");
  if (provider === "claude") {
    const schemaJson = JSON.stringify(JSON.parse(readRegularFile(schemaPath, REVIEW_OUTPUT_MAX_BYTES).toString("utf8")));
    return [...withoutOption(withoutOption(configuredArgv, "--json-schema"), "--output-format"), "--json-schema", schemaJson, "--output-format", "json"];
  }
  const argv = withoutOption(withoutOption(configuredArgv, "--output-schema"), "-o");
  if (argv.at(-1) !== "-") throw new Error("Codex review command must end with stdin marker '-'");
  return [...argv.slice(0, -1), "--output-schema", schemaPath, "-o", lastMessagePath, "-"];
}
export function structuredProviderEvent(provider: Provider, event: unknown): StructuredProviderValue {
  const record = event !== null && typeof event === "object" && !Array.isArray(event) ? event as Record<string, unknown> : null;
  if (!record) return { found: false };
  if (provider === "claude") { if (record.type !== "result") return { found: false }; if ("structured_output" in record) return parseJson(record.structured_output); return "result" in record ? parseJson(record.result) : { found: false }; }
  if (record.type !== "item.completed") return { found: false };
  const item = record.item !== null && typeof record.item === "object" && !Array.isArray(record.item) ? record.item as Record<string, unknown> : null;
  return item?.type === "agent_message" && typeof item.text === "string" ? parseJson(item.text) : { found: false };
}
/** Read Codex's final-message fallback only after provider command completion. */
export function readStructuredLastMessage(path: string, maxBytes = REVIEW_OUTPUT_MAX_BYTES): StructuredProviderValue { if (!existsSync(path)) return { found: false }; try { return parseJson(readRegularFile(path, maxBytes).toString("utf8")); } catch (error) { return { found: true, error: error instanceof Error ? error.message : "Unable to read provider last message" }; } }
