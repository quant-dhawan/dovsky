import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { explore, outlineResult } from "../src/commands/explore.mjs";

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dovsky-outline-"));
  context.after(async () => { await (await import("node:fs/promises")).rm(root, { recursive: true, force: true }); });
  return root;
}

test("outlines supported source with byte spans, stripped signatures, and safe docs", async (context) => {
  const root = await fixture(context);
  const source = "/** A useful \u001b[2Jfunction. */\nexport function greet(name: string): string {\n  return name;\n}\n\nexport const answer = 42;\n";
  await writeFile(path.join(root, "sample.ts"), source);

  const result = await outlineResult("sample.ts", { cwd: root });

  assert.equal(result.version, 1);
  assert.equal(result.path, "sample.ts");
  assert.equal(result.language, "typescript");
  assert.match(result.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.problems, []);
  assert.equal(result.declarations[0].kind, "function_declaration");
  assert.equal(result.declarations[0].name, "greet");
  assert.equal(result.declarations[0].signature, "export function greet(name: string): string");
  assert.equal(result.declarations[0].startByte, 30);
  assert.equal(result.declarations[0].startLine, 2);
  assert.equal(result.declarations[0].endLine, 4);
  assert.equal(result.declarations[0].documentation, "/** A useful function. */");
  assert.equal(result.declarations[1].name, "answer");
});

test("reports unsupported language and parser errors without a source fallback", async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, "note.txt"), "hello");
  await writeFile(path.join(root, "broken.ts"), "export function nope( {");

  const unsupported = await outlineResult("note.txt", { cwd: root });
  assert.equal(unsupported.language, "unsupported");
  assert.equal(unsupported.declarations.length, 0);
  assert.equal(unsupported.problems[0].code, "unsupported_language");

  const broken = await outlineResult("broken.ts", { cwd: root });
  assert.equal(broken.declarations.length, 0);
  assert.equal(broken.problems[0].code, "parse_error");
  assert.equal(typeof broken.problems[0].line, "number");
});

test("retains imports, re-exports, immediate members, overloads, decorators, and arrows", async (context) => {
  const root = await fixture(context);
  const source = `import type { TaskView as TV } from "./coordination.js";
export { TV as View } from "./coordination.js";
export * from "./features.js";
@sealed
export class Box {
  @logged
  field = () => { return 1; };
  method(value: string): void { function hidden() {} console.log(value); }
}
export interface Shape {
  readonly id: string;
  draw(value: number): void;
}
export enum Status { Ready, Done = 2 }
export function lookup(value: string): string;
export function lookup(value: unknown) { return String(value); }
export const arrow = (value: number) => { return value; };
export default (value: number) => { return value; };
`;
  await writeFile(path.join(root, "golden.ts"), source);

  const result = await outlineResult("golden.ts", { cwd: root });
  const byName = new Map(result.declarations.map((entry) => [entry.name, entry]));

  assert.equal(result.problems.length, 0);
  assert.ok(result.declarations.some((entry) => entry.kind === "import_statement"));
  assert.ok(result.declarations.some((entry) => entry.kind === "export_statement" && /export \{ TV as View \}/.test(entry.signature)));
  assert.ok(result.declarations.some((entry) => entry.kind === "export_statement" && /export \* from/.test(entry.signature)));
  assert.match(byName.get("Box.field").signature, /field = \(\) =>$/);
  assert.doesNotMatch(byName.get("Box.field").signature, /return 1/);
  assert.match(byName.get("Box.method").signature, /method\(value: string\): void$/);
  assert.doesNotMatch(byName.get("Box.method").signature, /hidden|console\.log/);
  assert.equal(result.declarations.some((entry) => entry.name?.includes("hidden")), false);
  assert.equal(byName.get("Shape.id").signature, "readonly id: string");
  assert.equal(byName.get("Shape.draw").signature, "draw(value: number): void");
  assert.ok(byName.has("Status.Ready"));
  assert.equal(result.declarations.filter((entry) => entry.name === "lookup").length, 2);
  assert.match(byName.get("arrow").signature, /=>$/);
  assert.ok(result.declarations.some((entry) => entry.kind === "export_statement" && entry.name === null && /export default \(value: number\) =>$/.test(entry.signature)));
});

test("documentation is only the immediately adjacent comment, never intervening source", async (context) => {
  const root = await fixture(context);
  const source = `/** First documentation */
export function first() {
  const body = "${"x".repeat(3 * 1024)}";
  return body;
}
const interposed = "must not enter docs";
/** Second documentation */
export function second() { return 2; }
// Line one
// Line two
export const lineDocs = 1;
export function third() { return "${"y".repeat(20 * 1024)}"; }
`;
  await writeFile(path.join(root, "docs.ts"), source);

  const result = await outlineResult("docs.ts", { cwd: root });
  const second = result.declarations.find((entry) => entry.name === "second");
  const lineDocs = result.declarations.find((entry) => entry.name === "lineDocs");
  const resultBytes = Buffer.byteLength(JSON.stringify(result));

  assert.equal(second.documentation, "/** Second documentation */");
  assert.doesNotMatch(second.documentation, /interposed|return body|xxxxx/);
  assert.equal(lineDocs.documentation, "// Line one\n// Line two");
  assert.ok(resultBytes < Buffer.byteLength(source) / 4);
});

test("keeps usable declarations next to a Tree-sitter parse error", async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, "partial.ts"), "export interface UsesImport { task?: import(\"./coordination.js\").TaskView; }\nexport const broken = ;\nexport const usable = 1;\n");

  const result = await outlineResult("partial.ts", { cwd: root });

  assert.equal(result.problems[0].code, "parse_error");
  assert.ok(result.declarations.some((entry) => entry.name === "UsesImport"));
  assert.ok(result.declarations.some((entry) => entry.name === "usable"));
});

test("rejects unsafe paths and symlink traversal", async (context) => {
  const root = await fixture(context);
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, "inside.ts"), "export const x = 1;");
  await symlink(path.join(root, "inside.ts"), path.join(root, "linked.ts"));
  await symlink(root, path.join(root, "linked-dir"));

  for (const unsafe of ["", ".", "../inside.ts", ".git/config", "inside//x.ts", "linked.ts", "linked-dir/inside.ts", "bad\0.ts", "bad\nname.ts", `${"a".repeat(1025)}.ts`]) {
    await assert.rejects(outlineResult(unsafe, { cwd: root }), /path|segment|symlink|NUL|relative/i);
  }
});

test("rejects an ancestor swapped for an outside symlink before open", async (context) => {
  const root = await fixture(context);
  const outside = await mkdtemp(path.join(os.tmpdir(), "dovsky-outline-outside-"));
  context.after(() => rm(outside, { recursive: true, force: true }));
  const nested = path.join(root, "nested");
  await mkdir(nested);
  await writeFile(path.join(nested, "sample.ts"), "export const inside = true;");
  await writeFile(path.join(outside, "sample.ts"), "export const outside = true;");

  await assert.rejects(outlineResult("nested/sample.ts", {
    cwd: root,
    beforeOpen: async () => {
      await rm(nested, { recursive: true });
      await symlink(outside, nested);
    },
  }), /escapes --cwd/i);
});

test("bounds declarations and reports truncation", async (context) => {
  const root = await fixture(context);
  const source = Array.from({ length: 513 }, (_, index) => `export const value${index} = ${index};`).join("\n");
  await writeFile(path.join(root, "many.ts"), source);

  const result = await outlineResult("many.ts", { cwd: root });

  assert.ok(result.declarations.length > 0 && result.declarations.length < 512);
  assert.equal(result.truncated, true);
  assert.equal(result.problems.at(-1).code, "truncated");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8 * 1024);
});

test("caps type-heavy outline inflation relative to source bytes", async (context) => {
  const root = await fixture(context);
  const source = Array.from({ length: 400 }, (_, index) => `export interface Shape${index} { readonly id: string; render(value: { nested: string; count: number }): Promise<string>; }`).join("\n");
  await writeFile(path.join(root, "types.ts"), source);

  const result = await outlineResult("types.ts", { cwd: root, deadline: 1_000 });
  const sourceBytes = Buffer.byteLength(source);

  assert.ok(sourceBytes > 27 * 1024);
  assert.equal(result.truncated, true);
  assert.equal(result.problems.at(-1).code, "truncated");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= Math.floor(sourceBytes * 0.30));
});

test("bounds file reads and reports an expired deadline", async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, "large.ts"), "x".repeat(2 * 1024 * 1024 + 1));
  await writeFile(path.join(root, "slow.ts"), "export const x = 1;");

  const large = await outlineResult("large.ts", { cwd: root });
  assert.equal(large.truncated, true);
  assert.equal(large.problems[0].code, "truncated");
  assert.equal(large.contentHash, "");

  let tick = 0;
  const late = await outlineResult("slow.ts", { cwd: root, deadline: 100, now: () => (tick += 101) });
  assert.equal(late.truncated, true);
  assert.equal(late.problems[0].code, "deadline");
});

test("parses sources beyond Tree-sitter's default input buffer", async (context) => {
  const root = await fixture(context);
  const source = `export const first = 1;\n${"// filler\n".repeat(4 * 1024)}export function tail() { return first; }\n`;
  await writeFile(path.join(root, "large-parse.ts"), source);

  const result = await outlineResult("large-parse.ts", { cwd: root, deadline: 1_000 });

  assert.ok(Buffer.byteLength(source) > 32 * 1024);
  assert.ok(result.declarations.some((entry) => entry.name === "tail"));
  assert.equal(result.problems.some((entry) => entry.code === "parse_error"), false);
});

test("uses UTF-8 byte spans after non-ASCII source and slices signatures by UTF-16 offsets", async (context) => {
  const root = await fixture(context);
  const source = "// é 😀\nexport function greet(value: string) { return value; }\n";
  await writeFile(path.join(root, "unicode.ts"), source);

  const result = await outlineResult("unicode.ts", { cwd: root });
  const greet = result.declarations.find((entry) => entry.name === "greet");

  assert.equal(greet.startByte, Buffer.byteLength(source.slice(0, source.indexOf("export function"))));
  assert.equal(greet.endByte, Buffer.byteLength(source.trimEnd()));
  assert.equal(greet.signature, "export function greet(value: string)");
});

test("command rejects valueless cwd and deadline options", async () => {
  const run = (name) => explore[0].run({ positionals: ["outline", "sample.ts"], options: new Map([[name, true]]) });
  await assert.rejects(run("cwd"), /Missing required --cwd/);
  await assert.rejects(run("deadline"), /Missing required --deadline/);
});

test("backs signature truncation off a UTF-8 continuation byte", async (context) => {
  const root = await fixture(context);
  const prefix = "export const value = \"";
  const source = `${prefix}${"a".repeat(2047 - Buffer.byteLength(prefix))}é\";`;
  await writeFile(path.join(root, "boundary.ts"), source);

  const result = await outlineResult("boundary.ts", { cwd: root });
  const value = result.declarations.find((entry) => entry.name === "value");

  assert.equal(value.signature.includes("�"), false);
  assert.equal(value.signature.endsWith("a"), true);
  assert.equal(result.truncated, true);
});

test("strips the first executable body across multi-declarator arrows and keeps decorated abstract members", async (context) => {
  const root = await fixture(context);
  const source = `const first = 1, second = () => ({ marker: "PAREN_BODY" }), third = () => { return "SECOND_BODY"; };
abstract class AbstractWorker {
  /** Runs the job. */
  @logged
  @traced
  run() { return "METHOD_BODY"; }
}
`;
  await writeFile(path.join(root, "abstract.ts"), source);

  const result = await outlineResult("abstract.ts", { cwd: root });
  const variables = result.declarations.find((entry) => entry.name === "first");
  const run = result.declarations.find((entry) => entry.name === "AbstractWorker.run");

  assert.equal(variables.signature, "const first = 1, second = () =>");
  assert.doesNotMatch(variables.signature, /PAREN_BODY|SECOND_BODY/);
  assert.match(run.signature, /^@logged\n  @traced\n  run\(\)$/);
  assert.equal(run.documentation, "/** Runs the job. */");
  assert.equal(run.startByte, Buffer.byteLength(source.slice(0, source.indexOf("@logged"))));
  assert.doesNotMatch(run.signature, /METHOD_BODY/);
});
