import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const legacyIdentity = /h(?:uo|u)[\s_-]*xiao[\s_-]*ying|[货貨]\s*小\s*影|扣子编程|Coze Code|cyj-765944042/iu;
const cjk = /\p{Script=Han}/u;
const nonEnglishOption = /\b(?:mandarin|cantonese|putonghua)\b|zh[-_](?:CN|TW|HK)|yue|cmn/i;
const trackedFiles = () =>
  execFileSync('git', ['ls-files', '-z'], { cwd: fileURLToPath(root), encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
const textLike = /\.(?:tsx?|mjs|cjs|js|json|md|sql|sh|ya?ml|txt|css|svg|html|npmrc|gitignore|example)$|^\.(?:npmrc|gitignore|env\.example)$|\/\.(?:npmrc|gitignore|env\.example)$/;

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
  assert.equal((page.match(/Hi! I am vidio, your product video assistant\./g) ?? []).length, 2);
  assert.match(page, /link\.download = `vidio_/);
  const chat = read('src/app/chat/page.tsx');
  assert.match(chat, /Hi! I am vidio, your product video assistant\./);
  assert.doesNotMatch(chat, legacyIdentity);
  const prompt = read('src/agent/chat-node.ts');
  assert.match(prompt, /^const SYSTEM_PROMPT = `You are vidio,/m);
  assert.match(prompt, /Always introduce yourself as vidio/);
  assert.match(prompt, /Always reply in English/);
  assert.doesNotMatch(prompt, legacyIdentity);
});

test('API usage display name is branded while its route stays stable', () => {
  const route = read('src/app/api/generate-product-video/route.ts');
  assert.match(route, /name: 'vidio - product video generation API'/);
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

test('tracked text files are English-only with no legacy identity or hosting markers', () => {
  const offenders = [];
  for (const path of trackedFiles()) {
    if (path === 'pnpm-lock.yaml' || !textLike.test(path)) continue;
    if (cjk.test(path)) offenders.push(`${path}: non-English path`);
    const text = read(path);
    if (path === 'scripts/test-branding.mjs') continue;
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (/^const (?:USER_AVATAR_STORAGE_KEY|SESSIONS_STORAGE_KEY) = /.test(line)) return;
      if (cjk.test(line)) offenders.push(`${path}:${index + 1}: CJK text`);
      if (legacyIdentity.test(line)) offenders.push(`${path}:${index + 1}: legacy identity`);
      if (/dev\.coze\.site|coze check-bins|\.cozeproj|\.coze-logs/.test(line)) offenders.push(`${path}:${index + 1}: hosting marker`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('no Mandarin or Cantonese options remain in application code', () => {
  const offenders = [];
  for (const path of trackedFiles()) {
    if (!/^(?:src|scripts|migrations)\//.test(path) || !textLike.test(path)) continue;
    if (/^scripts\/test-/.test(path)) continue;
    read(path).split('\n').forEach((line, index) => {
      if (nonEnglishOption.test(line)) offenders.push(`${path}:${index + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(offenders, []);
  assert.match(read('src/studio/types.ts'), /language: z\.literal\("english"\)/);
  assert.match(read('src/app/page.tsx'), /voiceLanguage: 'english'/);
  assert.match(read('migrations/0007_english_only.sql'), /"english"/);
});

test('no sample media remains in public', () => {
  const media = trackedFiles().filter((path) => path.startsWith('public/') && /\.(?:mp4|mp3|wav|m4a|mov|srt|ass)$/i.test(path));
  assert.deepEqual(media, []);
});
