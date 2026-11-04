import path from 'node:path';
import { workspaceRoot } from '../io/paths.mjs';

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizeHintPath(str, root = workspaceRoot()) {
  if (!str) return '';
  let s = String(str);
  if (root) {
    const normRoot = path.resolve(root);
    s = s.replaceAll(normRoot, '.');
    s = s.replaceAll(normRoot.replace(/\\/g, '/'), '.');
  }
  s = s.replace(/[A-Za-z]:[\\/][^\s"']+/g, '<path>');
  s = s.replace(/(?:^|[\s"'])\/(?:[\w.-]+\/)+[\w.-]+/g, ' <path>');
  return s.trim();
}

export function normalizeErrorSignature(tool, errorText) {
  const toolName = String(tool || 'unknown').trim();
  const raw = String(errorText || '').trim();
  const cleaned = raw
    .replace(/[A-Za-z]:[\\/][^\s'",;()]+/g, '<PATH>')
    .replace(/(?:^|[\s'",;()])\/(?:[\w.-]+\/)+[\w.-]+/g, ' <PATH>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TS>')
    .replace(/\b0x[0-9a-fA-F]+\b/g, '<HEX>')
    .replace(/\b\d+\b/g, '<NUM>')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    tool: toolName,
    raw,
    cleaned,
    signature: `${toolName}:${cleaned}`,
  };
}

export function extractErrorDetails(event) {
  const d = event.data && typeof event.data === 'object' ? event.data : {};
  const msg = d.error || event.error || event.summary || d.cmd_line || d.cmd_head || d.stderr || event.target || event.status || '';
  return String(msg).trim();
}

export function buildRegexPattern(cleaned, raw) {
  const input = String(cleaned || raw || '').trim();
  if (!input) return '.*';
  const tokens = input.split(/<PATH>|<NUM>|<TS>|<HEX>/);
  const escapedParts = tokens.map((part) => escapeRegex(part.trim())).filter(Boolean);
  const pattern = escapedParts.join('.*');
  const candidate = pattern.slice(0, 100);
  if (candidate.length >= 4) {
    try {
      new RegExp(candidate);
      return candidate;
    } catch {}
  }
  const fallback = escapeRegex(raw.slice(0, 50));
  return fallback.length >= 4 ? fallback : '.*';
}
