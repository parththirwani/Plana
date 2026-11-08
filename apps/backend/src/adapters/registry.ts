import { AGENT_ENGINE_IDS, ENGINE_CAPABILITIES, type AgentEngineId } from "./capabilities";
import { EngineError, type EngineAdapter } from "./contract";
import { FakeEngineAdapter } from "./fakeEngine";

// Engine adapter registry (CP5/CP6).
//
// The worker resolves adapters ONLY through this registry, so what can run is
// exactly what is registered — there is no fallback lookup, no "closest
// engine", nothing inline. The DEFAULT registry contains ONLY the fake
// adapters:
//
//   * CODEX / CLAUDE_CODE / OPENCODE -> FakeEngineAdapter(engineId), which
//     enforce the shared capability catalog;
//   * PI is intentionally ABSENT: the catalog marks it unavailable ("never
//     substituted"), and an adapter was never shipped. require("PI") throws
//     UNSUPPORTED_CAPABILITY with the catalog reason — the worker then FAILS
//     the run; it never picks a different engine.
//
// The real E2B-backed adapters (Codex SDK / Claude Agent SDK / OpenCode SDK /
// Pi RPC) are OUT OF SCOPE in this container (no credentials, no network):
// registering them here is the single seam production will use; the worker
// code does not change. That stays in the UNVERIFIED ledger.

export interface EngineAdapterRegistry {
    get(engineId: string): EngineAdapter | undefined;
    /** Throws EngineError(UNSUPPORTED_CAPABILITY) — never substitutes. */
    require(engineId: string): EngineAdapter;
    register(adapter: EngineAdapter): void;
    describe(): string[];
}

export const createEngineAdapterRegistry = (
    adapters: EngineAdapter[] = []
): EngineAdapterRegistry => {
    const byEngine = new Map<string, EngineAdapter>();
    for (const adapter of adapters) byEngine.set(adapter.engineId, adapter);

    return {
        get: (engineId) => byEngine.get(engineId),

        require: (engineId) => {
            const adapter = byEngine.get(engineId);
            if (adapter) return adapter;
            const spec = (ENGINE_CAPABILITIES as Record<string, any>)[engineId];
            const known = (Object.keys(ENGINE_CAPABILITIES) as string[]).includes(engineId);
            throw new EngineError(
                "UNSUPPORTED_CAPABILITY",
                known
                    ? spec?.reason ?? `no engine adapter is registered for ${engineId}`
                    : `unknown engine '${engineId}'; no adapter exists and nothing is ever substituted`,
                { engine: engineId, registeredAdapters: [...byEngine.keys()], substituted: false }
            );
        },

        register: (adapter) => {
            byEngine.set(adapter.engineId, adapter);
        },

        describe: () =>
            [...byEngine.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([engineId, adapter]) => `${engineId}=${adapter.id}`),
    };
};

/** The ONLY registry usable in this container: fake adapters for the three
 *  engines the capability catalog marks available. PI is deliberately absent
 *  and real providers are not registered. */
export const createFakeOnlyRegistry = (): EngineAdapterRegistry =>
    createEngineAdapterRegistry(
        AGENT_ENGINE_IDS.filter((id) => ENGINE_CAPABILITIES[id].available).map(
            (id) => new FakeEngineAdapter(id as keyof typeof ENGINE_CAPABILITIES)
        )
    );

export type { AgentEngineId };
