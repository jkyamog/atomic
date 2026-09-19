import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import {
	EXIT_CLEANUP_QUIT_TIMEOUT_MS,
	quitRun,
	quitRunWithAction,
} from "../../packages/workflows/src/runs/background/quit.js";
import { resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { createWorkflowExitManager } from "../../packages/workflows/src/runs/foreground/executor-exit-manager.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { WorkflowRunContext } from "../../packages/workflows/src/shared/types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

/**
 * Build a workflow whose run body registers a cleanup and then blocks in a
 * tool node until its abort signal lands, so a quit can be observed while the
 * run still has live work.
 */
function makeHangWorkflow(name: string, registerCleanup: (ctx: WorkflowRunContext) => void) {
	const entered = Promise.withResolvers<void>();
	const definition = workflow({
		name,
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			registerCleanup(ctx);
			await ctx.tool("hang", {}, async ({ signal }) => {
				entered.resolve();
				await new Promise<void>((resolve) => {
					if (signal.aborted) return resolve();
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return "late";
			});
			return {};
		},
	});
	return { definition, entered };
}

afterEach(() => setDurableBackend(undefined));

describe("ctx.registerExitCleanup quit drain", () => {
	test("quit fires registered cleanups before the quit result resolves", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const runId = "quit-cleanup-drain";
		let fired = 0;
		const { definition, entered } = makeHangWorkflow(runId, (ctx) => {
			ctx.registerExitCleanup(
				() => {
					fired += 1;
				},
				"drain-check",
			);
		});
		const execution = run(definition, {}, {
			runId,
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
			durableBackend: backend,
		});
		await entered.promise;

		const result = await quitRun(runId, { store, stageControlRegistry: registry, toolControlRegistry: toolControls });

		assert.equal(result.ok, true);
		assert.equal(fired, 1, "the drain settled the cleanup before the quit result resolved");
		if (result.ok) {
			assert.equal(result.abandonedCleanups, undefined);
			assert.deepEqual(result.cancelledTools.map((entry) => [entry.node.name, entry.node.status]), [
				["hang", "cancelled"],
			]);
			assert.deepEqual(result.abandonedTools, []);
		}
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.resumable, true);
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
		assert.equal((await execution).status, "paused");
	});

	test("a hanging cleanup is abandoned at the drain bound and reported", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const runId = "quit-cleanup-hang";
		const { definition, entered } = makeHangWorkflow(runId, (ctx) => {
			ctx.registerExitCleanup(
				async () => {
					await new Promise<void>(() => {}); // never settles
				},
				"hang-cleanup",
			);
		});
		const execution = run(definition, {}, {
			runId,
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
			durableBackend: backend,
		});
		await entered.promise;

		const result = await quitRun(runId, {
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
			cleanupDrainTimeoutMs: 50,
		});

		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.abandonedCleanups, ["hang-cleanup"]);
			assert.match(result.message ?? "", /Abandoned 1 exit cleanup/);
		}
		assert.equal((await execution).status, "paused", "an abandoned cleanup must not pin the quit");
	});

	test("an actor-carrying quit is terminal, still drains, and rejects resume", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const runId = "quit-cleanup-terminal";
		let fired = 0;
		const { definition, entered } = makeHangWorkflow(runId, (ctx) => {
			ctx.registerExitCleanup(
				() => {
					fired += 1;
				},
				"terminal-drain",
			);
		});
		const execution = run(definition, {}, {
			runId,
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
			durableBackend: backend,
		});
		await entered.promise;

		const result = await quitRun(runId, {
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
			actor: "user",
		});

		assert.equal(result.ok, true);
		assert.equal(fired, 1, "a terminal quit still drains its cleanups");
		const snapshot = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(snapshot?.resumable, false);
		assert.equal(snapshot?.exitReason, "quit");
		const resumed = await resumeRun(runId, {
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
		});
		assert.equal(resumed.ok, false);
		if (!resumed.ok) assert.equal(resumed.reason, "not_resumable");
		void execution;
	});

	test("interrupt does not fire run-level cleanups and stays resumable", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const runId = "interrupt-cleanup-pause";
		let fired = 0;
		const { definition, entered } = makeHangWorkflow(runId, (ctx) => {
			ctx.registerExitCleanup(
				() => {
					fired += 1;
				},
				"interrupt-skip",
			);
		});
		const execution = run(definition, {}, {
			runId,
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
			durableBackend: backend,
		});
		await entered.promise;

		const result = await quitRunWithAction(
			runId,
			{ store, stageControlRegistry: registry, toolControlRegistry: toolControls },
			"interrupt",
		);

		assert.equal(result.ok, true);
		assert.equal(fired, 0, "interrupt is a resumable pause, not a quit drain");
		const snapshot = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(snapshot?.resumable, true);
		assert.equal(snapshot?.status, "paused");
		assert.equal((await execution).status, "paused");
	});
});

describe("run-level exit cleanup drain semantics", () => {
	test("fired cleanups are not re-fired by later drains", async () => {
		const manager = createWorkflowExitManager({
			runId: "once-only",
			exitScope: Symbol("once-only"),
			controller: new AbortController(),
		});
		let fired = 0;
		const unregister = manager.registerRunExitCleanup(
			() => {
				fired += 1;
			},
			"once",
		);
		unregister();
		const unregistered = await manager.drainRunExitCleanups(500);
		assert.deepEqual(unregistered, []);
		assert.equal(fired, 0, "an unregistered cleanup never fires");

		manager.registerRunExitCleanup(() => {
			fired += 1;
		});
		await manager.drainRunExitCleanups(500);
		assert.equal(fired, 1);
		const abandoned = await manager.drainRunExitCleanups(500);
		assert.deepEqual(abandoned, []);
		assert.equal(fired, 1, "a repeated drain observes nothing left to fire");
		await manager.drainWorkflowExitCleanups("workflow-exit");
		assert.equal(fired, 1, "the exit finalizer drain observes nothing left to fire");
	});

	test("the default drain bound pins the documented 30s", () => {
		assert.equal(EXIT_CLEANUP_QUIT_TIMEOUT_MS, 30_000);
	});
});
