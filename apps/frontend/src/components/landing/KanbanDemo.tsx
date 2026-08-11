import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { TaskCard, DemoAvatar } from "./TaskCard";

type Card = {
  id: string;
  title: string;
  tone: "high" | "medium" | "low";
  label: string;
  people: string[];
};

type Column = { id: string; title: string; cards: Card[] };

const initialColumns: Column[] = [
  {
    id: "todo",
    title: "To do",
    cards: [
      { id: "c1", title: "Design new homepage", tone: "medium", label: "Medium", people: ["AR"] },
      { id: "c2", title: "Write launch copy", tone: "low", label: "Low", people: ["SL", "MK"] },
      { id: "c3", title: "Plan the team offsite", tone: "low", label: "Low", people: ["JT"] },
    ],
  },
  {
    id: "doing",
    title: "In progress",
    cards: [
      { id: "c4", title: "Fix login bug", tone: "high", label: "High", people: ["MK", "JT"] },
      {
        id: "c5",
        title: "Review onboarding flow",
        tone: "medium",
        label: "Medium",
        people: ["AR"],
      },
    ],
  },
  {
    id: "done",
    title: "Done",
    cards: [
      { id: "c6", title: "Send weekly update", tone: "low", label: "Low", people: ["SL"] },
      {
        id: "c7",
        title: "Pick a launch date",
        tone: "medium",
        label: "Medium",
        people: ["JT", "AR"],
      },
    ],
  },
];

function CardBody({ card, dragging }: { card: Card; dragging?: boolean }) {
  return (
    <TaskCard
      title={card.title}
      tag={{ label: card.label, tone: card.tone }}
      people={card.people}
      dragging={dragging ?? false}
    />
  );
}

type DragState = {
  card: Card;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  x: number;
  y: number;
  targetCol: string;
  targetIndex: number;
};

export function KanbanDemo() {
  const [columns, setColumns] = useState<Column[]>(initialColumns);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [touched, setTouched] = useState(false);
  const [mounted, setMounted] = useState(false);

  const cardEls = useRef(new Map<string, HTMLElement>());
  const colEls = useRef(new Map<string, HTMLElement>());
  const prevRects = useRef(new Map<string, DOMRect>());
  const dragRef = useRef<DragState | null>(null);
  const flipReady = useRef(false);

  useEffect(() => {
    setMounted(true);
    const t = window.setTimeout(() => {
      flipReady.current = true;
    }, 900);
    return () => window.clearTimeout(t);
  }, []);

  // FLIP: animate every card from its previous box to its new one.
  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>();
    cardEls.current.forEach((el, id) => {
      const rect = new DOMRect(el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight);
      next.set(id, rect);
      const prev = prevRects.current.get(id);
      if (!prev || !flipReady.current) return;
      const dx = prev.left - rect.left;
      const dy = prev.top - rect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = "transform 320ms cubic-bezier(0.22, 1.2, 0.36, 1)";
        el.style.transform = "";
      });
    });
    prevRects.current = next;
  });

  const resolveTarget = useCallback((clientX: number, clientY: number, current: DragState) => {
    let targetCol = current.targetCol;
    let targetIndex = current.targetIndex;
    let found = false;

    colEls.current.forEach((el, colId) => {
      const rect = el.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right) {
        found = true;
        targetCol = colId;
      }
    });
    if (!found) return { targetCol, targetIndex };

    const col = colEls.current.get(targetCol);
    if (!col) return { targetCol, targetIndex };
    const items = Array.from(col.querySelectorAll<HTMLElement>("[data-card-slot]"));
    let idx = items.length;
    for (let i = 0; i < items.length; i += 1) {
      const r = items[i]!.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        idx = i;
        break;
      }
    }
    targetIndex = idx;
    return { targetCol, targetIndex };
  }, []);

  const startDrag = (e: React.PointerEvent, card: Card, colId: string, index: number) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const el = cardEls.current.get(card.id);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setTouched(true);

    const state: DragState = {
      card,
      width: rect.width,
      height: rect.height,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      x: rect.left,
      y: rect.top,
      targetCol: colId,
      targetIndex: index,
    };
    dragRef.current = state;
    setDrag(state);
    setColumns((cols) =>
      cols.map((c) =>
        c.id === colId ? { ...c, cards: c.cards.filter((x) => x.id !== card.id) } : c,
      ),
    );
    cardEls.current.delete(card.id);
    prevRects.current.delete(card.id);
    e.preventDefault();
  };

  useEffect(() => {
    if (!drag) return;

    const onMove = (e: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      const t = resolveTarget(e.clientX, e.clientY, cur);
      const next: DragState = {
        ...cur,
        x: e.clientX - cur.offsetX,
        y: e.clientY - cur.offsetY,
        ...t,
      };
      dragRef.current = next;
      setDrag(next);
      e.preventDefault();
    };

    const onUp = () => {
      const cur = dragRef.current;
      dragRef.current = null;
      if (!cur) return setDrag(null);
      setColumns((cols) =>
        cols.map((c) => {
          if (c.id !== cur.targetCol) return c;
          const cards = [...c.cards];
          cards.splice(Math.min(cur.targetIndex, cards.length), 0, cur.card);
          return { ...c, cards };
        }),
      );
      setDrag(null);
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag, resolveTarget]);

  // Ambient hint: move one card by itself once, if nobody has touched it.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (dragRef.current) return;
      setTouched((wasTouched) => {
        if (!wasTouched) {
          setColumns((cols) => {
            const from = cols.find((c) => c.id === "todo");
            const moving = from?.cards[0];
            if (!moving) return cols;
            return cols.map((c) => {
              if (c.id === "todo")
                return { ...c, cards: c.cards.filter((x) => x.id !== moving.id) };
              if (c.id === "doing") return { ...c, cards: [moving, ...c.cards] };
              return c;
            });
          });
        }
        return wasTouched;
      });
    }, 4200);
    return () => window.clearTimeout(t);
  }, []);

  let order = 0;

  return (
    <div className="relative overflow-x-auto bg-white p-4 sm:p-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight">Product</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">7 cards · 4 people</p>
        </div>
        <div className="flex -space-x-2">
          {["JT", "AR", "MK", "SL"].map((p, i) => (
            <DemoAvatar key={p} initials={p} index={i} />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-[repeat(3,minmax(200px,1fr))] gap-3 sm:gap-5">
        {columns.map((col) => (
          <div
            key={col.id}
            ref={(el) => {
              if (el) colEls.current.set(col.id, el);
              else colEls.current.delete(col.id);
            }}
            className="rounded-xl bg-background/80 p-2.5 sm:p-3"
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className={cn(
                    "h-3 w-[3px] shrink-0 rounded-full",
                    col.id === "done" ? "bg-accent/70" : "bg-border",
                  )}
                />
                <span className="truncate text-[11px] font-semibold">{col.title}</span>
              </span>
              <span className="text-[11px] text-muted-foreground">{col.cards.length}</span>
            </div>

            <div className="min-h-[180px] space-y-3">
              {col.cards.map((card, i) => {
                const showGap = drag && drag.targetCol === col.id && drag.targetIndex === i;
                const delay = (order += 1) * 60;
                return (
                  <div key={card.id}>
                    {showGap && (
                      <div
                        style={{ height: drag.height }}
                        className="rounded-xl border border-dashed border-accent/30 bg-accent-soft/40"
                      />
                    )}
                    <div
                      data-card-slot
                      ref={(el) => {
                        if (el) cardEls.current.set(card.id, el);
                        else cardEls.current.delete(card.id);
                      }}
                      onPointerDown={(e) => startDrag(e, card, col.id, i)}
                      style={{ transitionDelay: mounted ? "0ms" : `${delay}ms` }}
                      className={cn(
                        "cursor-grab touch-none active:cursor-grabbing",
                        "transition-[opacity,transform] duration-500",
                        mounted ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
                      )}
                    >
                      <CardBody card={card} />
                    </div>
                  </div>
                );
              })}
              {drag && drag.targetCol === col.id && drag.targetIndex >= col.cards.length && (
                <div
                  style={{ height: drag.height }}
                  className="rounded-xl border border-dashed border-accent/30 bg-accent-soft/40"
                />
              )}
            </div>
          </div>
        ))}
      </div>

      {drag &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[60] origin-center"
            style={{
              left: drag.x,
              top: drag.y,
              width: drag.width,
              transform: "scale(1.04) rotate(-1.5deg)",
            }}
          >
            <CardBody card={drag.card} dragging />
          </div>,
          document.body,
        )}

      <div
        className={cn(
          "pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-white px-3 py-1.5 text-[11px] text-muted-foreground shadow-soft transition-all duration-300",
          touched ? "translate-y-1 opacity-0" : "opacity-100 delay-700",
        )}
      >
        Try dragging a card
      </div>
    </div>
  );
}
