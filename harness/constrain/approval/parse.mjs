// approval: tach lenh shell-like (bash/ps) + nhan dien lenh con cua shell. Thuan ham, khong IO.
import path from 'node:path';

// ---------- Tach lenh (shell-like, tuyen tinh, khong regex) ----------
/** Vi tri ')' dong cua $( bat dau tai i (dem ngoac, bo qua chuoi '..' va ".."). Khong dong -> str.length. Tuyen tinh. */
function closeParen(str, i, esc) {
  for (let d = 1; i < str.length; i++) {
    const c = str[i];
    if (c === esc) { i++; continue; }
    if (c === "'" || c === '"') { let e = i + 1; while (e < str.length && str[e] !== c) e += str[e] === esc && c === '"' ? 2 : 1; i = e; continue; }
    if (c === '(') d++;
    else if (c === ')' && --d === 0) return i;
  }
  return str.length;
}
/** Vi tri backtick dong (bash, bo qua \x). Khong dong -> str.length. */
function closeTick(str, i) { while (i < str.length && str[i] !== '`') i += str[i] === '\\' ? 2 : 1; return Math.min(i, str.length); }

/** -> [{tokens:[{v,glob,dyn,brace}], piped}] (+ .subs: lenh con $(...)/`...` nam TRONG nhay kep - shell van thuc thi; nhay don thi khong).
 * mode 'bash' (\ escape) | 'ps' (` escape, \ la ky tu thuong, , tach doi so). */
export function split(str, mode = 'bash') {
  const segs = []; const subs = []; let toks = []; let cur = null; let piped = false;
  segs.subs = subs;
  const tok = () => (cur ||= { v: '', glob: false, dyn: false, brace: false });
  const endTok = () => { if (cur) toks.push(cur); cur = null; };
  const endSeg = (nextPiped) => { endTok(); if (toks.length) segs.push({ tokens: toks, piped }); toks = []; piped = nextPiped; };
  const esc = mode === 'ps' ? '`' : '\\';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === esc && i + 1 < str.length) { const n = str[++i]; if (n !== '\n' && n !== '\r') tok().v += n; else if (n === '\r' && str[i + 1] === '\n') i++; continue; }
    if (c === "'") { const t = tok(); i++; while (i < str.length) { if (str[i] === "'") { if (mode === 'ps' && str[i + 1] === "'") { t.v += "'"; i += 2; continue; } break; } t.v += str[i++]; } continue; }
    if (c === '"') {
      const t = tok(); i++;
      while (i < str.length && str[i] !== '"') {
        const ch = str[i];
        if (ch === esc && i + 1 < str.length) { t.v += str[i + 1]; i += 2; continue; }
        if (ch === '$' && str[i + 1] === '(') { const e = closeParen(str, i + 2, esc); subs.push(str.slice(i + 2, e)); t.dyn = true; t.v += str.slice(i, e + 1); i = e + 1; continue; }
        if (mode === 'bash' && ch === '`') { const e = closeTick(str, i + 1); subs.push(str.slice(i + 1, e)); t.dyn = true; i = e + 1; continue; }
        if (ch === '$') t.dyn = true;
        t.v += str[i++];
      }
      continue;
    }
    if (c === ' ' || c === '\t') { endTok(); continue; }
    if (c === '\n' || c === '\r' || c === ';' || c === '(' || c === ')' || (mode === 'bash' && c === '`')) { endSeg(false); continue; }
    if (c === '|') { if (str[i + 1] === '|') { i++; endSeg(false); } else endSeg(true); continue; }
    if (c === '&') { if (str[i + 1] === '&') i++; endSeg(false); continue; }
    if (mode === 'ps' && c === ',') { endTok(); continue; }
    if (c === '>' || c === '<') { endTok(); while (str[i + 1] === '>' || str[i + 1] === '&') i++; continue; }
    const t = tok();
    if (c === '*' || c === '?' || c === '[') t.glob = true;
    if (c === '$') t.dyn = true;
    if (c === '{' && mode === 'bash') t.brace = true;
    t.v += c;
  }
  endSeg(false);
  return segs;
}

export const base = (v) => path.basename(String(v).replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
export const restOf = (args, j) => args.slice(j).map((t) => t.v).join(' ');

const BASH_VAL = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
const PS_SH_VAL = ['-executionpolicy', '-windowstyle', '-workingdirectory', '-inputformat', '-outputformat', '-version', '-configurationname', '-settingsfile', '-custompipename', '-psconsolefile', '-encodedarguments'];
const PS_SH_ALIAS = new Set(['-ep', '-ex', '-ea', '-wd', '-if', '-of']);

/** Lenh con cua shell -> {cmd, mode} | {encoded} | {stdin:true} (doc lenh tu stdin) | null (chay file script / khong co lenh). */
export function shellCommand(name, args) {
  if (name === 'cmd') { // cmd /s /c, /S/C, /k, /r
    for (let j = 0; j < args.length; j++) {
      const v = args[j].v.toLowerCase();
      if (!v.startsWith('/')) return null;
      if (v.split('/').some((x) => x === 'c' || x === 'k' || x === 'r')) return { cmd: restOf(args, j + 1), mode: 'ps' };
    }
    return null;
  }
  if (name === 'wsl') {
    for (let j = 0; j < args.length; j++) {
      const v = args[j].v;
      if (v === '-e' || v === '--exec' || v === '--') return { cmd: restOf(args, j + 1), mode: 'bash' };
      if (/^(-d|--distribution|-u|--user|--cd|--shell-type)$/.test(v)) { j++; continue; }
      if (!v.startsWith('-')) return { cmd: restOf(args, j), mode: 'bash' };
    }
    return null;
  }
  if (name === 'pwsh' || name === 'powershell') { // co ten viet tat bat ky (-c/-com/-enc...), /Flag, --Flag; khong co -Command -> doi so vi tri la lenh
    for (let j = 0; j < args.length; j++) {
      let v = args[j].v;
      if (v === '-') return { stdin: true };
      if (/^\/[a-z]/i.test(v)) v = '-' + v.slice(1); else if (v.startsWith('--')) v = v.slice(1);
      if (!v.startsWith('-')) return { cmd: restOf(args, j), mode: 'ps' };
      const c = v.indexOf(':'); const f = (c > 0 ? v.slice(0, c) : v).toLowerCase(); const inl = c > 0 ? v.slice(c + 1) : null;
      if (f === '-e' || f === '-ec' || (f.length >= 3 && '-encodedcommand'.startsWith(f))) return { encoded: inl ?? (args[j + 1]?.v || '') };
      if (f === '-c' || f === '-cwa' || (f.length >= 3 && ('-command'.startsWith(f) || '-commandwithargs'.startsWith(f)))) return { cmd: (inl ? inl + ' ' : '') + restOf(args, j + 1), mode: 'ps' };
      if (f === '-f' || (f.length >= 3 && '-file'.startsWith(f))) return null;
      if (inl === null && (PS_SH_ALIAS.has(f) || (f.length >= 2 && PS_SH_VAL.some((x) => x.startsWith(f))))) j++;
    }
    return { stdin: true };
  }
  for (let j = 0; j < args.length; j++) { // sh/bash/zsh/dash/ksh: nhan co gop -lc/-ec/-xc (chu c thuong; -C la noclobber)
    const v = args[j].v;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(v)) { const k = args[j + 1]?.v === '--' ? j + 2 : j + 1; return { cmd: args[k]?.v || '', mode: 'bash' }; }
    if (BASH_VAL.has(v)) { j++; continue; }
    if (/^[-+]/.test(v)) continue;
    return null;
  }
  return { stdin: true };
}

/** Giai ma -EncodedCommand (base64 UTF-16LE). Khong hop le -> null. */
export function decodePs(s) {
  if (typeof s !== 'string' || s.length % 4 || !/^[A-Za-z0-9+/]{4,}={0,2}$/.test(s)) return null;
  const b = Buffer.from(s, 'base64'); if (b.length % 2) return null;
  const t = b.toString('utf16le');
  return /^[\t\n\r\x20-\x7e -￼]*$/.test(t) ? t : null;
}
