import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { NotFound, Wiki, extractLinks, parseMeta, privacyProblems, splitFrontmatter } from '../src/wiki.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wiki-test-'));
  mkdirSync(join(dir, 'pages'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const page = (title: string, description: string, body = 'Body.', extra = '') => `---\ntitle: ${title}\ndescription: ${description}\n${extra}---\n\n${body}\n`;
const put = (slug: string, content: string) => writeFileSync(join(dir, 'pages', `${slug}.md`), content);
const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
function initGit() {
  git('init', '-q');
  git('config', 'user.name', 'Owner');
  git('config', 'user.email', 'owner@example.test');
  git('config', 'commit.gpgsign', 'false');
}

describe('parsing', () => {
  test('frontmatter, lists and links', () => {
    const { fm, body } = splitFrontmatter('---\ntitle: "Hub"\ndescription: One line\naliases: [team hub, mcp hub]\ntags:\n  - project\n  - mcp\nupdated: 2026-11-21\n---\nSee [[other-page]] and [[x]] and [[x]].\n');
    const m = parseMeta(fm, 'hub');
    assert.deepEqual(m, { title: 'Hub', description: 'One line', aliases: ['team hub', 'mcp hub'], tags: ['project', 'mcp'], updated: '2026-11-21' });
    assert.deepEqual(extractLinks(body), ['other-page', 'x']);
    assert.equal(splitFrontmatter('no frontmatter').fm, null);
    assert.equal(parseMeta(null, 'slug').title, 'slug');
    assert.equal(splitFrontmatter('---\ntitle: a---b\n---\nx').fm, 'title: a---b');
  });

  test('the privacy check names the kind and never the value', () => {
    const login = userInfo().username;
    const cases: [string, string][] = [
      ['key sk-abcdefghijklmnopqrstuvwx', 'API key'],
      ['token ghp_abcdefghijklmnopqrstuvwxyz0123', 'GitHub token'],
      ['AKIAABCDEFGHIJKLMNOP', 'AWS key'],
      ['-----BEGIN RSA PRIVATE KEY-----', 'private key'],
      ['password: hunter2hunter2', 'password'],
      ['write to someone@example.com', 'email'],
      ['see /Users/someone/code', 'home-directory'],
      ['see /home/someone/code', 'home-directory'],
      [`run by ${login} today`, 'login name'],
    ];
    for (const [text, kind] of cases) {
      const found = privacyProblems(text);
      assert.ok(found.some((f) => f.includes(kind)), `${kind}: ${found}`);
      assert.ok(!found.join().includes('hunter2'));
    }
    assert.deepEqual(privacyProblems('A plain page about ~/projects and token: short'), []);
  });
});

describe('reading and search', () => {
  test('lists pages newest first, caches by mtime and sees outside edits', () => {
    const w = new Wiki(dir);
    put('older', page('Older', 'Old page', 'x', 'updated: 2026-01-01\n'));
    put('newer', page('Newer', 'New page', 'y', 'updated: 2026-06-01\n'));
    put('Bad_Name', page('Bad', 'ignored'));
    writeFileSync(join(dir, 'pages', 'notes.txt'), 'ignored');
    assert.deepEqual(w.pages().map((p) => p.slug), ['newer', 'older']);
    const v1 = w.page('older')!.version;
    put('older', page('Older', 'Edited elsewhere', 'changed', 'updated: 2026-01-01\n'));
    assert.notEqual(w.page('older')!.version, v1);
    assert.equal(w.page('older')!.meta.description, 'Edited elsewhere');
    rmSync(join(dir, 'pages', 'newer.md'));
    assert.equal(w.page('newer'), undefined);
    assert.equal(w.page('../etc/passwd'), undefined);
  });

  test('a missing pages folder is an empty wiki', () => {
    assert.deepEqual(new Wiki(join(dir, 'nothing')).pages(), []);
  });

  test('search: metadata first, body needs enough words, stopwords dropped, snippet around the hit', () => {
    const w = new Wiki(dir);
    put('deploy', page('Deploying the hub', 'Where it runs', 'Runs on the always-on mini behind tailscale serve.', 'aliases: [shipping]\ntags: [ops]\n'));
    put('notes', page('Random notes', 'Misc', `${'filler '.repeat(40)} the tailscale serve setup uses port 7600 ${'more '.repeat(40)}`));
    put('other', page('Other', 'Unrelated', 'tailscale only here'));
    const hits = w.search('how does tailscale serve work');
    assert.deepEqual(hits.map((h) => h.slug), ['deploy', 'notes'], 'other has one body word, below the threshold of 2');
    assert.match(hits[1].snippet, /^… .*tailscale serve setup.* …$/);
    assert.ok(hits[1].snippet.split(' ').length <= 34);
    assert.deepEqual(w.search('shipping').map((h) => h.slug), ['deploy']);
    assert.deepEqual(w.search('ops').map((h) => h.slug), ['deploy'], 'tags count');
    assert.deepEqual(w.search('the and for'), []);
    for (let i = 0; i < 12; i++) put(`many-${i}`, page(`Many ${i}`, 'all about zebras'));
    assert.equal(w.search('zebras').length, 8);
  });

  test('backlinks', () => {
    const w = new Wiki(dir);
    put('a', page('A', 'a', 'see [[b]] and [[a]]'));
    put('b', page('B', 'b', 'nothing'));
    assert.deepEqual(w.linksTo('b'), ['a']);
    assert.deepEqual(w.linksTo('a'), []);
  });
});

describe('save without git', () => {
  test('creates, sets updated, mode 600, no temp files left', async () => {
    const w = new Wiki(dir);
    const r = await w.save({ slug: 'new-page', content: page('New', 'A page', 'Hello', 'updated: 1999-01-01\n'), message: 'add', agent: 'claude' });
    assert.equal(r.created, true);
    assert.equal(r.note, '');
    const text = readFileSync(join(dir, 'pages', 'new-page.md'), 'utf8');
    assert.match(text, new RegExp(`updated: ${new Date().getFullYear()}-`));
    assert.doesNotMatch(text, /1999/);
    assert.equal(statSync(join(dir, 'pages', 'new-page.md')).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(dir, 'pages')), ['new-page.md']);
    assert.equal(w.page('new-page')!.version, r.version);
    // updated is added when missing
    await w.save({ slug: 'second', content: '---\ntitle: S\ndescription: d\n---\nbody', message: 'm', agent: 'claude' });
    assert.match(readFileSync(join(dir, 'pages', 'second.md'), 'utf8'), /^---\ntitle: S\ndescription: d\nupdated: \d{4}-\d\d-\d\d\n---\nbody\n$/);
    assert.deepEqual(await w.history('second'), []);
    assert.deepEqual(await w.changes(), []);
  });

  test('versions: create-only, update needs the current version, stale is refused', async () => {
    const w = new Wiki(dir);
    const a = await w.save({ slug: 'p', content: page('P', 'd'), message: 'one', agent: 'claude' });
    await assert.rejects(w.save({ slug: 'p', content: page('P', 'd2'), message: 'two', agent: 'codex' }), /already exists/);
    await assert.rejects(w.save({ slug: 'q', content: page('Q', 'd'), message: 'x', agent: 'codex', version: a.version }), /doesn't exist yet/);
    const b = await w.save({ slug: 'p', content: page('P', 'd2'), message: 'two', agent: 'codex', version: a.version });
    assert.equal(b.created, false);
    await assert.rejects(w.save({ slug: 'p', content: page('P', 'd3'), message: 'three', agent: 'claude', version: a.version }), /changed since you read it; read it again/);
    put('p', page('P', 'edited by hand'));
    await assert.rejects(w.save({ slug: 'p', content: page('P', 'd4'), message: 'four', agent: 'claude', version: b.version }), /changed since/);
  });

  test('rules: slug, size, frontmatter, privacy', async () => {
    const w = new Wiki(dir);
    const ok = page('T', 'd');
    for (const slug of ['Bad', '-x', 'a_b', '../x', '', 'x'.repeat(81)]) await assert.rejects(w.save({ slug, content: ok, message: 'm', agent: 'a' }), /slug/, slug);
    await assert.rejects(w.save({ slug: 'big', content: page('T', 'd', 'x'.repeat(41 * 1024)), message: 'm', agent: 'a' }), /40 KB/);
    await assert.rejects(w.save({ slug: 'nofm', content: 'just text', message: 'm', agent: 'a' }), /frontmatter/);
    await assert.rejects(w.save({ slug: 'notitle', content: '---\ndescription: d\n---\nx', message: 'm', agent: 'a' }), /title and a description/);
    await assert.rejects(w.save({ slug: 'nodesc', content: '---\ntitle: t\n---\nx', message: 'm', agent: 'a' }), /title and a description/);
    await assert.rejects(w.save({ slug: 'leak', content: page('T', 'd', 'mail me at someone@example.com'), message: 'm', agent: 'a' }), (e: Error) => /an email address/.test(e.message) && !/someone@/.test(e.message));
    await assert.rejects(w.save({ slug: 'leak', content: ok, message: 'see /Users/x/y', agent: 'a' }), /home-directory/);
    assert.deepEqual(readdirSync(join(dir, 'pages')), []);
  });

  test('saves are serialized', async () => {
    const w = new Wiki(dir);
    const base = await w.save({ slug: 'race', content: page('R', 'd'), message: 'm', agent: 'a' });
    const results = await Promise.allSettled([
      w.save({ slug: 'race', content: page('R', 'one'), message: 'm', agent: 'a', version: base.version }),
      w.save({ slug: 'race', content: page('R', 'two'), message: 'm', agent: 'b', version: base.version }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  });
});

describe('with git', () => {
  test('commits only the saved page, with the agent as author', async () => {
    initGit();
    put('existing', page('Existing', 'tracked'));
    git('add', '-A');
    git('commit', '-qm', 'seed');
    writeFileSync(join(dir, 'other-file.txt'), 'owner is working on this');
    put('unrelated', page('Unrelated', 'uncommitted edit by the owner'));
    const w = new Wiki(dir);
    const r = await w.save({ slug: 'fresh', content: page('Fresh', 'new', 'Body with [[existing]]'), message: 'Record the decision and why', agent: 'codex' });
    assert.equal(r.note, '');
    assert.equal(git('log', '-1', '--format=%an <%ae> | %cn <%ce> | %s').trim(), 'codex <codex@agent-team-up> | agent-team-up <agent-team-up@localhost> | Record the decision and why');
    assert.equal(git('show', '--name-only', '--format=', 'HEAD').trim(), 'pages/fresh.md');
    assert.match(git('status', '--porcelain'), /\?\? other-file\.txt/);
    assert.match(git('status', '--porcelain'), /\?\? pages\/unrelated\.md/);

    const v = w.page('fresh')!.version;
    await w.save({ slug: 'fresh', content: page('Fresh', 'newer'), message: 'Second edit', agent: 'claude', version: v });
    const hist = await w.history('fresh');
    assert.deepEqual(hist.map((h) => [h.author, h.message]), [['claude', 'Second edit'], ['codex', 'Record the decision and why']]);
    const changes = await w.changes();
    assert.equal(changes[0].message, 'Second edit');
    assert.deepEqual(changes[0].pages, ['fresh']);
    assert.ok(changes.some((c) => c.message === 'seed' && c.pages.includes('existing')));
    const c = await w.commit(changes[0].sha.slice(0, 8));
    assert.equal(c.author, 'claude');
    assert.match(c.diff, /^diff --git a\/pages\/fresh\.md/m);
    assert.match(c.diff, /^\+description: newer$/m);
    assert.match(c.diff, /^-description: new$/m);
  });

  test('a commit failure is reported and the save stands', async () => {
    initGit();
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const w = new Wiki(dir);
    const r = await w.save({ slug: 'hooked', content: page('H', 'd'), message: 'm', agent: 'claude' });
    assert.match(r.note, /git commit failed/);
    assert.ok(w.page('hooked'));
  });

  test('commit() validates the sha and reports unknown commits', async () => {
    initGit();
    const w = new Wiki(dir);
    await assert.rejects(w.commit('--output=x'), /7 to 40 hex/);
    await assert.rejects(w.commit('abc'), /7 to 40 hex/);
    await assert.rejects(w.commit('deadbeef'), NotFound);
  });

  test('a folder that is not a repo has no history', async () => {
    const w = new Wiki(dir);
    assert.equal(await w.isRepo(), false);
    await assert.rejects(w.commit('deadbeef'), NotFound);
  });
});
