## MR Review Workflow

When asked to review an MR, follow these steps:

1. Fetch and read the diff (all changed files in full).
2. Fetch and read each link listed under "MR Review Process" below.
3. Switch to Plan mode and produce a review plan in markdown with:
   - **Issues** categorized by priority: `blocking`, `non-blocking`, `nit`
   - For each issue: a draft inline comment (file + line reference) written in the user's voice
   - A **recommendation** at the bottom: `Approve`, `Comment`, or `Request Changes`, with a one-line rationale
4. Wait for user approval of the plan before posting any comments or taking any action.
5. Once approved, post each comment as an inline diff comment using `glab api` (see "MR Review Comments" section below), then apply the recommended review action.

## MR Review Voice

Write like a real person doing a quick code review, not an AI carefully composing feedback. Proper capitalization and punctuation are fine. Be inquisitive when raising issues ("is this intentional?", "should this be X?") rather than declarative. Praise should be brief and genuine — "Nice catch" with a one-line callout is enough, no need to justify why it's good. Skip the hedging on nits (no "pre-existing but worth noting while we're here"). One sentence is usually enough. Light emoji is fine.

- no em dashes or hyphens unless it's ABSOLUTELY necessary.

## MR Review Process

When actively performing an MR review, fetch and read each of these links before writing any comments:

- https://conventionalcomments.org/
- https://google.github.io/eng-practices/review/reviewer/standard.html
- https://google.github.io/eng-practices/review/reviewer/looking-for.html
- https://google.github.io/eng-practices/review/reviewer/navigate.html
- https://google.github.io/eng-practices/review/reviewer/speed.html
- https://google.github.io/eng-practices/review/reviewer/comments.html
- https://google.github.io/eng-practices/review/reviewer/pushback.html

## MR Review Comments

When posting review comments on a GitLab MR, use `glab api` with diff position parameters to post inline comments on the actual diff lines. Do not use `glab mr note`, which only posts top-level MR notes, unless you have a comment about the MR in general that doesn't fit into the main review comment.

Required diff position parameters:

- `position[position_type]`: `text`
- `position[base_sha]`: merge base SHA
- `position[start_sha]`: base branch HEAD SHA
- `position[head_sha]`: MR branch HEAD SHA
- `position[old_path]` / `position[new_path]`: file path
- `position[new_line]`: line number in the new file (or `old_line` for deleted lines)

Example:

```bash
glab api projects/:fullpath/merge_requests/:iid/discussions \
  --method POST \
  -f "body=your comment" \
  -f "position[position_type]=text" \
  -f "position[base_sha]=<base_sha>" \
  -f "position[start_sha]=<start_sha>" \
  -f "position[head_sha]=<head_sha>" \
  -f "position[old_path]=path/to/file.ts" \
  -f "position[new_path]=path/to/file.ts" \
  -f "position[new_line]=42"
```

Get the SHAs from `glab api projects/:fullpath/merge_requests/:iid` (`.diff_refs` field).
