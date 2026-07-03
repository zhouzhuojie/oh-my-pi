# Tool output compression: trim before context, not after

Most CLI output has the same shape: important stuff at the top and bottom, repetitive noise in the middle. A 200-line `git diff` teaches the model nothing from line 150 that it didn't already learn from line 10.

Strip the middle, keep the bookends. The model can re-run with `grep` or `tail` if it needs a specific line from the trimmed region. That costs one extra tool call, which is cheaper than stuffing 500 lines of redundant output into context every turn.

oh-my-pi already compresses history after it enters the conversation (pruning, shake, compaction). This does the other direction: trim tool output before it enters the conversation in the first place.

## What it does

For every non-error tool result:
1. Strip ANSI escape codes (color, cursor movement, pure noise)
2. Collapse 3+ blank lines to 1
3. Truncate to per-tool line budgets, keeping head and tail

## Levels

| Level | What happens |
|-------|-------------|
| `off` | nothing |
| `conservative` | strip ANSI + collapse blanks, generous budgets (default) |
| `aggressive` | all of the above, tight budgets (caveman-code defaults) |

Conservative is the safe starting point for real coding. Aggressive is what caveman-code ships with.

## Tool exclusions

The `read` tool delivers file content that the model needs in full to reason about or edit. Truncating it defeats the purpose. `compressToolOutput` skips truncation for `read` (ANSI stripping and blank collapsing still apply). The exclusion set is `SKIP_TRUNCATION_TOOLS` in `tool-output-compression.ts`.

## Why it is safe

The agent always sees the first and last N lines of output. Errors appear at the top or bottom. Test results appear at the bottom. The middle is almost always format-repeated noise. And the model can always ask for more with `head`/`tail`/`grep`.

## Token savings

Assuming a 15-turn session with typical tool output (bash: 200 lines/turn, read: 400 lines/turn, grep: 150 lines/turn):

| Level | Direct savings | With re-read compounding |
|-------|---------------|------------------------|
| conservative | ~15% | ~5,000-7,000 tokens |
| aggressive | ~35% | ~16,000-19,000 tokens |

Conservative trims the obvious junk (ANSI, blank lines) and only truncates the longest outputs. Aggressive truncates everything to tight budgets.

## Implementation

`packages/agent/src/compression/tool-output-compression.ts` (~160 lines, zero deps, 19 tests).

Key functions:

```ts
// Pipeline entry point — runs all three steps
compressToolOutput(text, toolName, level) → string

// Step 1: strip ANSI escape codes
stripAnsi(text) → string

// Step 2: collapse 3+ blank lines to 1
collapseBlankLines(text) → string

// Step 3: head+tail truncation per tool budget (skipped for read)
truncateWithToolBudget(text, toolName, level) → string

// Processes Anthropic-style content block arrays
compressToolContentBlocks(content, toolName, level) → blocks
```

Budgets live in two maps (`CONSERVATIVE_BUDGETS`, `AGGRESSIVE_BUDGETS`), selected by the `level` parameter. Unknown tools fall back to a default budget.

Gated on `AgentLoopConfig.toolCompression` (`"off"` | `"conservative"` | `"aggressive"`, default `undefined`). Wired into `agent-loop.ts` at the `ToolResultMessage` construction point. Error results are never compressed.

Ported from caveman-code (MIT).
