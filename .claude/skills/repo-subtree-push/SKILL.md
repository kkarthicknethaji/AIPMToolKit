---
name: repo-subtree-push
description: Push the tracked changes in a directory of this repo (e.g. proxy/) out to a separate standalone deploy repo that mirrors that directory at its root — e.g. syncing proxy/ to kkarthicknethaji/product-diagnostics-proxy after a new proxy version lands on main. Use when the user asks to "push/sync/migrate the proxy changes to <repo>" or similar.
---

# Repo subtree push

Mirrors a tracked subdirectory of the current repo (source) into the root of a
separate git repo (target) as one commit, then pushes it. This is how
`proxy/` gets deployed to `product-diagnostics-proxy` — that repo has no
`proxy/` prefix, its root IS the contents of `proxy/`.

This skill is additive/modify-only by design (see "What this does not do"
below) — it never auto-deletes files in the target repo, and it never pushes
without an explicit go-ahead.

## 1. Gather inputs

| Input | Required? | If not given |
|---|---|---|
| Source directory | No | **Defaults to wherever this skill is being run from** — the repo in the current working directory (default subdirectory `proxy/` if the user just says "the proxy changes"; otherwise the directory they name). Confirm it's actually tracked and non-empty: `git -C <repo-root> ls-files -- <source-dir>`. If that returns nothing, stop and tell the user — do not guess a different path. |
| Target repo URL | **Yes** | Stop and ask. Do not proceed on a guess or on a URL only mentioned loosely — confirm the exact `owner/repo`. If already named earlier in this conversation, reuse it without re-asking. |
| Target branch | No | Default `main`, but say so out loud in the summary (step 3) rather than assuming silently. |
| Baseline commit to diff from | No | The last commit in *this* repo you know was already synced (from your own earlier turns this session, or ask the user). If genuinely unknown, fall back to a full-tree comparison in step 2 instead of a targeted range — say so explicitly, don't silently pick a guessed commit. |
| PAT for the target repo | Only if the push needs it | Don't ask upfront. Ask right before step 6 (push), and only if a plain `git push` would need auth this session doesn't otherwise have (the target is usually a different account/org than this repo pushes as). Never store it beyond that one push command. |

**Target repo URL is the one truly mandatory input.** If it's missing or
ambiguous, stop here and ask — do not continue to step 2 on an assumption.

## 2. Determine both versions and what would move

Get the source side (no network needed):

```bash
git -C <repo-root> log -1 --format='%h %s' -- <source-dir>
git -C <repo-root> log -1 --format='%h %s'          # overall repo HEAD, for context
```

Get the target side **without cloning yet** — a lightweight remote check:

```bash
git ls-remote <target-repo-url> <target-branch>
```

Then compute the file list:

```bash
# if a baseline is known:
git -C <repo-root> log --oneline <baseline>..HEAD -- <source-dir>
git -C <repo-root> diff --stat <baseline> HEAD -- <source-dir>

# if no baseline is known, list everything currently tracked instead, and
# say plainly that this is a full-tree listing, not an incremental diff:
git -C <repo-root> ls-files -- <source-dir>
```

## 3. Present the summary and stop for confirmation

Before touching anything else, show the user:

- **Source version**: the source repo's current HEAD (and the source
  directory's own last-touched commit if different), e.g.
  `beb63fe → 1e685e0 ("Add AI Trace Layer: Payload Capture Infrastructure...")`.
- **Target version**: the commit hash `git ls-remote` returned for the
  target branch, and whether that matches the last-known-synced baseline
  (i.e. confirm there's no unexpected drift on the target side before you
  even clone it).
- **Target repo + branch** being pushed to.
- **The exact file list** from step 2 (new / modified, and any deletions
  noted as "not handled automatically" per below).

Then ask for an explicit go-ahead. Do not proceed to step 4 without it.

## 4. Clone the target fresh, to a short path

Windows path-length limits have broken this before when cloned under a deep
scratchpad path. Use a short, throwaway path instead, and remove any stale
leftover first:

```bash
rm -rf /c/tmp/<slug>-sync 2>/dev/null
git clone --depth 1 <target-repo-url> /c/tmp/<slug>-sync
```

(`<slug>` = something short derived from the target repo name.)

Confirm the clone's HEAD matches what `git ls-remote` reported in step 2 —
if it doesn't, something changed on the target between the check and now;
stop and re-summarize rather than continuing on stale information.

## 5. Verify no drift, then copy the changed files over

For each file about to be touched, diff the target's current copy against
the source at the baseline commit (normalizing line endings — CRLF-only
differences are noise, not real drift):

```bash
diff <(git -C <repo-root> show <baseline>:<source-dir>/<relpath> | sed 's/\r$//') \
     <(sed 's/\r$//' /c/tmp/<slug>-sync/<relpath-without-source-prefix>)
```

If no baseline was available, diff the target's full current tree against
the source directory's current tracked files instead, and flag anything
unexpected to the user rather than guessing.

Then copy, mapping each source path by stripping the `<source-dir>/` prefix
and creating destination directories as needed:

```bash
mkdir -p /c/tmp/<slug>-sync/<dest-subdir>
cp <source-dir>/<relpath> /c/tmp/<slug>-sync/<relpath-without-source-prefix>
```

Stage and review — this is the last checkpoint before committing:

```bash
cd /c/tmp/<slug>-sync && git add -A && git status --short
```

The status output must show **exactly** the files promised in step 3 —
nothing extra, nothing missing. If anything else shows up staged, stop and
find out why before continuing (most likely cause: the baseline was wrong,
or a file outside the intended set genuinely drifted).

## 6. Commit and push

Commit with a message describing what shipped (mirror the source commit's
own message/version if there is one). If a PAT is needed and wasn't already
provided, ask for it now:

```bash
git -c user.name="<git user from environment>" -c user.email="<user's email>" \
  commit -q -m "<message>"
git push https://<pat-account>:<PAT>@github.com/<owner>/<repo>.git HEAD:<branch>
```

Never persist the PAT to git config or any file — inline in that one push
command only, and never run a bare `git remote set-url` with it in.

Confirm nothing leaked, then clean up:

```bash
git remote -v   # must still show the plain URL, no token
cd .. && rm -rf /c/tmp/<slug>-sync
```

## 7. Final summary

Report back to the user, explicitly:

- The **files pushed** (same list confirmed in step 5).
- The **commit range** (`<old-target-hash>..<new-target-hash>`) and the new
  commit's hash/message.
- The **source version** this corresponds to (the source repo commit(s)
  synced).
- The **target repo + branch** now holding it, and that the push is
  confirmed live (via the push command's own reported ref update, not a
  fresh `git ls-remote` unless the user wants extra confirmation).

## What this does not do

- **No automatic deletions.** If a file was deleted from the source
  directory since the baseline, this workflow will not remove it from the
  target — call it out to the user explicitly instead of guessing whether
  it's safe to `git rm` in the target too.
- **No unattended pushing.** Step 3's confirmation gate is mandatory before
  any clone/copy/push happens — pushing to another repo's `main` is not
  easily reversible.
- **No PAT persistence**, ever, under any circumstance.
