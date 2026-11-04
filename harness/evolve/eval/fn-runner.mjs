#!/usr/bin/env node
// node fn-runner.mjs <module tuong doi harness/> <export>; stdin = mang tham so JSON -> stdout {"value": ...}. Chi module trong harness/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [mod, name] = process.argv.slice(2);
const file = path.resolve(HARNESS, mod || '');
const rel = path.relative(HARNESS, file);
if (!mod || !name || rel.startsWith('..') || path.isAbsolute(rel)) { console.error('fn-runner: module phai nam trong harness/'); process.exit(2); }
let args = [];
try { const s = fs.readFileSync(0, 'utf8').trim(); args = s ? JSON.parse(s) : []; } catch (e) { console.error('fn-runner: stdin khong phai JSON: ' + e.message); process.exit(2); }
const m = await import(pathToFileURL(file).href);
if (typeof m[name] !== 'function') { console.error(`fn-runner: khong co ham ${name}`); process.exit(2); }
const v = await m[name](...(Array.isArray(args) ? args : [args]));
console.log(JSON.stringify({ value: v === undefined ? null : v }));
