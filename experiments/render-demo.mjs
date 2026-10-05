// Draws docs/demo.svg from the output that demo-codex.mjs saved, in the
// colors mcp-janitor uses in a terminal.
//
//   node experiments/render-demo.mjs <demo folder>
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const list = fs.readFileSync(path.join(dir, 'list.txt'), 'utf8').trimEnd().split('\n').map(line => line.replace(/^\$ mcp-janitor/, '$ npx mcp-janitor'));
const stop = fs.readFileSync(path.join(dir, 'stop.txt'), 'utf8').trimEnd().split('\n').map(line => line.replace(/^\$ mcp-janitor/, '$ npx mcp-janitor'));
const lines = [...list, '', ...stop];

const color = { text: '#e6edf3', dim: '#7d8590', yellow: '#e3b341', green: '#3fb950', prompt: '#7ee787' };
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (text, fill = color.text, weight) => `<tspan fill="${fill}"${weight ? ` font-weight="${weight}"` : ''}>${escape(text)}</tspan>`;

function styled(line) {
  if (line.startsWith('$ ')) return span('$ ', color.prompt) + span(line.slice(2));
  if (/^Stopped /.test(line)) return span(line, color.green);
  if (/^\S.*\(pid \d+\): /.test(line)) return span(line, color.text, 'bold');
  const conversation = /^(\s+".*")(\s+\(latest\))?$/.exec(line);
  if (conversation) return span(conversation[1]) + (conversation[2] ? span(conversation[2], color.dim) : '');
  const row = /^(\s+\S+\s+\d+(?:\.\d)? [MG]B\s+)(idle \S+(?: \S+)?|active|in use now|–)(\s+)(pid \d+)$/.exec(line);
  if (row) return span(row[1]) + span(row[2], row[2].startsWith('idle') ? color.yellow : color.text) + span(row[3]) + span(row[4], color.dim);
  return span(line);
}

const fontSize = 14;
const lineHeight = 21;
const padding = 24;
const titleBar = 36;
const columns = Math.max(...lines.map(line => line.length));
const width = Math.max(640, Math.ceil(padding * 2 + columns * fontSize * 0.6));
const height = titleBar + padding + lines.length * lineHeight + padding - 6;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" rx="10" fill="#0d1117"/>
  <rect width="${width}" height="${titleBar}" rx="10" fill="#161b22"/>
  <rect y="${titleBar - 10}" width="${width}" height="10" fill="#161b22"/>
  <circle cx="20" cy="18" r="6" fill="#ff5f56"/><circle cx="40" cy="18" r="6" fill="#ffbd2e"/><circle cx="60" cy="18" r="6" fill="#27c93f"/>
  <text x="${width / 2}" y="23" fill="${color.dim}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="13" text-anchor="middle">Codex app server · three conversations, opened two minutes apart</text>
  <text font-family="Cascadia Mono, Consolas, Menlo, monospace" font-size="${fontSize}" xml:space="preserve">
${lines.map((line, i) => `    <tspan x="${padding}" y="${titleBar + padding + i * lineHeight + 8}">${styled(line)}</tspan>`).join('\n')}
  </text>
</svg>
`;
fs.mkdirSync(new URL('../docs/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../docs/demo.svg', import.meta.url), svg);
console.log(`docs/demo.svg: ${width}x${height}`);
