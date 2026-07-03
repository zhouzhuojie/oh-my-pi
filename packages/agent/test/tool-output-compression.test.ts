import { describe, expect, it } from "bun:test";
import {
	collapseBlankLines,
	compressToolContentBlocks,
	compressToolOutput,
	getToolBudget,
	stripAnsi,
	truncateWithToolBudget,
	type ToolCompressionLevel,
} from "../src/compression/tool-output-compression";

describe("stripAnsi", () => {
	it("strips SGR color codes", () => {
		expect(stripAnsi("\x1b[31mred text\x1b[0m")).toBe("red text");
	});

	it("strips cursor movement sequences", () => {
		expect(stripAnsi("\x1b[2J\x1b[H")).toBe("");
	});

	it("leaves plain text untouched", () => {
		const input = "hello world\nline 2";
		expect(stripAnsi(input)).toBe(input);
	});
});

describe("collapseBlankLines", () => {
	it("collapses 3+ blank lines to 1", () => {
		expect(collapseBlankLines("line1\n\n\n\nline2")).toBe("line1\n\nline2");
	});

	it("preserves double blank lines", () => {
		expect(collapseBlankLines("line1\n\n\nline2")).toBe("line1\n\nline2");
	});

	it("collapses many blank lines", () => {
		expect(collapseBlankLines("line1\n\n\n\n\n\n\n\nline2")).toBe("line1\n\nline2");
	});
});

describe("getToolBudget", () => {
	it("returns conservative budget for known tools", () => {
		const budget = getToolBudget("bash", "conservative");
		expect(budget.maxLines).toBe(300);
	});

	it("returns aggressive budget for known tools", () => {
		const budget = getToolBudget("bash", "aggressive");
		expect(budget.maxLines).toBe(80);
	});

	it("returns fallback for unknown tools", () => {
		expect(getToolBudget("unknown_tool", "conservative").maxLines).toBe(250);
		expect(getToolBudget("unknown_tool", "aggressive").maxLines).toBe(150);
	});

	it("allows custom budget overrides", () => {
		const custom = { bash: { maxLines: 200, headLines: 150, tailLines: 50 } };
		expect(getToolBudget("bash", "conservative", custom).maxLines).toBe(200);
	});
});

describe("truncateWithToolBudget", () => {
	it("does not truncate short output", () => {
		const input = "line1\nline2\nline3";
		expect(truncateWithToolBudget(input, "bash", "conservative")).toBe(input);
	});

	it("truncates long output with head+tail", () => {
		const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
		const result = truncateWithToolBudget(lines.join("\n"), "bash", "conservative");
		const resultLines = result.split("\n");

		// Conservative bash: head 200 + blank + marker + blank + tail 100 = 303
		expect(resultLines.length).toBe(200 + 1 + 1 + 1 + 100);
		expect(resultLines[0]).toBe("line 0");
		expect(resultLines[199]).toBe("line 199");
		expect(resultLines[203]).toBe("line 400");
		expect(resultLines[302]).toBe("line 499");
		expect(result).toContain("200 lines omitted");
	});

	it("aggressive level uses tighter budgets", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
		const result = truncateWithToolBudget(lines.join("\n"), "bash", "aggressive");
		const resultLines = result.split("\n");

		// Aggressive bash: head 50 + blank + marker + blank + tail 30 = 83
		expect(resultLines.length).toBe(83);
		expect(result).toContain("120 lines omitted");
	});
});

describe("compressToolOutput", () => {
	it("strips ANSI, collapses blanks, and truncates", () => {
		const lines = Array.from({ length: 100 }, (_, i) => `\x1b[32m${i}: output\x1b[0m`);
		const result = compressToolOutput(lines.join("\n\n\n"), "bash", "aggressive");

		expect(result).not.toContain("\x1b[");
		expect(result).not.toContain("output\n\n\n\noutput");
		expect(result).toContain("lines omitted");
	});

	it("conservative level does not truncate short output", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
		const result = compressToolOutput(lines.join("\n"), "bash", "conservative");
		expect(result).not.toContain("lines omitted");
	});

	it("does not truncate read tool output (file content must stay whole)", () => {
		const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
		const result = compressToolOutput(lines.join("\n"), "read", "aggressive");
		// ANSI stripping and blank collapsing still apply, but no truncation
		expect(result).not.toContain("lines omitted");
		expect(result.split("\n")).toHaveLength(500);
	});
});

describe("compressToolContentBlocks", () => {
	it("compresses text blocks", () => {
		const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
		const content = [{ type: "text" as const, text: lines.join("\n") }];
		const result = compressToolContentBlocks(content, "bash", "conservative");
		const block = result[0];
		expect(block.type).toBe("text");
		if (block.type === "text") {
			expect(block.text).toContain("lines omitted");
		}
	});

	it("passes through image blocks unchanged", () => {
		const content = [{ type: "image" as const, data: "base64data", mimeType: "image/png" }];
		expect(compressToolContentBlocks(content, "bash", "conservative")).toEqual(content);
	});

	it("returns same reference when no changes needed", () => {
		const content = [{ type: "text" as const, text: "short output" }];
		expect(compressToolContentBlocks(content, "bash", "conservative")).toBe(content);
	});
});
