import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { GripVertical, LayoutGrid, MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/plana/app-shell";
import { IssuePanel } from "@/components/plana/issue-panel";
import {
  AvatarStack,
  DueDate,
  EmptyState,
  GhostButton,
  Icon,
  PrimaryButton,
  PriorityTag,
  SecondaryButton,
  Surface,
  inputClass,
} from "@/components/plana/ui-kit";
import { usePlana } from "@/lib/plana-store";
import { roleFor } from "@/lib/plana-store";
import { atLeast } from "@/lib/plana-types";
import { Authed } from "@/lib/auth-guard";
import { ApiError } from "@/lib/api";
import { connectBoardSocket } from "@/lib/board-socket";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/board/$boardId")({
  head: () => ({
    meta: [
      { title: "Board — Plana" },
      {
        name: "description",
        content:
          "A calm kanban board: drag cards between sections, your team sees changes as they happen.",
      },
      { property: "og:title", content: "Board — Plana" },
      {
        property: "og:description",
        content: "Drag cards between sections. Your team sees changes as they happen.",
      },
    ],
  }),
  component: () => (
    <Authed>
      <BoardScreen />
    </Authed>
  ),
});

const msg = (e: unknown) =>
  e instanceof ApiError ? e.message : "Something went wrong. Please try again.";

function BoardScreen() {
  const { boardId } = Route.useParams();
  const board = usePlana((s) => s.board);
  const boardLoading = usePlana((s) => s.boardLoading);
  const error = usePlana((s) => s.error);
  const orgs = usePlana((s) => s.orgs);
  const loadBoard = usePlana((s) => s.loadBoard);
  const loadMembers = usePlana((s) => s.loadMembers);
  const flash = usePlana((s) => s.flash);
  const createSection = usePlana((s) => s.createSection);
  const renameSection = usePlana((s) => s.renameSection);
  const deleteSection = usePlana((s) => s.deleteSection);
  const moveSection = usePlana((s) => s.moveSection);
  const createIssue = usePlana((s) => s.createIssue);
  const updateBoard = usePlana((s) => s.updateBoard);
  const deleteBoard = usePlana((s) => s.deleteBoard);
  const moveIssue = usePlana((s) => s.moveIssue);
  const navigate = useNavigate();

  const org = orgs.find((o) => o.id === board?.organizationId);
  const role = board ? roleFor(orgs, board.organizationId) : null;
  const canEdit = role !== null && atLeast(role, "MODERATOR");

  const [dragCard, setDragCard] = useState<string | null>(null);
  const [dragSection, setDragSection] = useState<string | null>(null);
  const [overSection, setOverSection] = useState<string | null>(null);
  const [openIssue, setOpenIssue] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [addingSection, setAddingSection] = useState(false);
  const [sectionTitle, setSectionTitle] = useState("");
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    void loadBoard(boardId);
  }, [boardId, loadBoard]);

  useEffect(() => {
    const closeSocket = connectBoardSocket(boardId);
    return closeSocket;
  }, [boardId]);

  const orgId = board?.organizationId;
  useEffect(() => {
    if (orgId) void loadMembers(orgId);
  }, [orgId, loadMembers]);

  useEffect(() => {
    if (editing && board) {
      setEditTitle(board.title);
      setEditDesc(board.description ?? "");
    }
  }, [editing, board]);

  const sections = board?.sections ?? [];
  const issue = sections.flatMap((s) => s.issues).find((i) => i.id === openIssue) ?? null;

  const sectionIndex = (sectionId: string) => sections.findIndex((s) => s.id === sectionId);

  const dropCard = async (sectionId: string, beforeIndex: number | undefined) => {
    if (!canEdit || !dragCard) {
      setDragCard(null);
      setOverSection(null);
      return;
    }
    try {
      await moveIssue(dragCard, sectionId, beforeIndex);
    } catch (e) {
      setActionError(msg(e));
    }
    setDragCard(null);
    setOverSection(null);
  };

  const dropSection = async (sectionId: string) => {
    if (!canEdit || !dragSection || dragSection === sectionId) {
      setDragSection(null);
      setOverSection(null);
      return;
    }
    try {
      await moveSection(dragSection, sectionIndex(sectionId));
    } catch (e) {
      setActionError(msg(e));
    }
    setDragSection(null);
    setOverSection(null);
  };

  if (!boardLoading && !board) {
    return (
      <AppShell title="Board">
        <EmptyState
          icon={LayoutGrid}
          title="This board isn't available"
          body={
            error ?? "It may have been deleted, or you no longer have access to this workspace."
          }
          action={
            <PrimaryButton onClick={() => navigate({ to: "/app" })}>
              Go to organizations
            </PrimaryButton>
          }
        />
      </AppShell>
    );
  }

  if (!board) {
    return (
      <AppShell title="Board">
        <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
      </AppShell>
    );
  }

  const addCard = async (sectionId: string) => {
    if (!newTitle.trim()) return;
    try {
      await createIssue(sectionId, newTitle.trim());
      setNewTitle("");
      setAdding(null);
    } catch (e) {
      setActionError(msg(e));
    }
  };

  const handleAddCard = () => {
    const first = sections[0]?.id;
    if (first) {
      setAdding(first);
    } else {
      setAddingSection(true);
    }
  };

  const addSection = async () => {
    if (!sectionTitle.trim()) return;
    try {
      await createSection(board.id, sectionTitle.trim());
      setSectionTitle("");
      setAddingSection(false);
    } catch (e) {
      setActionError(msg(e));
    }
  };

  const saveRename = async (sectionId: string) => {
    if (!renameValue.trim()) {
      setRenaming(null);
      return;
    }
    try {
      await renameSection(sectionId, renameValue.trim());
      setRenaming(null);
    } catch (e) {
      setActionError(msg(e));
    }
  };

  const removeSection = async (sectionId: string) => {
    if (!window.confirm("Delete this section and all its cards?")) return;
    try {
      await deleteSection(sectionId);
    } catch (e) {
      setActionError(msg(e));
    }
  };

  const removeBoard = async () => {
    if (!window.confirm("Delete this board permanently?")) return;
    try {
      await deleteBoard(board.id);
      navigate({ to: "/app/org/$orgId", params: { orgId: board.organizationId } });
    } catch (e) {
      setActionError(msg(e));
    }
  };

  const saveBoardDetails = async () => {
    try {
      await updateBoard(board.id, {
        title: editTitle.trim(),
        description: editDesc.trim(),
      });
      setEditing(false);
    } catch (e) {
      setActionError(msg(e));
    }
  };

  return (
    <AppShell
      orgId={board.organizationId}
      title={board.title}
      breadcrumb={[org?.name ?? "Organization", "Boards", board.title]}
      fullHeight
      action={
        <>
          {canEdit && (
            <>
              <PrimaryButton onClick={handleAddCard}>
                <Icon icon={Plus} /> Add card
              </PrimaryButton>
              <div className="relative">
                <GhostButton onClick={() => setMenu((m) => !m)} aria-label="Board actions">
                  <Icon icon={MoreHorizontal} />
                </GhostButton>
                {menu && (
                  <div className="fade-up absolute right-0 z-30 mt-1 w-44 rounded-xl border border-border bg-popover p-1 shadow-panel">
                    <button
                      className="block w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted"
                      onClick={() => {
                        setEditing(true);
                        setMenu(false);
                      }}
                    >
                      Edit board details
                    </button>
                    <button
                      className="block w-full rounded-lg px-2 py-1.5 text-left text-sm text-destructive hover:bg-destructive-soft"
                      onClick={() => {
                        setMenu(false);
                        void removeBoard();
                      }}
                    >
                      Delete board
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      }
    >
      <div className="flex h-[calc(100vh-73px)] flex-col">
        {actionError && (
          <p className="px-6 pt-4 text-sm text-destructive" role="alert">
            {actionError}
          </p>
        )}

        {editing && (
          <Surface className="fade-up m-6 mb-0 max-w-lg space-y-3 p-4">
            <input
              className={inputClass}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="Board title"
            />
            <input
              className={inputClass}
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              placeholder="Board description"
            />
            <div className="flex gap-2">
              <PrimaryButton onClick={() => void saveBoardDetails()}>Done</PrimaryButton>
              <SecondaryButton onClick={() => setEditing(false)}>Cancel</SecondaryButton>
            </div>
          </Surface>
        )}

        <div className="flex flex-1 gap-4 overflow-x-auto px-6 py-6">
          {sections.map((section) => {
            const cards = section.issues;
            return (
              <div
                key={section.id}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverSection(section.id);
                }}
                onDragLeave={() => setOverSection((s) => (s === section.id ? null : s))}
                onDrop={() => {
                  if (dragSection) void dropSection(section.id);
                  else if (dragCard) void dropCard(section.id, undefined);
                }}
                className={cn(
                  "flex w-[19rem] shrink-0 flex-col rounded-2xl border border-border bg-surface/70 transition-colors duration-200",
                  overSection === section.id && "border-primary/40 bg-primary-soft/40",
                )}
              >
                <div className="flex items-center gap-2 px-3 py-3">
                  {canEdit && (
                    <span
                      draggable
                      onDragStart={() => setDragSection(section.id)}
                      onDragEnd={() => setDragSection(null)}
                      className="cursor-grab text-muted-foreground active:cursor-grabbing"
                      aria-label="Reorder section"
                    >
                      <Icon icon={GripVertical} />
                    </span>
                  )}
                  {renaming === section.id ? (
                    <input
                      autoFocus
                      className={`${inputClass} h-7 text-sm`}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => void saveRename(section.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveRename(section.id);
                        if (e.key === "Escape") setRenaming(null);
                      }}
                    />
                  ) : (
                    <h2
                      className="cursor-default text-sm font-semibold"
                      onDoubleClick={() => {
                        if (!canEdit) return;
                        setRenaming(section.id);
                        setRenameValue(section.title);
                      }}
                      title={canEdit ? "Double-click to rename" : undefined}
                    >
                      {section.title}
                    </h2>
                  )}
                  <span className="rounded-full border border-border px-1.5 text-[11px] text-muted-foreground">
                    {cards.length}
                  </span>
                  {canEdit && (
                    <>
                      <button
                        onClick={() => setAdding(section.id)}
                        className="ml-auto rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
                        aria-label={`Add card to ${section.title}`}
                      >
                        <Icon icon={Plus} />
                      </button>
                      <button
                        onClick={() => void removeSection(section.id)}
                        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                        aria-label={`Delete section ${section.title}`}
                      >
                        <Icon icon={MoreHorizontal} />
                      </button>
                    </>
                  )}
                </div>

                <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
                  {adding === section.id && (
                    <div className="fade-up rounded-xl border border-border bg-surface p-2">
                      <input
                        autoFocus
                        className={inputClass}
                        placeholder="Card title"
                        value={newTitle}
                        onChange={(e) => setNewTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void addCard(section.id);
                          if (e.key === "Escape") setAdding(null);
                        }}
                      />
                      <div className="mt-2 flex gap-2">
                        <PrimaryButton className="h-8" onClick={() => void addCard(section.id)}>
                          Add
                        </PrimaryButton>
                        <SecondaryButton className="h-8" onClick={() => setAdding(null)}>
                          Cancel
                        </SecondaryButton>
                      </div>
                    </div>
                  )}

                  {cards.map((card, index) => (
                    <div
                      key={card.id}
                      draggable={canEdit}
                      onDragStart={() => setDragCard(card.id)}
                      onDragEnd={() => setDragCard(null)}
                      onDrop={(e) => {
                        e.stopPropagation();
                        void dropCard(section.id, index);
                      }}
                      onClick={() => setOpenIssue(card.id)}
                      className={cn(
                        "card-hover cursor-pointer rounded-xl border border-border bg-surface p-3 shadow-soft",
                        dragCard === card.id && "opacity-50",
                        flash.includes(card.id) && "live-glow",
                      )}
                    >
                      <p className="text-sm font-medium">{card.title}</p>
                      <div className="mt-2.5 flex items-center gap-3">
                        <PriorityTag priority={card.priority} />
                        {card.dueDate && <DueDate date={card.dueDate} />}
                        <span className="ml-auto">
                          <AvatarStack users={card.assignees} size={22} max={3} />
                        </span>
                      </div>
                    </div>
                  ))}

                  {cards.length === 0 && adding !== section.id && (
                    <div className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                      Nothing in {section.title.toLowerCase()} yet.
                      {canEdit && (
                        <button
                          onClick={() => setAdding(section.id)}
                          className="mt-1 block w-full text-primary"
                        >
                          Add the first card
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {canEdit && (
            <div className="w-[19rem] shrink-0">
              {addingSection ? (
                <Surface className="fade-up p-3">
                  <input
                    autoFocus
                    className={inputClass}
                    placeholder="Section name"
                    value={sectionTitle}
                    onChange={(e) => setSectionTitle(e.target.value)}
                  />
                  <div className="mt-2 flex gap-2">
                    <PrimaryButton className="h-8" onClick={() => void addSection()}>
                      Add section
                    </PrimaryButton>
                    <SecondaryButton className="h-8" onClick={() => setAddingSection(false)}>
                      Cancel
                    </SecondaryButton>
                  </div>
                </Surface>
              ) : (
                <button
                  onClick={() => setAddingSection(true)}
                  className="flex h-full min-h-[7rem] w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border text-sm text-muted-foreground transition-colors duration-200 hover:border-primary/40 hover:bg-primary-soft/40 hover:text-primary"
                >
                  <Icon icon={Plus} />
                  Add section
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {issue && <IssuePanel issue={issue} role={role} onClose={() => setOpenIssue(null)} />}
    </AppShell>
  );
}
