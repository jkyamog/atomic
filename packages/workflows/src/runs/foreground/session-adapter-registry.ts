import type { SessionAdapterSelector } from "../../shared/types.js";
import type { AgentSessionAdapter, StageAdapters } from "./stage-runner-types.js";

export const SESSION_ADAPTER_PROTOCOL_VERSION = 1 as const;
export const SESSION_ADAPTER_REGISTER_EVENT = "atomic:workflows:session-adapter:register";
export const SESSION_ADAPTER_DISCOVER_EVENT = "atomic:workflows:session-adapter:discover";

export interface SessionAdapterRegistration {
	readonly version: typeof SESSION_ADAPTER_PROTOCOL_VERSION;
	readonly name: string;
	readonly adapter: AgentSessionAdapter;
}

export interface SessionAdapterEventBus {
	emit(channel: string, data: Record<string, unknown>): void;
	on(channel: string, handler: (data: unknown) => void): unknown;
}

export class SessionAdapterRegistry {
	private readonly registrations = new Map<string, AgentSessionAdapter>();

	register(registration: SessionAdapterRegistration): void {
		if (registration.version !== SESSION_ADAPTER_PROTOCOL_VERSION) {
			throw new Error(
				`atomic-workflows: unsupported session adapter protocol version ${String(registration.version)}; expected ${SESSION_ADAPTER_PROTOCOL_VERSION}`,
			);
		}
		const name = registration.name.trim();
		if (name.length === 0) throw new Error("atomic-workflows: session adapter name must not be empty");
		const existing = this.registrations.get(name);
		if (existing === registration.adapter) return;
		if (existing !== undefined) {
			throw new Error(`atomic-workflows: conflicting session adapter registration for name "${name}"`);
		}
		this.registrations.set(name, registration.adapter);
	}

	get(name: string): AgentSessionAdapter | undefined {
		return this.registrations.get(name);
	}

	names(): readonly string[] {
		return [...this.registrations.keys()].sort();
	}
}

function isRegistration(value: unknown): value is SessionAdapterRegistration {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as Partial<SessionAdapterRegistration>;
	return (
		candidate.version === SESSION_ADAPTER_PROTOCOL_VERSION &&
		typeof candidate.name === "string" &&
		candidate.adapter !== null &&
		typeof candidate.adapter === "object" &&
		typeof candidate.adapter.create === "function"
	);
}

export function installSessionAdapterDiscovery(
	events: SessionAdapterEventBus | undefined,
	registry: SessionAdapterRegistry = new SessionAdapterRegistry(),
): { readonly registry: SessionAdapterRegistry; readonly dispose: () => void } {
	if (events === undefined) return { registry, dispose: () => undefined };
	const unsubscribe = events.on(SESSION_ADAPTER_REGISTER_EVENT, (payload) => {
		if (isRegistration(payload)) registry.register(payload);
	});
	events.emit(SESSION_ADAPTER_DISCOVER_EVENT, { version: SESSION_ADAPTER_PROTOCOL_VERSION });
	return { registry, dispose: typeof unsubscribe === "function" ? () => unsubscribe() : () => undefined };
}

export function resolveSessionAdapter(
	adapters: StageAdapters,
	selector: SessionAdapterSelector | undefined,
): AgentSessionAdapter | undefined {
	if (selector === undefined) return adapters.agentSession;
	const adapter = adapters.sessionAdapters?.get(selector.name);
	if (adapter !== undefined) return adapter;
	const available = adapters.sessionAdapters?.names() ?? [];
	const suffix =
		available.length > 0 ? ` Available adapters: ${available.join(", ")}.` : " No named adapters are registered.";
	throw new Error(`atomic-workflows: unknown session adapter "${selector.name}".${suffix}`);
}
