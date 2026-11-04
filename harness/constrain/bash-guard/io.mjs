// Tien ich I/O + hang agy cho bash-guard: stdio dung chung o core/io/stdio.mjs; hang agy o core/io/agy-payload.mjs.
export { readJsonStdin, isMain, writeOut } from '../../core/io/stdio.mjs';
export { ALLOW, getSid, getCommand } from '../../core/io/agy-payload.mjs';
