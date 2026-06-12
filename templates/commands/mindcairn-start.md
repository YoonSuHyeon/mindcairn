Entry point for the mindcairn-first workflow. **Auto-routes by input type → leverages the unified mindcairn-myproject MCP → automatically captures decisions.**

Can run alongside your existing "start work" command. mindcairn-start is the superset — 6 modes: Notion ticket + free-form question + analytics SQL + debug + retrospective + free search.

$ARGUMENTS

---

## Usage

```
/mindcairn-start <any input>
```

### Examples (6 modes)

```
/mindcairn-start https://www.notion.so/<workspace>/TASK-1234 # ① Start work
/mindcairn-start Why use a separate time util instead of clock()? # ⑥ Free-form question
/mindcairn-start Build a query for this month's unpaid order stats # ③ Analytics SQL
/mindcairn-start Sentry OrderItem NPE                        # ④ Debug
/mindcairn-start Where is order_status used?                 # ⑥ Free search
/mindcairn-start Summarize last week's decisions             # ⑤ Retrospective
```

---

## Automatic input routing

Inspect `$ARGUMENTS` and pick a mode in the following priority order:

1. **Contains a Notion URL / page ID** → Mode ① **Start work**
   - Regex: `notion.so/` or a 32-char UUID
2. **"PR" / "review" / "diff" / "#" + number** → Mode ④ **PR review**
3. **"query" / "SQL" / "stats" / "lookup" / "aggregate" / "extract"** → Mode ③ **Analytics SQL**
4. **"Sentry" / "NPE" / "error" / "outage" / "issue"** → Mode ④ **Debug**
5. **"last week" / "this month" / "retrospective" / "today's decisions" / "recent"** → Mode ⑤ **Retrospective**
6. **Any other free-form text** → Mode ⑥ **Free search** (includes Q&A / domain learning)

If the argument is empty → print usage:
```
Usage: /mindcairn-start <Notion URL | question | work input>
```

If routing is ambiguous → ask the user one clarifying question:
```
I only got the keyword "payment". Which one?
  1) Learn the payment domain
  2) Start payment-related work (please share the Notion URL)
  3) Write a payment SQL query
```

---

## Mode ① — Start work (Notion URL)

Your team's "start work" workflow + mindcairn integration. **The skill/agent names below are all placeholder examples — replace them with what your team actually has, and delete any STEP you don't use.** STEPs 6–8 (updating the Notion body, worktree) should be adapted to fit your team's workflow.

### STEP 1. Trace context (e.g. a `<context-tracer>` skill)
- Fetch the task (`include_discussions: true`)
- Follow the `project` relation → fetch the project page
- Fetch planning/analysis-design tasks from the same project in parallel
- If the body is empty → fetch the linked source request document
- Normalize the facts

### STEP 2. Unified mindcairn search (★ new)

Call mindcairn-myproject with the extracted keywords (domain / table name / feature name):

```
mindcairn-myproject.search_codebase(query=<summary>, topK=15)
mindcairn-myproject.find_pattern(query=<summary>, type="captured_decision")
mindcairn-myproject.find_pattern(query=<summary>, type="doc_design")   # filter by the kind of document you ingested
```

### STEP 3. Summarize requirements (e.g. a `<doc-analyzer>` agent)
- Input: `requirements` + `out_of_scope` from STEP 1
- Output: structured requirements + impact keywords

### STEP 4. Impact analysis (e.g. an `<impact-analyzer>` agent)
- Input: domain + table names + keywords
- Output: affected files + whether the DB changes + whether a migration is needed

### STEP 5. Development plan (e.g. a `<dev-plan-writer>` agent)
- Input: STEP 3 + STEP 4
- Output: step-by-step plan + test cases (happy path / combinations / regression / errors)

### STEP 6. Consolidated output + approval gate

```
🚀 Mode ①: Start work (Notion ticket)
📋 Ticket: {ID} — {title}

📌 Related decisions (mindcairn captured, N)
- "{title}" — {one-line summary}

📊 Notion materials (M)
- "{section}" — {brief}

💻 Related code (K, mindcairn)
- {file:line} — {description}

📐 Impact analysis
- DB change: {Y/N}
- Migration: {Y/N}
- Files likely to change: {list}

🗂 Development plan
{step-by-step checklist + test cases}

⚠️ Additional decisions needed (if any)
- {ambiguous / unspecified points}

---
Next:
- "go" → STEP 7 (snapshot the plan + update the Notion body)
- "edit: ..." → incorporate feedback and re-run
- "hold" → stop here
```

### STEP 7~9. Update Notion → worktree (adapt to your team's workflow)

After the user says "go" (all examples — replace with your team's conventions):
1. Save a plan snapshot (e.g. `task-plans/TASK-{ID}.json`)
2. If you have a Notion-body-update skill, call it (draft approval gate)
3. Wait for Notion confirmation → user says "go"
4. Create a worktree (e.g. `feat/TASK-{ID}`, base = your team's dev branch)

---

## Mode ⑥ — Free search / question / domain learning

The mode you'll use most often. Free-form text → unified mindcairn search → answer.

### Flow

```
mindcairn-myproject.search_codebase(query=$ARGUMENTS, topK=12)
mindcairn-myproject.find_pattern(query=$ARGUMENTS, type="captured_decision")
```

Synthesize the results into an answer. This isn't plain search but an **answering** mode — Claude reads the retrieved chunks and answers directly.

### Output format

```
🚀 Mode ⑥: Free search
❓ Question: {$ARGUMENTS}

📌 Related decisions (mindcairn captured, N)
- "{title}" — {summary}

💻 Related code (K)
- {file:line} — {role}

📊 Related Notion materials (M, if any)
- "{section}" — {brief}

💡 Answer
{natural-language answer synthesized from the chunks}
- Key point 1
- Key point 2
- (cite the source when quoting code/Notion)

→ More detail? / Next question?
```

---

## Mode ③ — Write analytics SQL

Analytics / stats / lookup query requests.

### Flow

```
mindcairn-myproject.find_pattern(query=$ARGUMENTS, type="doc_data")  # prioritize similar analytics-query docs
mindcairn-myproject.search_codebase(query=$ARGUMENTS, topK=10)
mindcairn-myproject.find_pattern(query=$ARGUMENTS, type="captured_decision")  # decisions on analysis criteria
```

### Output format

```
🚀 Mode ③: Analytics SQL

🎯 Request: {$ARGUMENTS}

📊 Reference Notion queries (N)
- "{title}" — {SQL excerpt}

📌 Decisions to apply (mindcairn captured)
- "{title}" — {decision detail}

💻 Related domains/tables
- {table_name} — {role}
- {Entity.kt} — {mapping}

💡 The SQL I wrote
```sql
-- Applied decision: ...
-- Reference Notion: ...
SELECT ...
FROM ...
WHERE ...
```

→ Run it? / Request changes? / Save to mindcairn as a 'fact'? (if it's a new analysis pattern)
```

---

## Mode ④ — PR review / debug

### Flow

Given a PR URL / error message / code diff:

```
1. Extract changed files/symbols (or the class name from the error)
2. mindcairn-myproject.search_codebase(query=<symbol name>, topK=10)
3. mindcairn-myproject.find_pattern(query=<symbol>, type="captured_decision")
4. Check for company convention violations
```

### Output format (debug case)

```
🚀 Mode ④: Debug
🐛 Issue: {summary}

💻 Related code (mindcairn)
- {file:line} — {quoted body}
- {nullable risk point found}

📌 Related decisions / past incidents
- "{title}" — {action taken}

💡 Diagnosis
- Possible cause: ...
- Temporary fix: ...
- Permanent fix: ...

→ Save this diagnosis to mindcairn as an 'incident' kind?
```

---

## Mode ⑤ — Retrospective / decision summary

Given a time range ("last week" / "this month" / "today") → summarize the decisions captured in mindcairn.

### Flow

```
1. Parse the range ("last week" → 7 days, "this month" → start of month ~ today)
2. Query SQLite directly (filter on capturedAt)
3. Group by domain / kind
4. Output as markdown
```

### Output format

```
🚀 Mode ⑤: Retrospective
📅 Range: {start} ~ {end}

Total {N} (decision: {a} / incident: {b} / fact: {c})

## Domain: order
- "Criteria for determining order completion" (decision)
- "Criteria for unpaid order stats" (fact)

## Domain: member
- ...

→ Write to a Notion retrospective page? / More detail?
```

---

## Common — automatic capture triggers (all modes)

When you detect any of the following patterns during the conversation → **automatically suggest** mindcairn-myproject.capture_decision:

- "let's go with ~" / "decided on ~" / "we'll do ~"
- A conclusion after a comparison/judgment ("A vs B → chose A")
- A confirmed cause/action for an operational issue
- A deliberate choice made while writing code/SQL
- When a new analysis pattern is created (end of Mode ③)

### Suggestion format

```
Just detected a decision/fact: "{one-line summary}"
Save it via mindcairn-myproject.capture_decision? (kind={decision/incident/fact/spec})
```

### yes / sure / ok / save → make the call

Auto-fill:
- `title`: one-line summary of the decision
- `content`: the gist of the decision + reasoning/context (extracted from the conversation)
- `kind`: 'decision' (default), or incident/fact/spec as appropriate
- `domain`: infer the domain (order/member/payment/...)
- `links`: code symbols mentioned in the conversation / IDs of prior decisions

### no / pass → skip

Continue quietly.

---

## Edge cases

| Situation | Handling |
|------|------|
| mindcairn-myproject MCP connection fails | Prompt: "mindcairn connection failed. Proceed with other info only?" |
| Notion URL but no access | "Can't access the page. Check permissions or share the ID." |
| Text too short (`payment`) | Clarifying question (see the routing section above) |
| 0 mindcairn search results | Prompt: "No related info found. Try different keywords / does mindcairn need indexing?" |
| No argument | Print usage |

---

## Notes

- mindcairn-myproject MCP comes first. A Notion fetch is only required in Mode ①.
- Automatic capture is a **suggestion**. Never save without a human "yes".
- Mode ①'s STEP 6 (updating the Notion body) requires a draft approval gate.
- The worktree creation at the end of Mode ① follows your team's existing worktree flow — no new session.
- In every mode, **cite the source** when quoting retrieved code/Notion (file:line / Notion page title).
