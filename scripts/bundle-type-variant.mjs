// gdy paczkę składa SignPath albo quick-sharun zamiast `tauri bundle`, typ paczki wpisujemy sami jak on
// shortcut: odtwarza wewnętrzny znacznik tauri-utils (platform.rs); gdy Tauri zmieni format, skrypt przerwie build
import { readFileSync, writeFileSync } from 'node:fs';

const [src, dst, kind] = process.argv.slice(2);
if (!src || !dst || !['NSS', 'MSI', 'APP'].includes(kind)) {
  console.error('usage: bundle-type-variant.mjs <in> <out> NSS|MSI|APP');
  process.exit(2);
}
const from = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
const to = Buffer.from(`__TAURI_BUNDLE_TYPE_VAR_${kind}`);
const buf = readFileSync(src);
const at = buf.indexOf(from);
if (at < 0 || buf.indexOf(from, at + 1) >= 0) {
  throw new Error(`${src}: expected exactly one bundle-type marker`);
}
to.copy(buf, at);
writeFileSync(dst, buf);
