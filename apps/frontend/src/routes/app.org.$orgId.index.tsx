import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LayoutGrid, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/plana/app-shell";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DashedTile,
  EmptyState,
  Field,
  GhostButton,
  Icon,
  PrimaryButton,
  SecondaryButton,
  Surface,
  inputClass,
  timeAgo,
} from "@/components/plana/ui-kit";
import { roleFor, usePlana } from "@/lib/plana-store";
import { atLeast } from "@/lib/plana-types";
import { Authed } from "@/lib/auth-guard";

export const Route = createFileRoute("/app/org/$orgId/")({
  head: () => ({
    meta: [
      { title: "Plana" },
      { name: "description", content: "All boards in this Plana organization." },
      { property: "og:title", content: "Boards · Plana" },
      { property: "og:description", content: "All boards in this Plana organization." },
    ],
  }),
  component: () => (
    <Authed>
      <BoardsList />
    </Authed>
  ),
});

function BoardsList() {
  const { orgId } = Route.useParams();
  const orgs = usePlana((s) => s.orgs);
  const boards = usePlana((s) => s.boards);
  const boardsLoading = usePlana((s) => s.boardsLoading);
  const error = usePlana((s) => s.error);
  const loadBoards = usePlana((s) => s.loadBoards);
  const createBoard = usePlana((s) => s.createBoard);
  const deleteBoard = usePlana((s) => s.deleteBoard);
  const navigate = useNavigate();
  const org = orgs.find((o) => o.id === orgId);
  const role = roleFor(orgs, orgId);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"recent" | "alpha">("recent");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    description?: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  useEffect(() => {
    void loadBoards(orgId);
  }, [orgId, loadBoards]);

  const list = useMemo(() => {
    const filtered = boards
      .filter((b) => b.title.toLowerCase().includes(query.toLowerCase()))
      .slice();
    return filtered.sort((a, b) =>
      sort === "alpha"
        ? a.title.localeCompare(b.title)
        : new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }, [boards, query, sort]);

  if (!org || !role) {
    return (
      <AppShell title="Organization">
        <EmptyState
          icon={LayoutGrid}
          title="This workspace isn't available"
          body="It may have been deleted, or you no longer have access to it."
        />
      </AppShell>
    );
  }

  const canCreate = atLeast(role, "MODERATOR");

  const create = async () => {
    if (!title.trim()) return;
    setCreateError(null);
    try {
      const board = await createBoard(orgId, { title: title.trim(), description: desc.trim() });
      setTitle("");
      setDesc("");
      setCreating(false);
      navigate({ to: "/app/board/$boardId", params: { boardId: board.id } });
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Something went wrong.");
    }
  };

  const remove = async (boardId: string) => {
    try {
      await deleteBoard(boardId);
      await loadBoards(orgId);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Something went wrong.");
    }
  };

  return (
    <AppShell
      orgId={orgId}
      title="Boards"
      breadcrumb={[org.name, "Boards"]}
      action={
        canCreate ? (
          <PrimaryButton onClick={() => setCreating(true)}>
            <Icon icon={Plus} /> New board
          </PrimaryButton>
        ) : null
      }
    >
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Icon
            icon={Search}
            className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-muted-foreground"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search boards"
            className={`${inputClass} w-64 pl-9`}
          />
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-0.5">
          {(["recent", "alpha"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSort(s)}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors duration-200 ${
                sort === s ? "bg-primary-soft text-primary" : "text-muted-foreground"
              }`}
            >
              {s === "recent" ? "Recently updated" : "A–Z"}
            </button>
          ))}
        </div>
      </div>

      {creating && (
        <Surface className="fade-up mb-5 max-w-lg p-4">
          <div className="space-y-3">
            <Field label="Board title">
              <input
                autoFocus
                className={inputClass}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Q4 Planning"
              />
            </Field>
            <Field label="Description">
              <input
                className={inputClass}
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="What this board is for"
              />
            </Field>
          </div>
          {createError && (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {createError}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <PrimaryButton onClick={create}>Create board</PrimaryButton>
            <SecondaryButton onClick={() => setCreating(false)}>Cancel</SecondaryButton>
          </div>
        </Surface>
      )}

      {error && !creating && <p className="mb-4 text-sm text-destructive">{error}</p>}

      {boardsLoading && list.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
      ) : list.length === 0 && !canCreate ? (
        <EmptyState
          icon={LayoutGrid}
          title="No boards here yet"
          body="When a moderator creates a board in this workspace, it'll show up here."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((board) => (
            <Surface
              key={board.id}
              hover
              onClick={() => navigate({ to: "/app/board/$boardId", params: { boardId: board.id } })}
              className="flex min-h-[8.5rem] flex-col p-5"
            >
              <div className="flex items-start gap-2">
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{board.title}</h2>
                {canCreate && (
                  <GhostButton
                    className="h-6 w-6 p-0"
                    aria-label={`Delete ${board.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirm({
                        title: "Delete this board?",
                        description: "This cannot be undone.",
                        onConfirm: () => remove(board.id),
                      });
                    }}
                  >
                    <Icon icon={Trash2} />
                  </GhostButton>
                )}
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                {board.description || "No description yet."}
              </p>
              <div className="mt-auto flex items-center pt-5">
                <span className="ml-auto text-xs text-muted-foreground">
                  {timeAgo(board.updatedAt)}
                </span>
              </div>
            </Surface>
          ))}
          {canCreate && (
            <DashedTile icon={Plus} label="New board" onClick={() => setCreating(true)} />
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirm?.title ?? ""}
        description={confirm?.description}
        onConfirm={() => {
          confirm?.onConfirm();
        }}
      />
    </AppShell>
  );
}
