// Repro regression: role-header-prefixed close tag must be protected like any tag line.
// Defect: keepContextLineNumbers protected the line BEFORE a header-prefixed
// `</keepContext>` instead of the tag line itself (asymmetric with plain closes
// and with header-prefixed openers). See /task/notes-b.md.
import { describe, expect, it } from "vitest";
import { keepContextLineNumbers } from "../src/core/compaction/transcript-serialization.js";

describe("keepContext close tag on a role-header line (agent b repro)", () => {
	it("protects the close-tag line when the close tag follows a role header", () => {
		const lines = ["[User]: a", "<keepContext>", "b", "[User]: </keepContext>", "c"];
		// Contract (source docblock): one-based lines covered by spans, INCLUSIVE
		// of the tag lines. Open tag = line 2, close tag = line 4.
		expect([...keepContextLineNumbers(lines)]).toEqual([2, 3, 4]);
	});

	it("does not protect lines after a header-prefixed close tag", () => {
		const lines = ["[User]: a", "<keepContext>", "[User]: </keepContext>", "free text"];
		expect([...keepContextLineNumbers(lines)]).toEqual([2, 3]);
	});

	it("keeps the asymmetric case (header-prefixed open) unchanged", () => {
		const lines = ["[User]: <keepContext>", "pinned", "</keepContext>", "after"];
		expect([...keepContextLineNumbers(lines)]).toEqual([1, 2, 3]);
	});

	it("treats a header-prefixed close tag in a tool result as inert data", () => {
		// Tool-result payloads are untrusted: their tag text is data, not syntax.
		const lines = ["[User]: <keepContext>", "pinned", "[Tool result]: </keepContext>", "more"];
		// The tool-result header closes the open user span at its previous line;
		// the close tag itself must NOT re-arm protection on line 3.
		expect([...keepContextLineNumbers(lines)]).toEqual([1, 2]);
	});

	it("matches a plain (header-less) close tag: span inclusive of the close line", () => {
		const lines = ["[User]: a", "<keepContext>", "b", "</keepContext>", "c"];
		expect([...keepContextLineNumbers(lines)]).toEqual([2, 3, 4]);
	});
});
