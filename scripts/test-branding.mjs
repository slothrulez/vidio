import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const legacyIdentity = /h(?:uo|u)[\s_-]*xiao[\s_-]*ying|[货貨]\s*小\s*影|扣子编程|Coze Code/iu;

test('package and documentation identify vidio without changing package management', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'vidio');
  assert.equal(pkg.packageManager, 'pnpm@9.0.0');
  assert.equal(pkg.scripts.build, 'bash ./scripts/build.sh');
  for (const path of ['README.md', 'AGENTS.md', 'DESIGN.md']) {
    const text = read(path);
    assert.match(text, /^# vidio/m);
    assert.doesNotMatch(text, legacyIdentity);
  }
});

test('page metadata and social previews use vidio, not template attribution', () => {
  const source = read('src/app/layout.tsx');
  const literal = source.match(/export const metadata: Metadata = ([\s\S]*?);\n/);
  assert.ok(literal);
  const metadata = runInNewContext(`(${literal[1]})`, {
    URL,
    projectDomain: 'http://localhost:5000',
  });
  assert.match(metadata.title.default, /^vidio \|/);
  assert.equal(metadata.title.template, '%s | vidio');
  assert.equal(metadata.applicationName, 'vidio');
  assert.match(metadata.description, /vidio/);
  assert.equal(metadata.openGraph.siteName, 'vidio');
  assert.match(metadata.openGraph.title, /^vidio \|/);
  assert.match(metadata.twitter.title, /^vidio \|/);
  assert.equal(metadata.twitter.card, 'summary_large_image');
  assert.equal(metadata.authors, undefined);
  assert.equal(metadata.generator, undefined);
  assert.equal(metadata.openGraph.url, undefined);
  assert.doesNotMatch(source, /code\.coze\.cn/);
  assert.doesNotMatch(source, legacyIdentity);
  assert.match(source, /<html lang="en">/);
  assert.match(read('src/app/opengraph-image.alt.txt'), /^vidio/);
});

test('social-image origins reuse the existing project domain setting', () => {
  const source = read('src/app/layout.tsx');
  assert.match(source, /process\.env\.COZE_PROJECT_DOMAIN_DEFAULT \|\| 'http:\/\/localhost:5000'/);
  const literal = source.match(/export const metadata: Metadata = ([\s\S]*?);\n/);
  assert.ok(literal);
  for (const [projectDomain, origin] of [
    ['http://localhost:5000', 'http://localhost:5000'],
    ['vidio.example', 'https://vidio.example'],
    ['https://vidio.example', 'https://vidio.example'],
  ]) {
    const metadata = runInNewContext(`(${literal[1]})`, { URL, projectDomain });
    assert.equal(metadata.metadataBase.origin, origin);
  }
});

test('both chat pages and the agent use the same identity', () => {
  const page = read('src/app/page.tsx');
  const visibleSource = page.replace(/^const (?:USER_AVATAR_STORAGE_KEY|SESSIONS_STORAGE_KEY) = '[^']+';\r?\n/gm, '');
  assert.doesNotMatch(visibleSource, legacyIdentity);
  assert.equal((page.match(/alt="vidio"/g) ?? []).length, 3);
  assert.equal((page.match(/您好！我是「vidio」/g) ?? []).length, 2);
  assert.match(page, /link\.download = `vidio_/);
  const chat = read('src/app/chat/page.tsx');
  assert.match(chat, /您好！我是 vidio/);
  assert.doesNotMatch(chat, legacyIdentity);
  const prompt = read('src/agent/chat-node.ts');
  assert.match(prompt, /智能助手【vidio】/);
  assert.match(prompt, /自我介绍统一称呼自己为「vidio」/);
  assert.doesNotMatch(prompt, legacyIdentity);
});

test('API usage display name is branded while its route stays stable', () => {
  const route = read('src/app/api/generate-product-video/route.ts');
  assert.match(route, /name: 'vidio - 商品带货视频生成API'/);
  assert.match(route, /endpoint: '\/api\/generate-product-video'/);
  assert.doesNotMatch(route, legacyIdentity);
});

test('original logo and all icon/social raster sizes are present', () => {
  for (const path of ['public/assets/vidio-icon.svg', 'public/assets/vidio-logo.svg']) {
    const svg = read(path);
    assert.match(svg, /<title id="title">vidio/);
    assert.match(svg, /#B999F3/);
    assert.doesNotMatch(svg, legacyIdentity);
  }
  for (const [path, width, height] of [
    ['public/assets/agent-avatar.png', 512, 512],
    ['src/app/icon.png', 512, 512],
    ['src/app/apple-icon.png', 180, 180],
    ['src/app/opengraph-image.png', 1200, 630],
  ]) {
    const png = readFileSync(fileURLToPath(new URL(path, root)));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', path);
    assert.equal(png.readUInt32BE(16), width, path);
    assert.equal(png.readUInt32BE(20), height, path);
  }
  const icon = readFileSync(new URL('src/app/favicon.ico', root));
  assert.equal(icon.readUInt16LE(2), 1);
  assert.equal(icon.readUInt16LE(4), 6);
});
