import { describe, expect, it } from "vitest";
import { keepContextLineNumbers } from "../src/core/compaction/transcript-serialization.js";

describe("keepContext header-prefixed tags", () => {
	it("protects a close tag written after a role header", () => {
		const lines = ["[User]: a", "<keepContext>", "b", "[User]: </keepContext>", "c"];
		// Tag lines are part of the span and must survive: lines 2-4.
		expect([...keepContextLineNumbers(lines)]).toEqual([2, 3, 4]);
	});

	it("still protects an open tag written after a role header (existing behavior)", () => {
		const lines = ["[User]: <keepContext>", "secret", "</keepContext>", "after"];
		expect([...keepContextLineNumbers(lines)]).toEqual([1, 2, 3]);
	});

	it("header-prefixed close tag closes the span rather than leaking past it", () => {
		const lines = ["[User]: <keepContext>", "pinned", "[User]: </keepContext>", "free"];
		expect([...keepContextLineNumbers(lines)]).toEqual([1, 2, 3]);
	});
});
