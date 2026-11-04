import { test, expect } from 'bun:test';
import { analyze, run } from './proc-watch.mjs';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const at = (minAgo) => NOW - minAgo * 60000;
const P = (pid, ppid, name, minAgo, cpu = 0, cmd = '') => ({ pid, ppid, name, startMs: at(minAgo), cpu, cmd });
const procs = [
  P(1, 0, 'claude.exe', 500),
  P(2, 1, 'bash.exe', 100, 0, 'bash -c ping'),          // shell cua session hien tai (to tien cua self)
  P(3, 2, 'node.exe', 1, 0, 'node proc-watch'),          // self
  P(10, 2, 'ping.exe', 60, 0, 'ping -n 200 127.0.0.1'),  // killable
  P(11, 2, 'ping.exe', 5, 0, 'ping x'),                  // qua tre
  P(12, 1, 'bun.exe', 90, 500, 'bun run telegram server.ts'), // protected
  P(13, 1, 'node.exe', 90, 500, 'node mcp-server.js'),   // protected (mcp)
  P(14, 1, 'chrome.exe', 90),                            // khong trong watch
  P(15, 1, 'cmd.exe', 90),                               // khong trong watch
  P(20, 999, 'python.exe', 90, 0, 'python x'),           // orphan: chi liet ke
  P(30, 40, 'node.exe', 90, 0, 'node dev'),              // khong phai con claude, khong orphan? 40 ton tai
  P(40, 0, 'explorer.exe', 900),
];

test('chi con chau claude, bao ve self/shell/telegram/mcp', () => {
  const r = analyze(procs, {}, NOW, 3);
  const by = Object.fromEntries(r.listed.map((x) => [x.pid, x]));
  expect(r.killable.map((x) => x.pid)).toEqual([10]);
  expect(by[2].protected).toBe(true);
  expect(by[12].protected).toBe(true);
  expect(by[13].protected).toBe(true);
  expect(by[12].cpuHigh).toBe(true);
  expect(by[11]).toBeUndefined();
  expect(by[20].orphan).toBe(true);
  expect(by[20].killable).toBe(false);
  expect(by[30]).toBeUndefined();
});

test('onlyPid loc killable', () => {
  expect(analyze(procs, { onlyPid: 99 }, NOW, 3).killable.length).toBe(0);
});

test('mac dinh khong kill; --kill goi stub dung PID', () => {
  const killed = []; const logs = [];
  const deps = { list: () => ({ procs }), kill: (pid) => (killed.push(pid), { pid, ok: true }), log: (e) => logs.push(e) };
  const orig = Date.now; Date.now = () => NOW;
  try {
    run({ selfPid: 3 }, deps);
    expect(killed).toEqual([]);
    run({ kill: true, selfPid: 3 }, deps);
  } finally { Date.now = orig; }
  expect(killed).toEqual([10]);
  expect(logs.length).toBe(2);
});

test('loi liet ke khong nem', () => {
  const r = run({}, { list: () => ({ procs: [], error: 'x' }), log: () => {} });
  expect(r.error).toBe('x');
});

test('cay roi tu shell tool Bash: killable; cay roi khac: khong', () => {
  const ps = [
    P(1, 999, 'bash.exe', 100, 0, 'bash -c source shell-snapshots/x.sh'),
    P(2, 1, 'ping.exe', 60, 0, 'ping'),
    P(3, 998, 'node.exe', 100, 0, 'node dev'),
    P(4, 3, 'node.exe', 60, 0, 'node child'),
  ];
  expect(analyze(ps, {}, NOW, 50).killable.map((x) => x.pid)).toEqual([2]);
});
