import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

export function collectJsonlFiles(dir) {
  const files = [];
  try {
    if (!fs.existsSync(dir)) return files;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        files.push(...collectJsonlFiles(full));
      } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        files.push(full);
      }
    }
  } catch {}
  return files.sort((a, b) => b.localeCompare(a));
}

// Doc audit jsonl moi nhat truoc, co tran byte + timeout. Tra { events, scannedEvents, truncated }.
export async function readAuditEvents(auditDir, maxBytes, deadline) {
  let truncated = null;
  let totalBytes = 0;
  let scannedEvents = 0;
  const events = [];
  for (const filePath of collectJsonlFiles(auditDir)) {
    if (Date.now() > deadline) {
      truncated = 'timeout';
      break;
    }
    let fileSize = 0;
    try {
      fileSize = fs.statSync(filePath).size;
    } catch {
      continue;
    }
    if (totalBytes + fileSize > maxBytes) {
      truncated = 'max_bytes';
      break;
    }
    totalBytes += fileSize;
    try {
      const rl = createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if ((scannedEvents & 1023) === 0 && Date.now() > deadline) {
          truncated = 'timeout';
          rl.close();
          break;
        }
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed);
          if (ev && typeof ev === 'object' && !Array.isArray(ev)) {
            events.push(ev);
            scannedEvents++;
          }
        } catch {}
      }
    } catch {}
    if (truncated) break;
  }
  return { events, scannedEvents, truncated };
}
