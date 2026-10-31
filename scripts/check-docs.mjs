import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tools } from '../dist/tools.js';
import { checkToolDocs } from './generate-tool-docs.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(resolve(root, path), 'utf8');
const pkg = JSON.parse(read('package.json'));
const walk = directory => readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);
const docs = ['README.md', 'CONTRIBUTING.md', 'CLAUDE.md', ...walk('docs').filter(file => file.endsWith('.md'))];
const stripFences = text => text.replace(/```[^\n]*\n[\s\S]*?```/g, '');
function anchors(text) {
  const counts = new Map();
  return new Set([...stripFences(text).matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, title]) => {
    const slug = title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const count = counts.get(slug) || 0;
    counts.set(slug, count + 1);
    return count ? `${slug}-${count}` : slug;
  }));
}

checkToolDocs();
let links = 0;
let jsonBlocks = 0;
for (const file of docs) {
  const content = read(file);
  for (const [, json] of content.matchAll(/```json\s*\n([\s\S]*?)```/g)) {
    assert.doesNotThrow(() => JSON.parse(json), `${file}: invalid fenced JSON`);
    jsonBlocks++;
  }
  for (const [, href] of stripFences(content).matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) continue;
    const [path, fragment] = href.split('#');
    const target = path ? resolve(root, dirname(file), decodeURIComponent(path)) : resolve(root, file);
    assert.ok(existsSync(target), `${file}: missing link target ${href}`);
    if (fragment && extname(target) === '.md') assert.ok(anchors(readFileSync(target, 'utf8')).has(decodeURIComponent(fragment)), `${file}: missing anchor ${href}`);
    links++;
  }
  // Keep documented release pins synchronized when a later release is prepared.
  for (const [, version] of content.matchAll(/(?:@ttpears\/gitlab-mcp-server@|ghcr\.io\/ttpears\/gitlab-mcp:)(\d+\.\d+\.\d+)/g)) {
    assert.equal(version, pkg.version, `${file}: stale release pin`);
  }
}

const configSource = read('src/config.ts') + read('src/index.ts') + read('src/oauth-store.ts');
const envNames = new Set([...configSource.matchAll(/process\.env\.([A-Z][A-Z_\d]+)/g)].map(([, name]) => name));
const removedEnvNames = new Set(['GITLAB_AUTH_MODE', 'GITLAB_SHARED_ACCESS_TOKEN']);
const configDoc = read('docs/configuration.md');
for (const name of envNames) assert.ok(configDoc.includes(`\`${name}\``), `Missing configuration documentation for ${name}`);

for (const file of ['.clauderc.example', 'claude_desktop_config.example.json', 'mcp.json', 'mcp-inspector.example.json']) {
  const example = JSON.parse(read(file));
  const server = example.mcpServers?.gitlab;
  assert.equal(server?.command, 'npx', `${file}: expected runnable npx example`);
  assert.deepEqual(server.args, ['-y', `${pkg.name}@${pkg.version}`], `${file}: package/version drift`);
  for (const [name, value] of Object.entries(server.env || {})) {
    assert.ok(envNames.has(name) && !removedEnvNames.has(name), `${file}: unsupported environment variable ${name}`);
    assert.equal(typeof value, 'string', `${file}: environment must contain string values`);
  }
  assert.ok(!(server.env.GITLAB_TOKEN && server.env.GITLAB_READ_TOKEN), `${file}: conflicting fallback tokens`);
}

// Validate real workflow examples against the registry, including refinements.
const usage = read('docs/usage.md');
let calls = 0;
function checkCall(name, args) {
  const tool = tools.find(tool => tool.name === name);
  assert.ok(tool, `Unknown documented tool ${name}`);
  assert.doesNotThrow(() => tool.inputSchema.parse(args), `Invalid documented call to ${name}`);
  calls++;
}
for (const [, name, json] of usage.matchAll(/`([a-z_]+)` — `(\{[^\n`]+\})`/g)) checkCall(name, JSON.parse(json));
for (const [, name, json] of usage.matchAll(/```text\n([a-z_]+)\n```\s*```json\n([\s\S]*?)```/g)) checkCall(name, JSON.parse(json));
assert.ok(calls >= 10, 'Expected workflow examples to be validated');
assert.ok(read('README.md').includes(`**${tools.length} tools**`), 'README tool count is stale');
console.log(`Documentation checks passed: ${docs.length} pages, ${links} local links, ${jsonBlocks} JSON blocks, ${calls} tool calls, ${tools.length} tools.`);
