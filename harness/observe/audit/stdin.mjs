// Doc stdin bat dong bo co tran (maxBytes) va watchdog (timeoutMs). Het han/loi -> tra ve phan da doc (khong nem).
export function readStdinRaw({ maxBytes = 1048576, timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0, done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { process.stdin.pause(); process.stdin.removeAllListeners('data'); } catch {}
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      process.stdin.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { chunks.push(c.subarray(0, c.length - (size - maxBytes))); finish(); return; }
        chunks.push(c);
      });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch { finish(); }
  });
}
