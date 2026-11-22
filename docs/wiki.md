# Wiki: shared knowledge for the team, and a page to read it

Agents from different apps forget everything between sessions, and each app has its own memory that the
others can't see. `serve --wiki <dir>` gives the whole team one wiki: a folder of linked Markdown pages
that every agent can search, read and add to through MCP tools, and that the owner browses at `/wiki`.

The board holds live coordination (who is doing what now). The wiki holds what should outlast it:
decisions and their reasons, where things run, corrections, preferences. A project's own design still
belongs in its repo.

## The folder

The format the owner's existing wiki already uses, so it works on that folder unchanged:

```
<dir>/pages/<slug>.md      one page per topic; slug is [a-z0-9-]+
```

```markdown
---
title: agent-team-up
description: One line used to decide relevance
aliases: [team hub, mcp hub]
tags: [project, mcp]
updated: 2026-11-21
---

Body in Markdown. Links to other pages are [[slug]].
```

- `pages/` is the source of truth. Nothing else in the folder is read or written by the hub (other tools
  may keep their own index files there).
- If `<dir>` is itself a git repo (its top level is `<dir>`, not a parent folder), every save is committed (below). A wiki that is only a subfolder of a bigger repo is treated as having no git: nothing is committed there, and history and changes are empty. That history is what "recent changes" on
  `/wiki` shows.
- Only regular files in `pages/` count. Symlinks and anything else are ignored for listing, reading, search and backlinks, and a save onto one is refused.
- Pages are read from disk on demand and cached by mtime, so edits made outside the hub (an editor,
  another tool) show up at once.

## Tools (only when `--wiki` is set)

| Tool | What it does |
| --- | --- |
| `wiki_search` | `query` -> up to 8 pages: slug, title, description, a short snippet. |
| `wiki_read` | `slug` -> the page as Markdown, its `version`, and the pages it links to and from. |
| `wiki_save` | `slug`, `content` (the whole page, frontmatter included), `message`, and `version` when changing an existing page. |

**Search** uses a SQLite FTS5 index, built the same way as the owner's `wiki.py` (`tokenize="porter
unicode61"`, columns `title, aliases, tags, description, body`), so results feel the same in every app and
match whole words with Porter stemming (`deploy` finds `deploys` and `deployed`; `ops` no longer matches inside
`stops`). Porter does not join every derived form: `deploy` does not find `deployment`.

- **The index** lives in an in-memory database (`node:sqlite`, `:memory:`), never a file: the hub still
  writes nothing in the folder except pages. Before each search (and each page listing that needs it) the
  hub compares every regular file in `pages/` by mtime and size with what it indexed, and re-indexes only the
  changed, new and removed pages, in one transaction. Edits made outside the hub show up on the next search.
  A save updates its page in the index directly.
- **Terms:** words of 3+ letters or digits (Unicode letters and digits, as `[\p{L}\p{N}]{3,}`, like Python's `[^\W_]`), lower-cased, de-duplicated,
  without `wiki.py`'s stopword list (copy it exactly) or pure numbers, longest first, at most 24.
- **Matching:** for each term, a quoted FTS5 query (`"term"`; a term can't inject FTS syntax) over all
  columns counts body-or-metadata hits, and the same scoped to `{title aliases tags description}` counts
  metadata hits. A page qualifies if it has a metadata hit or at least `min(max(2, ceil(25% of the terms)),
  number of terms)` hits (so a single word can match body text; this clamp is the one deliberate difference
  from `wiki.py`). Order by metadata hits, then all hits, then slug. No bm25: in a small wiki its scores
  collapse to almost zero, which is why `wiki.py` counts coverage instead.
- **Snippet:** FTS5 `snippet()` on the body column with the terms OR-ed, 32 tokens, `' … '` as the
  ellipsis, whitespace collapsed. Empty if only metadata matched (unlike `wiki.py`, which then shows the start of the body).
- **Results:** up to 8 for the tool and the API (unchanged shape: slug, title, description, snippet, plus
  `updated`).
- If the index can't be built (a SQLite error), search falls back to the old in-memory scoring and logs
  the error once; it never fails the tool.

**Save** rules, all enforced by the hub:

1. The agent must be allowed to write (`--wiki-writers`, below).
2. `slug` matches `^[a-z0-9][a-z0-9-]{0,79}$`. `content` is at most 40 KB (also capped in the tool's schema; `/mcp` bodies over 256 KB get a 413) and starts with frontmatter that
   has `title` and `description`. The hub sets `updated:` to today's date (adds it if missing).
3. **No lost updates.** Changing an existing page requires the `version` from `wiki_read` (a SHA-256 of
   the file's bytes). If the file changed since, the save is refused with "changed since you read it;
   read it again". Creating a page requires that it doesn't exist yet.
4. **Privacy checks.** Refused, naming what was found (never echoing it), if the content contains: an API
   key (`sk-...`), a GitHub token (`gh[pousr]_...`), an AWS key, a private key block, a
   `password|secret|api_key|token: <8+ chars>` pair, an email address, a home-directory path
   (`/Users/<x>` or `/home/<x>`), or the server user's login name as a word. Same rules as the owner's
   `wiki.py lint`, so a page the hub accepts also passes their commit check.
5. Written atomically: a temp file in `pages/` (fsynced), then rename for an existing page (after a last version re-check) or an exclusive `link()` for a new one, so a page someone else just created is never overwritten. Mode 600 for new files.
6. If `<dir>` is a git repo: `git add pages/<slug>.md` and commit just that path with the agent's
   `message` (control characters removed), author `<agent> <agent@agent-team-up>`, committer `agent-team-up <agent-team-up@localhost>`.
   Never `add -A`: other uncommitted edits in the folder stay theirs. If nothing changed, there is no commit and the reply says so. A commit failure is reported in the reply (git's first line, with the wiki and home paths replaced by `<wiki>` and `~`), the page is unstaged again, and the save stands.
7. Saves are serialized inside the process. A page event goes to the log (`saved wiki page <slug>`),
   audience `log`, so the board's activity shows it.

There is no delete tool. Deleting or renaming is the owner's call, outside the hub.

**Instructions.** When `--wiki` is set, the server instructions gain one line: search the wiki before
starting work on something that may have history; save facts that will matter in a future session and
can't be found in the code, git history or docs, with the reason; update a page rather than adding a
near-duplicate; never save personal details or secrets. With `--wiki-guide <slug>`, the line also says
to read that page before the first save.

## Options

```
serve --wiki <dir>                 enable the wiki tools and /wiki
      --wiki-writers <a,b,...>     agents allowed to save (default: every agent)
      --wiki-guide <slug>          page agents read before saving (e.g. wiki-conventions)
```

Agents not in `--wiki-writers` still search and read; `wiki_save` tells them they can't write.

## `/wiki`

One HTML file, `src/wiki.html`, served at `/wiki` with the same owner sign-in, CSP and Host checks as the
board, and linked from the board's header (the board links back). Read-only. Built with the board's
`h()`/`textContent` approach: no `innerHTML` anywhere, including the Markdown.

- **Pages:** a list with title and description, a search box (same search as the tool), tag chips to
  filter. Sorted by `updated`, newest first.
- **A page:** rendered Markdown, its tags and aliases, `updated`, links out, **linked from** (backlinks),
  and its own history (the commits that touched it). `[[slug]]` links navigate inside `/wiki`; broken ones
  are shown as plain text, struck through.
- **Recent changes:** the last 50 commits that touched `pages/`: when, author (an agent name, `wiki` for
  `wiki.py`, or a person), message, pages. Clicking one shows its diff for `pages/` only, as text lines
  coloured by `+`/`-`.
- **Graph:** pages as dots, links as lines, a small force layout drawn in SVG by the page's own script
  (no library). Click a dot to open the page.
- Navigation is in the URL hash (`#page/<slug>`, `#changes`, `#graph`, `#search/<q>`), so back/forward and
  links work.
- Works at 1280 and 390 wide, light and dark, like the board.

The Markdown renderer is small and builds DOM nodes: headings, paragraphs, bullet and numbered lists
(one level of nesting), fenced code, inline code, bold, italics, links (`http`/`https` only, others shown
as text), `[[slug]]`, tables (pipe syntax). Anything else is shown as text.

API (owner session, same-origin as the board's API):

```
GET /api/wiki/pages                 [{slug, title, description, tags, aliases, updated, links}]
GET /api/wiki/page?slug=<slug>      {slug, meta, body, version, linksOut, linksIn, history:[{sha,when,author,message}]}
GET /api/wiki/search?q=<text>       the tool's results
GET /api/wiki/changes               [{sha, when, author, message, pages}]
GET /api/wiki/commit?sha=<sha>      {sha, when, author, message, diff}   sha must be 7-40 hex chars
```

Git is called with `execFile` (no shell), `-C <dir>`, and paths limited to `pages/`. Log output is split on a per-call random delimiter, so a commit message can't forge entries. Without git, history
and changes are empty lists and the page says so. Every endpoint returns 404 when `--wiki` isn't set.

## Code

- `src/wiki.ts`: the folder: parse frontmatter, cache, links, search, privacy check, save (with git),
  history and diff. No HTTP or MCP in it. Tests in `test/wiki.test.ts` against a temp folder (with and
  without git).
- `src/mcp.ts`: the three tools, registered only when a wiki is configured; the instructions line.
- `src/http.ts`: `/wiki` and `/api/wiki/*`.
- `src/wiki.html`: the page. The build copies it to `dist/` like `board.html`.
- `src/cli.ts`: the three options.
- `test/hub.test.ts`: tools over MCP (search, read, save, version conflict, privacy refusal, a
  non-writer), the API needs the owner, `/wiki` has the CSP, 404s without `--wiki`.
- `README.md`: a short "Wiki" section. `docs/design.md`: a line under Model and the tools table.
