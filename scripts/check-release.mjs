import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const pkg = read('package.json');
const lock = read('package-lock.json');
const plugin = read('.claude-plugin/plugin.json');
assert.equal(plugin.version, pkg.version, 'Claude plugin version must match package.json');
assert.equal(lock.version, pkg.version, 'Lockfile version must match package.json');
assert.equal(lock.packages[''].version, pkg.version, 'Lockfile root package must match package.json');
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
assert.ok(changelog.includes(`## [${pkg.version}] - `), 'Current version needs a dated changelog entry');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const compose = readFileSync(new URL('../docker-compose.override.yml', import.meta.url), 'utf8');
for (const source of [readme, compose]) {
  const versions = [...source.matchAll(/ghcr\.io\/ttpears\/gitlab-mcp:([\d.]+)/g)].map(match => match[1]);
  assert.ok(versions.length > 0, 'Deployment examples must pin an image version');
  assert.ok(versions.every(version => version === pkg.version), 'Deployment examples must match package.json');
}
console.log(`Release metadata is consistent for ${pkg.version}`);
