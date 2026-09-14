import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { integer, positional, required, usage } from "../args.mjs";
import { stripTerminalControl } from "../sanitize.mjs";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PATH_BYTES = 1024;
const MAX_DECLARATIONS = 512;
const MAX_SIGNATURE_BYTES = 2048;
const MAX_DOCUMENTATION_BYTES = 4096;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MIN_RESPONSE_BYTES = 8 * 1024;
const TERMINAL_PROBLEM_RESERVE = 256;
const DEFAULT_DEADLINE_MS = 100;
const MAX_ERROR_NODES = 512;
const DECLARATIONS = new Set([
  "abstract_class_declaration", "class_declaration", "enum_declaration", "function_declaration",
  "function_signature", "generator_function_declaration", "interface_declaration", "lexical_declaration", "type_alias_declaration",
  "variable_declaration",
]);
const MEMBERS = new Set([
  "abstract_method_signature", "call_signature", "construct_signature", "enum_assignment", "index_signature",
  "method_definition", "method_signature", "property_signature", "public_field_definition",
]);

function securityError(message) { return usage(`Unsafe outline path: ${message}`); }

function languageFor(filename) {
  switch (path.extname(filename).toLowerCase()) {
    case ".js": case ".mjs": case ".cjs": case ".jsx": return { language: "javascript", grammar: "javascript", parserVersion: "tree-sitter-javascript@0.23.1" };
    case ".ts": case ".mts": case ".cts": return { language: "typescript", grammar: "typescript", parserVersion: "tree-sitter-typescript@0.23.2" };
    case ".tsx": return { language: "tsx", grammar: "tsx", parserVersion: "tree-sitter-typescript@0.23.2" };
    default: return { language: "unsupported", grammar: null, parserVersion: "" };
  }
}

async function secureFile(pathname, cwd) {
  if (typeof pathname !== "string" || pathname.length === 0) throw securityError("a non-empty relative path is required");
  if (Buffer.byteLength(pathname) > MAX_PATH_BYTES || /[\x00-\x1f\x7f]/.test(pathname) || path.isAbsolute(pathname)) {
    throw securityError(`path must be relative, control-free, and at most ${MAX_PATH_BYTES} bytes`);
  }
  const segments = pathname.split(/[\\/]/);
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment === ".git")) throw securityError("empty, dot, dot-dot, and .git segments are not allowed");

  const base = await realpath(cwd);
  const baseStat = await lstat(base);
  if (!baseStat.isDirectory()) throw securityError("--cwd must be a directory");
  let candidate = base;
  let targetStat;
  for (let index = 0; index < segments.length; index += 1) {
    candidate = path.join(candidate, segments[index]);
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink()) throw securityError("symlinks are not allowed");
    if (index < segments.length - 1 && !stat.isDirectory()) throw securityError("an ancestor is not a directory");
    if (index === segments.length - 1 && !stat.isFile()) throw securityError("target must be a regular file");
    if (index === segments.length - 1) targetStat = stat;
  }
  return { base, candidate, relative: segments.join("/"), targetStat };
}

function isStrictDescendant(base, target) {
  const relative = path.relative(base, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function stableRead(filename, base, expected, beforeOpen) {
  if (beforeOpen) await beforeOpen();
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    let openedPath;
    try { openedPath = await realpath(`/proc/self/fd/${handle.fd}`); }
    catch { throw securityError("cannot resolve opened target"); }
    if (!isStrictDescendant(base, openedPath)) throw securityError("opened target escapes --cwd");
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size) throw securityError("target changed while opening");
    if (opened.size > MAX_FILE_BYTES) return { tooLarge: true, bytes: Buffer.alloc(0) };
    const bytes = Buffer.alloc(opened.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw securityError("target changed while reading");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw securityError("target changed while reading");
    return { tooLarge: false, bytes };
  } finally { await handle.close(); }
}

function utf8OffsetMap(source) {
  const offsets = new Uint32Array(source.length + 1);
  let bytes = 0;
  for (let index = 0; index < source.length;) {
    offsets[index] = bytes;
    const code = source.codePointAt(index);
    const units = code > 0xffff ? 2 : 1;
    if (units === 2) offsets[index + 1] = bytes;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    index += units;
  }
  offsets[source.length] = bytes;
  return offsets;
}

function codeUnitAtByte(offsets, byte) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] < byte) low = middle + 1;
    else high = middle;
  }
  return low;
}

function boundedText(source, start, end, limit) {
  const text = source.slice(start, end);
  const bytes = Buffer.from(text, "utf8");
  let capped = Math.min(bytes.length, limit);
  while (capped > 0 && capped < bytes.length && (bytes[capped] & 0xc0) === 0x80) capped -= 1;
  return { text: stripTerminalControl(bytes.subarray(0, capped).toString("utf8")).trim(), truncated: capped < bytes.length };
}

function declarationNode(node) {
  if (node.type === "export_statement" || node.type === "ambient_declaration") return node.childForFieldName("declaration") ?? node.namedChildren.find((child) => DECLARATIONS.has(child.type));
  return node;
}

function nameFor(node) {
  const named = node.childForFieldName("name");
  if (named) return stripTerminalControl(named.text);
  if (node.type === "property_identifier") return stripTerminalControl(node.text);
  const declarator = node.namedChildren.find((child) => child.type === "variable_declarator");
  return declarator?.childForFieldName("name") ? stripTerminalControl(declarator.childForFieldName("name").text) : null;
}

function signatureEnd(node) {
  const body = node.childForFieldName("body");
  if (body) return body.startIndex;
  const declaration = node.childForFieldName("declaration");
  if (declaration) return signatureEnd(declaration);
  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    const executable = earliestVariableBody(node);
    if (executable !== null) return executable;
  }
  const declarator = node.namedChildren.find((child) => child.type === "variable_declarator");
  const value = declarator?.childForFieldName("value");
  const valueBody = value?.childForFieldName("body");
  if (valueBody) return valueBody.startIndex;
  const arrow = node.namedChildren.find((child) => child.type === "arrow_function");
  return arrow?.childForFieldName("body")?.startIndex ?? node.endIndex;
}

function earliestVariableBody(node) {
  const nodes = [node];
  let earliest = null;
  for (let index = 0; index < nodes.length; index += 1) {
    const current = nodes[index];
    if (current.type === "arrow_function") {
      const body = current.childForFieldName("body");
      if (body && (earliest === null || body.startIndex < earliest)) earliest = body.startIndex;
    }
    nodes.push(...current.namedChildren);
  }
  return earliest;
}

function memberNodes(node) {
  if (node.type !== "class_declaration" && node.type !== "abstract_class_declaration" && node.type !== "interface_declaration" && node.type !== "enum_declaration") return [];
  const body = node.childForFieldName("body");
  if (!body) return [];
  const members = [];
  let decorators = [];
  for (const child of body.namedChildren) {
    if (child.type === "decorator") { decorators.push(child); continue; }
    if (MEMBERS.has(child.type) || (node.type === "enum_declaration" && child.type === "property_identifier")) members.push({ node: child, startNode: decorators[0] ?? child });
    decorators = [];
  }
  return members;
}

function memberName(owner, node) {
  const name = nameFor(node);
  if (name) return owner ? `${owner}.${name}` : name;
  if (node.type === "construct_signature") return owner ? `${owner}.<construct>` : "<construct>";
  if (node.type === "call_signature") return owner ? `${owner}.<call>` : "<call>";
  if (node.type === "index_signature") return owner ? `${owner}.<index>` : "<index>";
  return owner ?? null;
}

function documentationBefore(source, offsets, start) {
  const startByte = offsets[start];
  const from = codeUnitAtByte(offsets, Math.max(0, startByte - MAX_DOCUMENTATION_BYTES));
  const text = source.slice(from, start);
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) end -= 1;
  if (end === 0) return { text: undefined, truncated: false };

  let documentation;
  if (text.slice(0, end).endsWith("*/")) {
    const blockStart = text.lastIndexOf("/*", end - 2);
    const lineStart = text.lastIndexOf("\n", blockStart - 1) + 1;
    if (blockStart >= 0 && /^[ \t]*$/.test(text.slice(lineStart, blockStart))) documentation = text.slice(blockStart, end);
  } else {
    let cursor = end;
    let groupStart = -1;
    while (cursor > 0) {
      const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
      const line = text.slice(lineStart, cursor).replace(/\r$/, "");
      if (!/^[ \t]*\/\/[^\r\n]*$/.test(line)) break;
      groupStart = lineStart;
      cursor = lineStart;
      if (text[cursor - 1] === "\n") cursor -= 1;
      if (text[cursor - 1] === "\r") cursor -= 1;
    }
    if (groupStart >= 0) documentation = text.slice(groupStart, end);
  }
  if (!documentation) return { text: undefined, truncated: false };
  const bounded = boundedText(documentation, 0, documentation.length, MAX_DOCUMENTATION_BYTES);
  return { text: bounded.text || undefined, truncated: from > 0 && text.indexOf(documentation) === 0 ? true : bounded.truncated };
}

function firstParseProblem(root, stopped) {
  const nodes = [root];
  for (let index = 0; index < nodes.length && index < MAX_ERROR_NODES; index += 1) {
    if (stopped()) return root;
    const node = nodes[index];
    if (node.type === "ERROR" || node.isMissing) return node;
    nodes.push(...node.namedChildren);
  }
  return root;
}

function problem(code, message, line) { return { code, message, ...(line === undefined ? {} : { line }) }; }

function declarationFor(source, offsets, sourceNode, node, owner, startNode = sourceNode) {
  const signature = boundedText(source, startNode.startIndex, signatureEnd(node), MAX_SIGNATURE_BYTES);
  const documentation = documentationBefore(source, offsets, startNode.startIndex);
  return {
    declaration: {
      kind: node.type,
      name: owner === undefined ? nameFor(node) : memberName(owner, node),
      signature: signature.text,
      startByte: offsets[startNode.startIndex],
      endByte: offsets[sourceNode.endIndex],
      startLine: startNode.startPosition.row + 1,
      endLine: sourceNode.endPosition.row + 1,
      ...(documentation.text === undefined ? {} : { documentation: documentation.text }),
    },
    truncated: signature.truncated || documentation.truncated,
  };
}

function* outlineNodes(root) {
  for (const sourceNode of root.namedChildren) {
    const node = declarationNode(sourceNode);
    if (sourceNode.type === "import_statement") yield { sourceNode, node: sourceNode };
    else if (sourceNode.type === "export_statement" && (!node || !DECLARATIONS.has(node.type))) yield { sourceNode, node: sourceNode };
    else if (node && DECLARATIONS.has(node.type)) {
      yield { sourceNode, node };
      const owner = nameFor(node);
      for (const member of memberNodes(node)) yield { sourceNode: member.node, node: member.node, owner, startNode: member.startNode };
    }
  }
}

export async function outlineResult(pathname, { cwd = process.cwd(), deadline = DEFAULT_DEADLINE_MS, now = () => performance.now(), beforeOpen } = {}) {
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 10_000) throw usage("--deadline must be an integer between 1 and 10000");
  const started = now();
  const { base, candidate, relative, targetStat } = await secureFile(pathname, cwd);
  const selected = languageFor(relative);
  const { tooLarge, bytes } = await stableRead(candidate, base, targetStat, beforeOpen);
  const result = {
    version: 1,
    path: stripTerminalControl(relative),
    contentHash: tooLarge ? "" : createHash("sha256").update(bytes).digest("hex"),
    language: selected.language,
    parserVersion: selected.parserVersion,
    declarations: [],
    truncated: false,
    problems: [],
  };
  const stop = (code, message) => { result.truncated = true; result.problems.push(problem(code, message)); return result; };
  if (tooLarge) return stop("truncated", `Source exceeds the ${MAX_FILE_BYTES}-byte limit`);
  if (now() - started > deadline) return stop("deadline", "Outline deadline exceeded before parsing");
  if (!selected.grammar) { result.problems.push(problem("unsupported_language", "Only JavaScript, TypeScript, and TSX files are supported")); return result; }

  let source;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { result.problems.push(problem("parse_error", "Source is not valid UTF-8", 1)); return result; }
  const offsets = utf8OffsetMap(source);
  const { default: Parser } = await import("tree-sitter");
  const grammar = selected.grammar === "javascript"
    ? (await import("tree-sitter-javascript")).default
    : (await import("tree-sitter-typescript")).default[selected.grammar];
  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree = parser.parse(source, undefined, { bufferSize: bytes.length + 1 });
  if (now() - started > deadline) return stop("deadline", "Outline deadline exceeded while parsing");
  if (tree.rootNode.hasError) {
    const error = firstParseProblem(tree.rootNode, () => now() - started > deadline);
    result.problems.push(problem("parse_error", "Source contains syntax errors", error.startPosition.row + 1));
  }

  let wasTruncated = false;
  const responseBudget = Math.min(MAX_RESPONSE_BYTES, Math.max(MIN_RESPONSE_BYTES, Math.floor(bytes.length * 0.30)));
  let responseBytes = Buffer.byteLength(JSON.stringify({ ...result, declarations: [] }));
  for (const { sourceNode, node, owner, startNode } of outlineNodes(tree.rootNode)) {
    if (now() - started > deadline) return stop("deadline", "Outline deadline exceeded while collecting declarations");
    if (result.declarations.length === MAX_DECLARATIONS) { wasTruncated = true; break; }
    const { declaration, truncated } = declarationFor(source, offsets, sourceNode, node, owner, startNode);
    const declarationBytes = Buffer.byteLength(JSON.stringify(declaration)) + (result.declarations.length === 0 ? 0 : 1);
    if (responseBytes + declarationBytes > responseBudget - TERMINAL_PROBLEM_RESERVE) { wasTruncated = true; break; }
    result.declarations.push(declaration);
    responseBytes += declarationBytes;
    wasTruncated ||= truncated;
  }
  if (wasTruncated) stop("truncated", "Outline reached a response safety limit");
  return result;
}

export const explore = [{
  names: ["outline"],
  usage: "outline PATH [--cwd DIR --deadline MS]",
  summary: "show bounded syntax declarations from a local source file",
  run: async (context) => outlineResult(positional(context.positionals, 1, "Path"), {
    cwd: context.options.has("cwd") ? required(context.options, "cwd") : process.cwd(),
    deadline: context.options.has("deadline")
      ? integer(required(context.options, "deadline"), "--deadline", { min: 1, max: 10_000 })
      : DEFAULT_DEADLINE_MS,
  }).then((result) => ({ result, negative: result.problems.some((entry) => entry.code === "parse_error" || entry.code === "deadline") })),
}];
