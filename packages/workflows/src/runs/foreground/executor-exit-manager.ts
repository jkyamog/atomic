import { workflowSerializableTypeName } from "../../shared/serializable.js";
import type { StageSnapshot } from "../../shared/store-types.js";
import type { WorkflowExitOptions } from "../../shared/types.js";
import {
	captureWorkflowExitOutputSnapshot,
	describeWorkflowExitOptionValue,
	findWorkflowExitSignal,
	freezeWorkflowExitOutputSnapshot,
	isWorkflowExitStatus,
	makeWorkflowExitSignal,
	parentWorkflowExitAbortReason,
	readWorkflowExitOption,
	type WorkflowExitSignal,
} from "./executor-abort.js";
import type { WorkflowExitCleanup } from "./executor-types.js";

export interface WorkflowExitAbortReason {
	readonly reason?: string;
}

export interface WorkflowExitManager {
	readonly exitScope: symbol;
	getSelectedExit(): WorkflowExitSignal | undefined;
	currentWorkflowExitAbortReason(): WorkflowExitAbortReason | undefined;
	workflowExitSkippedReason(reason?: string): string;
	isWorkflowExitSkippedReason(reason: string | undefined): boolean;
	preserveWorkflowExitSkippedReason(stage: StageSnapshot, fallback: string): void;
	registerWorkflowExitCleanup(stageId: string, cleanup: WorkflowExitCleanup): () => void;
	runWorkflowExitCleanups(reason?: string): void;
	drainWorkflowExitCleanups(reason?: string): Promise<void>;
	registerRunExitCleanup(cleanup: (reason?: string) => void | Promise<void>, name?: string): () => void;
	drainRunExitCleanups(timeoutMs: number, reason?: string): Promise<readonly string[]>;
	throwIfWorkflowExitSelected(): void;
	exit(options?: WorkflowExitOptions): never;
}

export function createWorkflowExitManager(input: {
	readonly runId: string;
	readonly exitScope: symbol;
	readonly controller: AbortController;
}): WorkflowExitManager {
	let selectedExit: WorkflowExitSignal | undefined;
	const exitCleanups = new Map<string, WorkflowExitCleanup>();
	const workflowExitCleanupPromises = new Set<Promise<void>>();
	const runExitCleanups: Array<{
		readonly name: string;
		readonly cleanup: (reason?: string) => void | Promise<void>;
	}> = [];
	const runExitCleanupPromises = new Map<Promise<void>, string>();

	const workflowExitSkippedReason = (reason?: string): string =>
		reason === undefined || reason.length === 0 ? "workflow-exit" : `workflow-exit: ${reason}`;
	const isWorkflowExitSkippedReason = (reason: string | undefined): boolean =>
		reason === "workflow-exit" || reason?.startsWith("workflow-exit: ") === true;
	const currentWorkflowExitAbortReason = (): WorkflowExitAbortReason | undefined => {
		const scopedExit = selectedExit ?? findWorkflowExitSignal(input.controller.signal.reason, input.exitScope);
		if (scopedExit !== undefined) {
			return scopedExit.reason === undefined ? {} : { reason: scopedExit.reason };
		}
		const parentExit = parentWorkflowExitAbortReason(input.controller.signal.reason);
		if (parentExit !== undefined) {
			return parentExit.workflowExitReason === undefined ? {} : { reason: parentExit.workflowExitReason };
		}
		return undefined;
	};
	const preserveWorkflowExitSkippedReason = (stage: StageSnapshot, fallback: string): void => {
		if (isWorkflowExitSkippedReason(stage.skippedReason)) return;
		const workflowExitAbort = currentWorkflowExitAbortReason();
		stage.skippedReason =
			workflowExitAbort !== undefined ? workflowExitSkippedReason(workflowExitAbort.reason) : fallback;
	};
	const trackWorkflowExitCleanup = (operation: void | Promise<void>): void => {
		if (operation === undefined) return;
		let tracked: Promise<void>;
		tracked = Promise.resolve(operation)
			.catch(() => {
				// Cleanup is best-effort and must never convert ctx.exit into failure.
			})
			.finally(() => {
				workflowExitCleanupPromises.delete(tracked);
			});
		workflowExitCleanupPromises.add(tracked);
	};
	const invokeWorkflowExitCleanup = (cleanup: WorkflowExitCleanup, reason?: string): void => {
		try {
			trackWorkflowExitCleanup(cleanup.skipForWorkflowExit(reason));
		} catch (err) {
			trackWorkflowExitCleanup(Promise.reject(err));
		}
	};
	const registerWorkflowExitCleanup = (stageId: string, cleanup: WorkflowExitCleanup): (() => void) => {
		if (selectedExit !== undefined) {
			invokeWorkflowExitCleanup(cleanup, selectedExit.reason);
			return () => undefined;
		}
		exitCleanups.set(stageId, cleanup);
		return () => {
			if (exitCleanups.get(stageId) === cleanup) exitCleanups.delete(stageId);
		};
	};
	const runWorkflowExitCleanups = (reason?: string): void => {
		for (const cleanup of [...exitCleanups.values()]) invokeWorkflowExitCleanup(cleanup, reason);
	};
	const invokeRunExitCleanup = (
		name: string,
		cleanup: (reason?: string) => void | Promise<void>,
		reason?: string,
	): void => {
		const promise = Promise.resolve()
			.then(() => cleanup(reason))
			.catch(() => {
				// Run-level cleanups are best-effort and must never fail the
				// quit or the ctx.exit finalization.
			});
		runExitCleanupPromises.set(promise, name);
		void promise.finally(() => {
			runExitCleanupPromises.delete(promise);
		});
	};
	/**
	 * Fire every registered run-level exit cleanup exactly once: the set is
	 * spliced on fire, so later drains (a repeated quit, the ctx.exit
	 * finalizer, a direct drain) observe nothing to fire, and unregisters
	 * returned for already-fired entries become no-ops.
	 */
	const fireRunExitCleanups = (reason?: string): void => {
		if (runExitCleanups.length === 0) return;
		for (const entry of runExitCleanups.splice(0, runExitCleanups.length)) {
			invokeRunExitCleanup(entry.name, entry.cleanup, reason);
		}
	};
	const registerRunExitCleanup = (cleanup: (reason?: string) => void | Promise<void>, name?: string): (() => void) => {
		const entry = { name: name ?? "exit-cleanup", cleanup };
		runExitCleanups.push(entry);
		return () => {
			const index = runExitCleanups.indexOf(entry);
			if (index !== -1) runExitCleanups.splice(index, 1);
		};
	};
	/**
	 * Fire the run-level set and await the fired cleanups up to `timeoutMs`,
	 * which bounds each cleanup because they all run in parallel. Returns the
	 * names still pending when the bound expires; a hanging cleanup must never
	 * pin the quit.
	 */
	const drainRunExitCleanups = async (timeoutMs: number, reason?: string): Promise<readonly string[]> => {
		fireRunExitCleanups(reason);
		if (runExitCleanupPromises.size === 0) return [];
		let expire: (() => void) | undefined;
		const deadline = new Promise<void>((resolve) => {
			expire = resolve;
		});
		const timer = setTimeout(() => expire?.(), timeoutMs);
		// Node's timer keeps the loop alive otherwise; quit must not extend
		// process lifetime just because a cleanup may never settle.
		(timer as { unref?: () => void }).unref?.();
		try {
			await Promise.race([Promise.all([...runExitCleanupPromises.keys()]), deadline]);
		} finally {
			clearTimeout(timer);
		}
		return [...runExitCleanupPromises.values()];
	};
	const drainWorkflowExitCleanups = async (reason?: string): Promise<void> => {
		runWorkflowExitCleanups(reason);
		// The ctx.exit finalizer path is also the drain point for the
		// run-level set: a run's cleanups fire through exactly one of this,
		// a quit drain, or nothing — once-only either way.
		fireRunExitCleanups(reason);
		while (workflowExitCleanupPromises.size > 0 || runExitCleanupPromises.size > 0) {
			await Promise.all([...workflowExitCleanupPromises, ...runExitCleanupPromises.keys()]);
		}
	};
	const throwIfWorkflowExitSelected = (): void => {
		if (selectedExit !== undefined) {
			if (!input.controller.signal.aborted) input.controller.abort(selectedExit);
			runWorkflowExitCleanups(selectedExit.reason);
			throw selectedExit;
		}
		if (input.controller.signal.aborted) {
			throw input.controller.signal.reason ?? new DOMException("workflow killed", "AbortError");
		}
	};

	const exit = (options?: WorkflowExitOptions): never => {
		if (selectedExit !== undefined) {
			if (!input.controller.signal.aborted) input.controller.abort(selectedExit);
			runWorkflowExitCleanups(selectedExit.reason);
			throw selectedExit;
		}
		if (input.controller.signal.aborted) {
			throw input.controller.signal.reason ?? new DOMException("workflow killed", "AbortError");
		}

		const throwNestedSelectedExit = (): void => {
			if (selectedExit === undefined) return;
			if (!input.controller.signal.aborted) input.controller.abort(selectedExit);
			runWorkflowExitCleanups(selectedExit.reason);
			throw selectedExit;
		};
		const rawOptions = options as
			| Pick<WorkflowExitOptions, "status" | "reason" | "resumable" | "outputs">
			| null
			| undefined;
		let validationError: Error | undefined;
		const captureValidationError = (error: Error): void => {
			validationError ??= error;
		};

		const statusRead = readWorkflowExitOption(rawOptions, "status");
		throwNestedSelectedExit();
		const rawStatus = statusRead.ok ? (statusRead.value ?? "completed") : "completed";
		if (!statusRead.ok) {
			captureValidationError(statusRead.error);
		} else if (!isWorkflowExitStatus(rawStatus)) {
			captureValidationError(
				new TypeError(
					`atomic-workflows: ctx.exit() status must be one of completed, skipped, cancelled, blocked, failed; got ${describeWorkflowExitOptionValue(rawStatus)}`,
				),
			);
		}
		const status = isWorkflowExitStatus(rawStatus) ? rawStatus : "completed";

		const reasonRead = readWorkflowExitOption(rawOptions, "reason");
		throwNestedSelectedExit();
		const rawReason = reasonRead.ok ? reasonRead.value : undefined;
		if (!reasonRead.ok) {
			captureValidationError(reasonRead.error);
		} else if (rawReason !== undefined && typeof rawReason !== "string") {
			captureValidationError(
				new TypeError(
					`atomic-workflows: ctx.exit() reason must be a string when provided; got ${workflowSerializableTypeName(rawReason)}`,
				),
			);
		}
		const reason = typeof rawReason === "string" ? rawReason : undefined;

		const resumableRead = readWorkflowExitOption(rawOptions, "resumable");
		throwNestedSelectedExit();
		const rawResumable = resumableRead.ok ? resumableRead.value : undefined;
		if (!resumableRead.ok) {
			captureValidationError(resumableRead.error);
		} else if (rawResumable !== undefined && typeof rawResumable !== "boolean") {
			captureValidationError(
				new TypeError(
					`atomic-workflows: ctx.exit() resumable must be a boolean when provided; got ${workflowSerializableTypeName(rawResumable)}`,
				),
			);
		} else if (rawResumable !== undefined && rawStatus !== "failed") {
			captureValidationError(
				new TypeError(
					`atomic-workflows: ctx.exit() resumable is only valid with status failed; got ${describeWorkflowExitOptionValue(rawStatus)}`,
				),
			);
		}
		const resumable = status === "failed" && rawResumable === true;

		const outputsRead = readWorkflowExitOption(rawOptions, "outputs");
		throwNestedSelectedExit();
		const outputSnapshot = !outputsRead.ok
			? freezeWorkflowExitOutputSnapshot({ ok: false, error: outputsRead.error })
			: outputsRead.value !== undefined
				? captureWorkflowExitOutputSnapshot(outputsRead.value)
				: undefined;
		throwNestedSelectedExit();

		selectedExit = Object.freeze(
			makeWorkflowExitSignal({
				scope: input.exitScope,
				status,
				...(reason !== undefined ? { reason } : {}),
				...(status === "failed" ? { resumable } : {}),
				...(outputSnapshot !== undefined ? { outputSnapshot } : {}),
				...(validationError !== undefined ? { validationError } : {}),
			}),
		);
		input.controller.abort(selectedExit);
		runWorkflowExitCleanups(reason);
		throw selectedExit;
	};

	return {
		exitScope: input.exitScope,
		getSelectedExit: () => selectedExit,
		currentWorkflowExitAbortReason,
		workflowExitSkippedReason,
		isWorkflowExitSkippedReason,
		preserveWorkflowExitSkippedReason,
		registerWorkflowExitCleanup,
		runWorkflowExitCleanups,
		drainWorkflowExitCleanups,
		registerRunExitCleanup,
		drainRunExitCleanups,
		throwIfWorkflowExitSelected,
		exit,
	};
}
