/**
 * Pre-context tool-output compression.
 *
 * Trims tool output before it enters the conversation context:
 * - Strips ANSI escape codes
 * - Collapses consecutive blank lines
 * - Truncates long outputs with head+tail preservation per tool budget
 *
 * Runs before the result enters the message array. The model never sees
 * the trimmed content.
 */

import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";

// ============================================================================
// Types
// ============================================================================

export type ToolCompressionLevel = "off" | "conservative" | "aggressive";

export interface ToolBudget {
	maxLines: number;
	headLines: number;
	tailLines: number;
}

// ============================================================================
// Budgets per level
// ============================================================================

const CONSERVATIVE_BUDGETS: Record<string, ToolBudget> = {
	bash: { maxLines: 300, headLines: 200, tailLines: 100 },
	grep: { maxLines: 200, headLines: 140, tailLines: 60 },
	glob: { maxLines: 100, headLines: 70, tailLines: 30 },
	eval: { maxLines: 250, headLines: 175, tailLines: 75 },
};

const AGGRESSIVE_BUDGETS: Record<string, ToolBudget> = {
	bash: { maxLines: 80, headLines: 50, tailLines: 30 },
	grep: { maxLines: 120, headLines: 80, tailLines: 40 },
	glob: { maxLines: 60, headLines: 40, tailLines: 20 },
	eval: { maxLines: 150, headLines: 100, tailLines: 50 },
};

const CONSERVATIVE_FALLBACK: ToolBudget = { maxLines: 250, headLines: 175, tailLines: 75 };
const AGGRESSIVE_FALLBACK: ToolBudget = { maxLines: 150, headLines: 100, tailLines: 50 };

// Tools whose output must not be truncated — the model needs the full
// content to reason about it or act on it (e.g. file content for edits).
const SKIP_TRUNCATION_TOOLS: Record<string, true> = { read: true };

// ============================================================================
// ANSI stripping
// ============================================================================

const ANSI_ESCAPE_RE =
	/[\u001b\u009b](?:[@-Z\\-_]|\[[0-9;]*[ -/]*[@-~]|[@-_][0-9;]*[@-~]?|[@-_]|[0-9;]*m)/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE_RE, "");
}

// ============================================================================
// Blank line collapsing
// ============================================================================

export function collapseBlankLines(text: string): string {
	return text.replace(/(\r?\n){3,}/g, "\n\n");
}

// ============================================================================
// Truncation with head+tail preservation
// ============================================================================

function getBudgetsForLevel(level: ToolCompressionLevel): {
	budgets: Record<string, ToolBudget>;
	fallback: ToolBudget;
} {
	return level === "aggressive"
		? { budgets: AGGRESSIVE_BUDGETS, fallback: AGGRESSIVE_FALLBACK }
		: { budgets: CONSERVATIVE_BUDGETS, fallback: CONSERVATIVE_FALLBACK };
}

export function getToolBudget(
	toolName: string,
	level: ToolCompressionLevel,
	customBudgets?: Record<string, ToolBudget>,
): ToolBudget {
	const { budgets, fallback } = getBudgetsForLevel(level);
	return customBudgets?.[toolName] ?? budgets[toolName] ?? fallback;
}

export function truncateWithToolBudget(
	text: string,
	toolName: string,
	level: ToolCompressionLevel,
	customBudgets?: Record<string, ToolBudget>,
): string {
	const budget = getToolBudget(toolName, level, customBudgets);
	const lines = text.split("\n");
	if (lines.length <= budget.maxLines) {
		return text;
	}
	const omitted = lines.length - budget.headLines - budget.tailLines;
	const head = lines.slice(0, budget.headLines);
	const tail = lines.slice(lines.length - budget.tailLines);
	return [
		...head,
		"",
		`[... ${omitted} lines omitted (${toolName} budget: ${budget.maxLines}) ...]`,
		"",
		...tail,
	].join("\n");
}

// ============================================================================
// Main compressor
// ============================================================================

export function compressToolOutput(
	text: string,
	toolName: string,
	level: ToolCompressionLevel,
	customBudgets?: Record<string, ToolBudget>,
): string {
	let out = stripAnsi(text);
	out = collapseBlankLines(out);
	if (!SKIP_TRUNCATION_TOOLS[toolName]) {
		out = truncateWithToolBudget(out, toolName, level, customBudgets);
	}
	return out;
}

// ============================================================================
// Content block processor
// ============================================================================

export function compressToolContentBlocks(
	content: (TextContent | ImageContent)[],
	toolName: string,
	level: ToolCompressionLevel,
	customBudgets?: Record<string, ToolBudget>,
): (TextContent | ImageContent)[] {
	let changed = false;
	const result = content.map(block => {
		if (block.type !== "text" || typeof block.text !== "string") {
			return block;
		}
		const compressed = compressToolOutput(block.text, toolName, level, customBudgets);
		if (compressed === block.text) {
			return block;
		}
		changed = true;
		return { ...block, text: compressed };
	});
	return changed ? result : content;
}
