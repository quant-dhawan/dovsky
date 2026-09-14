#!/usr/bin/env node
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(packageRoot, "dist", "build-provenance.json");
const temporary = `${destination}.${process.pid}.tmp`;
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(temporary, `${JSON.stringify({ builtAt: new Date().toISOString() })}\n`, { mode: 0o644 });
renameSync(temporary, destination);
