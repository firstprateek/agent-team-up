// The team wiki: a folder of Markdown pages (<dir>/pages/<slug>.md) read from disk, searched through an in-memory SQLite FTS5 index,
// saved with a version check and a privacy check, and committed to git when the folder is a repo.
// No HTTP or MCP in here.

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TeamError } from './store.ts';

export const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const MAX_PAGE = 40 * 1024;
const MAX_DIFF = 400 * 1024;
// Copied from the owner's ~/.claude/wiki/wiki.py so results feel the same in every app.
const STOPWORDS = new Set(
  `about above after again all also always and any are around because been before being below
between both but can cannot change could did does doing done down each else even every few fix
for from further get got had has have having help her here hers him his how into its just know
let like look make many may might more most much must need new not now off once one only other
our out over own please put really run same see she should show some something still such sure
take tell than that the their them then there these they thing things this those through too
try under until update use used using very want was way well were what when where which while
who whom why will with work would yes yet you your`.split(/\s+/),
);
const MAX_TERMS = 24;
const MIN_BODY_SHARE = 0.25;
const BODY_COLUMN = 4;

/** The words of a query worth searching for, longest first (wiki.py `terms`). */
export function terms(text: string): string[] {
  const words = [...new Set((text.match(/[^\W_]{3,}/gu) ?? []).map((w) => w.toLowerCase()))];
  return words.filter((w) => !STOPWORDS.has(w) && !/^\p{Nd}+$/u.test(w)).sort((a, b) => b.length - a.length).slice(0, MAX_TERMS);
}

/** An FTS5 string literal: nothing inside it is syntax. */
const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;

export class NotFound extends TeamError {}

export interface Meta {
  title: string;
  description: string;
  aliases: string[];
  tags: string[];
  updated: string;
}
export interface Page {
  slug: string;
  meta: Meta;
  body: string;
  raw: string;
  version: string;
  links: string[];
}
export interface Hit {
  slug: string;
  title: string;
  description: string;
  updated: string;
  snippet: string;
}
export interface Change {
  sha: string;
  when: string;
  author: string;
  message: string;
  pages: string[];
}

const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

function unquote(v: string): string {
  const t = v.trim();
  return /^(".*"|'.*')$/.test(t) && t.length > 1 ? t.slice(1, -1) : t;
}

function list(v: string): string[] {
  const t = v.trim();
  const inner = t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
  return inner.split(',').map(unquote).filter(Boolean);
}

/** Splits `---` frontmatter from the body. `fm` is null when there is none. */
export function splitFrontmatter(raw: string): { fm: string | null; body: string } {
  const text = raw.replace(/\r\n/g, '\n');
  const m = /^---\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { fm: null, body: text };
  return { fm: m[1] ?? '', body: text.slice(m[0].length) };
}

export function parseMeta(fm: string | null, slug: string): Meta {
  const kv: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let last = '';
  for (const line of (fm ?? '').split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && last) {
      (lists[last] ??= []).push(unquote(item[1]));
      continue;
    }
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m) {
      last = m[1].toLowerCase();
      kv[last] = m[2];
    }
  }
  const get = (k: string) => unquote(kv[k] ?? '');
  const many = (k: string) => (kv[k]?.trim() ? list(kv[k]) : (lists[k] ?? []));
  return { title: get('title') || slug, description: get('description'), aliases: many('aliases'), tags: many('tags'), updated: get('updated') };
}

export function extractLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\[\[([a-z0-9][a-z0-9-]*)\]\]/g)) out.add(m[1]);
  return [...out];
}

/** What the content must not contain. Names the kinds, never echoes the match. */
export function privacyProblems(text: string): string[] {
  const found: string[] = [];
  const rules: [string, RegExp][] = [
    ['an API key', /\bsk-[A-Za-z0-9_-]{16,}/],
    ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
    ['an AWS key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
    ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['a password or secret', /\b(?:password|passwd|secret|api[_-]?key|token)\b["']?\s*[:=]\s*["']?[^\s"']{8,}/i],
    ['an email address', /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/],
    ['a home-directory path', /(?:^|[^\w])\/(?:Users|home)\/[A-Za-z0-9._-]+/],
  ];
  for (const [name, re] of rules) if (re.test(text)) found.push(name);
  let login = '';
  try {
    login = userInfo().username;
  } catch {
    /* no login name */
  }
  if (login.length >= 2 && new RegExp(`(?<![A-Za-z0-9_-])${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'i').test(text)) found.push("the server user's login name");
  return found;
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function git(dir: string, args: string[], env: Record<string, string> = {}, maxBuffer = 4 * 1024 * 1024): Promise<string> {
  return gitRun(dir, args, env, maxBuffer).then((r) => {
    if (r.code !== 0) throw new Error(r.stderr.trim().split('\n')[0] || 'git failed');
    return r.stdout;
  });
}

/** Like git(), but a non-zero exit is a result, not an error. */
function gitRun(dir: string, args: string[], env: Record<string, string> = {}, maxBuffer = 4 * 1024 * 1024): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', dir, ...args], { env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: 15_000, maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') reject(new Error(stderr?.trim().split('\n')[0] || err.message));
      else resolve({ code: err ? (err.code as number) : 0, stdout, stderr });
    });
  });
}

/** A delimiter no commit message can contain, because it is made up per call. */
const nonce = () => randomBytes(12).toString('hex');

export class Wiki {
  readonly dir: string;
  private cache = new Map<string, { key: string; page: Page }>();
  private queue: Promise<unknown> = Promise.resolve();
  private index: DatabaseSync | undefined;
  private indexed = new Map<string, { id: number; key: string }>();
  private nextId = 1;
  private warned = false;

  constructor(dir: string) {
    this.dir = dir;
  }

  private get pagesDir(): string {
    return join(this.dir, 'pages');
  }

  private file(slug: string): string {
    return join(this.pagesDir, `${slug}.md`);
  }

  /** All pages, newest `updated` first. Re-reads only files whose mtime or size changed. */
  pages(): Page[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.pagesDir);
    } catch {
      /* no pages folder yet */
    }
    const seen = new Set<string>();
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      const slug = n.slice(0, -3);
      if (!SLUG.test(slug)) continue;
      const p = this.load(slug);
      if (p) seen.add(slug);
    }
    for (const k of this.cache.keys()) if (!seen.has(k)) this.cache.delete(k);
    return [...this.cache.values()].map((c) => c.page).sort((a, b) => b.meta.updated.localeCompare(a.meta.updated) || a.slug.localeCompare(b.slug));
  }

  page(slug: string): Page | undefined {
    if (!SLUG.test(slug)) return undefined;
    return this.load(slug);
  }

  private load(slug: string): Page | undefined {
    const f = this.file(slug);
    let key: string;
    try {
      const st = lstatSync(f, { bigint: true });
      if (!st.isFile()) {
        this.cache.delete(slug);
        return undefined;
      }
      key = `${st.mtimeNs}:${st.ctimeNs}:${st.size}:${st.ino}`;
    } catch {
      this.cache.delete(slug);
      return undefined;
    }
    const hit = this.cache.get(slug);
    if (hit?.key === key) return hit.page;
    let bytes: Buffer;
    try {
      bytes = readFileSync(f);
    } catch {
      return undefined;
    }
    const raw = bytes.toString('utf8');
    const { fm, body } = splitFrontmatter(raw);
    const page: Page = { slug, meta: parseMeta(fm, slug), body, raw, version: sha256(bytes), links: extractLinks(body) };
    this.cache.set(slug, { key, page });
    return page;
  }

  linksTo(slug: string): string[] {
    return this.pages().filter((p) => p.slug !== slug && p.links.includes(slug)).map((p) => p.slug).sort();
  }

  /** Pages matching the query, best first (see docs/wiki.md). Falls back to a plain scan if SQLite fails. */
  search(query: string, limit = 8): Hit[] {
    const words = terms(query);
    if (!words.length) return [];
    try {
      return this.searchIndex(words, limit);
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.error(`wiki: SQLite search failed, using the plain scan instead: ${(err as Error).message}`);
      }
      this.index = undefined;
      this.indexed.clear();
      return this.searchScan(words, limit);
    }
  }

  private db(): DatabaseSync {
    if (this.index) return this.index;
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE pages USING fts5(title, aliases, tags, description, body, tokenize="porter unicode61")');
    } catch (err) {
      db.close();
      throw err;
    }
    this.index = db;
    return db;
  }

  /** Brings the index in line with the folder: only new, changed (mtime or size) and removed files are touched. */
  private syncIndex(): DatabaseSync {
    const db = this.db();
    let names: string[] = [];
    try {
      names = readdirSync(this.pagesDir);
    } catch {
      /* no pages folder yet */
    }
    const seen = new Set<string>();
    const todo: string[] = [];
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      const slug = n.slice(0, -3);
      if (!SLUG.test(slug)) continue;
      let key: string;
      try {
        const st = lstatSync(this.file(slug), { bigint: true });
        if (!st.isFile()) continue;
        key = `${st.mtimeNs}:${st.size}`;
      } catch {
        continue;
      }
      seen.add(slug);
      if (this.indexed.get(slug)?.key !== key) todo.push(slug);
    }
    const gone = [...this.indexed.keys()].filter((k) => !seen.has(k));
    if (!todo.length && !gone.length) return db;
    db.exec('BEGIN');
    try {
      for (const slug of gone) this.unindex(db, slug);
      for (const slug of todo) this.indexPage(db, slug);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      this.indexed.clear();
      db.exec('DELETE FROM pages');
      throw err;
    }
    return db;
  }

  private unindex(db: DatabaseSync, slug: string) {
    const e = this.indexed.get(slug);
    if (!e) return;
    db.prepare('DELETE FROM pages WHERE rowid = ?').run(BigInt(e.id)); // node:sqlite binds plain numbers as REAL
    this.indexed.delete(slug);
  }

  /** (Re)indexes one page from disk. Not a regular file, or unreadable: it is removed from the index. */
  private indexPage(db: DatabaseSync, slug: string) {
    this.unindex(db, slug);
    let key: string;
    try {
      const st = lstatSync(this.file(slug), { bigint: true });
      if (!st.isFile()) return;
      key = `${st.mtimeNs}:${st.size}`;
    } catch {
      return;
    }
    this.cache.delete(slug);
    const p = this.load(slug);
    if (!p) return;
    const id = this.nextId++;
    db.prepare('INSERT INTO pages(rowid, title, aliases, tags, description, body) VALUES (?, ?, ?, ?, ?, ?)').run(BigInt(id), p.meta.title, p.meta.aliases.join(' '), p.meta.tags.join(' '), p.meta.description, p.body);
    this.indexed.set(slug, { id, key });
  }

  private searchIndex(words: string[], limit: number): Hit[] {
    const db = this.syncIndex();
    const bySlug = new Map<number, string>();
    for (const [slug, e] of this.indexed) bySlug.set(e.id, slug);
    const all = new Map<number, number>();
    const meta = new Map<number, number>();
    const hitsAll = db.prepare('SELECT rowid FROM pages WHERE pages MATCH ?');
    for (const w of words) {
      for (const r of hitsAll.all(quote(w)) as { rowid: number }[]) all.set(r.rowid, (all.get(r.rowid) ?? 0) + 1);
      for (const r of hitsAll.all(`{title aliases tags description} : ${quote(w)}`) as { rowid: number }[]) meta.set(r.rowid, (meta.get(r.rowid) ?? 0) + 1);
    }
    // The hub's one difference from wiki.py: never ask for more body hits than there are terms.
    const need = Math.min(Math.max(2, Math.ceil(words.length * MIN_BODY_SHARE)), words.length);
    const kept = [...all].filter(([id, n]) => meta.has(id) || n >= need).map(([id]) => id);
    kept.sort((a, b) => (meta.get(b) ?? 0) - (meta.get(a) ?? 0) || all.get(b)! - all.get(a)! || bySlug.get(a)!.localeCompare(bySlug.get(b)!));
    const any = words.map(quote).join(' OR ');
    const snip = db.prepare(`SELECT snippet(pages, ${BODY_COLUMN}, '', '', ' … ', 32) AS s FROM pages WHERE pages MATCH ? AND rowid = ?`);
    const inBody = new Set((db.prepare('SELECT rowid FROM pages WHERE pages MATCH ?').all(`{body} : (${any})`) as { rowid: number }[]).map((r) => r.rowid));
    const out: Hit[] = [];
    for (const id of kept) {
      if (out.length >= limit) break;
      const p = this.page(bySlug.get(id)!);
      if (!p) continue;
      const s = inBody.has(id) ? ((snip.get(any, BigInt(id)) as { s: string } | undefined)?.s ?? '') : '';
      out.push({ slug: p.slug, title: p.meta.title, description: p.meta.description, updated: p.meta.updated, snippet: s.split(/\s+/).filter(Boolean).join(' ') });
    }
    return out;
  }

  /** The old in-memory scoring, kept as the fallback if SQLite fails. */
  private searchScan(words: string[], limit: number): Hit[] {
    const need = Math.min(Math.max(2, Math.ceil(words.length * MIN_BODY_SHARE)), words.length);
    const scored: { p: Page; meta: number; body: number; lower: string }[] = [];
    for (const p of this.pages()) {
      const head = [p.meta.title, ...p.meta.aliases, ...p.meta.tags, p.meta.description].join(' ').toLowerCase();
      const lower = p.body.toLowerCase();
      const meta = words.filter((w) => head.includes(w)).length;
      const body = words.filter((w) => lower.includes(w)).length;
      if (meta > 0 || body >= need) scored.push({ p, meta, body, lower });
    }
    scored.sort((a, b) => b.meta - a.meta || b.body - a.body || a.p.slug.localeCompare(b.p.slug));
    return scored.slice(0, limit).map(({ p, lower }) => {
      const at = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
      return { slug: p.slug, title: p.meta.title, description: p.meta.description, updated: p.meta.updated, snippet: at === undefined ? '' : snippet(p.body, at) };
    });
  }

  /** Saves a whole page. Saves are serialized; a git failure is reported in `note`, the save stands. */
  save(a: { slug: string; content: string; message: string; agent: string; version?: string }): Promise<{ slug: string; version: string; created: boolean; note: string }> {
    const run = this.queue.then(() => this.doSave(a));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doSave(a: { slug: string; content: string; message: string; agent: string; version?: string }) {
    const { slug, agent } = a;
    if (!SLUG.test(slug)) throw new TeamError('slug must be lower-case letters, digits and dashes (at most 80), starting with a letter or digit.');
    let content = a.content.replace(/\r\n/g, '\n');
    if (Buffer.byteLength(content) > MAX_PAGE) throw new TeamError(`Page is over ${MAX_PAGE / 1024} KB. Split it into linked pages.`);
    const { fm, body } = splitFrontmatter(content);
    if (fm === null) throw new TeamError('Start the page with frontmatter: --- / title: ... / description: ... / --- (tags and aliases are optional).');
    const meta = parseMeta(fm, '');
    if (!meta.title || !meta.description) throw new TeamError('Frontmatter needs a title and a description.');
    const message = (a.message.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim() || `Update ${slug}`).slice(0, 200);
    const bad = privacyProblems(`${content}\n${message}`);
    if (bad.length) throw new TeamError(`Not saved: the page contains ${bad.join(', ')}. Remove it and save again.`);

    // The hub sets `updated`.
    const date = today();
    const lines = fm.split('\n');
    const i = lines.findIndex((l) => /^updated:/i.test(l));
    if (i >= 0) lines[i] = `updated: ${date}`;
    else lines.push(`updated: ${date}`);
    content = `---\n${lines.join('\n')}\n---\n${body.trimEnd()}\n`;

    this.cache.delete(slug);
    const existing = this.load(slug);
    if (existing) {
      if (!a.version) throw new TeamError(`${slug} already exists. Read it with wiki_read and save with its version.`);
      if (a.version !== existing.version) throw new TeamError(`${slug} changed since you read it; read it again.`);
    } else if (a.version) {
      throw new TeamError(`${slug} doesn't exist yet; save without a version to create it.`);
    }

    mkdirSync(this.pagesDir, { recursive: true });
    const target = this.file(slug);
    const tmp = join(this.pagesDir, `.${slug}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const fd = openSync(tmp, 'wx', 0o600);
      try {
        writeSync(fd, content);
        if (existing) fchmodSync(fd, lstatSync(target).mode & 0o777);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (existing) {
        // Look once more right before replacing: someone may have edited it meanwhile.
        this.cache.delete(slug);
        if (this.load(slug)?.version !== existing.version) throw new TeamError(`${slug} changed since you read it; read it again.`);
        renameSync(tmp, target);
      } else {
        try {
          linkSync(tmp, target); // fails if anything appeared there meanwhile
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new TeamError(`${slug} was created meanwhile (or is not a regular page file); read it first.`);
          throw err;
        }
        unlinkSync(tmp);
      }
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* already gone */
      }
      throw err;
    }
    this.cache.delete(slug);
    const version = sha256(Buffer.from(content));
    if (this.index) {
      try {
        this.index.exec('BEGIN');
        try {
          this.indexPage(this.index, slug);
          this.index.exec('COMMIT');
        } catch (err) {
          this.index.exec('ROLLBACK');
          throw err;
        }
      } catch {
        this.index = undefined; // rebuilt (or the scan fallback used) on the next search
        this.indexed.clear();
      }
    }

    let note = '';
    if (await this.isRepo()) {
      const who = { GIT_AUTHOR_NAME: agent, GIT_AUTHOR_EMAIL: `${agent}@agent-team-up`, GIT_COMMITTER_NAME: 'agent-team-up', GIT_COMMITTER_EMAIL: 'agent-team-up@localhost' };
      const path = `pages/${slug}.md`;
      try {
        await git(this.dir, ['add', '--', path], who);
        const same = await gitRun(this.dir, ['diff', '--cached', '--quiet', '--', path], who);
        if (same.code === 0) note = 'Saved; nothing changed, so no commit.';
        else await git(this.dir, ['-c', 'commit.gpgsign=false', 'commit', '-m', message, '--', path], who);
      } catch (err) {
        note = `Saved, but the git commit failed: ${this.scrub((err as Error).message)}`;
        await gitRun(this.dir, ['reset', '-q', '--', path], who).catch(() => undefined); // leave it unstaged
      }
    }
    return { slug, version, created: !existing, note };
  }

  /** Git's message with the wiki folder and the home folder replaced, so paths don't reach agents. */
  private scrub(msg: string): string {
    let out = msg.split('\n')[0];
    const dirs = new Set([this.dir]);
    try {
      dirs.add(realpathSync(this.dir));
    } catch {
      /* gone */
    }
    for (const d of [...dirs].sort((x, y) => y.length - x.length)) out = out.split(d).join('<wiki>');
    const home = homedir();
    if (home.length > 1) out = out.split(home).join('~');
    return out.replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 200);
  }

  // ── git: history for the page ──

  /** True only when the wiki folder is itself the top of a git repo (not a subfolder of a bigger one). */
  async isRepo(): Promise<boolean> {
    try {
      const top = (await git(this.dir, ['rev-parse', '--show-toplevel'])).trim();
      return realpathSync(top) === realpathSync(this.dir);
    } catch {
      return false;
    }
  }

  async history(slug: string, limit = 30): Promise<{ sha: string; when: string; author: string; message: string }[]> {
    if (!SLUG.test(slug) || !(await this.isRepo())) return [];
    try {
      const n = nonce();
      const out = await git(this.dir, ['log', `-n${limit}`, `--format=${n}C${n}%H${n}%aI${n}%an${n}%s`, '--', `pages/${slug}.md`]);
      return out.split(`${n}C${n}`).filter((c) => c.trim()).map((c) => {
        const [sha, when, author, message] = c.split(n);
        return { sha, when, author, message: (message ?? '').split('\n')[0] };
      });
    } catch {
      return [];
    }
  }

  async changes(limit = 50): Promise<Change[]> {
    if (!(await this.isRepo())) return [];
    try {
      const n = nonce();
      const out = await git(this.dir, ['log', `-n${limit}`, '--name-only', `--format=${n}C${n}%H${n}%aI${n}%an${n}%s${n}`, '--', 'pages/']);
      return out.split(`${n}C${n}`).filter((c) => c.trim()).map((c) => {
        const [sha, when, author, message, rest = ''] = c.split(n);
        const pages = rest.split('\n').map((f) => /^pages\/([^/]+)\.md$/.exec(f.trim())?.[1]).filter((x): x is string => Boolean(x));
        return { sha, when, author, message, pages };
      });
    } catch {
      return [];
    }
  }

  async commit(sha: string): Promise<{ sha: string; when: string; author: string; message: string; diff: string }> {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new TeamError('sha must be 7 to 40 hex characters.');
    if (!(await this.isRepo())) throw new NotFound('The wiki folder is not a git repo.');
    const n = nonce();
    let out: string;
    try {
      out = await git(this.dir, ['show', '--no-color', '--no-ext-diff', '--no-textconv', `--format=${n}%H${n}%aI${n}%an${n}%s${n}`, sha, '--', 'pages/'], {}, 16 * 1024 * 1024);
    } catch {
      throw new NotFound('No such commit.');
    }
    const [, full, when, author, message, ...rest] = out.split(n);
    let diff = rest.join(n).replace(/^\n+/, '');
    if (diff.length > MAX_DIFF) diff = `${diff.slice(0, MAX_DIFF)}\n… (diff cut)`;
    return { sha: full, when, author, message: (message ?? '').split('\n')[0], diff };
  }
}

function snippet(body: string, at: number): string {
  const words = body.split(/\s+/);
  let pos = 0;
  let idx = 0;
  for (; idx < words.length; idx++) {
    const next = body.indexOf(words[idx], pos);
    if (next + words[idx].length > at) break;
    pos = next + words[idx].length;
  }
  const from = Math.max(0, idx - 10);
  const to = Math.min(words.length, from + 30);
  return `${from > 0 ? '… ' : ''}${words.slice(from, to).join(' ')}${to < words.length ? ' …' : ''}`;
}
