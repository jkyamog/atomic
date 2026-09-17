import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";

// The broker request timeout is read from INTERCOM_REQUEST_TIMEOUT_MS at module
// load, so each behavior under test imports a fresh client module with the env
// var pinned first. The fake broker below only registers the client; what it
// does with subsequent `list` requests is per-test.

const agentDir = mkdtempSync(join(tmpdir(), "intercom-request-timeout-"));
const socketPath = getBrokerSocketPath(process.platform, agentDir);
const originalAtomicAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalTimeoutEnv = process.env.INTERCOM_REQUEST_TIMEOUT_MS;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;
mkdirSync(join(agentDir, "intercom"), { recursive: true });

type ClientModule = typeof import("../../packages/intercom/broker/client.js");
type Client = ClientModule["IntercomClient"];

const liveClients: InstanceType<Client>[] = [];
let server: net.Server | undefined;
let onList: ((socket: net.Socket, requestId: string) => void) | undefined;

function onConnection(socket: net.Socket): void {
	socket.on(
		"data",
		createMessageReader(
			(message) => {
				const frame = message as { type?: unknown; requestId?: unknown };
				if (frame.type === "register") {
					writeMessage(socket, { type: "registered", sessionId: "request-timeout-test" });
					return;
				}
				if (frame.type === "list" && typeof frame.requestId === "string") {
					onList?.(socket, frame.requestId);
				}
			},
			() => {},
		),
	);
	socket.on("error", () => {});
}

/** Import a fresh client module with INTERCOM_REQUEST_TIMEOUT_MS pinned to `raw` (or removed). */
async function importClientWithTimeout(raw: string | undefined): Promise<{
	module: ClientModule;
}> {
	if (raw === undefined) delete process.env.INTERCOM_REQUEST_TIMEOUT_MS;
	else process.env.INTERCOM_REQUEST_TIMEOUT_MS = raw;
	vi.resetModules();
	const mod = await import("../../packages/intercom/broker/client.js");
	return { module: mod };
}

async function connectedClient(mod: ClientModule): Promise<InstanceType<Client>> {
	const client = new mod.IntercomClient();
	liveClients.push(client);
	await client.connect({
		cwd: "/tmp/intercom-request-timeout-test",
		model: "test",
		pid: process.pid,
		startedAt: 1,
		lastActivity: 1,
	});
	return client;
}

beforeAll(async () => {
	const srv = net.createServer(onConnection);
	server = srv;
	await new Promise<void>((resolve) => srv.listen(socketPath, resolve));
});

afterEach(async () => {
	onList = undefined;
	for (const client of liveClients.splice(0)) {
		try {
			await client.disconnect();
		} catch {
			// Already gone; the assertion under way is what matters.
		}
	}
	if (originalTimeoutEnv === undefined) delete process.env.INTERCOM_REQUEST_TIMEOUT_MS;
	else process.env.INTERCOM_REQUEST_TIMEOUT_MS = originalTimeoutEnv;
	vi.resetModules();
});

afterAll(async () => {
	await new Promise<void>((resolve) => server?.close(() => resolve()));
	if (originalAtomicAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAtomicAgentDir;
	if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

test("a valid INTERCOM_REQUEST_TIMEOUT_MS is honored by the resolved constant", async () => {
	for (const [raw, expected] of [
		["250", 250],
		["120000", 120_000],
	] as const) {
		const { module } = await importClientWithTimeout(raw);
		assert.equal(module.REQUEST_TIMEOUT_MS, expected, `INTERCOM_REQUEST_TIMEOUT_MS=${raw}`);
	}
});

test("invalid INTERCOM_REQUEST_TIMEOUT_MS values fall back to the 5s default", async () => {
	for (const raw of ["banana", "0", "-100", ""]) {
		const { module } = await importClientWithTimeout(raw);
		assert.equal(module.REQUEST_TIMEOUT_MS, 5000, `INTERCOM_REQUEST_TIMEOUT_MS=${JSON.stringify(raw)}`);
	}
	const unset = await importClientWithTimeout(undefined);
	assert.equal(unset.module.REQUEST_TIMEOUT_MS, 5000, "unset env var");
});

test("a narrowed timeout rejects a stalled list request far before the 5s default", async () => {
	const { module } = await importClientWithTimeout("200");
	const client = await connectedClient(module);
	onList = () => {}; // broker stall: never answer
	const started = Date.now();
	await assert.rejects(client.listDirectory(), (error: unknown) => {
		assert.equal(String(error), "Error: List sessions timeout");
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 3000, `narrowed 200ms window tripped at ${elapsed}ms; the 5s default would take ~5000ms`);
		return true;
	});
});

test("a widened timeout lets a slow broker answer land where the 5s default would reject", async () => {
	// The historical failure mode: a resource-constrained broker whose event
	// loop stalls past the 5s round-trip window. Widening must let the answer
	// through instead of rejecting a healthy request.
	const { module } = await importClientWithTimeout("10000");
	const client = await connectedClient(module);
	onList = (socket, requestId) => {
		setTimeout(() => {
			writeMessage(socket, { type: "sessions", requestId, sessions: [] });
		}, 5300);
	};
	const directory = await client.listDirectory();
	assert.deepEqual(directory.sessions, []);
});
