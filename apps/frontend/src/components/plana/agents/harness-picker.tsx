import { useId } from "react";
import { Check, LockKeyhole } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EngineId, EngineSpec } from "@/lib/agent-types";

const brands: Record<EngineId, { name: string; asset: string; subtitle: string; color: string }> = {
  CODEX: { name: "Codex", asset: "codex", subtitle: "OpenAI", color: "bg-emerald-50" },
  CLAUDE_CODE: {
    name: "Claude Code",
    asset: "claude",
    subtitle: "Anthropic",
    color: "bg-orange-50",
  },
  OPENCODE: { name: "OpenCode", asset: "opencode", subtitle: "Open source", color: "bg-zinc-100" },
  PI: { name: "Pi", asset: "pi", subtitle: "Coding agent", color: "bg-sky-50" },
};

export function HarnessLogo({ engine, className }: { engine: EngineId; className?: string }) {
  const brand = brands[engine];
  return (
    <span
      className={cn(
        "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
        brand.color,
        className,
      )}
    >
      <img
        src={`/harnesses/${brand.asset}.svg`}
        alt=""
        className="h-6 w-6"
        width={24}
        height={24}
      />
    </span>
  );
}

export function HarnessPicker({
  engines,
  value,
  onChange,
  disabled = false,
}: {
  engines: EngineSpec[];
  value: EngineId | "";
  onChange: (engine: EngineSpec) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset disabled={disabled}>
      <legend className="mb-3 text-sm font-medium">Coding harness</legend>
      <div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
        {engines.map((engine) => {
          const brand = brands[engine.id];
          return (
            <div key={engine.id}>
              <label
                className={cn(
                  "relative flex min-h-20 cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors focus-within:ring-2 focus-within:ring-ring",
                  value === engine.id
                    ? "border-primary bg-primary-soft"
                    : "border-border bg-surface hover:bg-muted/60",
                  (disabled || !engine.available) && "cursor-not-allowed opacity-60",
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={engine.id}
                  checked={value === engine.id}
                  disabled={!engine.available}
                  aria-describedby={!engine.available ? `${name}-${engine.id}-reason` : undefined}
                  onChange={() => onChange(engine)}
                  className="sr-only"
                />
                <HarnessLogo engine={engine.id} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{brand.name}</span>
                  <span className="text-xs text-muted-foreground">{brand.subtitle}</span>
                </span>
                {value === engine.id ? (
                  <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                ) : !engine.available ? (
                  <LockKeyhole className="h-3.5 w-3.5" aria-hidden />
                ) : null}
              </label>
              {!engine.available && (
                <p
                  id={`${name}-${engine.id}-reason`}
                  className="mt-1.5 px-1 text-xs text-muted-foreground"
                >
                  {engine.reason ?? "Unavailable"}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
