# Eval harness (Wave 4)

A small, deterministic golden-test framework for the multi-tenant agent.
Cases are described in YAML, executed via scripted mock Gemini replies, and
their outcomes are compared against a stored baseline.

## Layout

```
src/multi/evals/
  types.ts            # EvalCase, EvalResult, EvalRunSummary, ...
  runner.ts           # EvalRunner: loadCases / runOne / runAll / compareWithBaseline
  judge.ts            # Optional LLM judge factory (Gemini Flash)
  cli.ts              # CLI: tsx src/multi/evals/cli.ts <cases.yaml>
  cases/builtin.yaml  # Starter golden set (~12 cases)
```

## Adding a case

Append an entry to `cases/builtin.yaml` (or any other file) with:

```yaml
- id: my_new_case
  description: One-line summary.
  category: delegation   # delegation | recall | tool_selection | persona | safety | skills
  input:
    userMessage: "что-то от пользователя"
  expected:
    firstTool: delegate_to_research          # optional
    textContains: "подстрока"                # string | string[]
    textMustNotContain: ["плохое"]           # forbidden tokens
    minRecall: { k: 5, relevantIds: [a, b] } # for recall cases
    judgeProperties:                         # for soft persona/safety eval
      - "ответ на ты"
  mockResponses:                             # required for non-skip cases
    - functionCall: { name: delegate_to_research, args: { task: "x" } }
    - text: "финальный ответ"
```

If a case requires a real LLM or full workspace wiring, set `skip: true` —
the runner will report it as `SKIP` and not count it against the success rate.

## Running locally

```bash
npx tsx src/multi/evals/cli.ts src/multi/evals/cases/builtin.yaml
npx tsx src/multi/evals/cli.ts src/multi/evals/cases/builtin.yaml --threshold 0.95
npx tsx src/multi/evals/cli.ts src/multi/evals/cases/builtin.yaml \
  --baseline evals.baseline.json --out evals.latest.json
```

Exit codes:

- `0` — success rate >= threshold AND no regressions vs baseline.
- `1` — regression OR threshold violation.
- `2` — invalid arguments / load failure.

## Updating the baseline

After verifying a run is healthy, write a fresh baseline:

```bash
npx tsx src/multi/evals/cli.ts src/multi/evals/cases/builtin.yaml \
  --out evals.baseline.json
```

Commit `evals.baseline.json` so CI can detect regressions on future runs.

## Environment

The default mock-mode runner needs no environment variables. Future modes
(live Gemini, real `runBetsy`) will be opt-in via env flags.
