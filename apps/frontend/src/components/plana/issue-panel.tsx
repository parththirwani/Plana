import { MoreHorizontal, Send, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { usePlana } from "@/lib/plana-store";
import { PRIORITIES, atLeast, priorityColor } from "@/lib/plana-types";
import type { Issue, Priority, Role } from "@/lib/plana-types";
import {
  GhostButton,
  Icon,
  PriorityTag,
  PrimaryButton,
  SecondaryButton,
  UserAvatar,
  inputClass,
  timeAgo,
} from "./ui-kit";
import { ApiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";

export function IssuePanel({
  issue,
  role,
  onClose,
}: {
  issue: Issue;
  role: Role | null;
  onClose: () => void;
}) {
  const members = usePlana((s) => s.members);
  const comments = usePlana((s) => s.comments);
  const loadComments = usePlana((s) => s.loadComments);
  const updateIssue = usePlana((s) => s.updateIssue);
  const setAssignees = usePlana((s) => s.setAssignees);
  const deleteIssue = usePlana((s) => s.deleteIssue);
  const addComment = usePlana((s) => s.addComment);
  const updateComment = usePlana((s) => s.updateComment);
  const deleteComment = usePlana((s) => s.deleteComment);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const canEdit = role !== null && atLeast(role, "MODERATOR");
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description ?? "");
  const [draft, setDraft] = useState("");
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTitle(issue.title);
    setDescription(issue.description ?? "");
  }, [issue.id, issue.title, issue.description]);

  useEffect(() => {
    void loadComments(issue.id);
  }, [issue.id, loadComments]);

  const tryAction = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong.");
    }
  };

  const commitTitle = () => {
    const next = title.trim();
    if (next && next !== issue.title) void tryAction(() => updateIssue(issue.id, { title: next }));
  };

  const commitDescription = () => {
    const next = description.trim();
    if (next !== (issue.description ?? ""))
      void tryAction(() => updateIssue(issue.id, { description: next }));
  };

  const toggleAssignee = async (userId: string) => {
    const on = issue.assignees.some((a) => a.id === userId);
    const next = on
      ? issue.assignees.filter((a) => a.id !== userId).map((a) => a.id)
      : [...issue.assignees.map((a) => a.id), userId];
    await tryAction(() => setAssignees(issue.id, next));
  };

  const sendComment = () => {
    if (!draft.trim()) return;
    const content = draft.trim();
    setDraft("");
    void tryAction(() => addComment(issue.id, content));
  };

  const removeIssue = async () => {
    if (!window.confirm("Delete this card?")) return;
    setError(null);
    try {
      await deleteIssue(issue.id);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong.");
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        className="absolute inset-0 bg-foreground/10 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden
      />
      <aside className="slide-over-in relative flex h-full w-full max-w-lg flex-col border-l border-border bg-surface shadow-panel">
        <header className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            {canEdit ? (
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                className="w-full rounded-md bg-transparent text-lg font-semibold tracking-tight outline-none focus:bg-muted focus:px-2"
              />
            ) : (
              <h2 className="text-lg font-semibold tracking-tight">{issue.title}</h2>
            )}
          </div>
          {canEdit && (
            <div className="relative">
              <GhostButton
                onClick={() => setMenuFor(menuFor === "issue" ? null : "issue")}
                aria-label="Card actions"
              >
                <Icon icon={MoreHorizontal} />
              </GhostButton>
              {menuFor === "issue" && (
                <div className="fade-up absolute right-0 z-10 mt-1 w-36 rounded-lg border border-border bg-popover p-1 shadow-panel">
                  <button
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-destructive hover:bg-destructive-soft"
                    onClick={() => void removeIssue()}
                  >
                    <Icon icon={Trash2} /> Delete card
                  </button>
                </div>
              )}
            </div>
          )}
          <GhostButton onClick={onClose} aria-label="Close panel">
            <Icon icon={X} />
          </GhostButton>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          {error && (
            <p
              className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}

          <section>
            <p className="label-eyebrow mb-1.5">Description</p>
            {canEdit ? (
              <textarea
                rows={4}
                value={description}
                placeholder="Add context, links, acceptance criteria…"
                onChange={(e) => setDescription(e.target.value)}
                onBlur={commitDescription}
                className={`${inputClass} h-auto py-2`}
              />
            ) : (
              <p className="text-sm whitespace-pre-wrap text-muted-foreground">
                {issue.description || "No description."}
              </p>
            )}
          </section>

          <section className="grid grid-cols-2 gap-4">
            <div>
              <p className="label-eyebrow mb-1.5">Priority</p>
              {canEdit ? (
                <div className="flex flex-wrap gap-1.5">
                  {PRIORITIES.map((p: Priority) => (
                    <button
                      key={p}
                      onClick={() => void updateIssue(issue.id, { priority: p })}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors duration-200",
                        issue.priority === p
                          ? "border-primary/30 bg-primary-soft text-primary"
                          : "border-border text-muted-foreground hover:bg-muted",
                      )}
                    >
                      <span className={cn("h-2 w-2 rounded-full", priorityColor[p])} />
                      {p}
                    </button>
                  ))}
                </div>
              ) : (
                <PriorityTag priority={issue.priority} />
              )}
            </div>
            <div>
              <p className="label-eyebrow mb-1.5">Due date</p>
              {canEdit ? (
                <input
                  type="date"
                  value={issue.dueDate ?? ""}
                  onChange={(e) =>
                    void updateIssue(issue.id, {
                      dueDate: e.target.value === "" ? null : e.target.value,
                    })
                  }
                  className={inputClass}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {issue.dueDate ? new Date(issue.dueDate).toLocaleDateString() : "No due date"}
                </p>
              )}
            </div>
          </section>

          <section>
            <p className="label-eyebrow mb-1.5">Assignees</p>
            <div className="flex flex-wrap gap-1.5">
              {members.map((m) => {
                const on = issue.assignees.some((a) => a.id === m.user.id);
                if (!canEdit && !on) return null;
                return (
                  <button
                    key={m.userId}
                    disabled={!canEdit}
                    onClick={() => void toggleAssignee(m.userId)}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-xs transition-colors duration-200",
                      on
                        ? "border-primary/30 bg-primary-soft text-primary"
                        : "border-border text-muted-foreground hover:bg-muted",
                    )}
                  >
                    <UserAvatar user={m.user} size={20} />
                    {m.user.name ?? m.user.email}
                  </button>
                );
              })}
              {!canEdit && issue.assignees.length === 0 && (
                <p className="text-sm text-muted-foreground">Nobody assigned</p>
              )}
            </div>
          </section>

          <section>
            <p className="label-eyebrow mb-2">Comments</p>
            <div className="space-y-4">
              {comments.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No comments yet — start the thread below.
                </p>
              )}
              {comments.map((c) => {
                const author = c.author ?? {
                  id: c.authorId,
                  name: null,
                  email: "",
                  avatarUrl: null,
                  onboardingCompleted: true,
                };
                const mine = author.id === currentUserId;
                return (
                  <div key={c.id} className="group flex gap-3">
                    <UserAvatar user={author} size={28} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{author.name ?? author.email}</p>
                        <span className="text-xs text-muted-foreground">
                          {timeAgo(c.createdAt)}
                        </span>
                        {(mine || canEdit) && (
                          <div className="relative ml-auto opacity-0 transition-opacity group-hover:opacity-100">
                            <button
                              onClick={() => setMenuFor(menuFor === c.id ? null : c.id)}
                              className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                              aria-label="Comment actions"
                            >
                              <Icon icon={MoreHorizontal} />
                            </button>
                            {menuFor === c.id && (
                              <div className="fade-up absolute right-0 z-10 mt-1 w-32 rounded-lg border border-border bg-popover p-1 shadow-panel">
                                <button
                                  className="block w-full rounded-md px-2 py-1 text-left text-xs hover:bg-muted"
                                  onClick={() => {
                                    setEditingComment(c.id);
                                    setEditValue(c.content);
                                    setMenuFor(null);
                                  }}
                                >
                                  Edit
                                </button>
                                <button
                                  className="block w-full rounded-md px-2 py-1 text-left text-xs text-destructive hover:bg-destructive-soft"
                                  onClick={() => {
                                    setMenuFor(null);
                                    void tryAction(() => deleteComment(c.id));
                                  }}
                                >
                                  Delete
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      {editingComment === c.id ? (
                        <div className="mt-1 space-y-2">
                          <textarea
                            rows={2}
                            className={`${inputClass} h-auto py-2`}
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                          />
                          <div className="flex gap-2">
                            <PrimaryButton
                              className="h-8"
                              onClick={() => {
                                const content = editValue.trim();
                                setEditingComment(null);
                                void tryAction(() => updateComment(c.id, content));
                              }}
                            >
                              Save
                            </PrimaryButton>
                            <SecondaryButton
                              className="h-8"
                              onClick={() => setEditingComment(null)}
                            >
                              Cancel
                            </SecondaryButton>
                          </div>
                        </div>
                      ) : (
                        <p className="mt-0.5 text-sm whitespace-pre-wrap">{c.content}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <footer className="flex items-end gap-2 border-t border-border px-5 py-3">
          <textarea
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Write a comment…"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendComment();
              }
            }}
            className={`${inputClass} h-auto max-h-32 min-h-9 resize-none py-2`}
          />
          <PrimaryButton aria-label="Send comment" className="w-9 px-0" onClick={sendComment}>
            <Icon icon={Send} />
          </PrimaryButton>
        </footer>
      </aside>
    </div>
  );
}
