import { AGENT_ENGINE_IDS, ENGINE_CAPABILITIES, type AgentEngineId,
} from "./capabilities";
import { EngineError, type EngineAdapter } from "./contract";
import { FakeEngineAdapter } from "./fakeEngine";

// Adapter selection is exact. Fake adapters are created only by explicit callers.

export interface EngineAdapterRegistry {
    get(engineId: string): EngineAdapter | undefined;
    /** Throws EngineError(UNSUPPORTED_CAPABILITY) — never substitutes. */
    require(engineId: string): EngineAdapter;
    register(adapter: EngineAdapter): void;
    describe(): string[];
}

export const createEngineAdapterRegistry = (
    adapters: EngineAdapter[] = [],
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
                    ? (spec?.reason ?? `no engine adapter is registered for ${engineId}`)
                    : `unknown engine '${engineId}'; no adapter exists and nothing is ever substituted`,
                { engine: engineId, registeredAdapters: [...byEngine.keys()], substituted: false,
                },
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

/** All four fixtures implement the same contract; this is not a production registry. */
export const createFakeOnlyRegistry = (): EngineAdapterRegistry =>
    createEngineAdapterRegistry(
        AGENT_ENGINE_IDS.filter((id) => ENGINE_CAPABILITIES[id].available).map(
            (id) => new FakeEngineAdapter(id as keyof typeof ENGINE_CAPABILITIES),
        ),
    );

export type { AgentEngineId };
