## MR Review Workflow

When asked to review an MR, follow these steps:

1. Fetch and read the diff (all changed files in full).
2. Fetch and read the MR Description from the author.
3. Fetch and read each link listed under "MR Review Process" below.
4. Switch to Plan mode and produce a review plan in markdown with:
   - **Issues** categorized by priority: `blocking`, `non-blocking`, `nit`
   - For each issue: a draft inline comment (file + line reference) written in the user's voice
   - A **recommendation** at the bottom: `Approve`, `Comment`, or `Request Changes`, with a one-line rationale
5. Wait for user approval of the plan before posting any comments or taking any action.
6. Once approved, post each comment as an inline diff comment using `glab api` (see "MR Review Comments" section below), then apply the recommended review action.
7. If an MR is set auto-merge (check with Gitlab CLI) and you have a comment you definitely want addressed, use Request Changes. If an MR is set to auto-merge, tell the user in your plan to warn if an approval would cause it to merge and verify approval/request changes etc.

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
- Err on the side of Question: vs Suggestion: when commenting. Only add Suggestion: when 100% confident it's worth suggesting.

## Validating Assumptions Before Commenting

Before raising any concern about types, safety, or correctness, **verify it**. Do not raise a comment based on assumption or pattern-matching alone.

For type-related comments specifically:
- Read the actual type definition of any hook or function involved (including third-party libraries in `node_modules`). Do not assume what a type is based on the name or general knowledge.
- Trace through every layer: if the code calls `useLocalSettings()`, read `useLocalSettings`. If that calls `useLocalStorage`, read the installed type definition for `useLocalStorage`.
- Understand what the concern actually protects against. For example, optional chaining (`?.`) only guards against `null` or `undefined`, not an empty object `{}`. Know the difference before suggesting it.

If after verification you are not certain the concern is real, use `question:` not `suggestion:`. If the verification proves the concern is unfounded, drop the comment entirely.

## Summary for me

Part of the plan doc should be a top level section that summarizes for me the MR so I can get a big picture view of the changes.

In addition, break down the changes into headings and explain key concepts or areas of concern I should understand.

## MR Review Comments

When posting review comments on a GitLab MR, use `curl` with a JSON body to post inline diff comments. Do **not** use `glab api -f` for this — it sends form strings instead of JSON integers, and GitLab silently falls back to a general note with no error when `new_line` is a string. Do not use `glab mr note` either, which only posts top-level MR notes.

### Getting the SHAs

```bash
glab api projects/:fullpath/merge_requests/:iid
# Use the .diff_refs field: base_sha, start_sha, head_sha
```

### Computing the correct line number

From the diff, read the hunk header: `@@ -old_start,old_count +new_start,new_count @@`. The first line of the hunk in the new file is `new_start`. Count down from there (context lines and `+` lines both increment the new-file counter; `-` lines do not).

Use `new_line` for added or context lines. Use `old_line` for deleted lines. For context lines, you can supply both.

### Posting the comment

```bash
TOKEN=$(glab config get token --host gitlab.com)
curl -s --request POST \
  --header "Authorization: Bearer $TOKEN" \
  --header "Content-Type: application/json" \
  --data '{
    "body": "your comment",
    "position": {
      "position_type": "text",
      "base_sha": "<base_sha>",
      "start_sha": "<start_sha>",
      "head_sha": "<head_sha>",
      "old_path": "path/to/file.ts",
      "new_path": "path/to/file.ts",
      "new_line": 42
    }
  }' \
  "https://gitlab.com/api/v4/projects/<project_id>/merge_requests/<iid>/discussions"
```

Get `project_id` from `glab api projects/:fullpath` (`.id` field).

### Verifying the comment landed inline

GitLab returns 200 even when position resolution fails. Always check that `notes[0].position` is non-null in the response. If it is null, the comment was posted as a general note and the line number is wrong.
