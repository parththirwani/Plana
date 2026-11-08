// Engine capability descriptors (CP4/CP5 contract home: src/adapters).
//
// Hard rules encoded here (docs/plans/cloud-agents-architecture.md):
//   * every engine/model/option combination is either available or explicitly
//     unavailable WITH a machine-readable reason;
//   * an unavailable selection is a validation failure — the API must reject it
//     (400) and NEVER silently substitute a supported one, and the engine is
//     never switched automatically;
//   * the same descriptors are what the fake adapters (CP5) implement, so the
//     HTTP layer validates against the exact contract the worker honours.
//
// The concrete model names/limits here mirror Phase-1 reality: real provider
// catalogs (E2B/Codex/Claude/OpenCode/Pi quotas, gateway metering) are NOT
// reachable from this container — see the UNVERIFIED ledger; this catalog is
// the contract surface, not a claim that real engines were probed.

export const AGENT_ENGINE_IDS = [
    "CODEX",
    "CLAUDE_CODE",
    "OPENCODE",
    "PI",
] as const;
export type AgentEngineId = (typeof AGENT_ENGINE_IDS)[number];

export const RUN_EXECUTION_MODE_IDS = ["IMPLEMENT", "PLAN_AND_APPROVE",
] as const;
export type RunExecutionModeId = (typeof RUN_EXECUTION_MODE_IDS)[number];

export type Availability =
    { available: true }
    | { available: false; reason: string };

export type OptionValueSpec = {
    value: string;
    available: boolean;
    reason?: string;
};

export type EngineModelSpec = {
    id: string;
    available: boolean;
    reason?: string;
    /** option name -> allowed values; unknown option names are rejected too. */
    options: Record<string, OptionValueSpec[]>;
};

export type EngineSpec = {
    id: AgentEngineId;
    label: string;
    available: boolean;
    reason?: string;
    executionModes: Record<RunExecutionModeId, { available: boolean; reason?: string }>;
    models: EngineModelSpec[];
};

const both = (
    implement: Availability,
    planAndApprove: Availability,
): EngineSpec["executionModes"] => ({
    IMPLEMENT: implement,
    PLAN_AND_APPROVE: planAndApprove,
});

const REASONING_EFFORT: OptionValueSpec[] = [
    { value: "low", available: true },
    { value: "medium", available: true },
    { value: "high", available: true },
    {
        value: "max",
        available: false,
        reason: "reasoning effort 'max' is excluded from the fake fixture",
    },
];

export const ENGINE_CAPABILITIES: Record<AgentEngineId, EngineSpec> = {
    CODEX: {
        id: "CODEX",
        label: "OpenAI Codex",
        available: true,
        executionModes: both({ available: true }, { available: true }),
        models: [
            {
                id: "gpt-5",
                available: true,
                options: { reasoningEffort: REASONING_EFFORT },
            },
            {
                id: "gpt-5-mini",
                available: true,
                options: { reasoningEffort: REASONING_EFFORT },
            },
            {
                id: "gpt-4.1",
                available: false,
                reason: "gpt-4.1 is excluded from the fake capability fixture",
                options: {},
            },
        ],
    },
    CLAUDE_CODE: {
        id: "CLAUDE_CODE",
        label: "Claude Code",
        available: true,
        executionModes: both({ available: true }, { available: true }),
        models: [
            {
                id: "claude-sonnet-4",
                available: true,
                options: {
                    thinking: [
                        { value: "off", available: true },
                        { value: "on", available: true },
                        {
                            value: "ultrathink",
                            available: false,
                            reason: "ultrathink has no fake budget tier fixture",
                        },
                    ],
                },
            },
            {
                id: "claude-haiku-3-5",
                available: false,
                reason: "claude-haiku-3-5 is excluded from the fake capability fixture",
                options: {},
            },
        ],
    },
    OPENCODE: {
        id: "OPENCODE",
        label: "OpenCode",
        available: true,
        executionModes: both(
            { available: true },
            {
                available: true }
        ),
        models: [
            { id: "opencode-linear", available: true, options: {} },
            {
                id: "opencode-large",
                available: false,
                reason: "opencode-large is excluded from the fake capability fixture",
                options: {},
            },
        ],
    },
    PI: {
        id: "PI",
        label: "Pi (fake)",
        available: true,
        executionModes: both(
            { available: true },
            { available: true }
        ),
        models: [
            {
                id: "pi-1",
                available: true, options: {} },
            {
                id: "pi-unavailable",
                available: false,
                reason: "pi-unavailable is excluded from the fake capability fixture",
                options: {},
            },
        ],
    },
};

export const listEngineSpecs = (): EngineSpec[] =>
    AGENT_ENGINE_IDS.map((id) =>
        process.env.AGENT_EXECUTION_MODE === "fake"
            ? ENGINE_CAPABILITIES[id]
            : {
                  ...ENGINE_CAPABILITIES[id],
                  available: false,
                  reason: "Real engine not qualified; explicitly enable fake mode for simulation",
                  models: ENGINE_CAPABILITIES[id].models.map((m) => ({
                      ...m,
                      available: false,
                  })),
                  executionModes: both(
                      { available: false, reason: "Execution disabled" },
                      { available: false, reason: "Execution disabled" },
                  ),
              },
    );

export const isAgentEngineId = (value: unknown): value is AgentEngineId =>
    typeof value === "string" &&
    (AGENT_ENGINE_IDS as readonly string[]).includes(value);

export const isRunExecutionModeId = (
    value: unknown,
): value is RunExecutionModeId =>
    typeof value === "string" &&
    (RUN_EXECUTION_MODE_IDS as readonly string[]).includes(value);

const findModel = (engine: EngineSpec, modelId: string) =>
    engine.models.find((m) => m.id === modelId);

const describedModelIds = (engine: EngineSpec) =>
    engine.models.filter((m) => m.available).map((m) => m.id);

export type RunSelectionIssue = {
    /** request field that failed: engine | model | executionMode | options.<name> */
    field: string;
    reason: string;
    /** machine-readable code carried into the 400 response */
    code: "UNSUPPORTED_CAPABILITY";
    /** the requested value that was rejected — never substituted */
    requested?: unknown;
    available?: string[];
};

export type RunSelectionResult =
    | { ok: true; engine: EngineSpec; model: EngineModelSpec }
    | { ok: false; issue: RunSelectionIssue };

/**
 * Validate an engine/model/options/execution-mode selection against the
 * capability contract. Every rejection carries an explicit reason so the HTTP
 * layer can answer 400 without ever guessing a replacement: a caller asking for
 * PI, a retired model or an unsupported option must get a failure, never a run
 * on a different engine/model.
 */
export const validateRunSelection = (input: {
    engine: string;
    model: string;
    options?: Record<string, unknown>;
    executionMode?: string;
},
    fixture = false,
): RunSelectionResult => {
    const issue = (
        field: string,
        reason: string,
        requested: unknown,
        available?: string[],
    ): { ok: false; issue: RunSelectionIssue } => ({
        ok: false,
        issue: {
            field,
            reason,
            code: "UNSUPPORTED_CAPABILITY",
            requested,
            ...(available ? { available } : {}),
        },
    });

    if (!fixture && process.env.AGENT_EXECUTION_MODE !== "fake")
        return issue(
            "engine",
            "Real engine execution is not configured; fake mode must be explicitly enabled",
            input.engine,
        );

    if (!isAgentEngineId(input.engine)) {
        return issue(
            "engine",
            `Unknown engine '${String(input.engine)}'; supported engines are ${AGENT_ENGINE_IDS.join(", ")}`,
            input.engine,
            AGENT_ENGINE_IDS.filter((id) => ENGINE_CAPABILITIES[id].available),
        );
    }
    const engine = ENGINE_CAPABILITIES[input.engine];
    if (!engine.available) {
        return issue("engine", engine.reason ?? `${engine.id} is unavailable`, engine.id,
        );
    }

    const mode = input.executionMode ?? "IMPLEMENT";
    if (!isRunExecutionModeId(mode)) {
        return issue(
            "executionMode",
            `Unknown execution mode '${String(mode)}'; supported modes are ${RUN_EXECUTION_MODE_IDS.join(", ")}`,
            mode,
            [...RUN_EXECUTION_MODE_IDS],
        );
    }
    const modeSpec = engine.executionModes[mode];
    if (!modeSpec.available) {
        return issue(
            "executionMode",
            modeSpec.reason ?? `${engine.id} does not support ${mode}`,
            mode,
        );
    }

    const model = findModel(engine, input.model);
    if (!model) {
        return issue(
            "model",
            `${engine.label} does not support model '${input.model}'`,
            input.model,
            describedModelIds(engine),
        );
    }
    if (!model.available) {
        return issue(
            "model",
            model.reason ?? `${model.id} is unavailable`,
            model.id,
            describedModelIds(engine),
        );
    }

    const options = input.options ?? {};
    for (const [name, value] of Object.entries(options)) {
        const spec = model.options[name];
        if (!spec) {
            const known = Object.keys(model.options);
            return issue(
                `options.${name}`,
                `${engine.label} model ${model.id} does not support option '${name}'${
                    known.length
                        ? `; supported options: ${known.join(", ")}`
                        : ""
                }`,
                name,
            );
        }
        const chosen = spec.find((v) => v.value === String(value));
        if (!chosen) {
            return issue(
                `options.${name}`,
                `'${String(value)}' is not a valid value for ${name} on ${model.id}; available values: ${spec
                    .filter((v) => v.available)
                    .map((v) => v.value)
                    .join(", ")}`,
                String(value),
                spec.filter((v) => v.available).map((v) => v.value),
            );
        }
        if (!chosen.available) {
            return issue(
                `options.${name}`,
                chosen.reason ?? `${name}='${chosen.value}' is unavailable`,
                chosen.value,
            );
        }
    }

    return { ok: true, engine, model };
};
