import { copyFile, mkdir } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const destination = new URL('web/vendor/', root);
await mkdir(destination, { recursive: true });
for (const [source, name] of [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/xterm/LICENSE', 'xterm.LICENSE'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['@xterm/addon-fit/LICENSE', 'addon-fit.LICENSE'],
]) {
  await copyFile(new URL(`node_modules/${source}`, root), new URL(name, destination));
}
