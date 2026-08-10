import { getWsToken } from "./api";
import { useAuthStore } from "./auth-store";
import { usePlana, type RealtimeStatus } from "./plana-store";
import type { BoardSection, Comment, Issue, Section } from "./plana-types";

// Derive the WS origin from the page itself so realtime works from any
// hostname/protocol the app is served on (LAN IP, https, etc.). Hard-coding
// ws://localhost silently breaks every other browser. VITE_WS_URL still wins.
// The fallback is computed in connect() (client-only) so this module is safe
// to import during SSR, where `window` does not exist.
const WS_URL = import.meta.env["VITE_WS_URL"] ?? "";

type WsActor = { id: string; name: string | null; avatarUrl: string | null };

type WsMessage = {
  boardId: string;
  event: string;
  actor: WsActor;
  data: {
    board?: Partial<BoardSection>;
    section?: Section;
    issue?: Issue;
    comment?: Comment;
    id?: string;
    needsRefetch?: boolean;
    sectionTitle?: string;
    fromSectionTitle?: string;
    toSectionTitle?: string;
  };
};

const sortByOrder = (a: { order: number }, b: { order: number }) => a.order - b.order;

const withSortedSections = (board: NonNullable<ReturnType<typeof usePlana.getState>["board"]>) => ({
  ...board,
  sections: board.sections
    .map((s) => ({ ...s, issues: [...s.issues].sort(sortByOrder) }))
    .sort(sortByOrder),
});

const upsertIssue = (sections: BoardSection[], issue: Issue): BoardSection[] =>
  sections
    .map((s) => ({ ...s, issues: s.issues.filter((i) => i.id !== issue.id) }))
    .map((s) =>
      s.id === issue.sectionId ? { ...s, issues: [...s.issues, issue].sort(sortByOrder) } : s,
    );

const actorName = (actor: WsActor | undefined) => actor?.name ?? actor?.id ?? "Someone";

const describeEvent = (msg: WsMessage): string | null => {
  const { event, actor, data } = msg;
  const who = actorName(actor);
  const issue = data.issue?.title;
  const section = data.section?.title;
  const board = data.board?.title;

  switch (event) {
    case "board.created":
      return board ? `${who} created board "${board}"` : null;
    case "board.updated":
      return board ? `${who} updated board "${board}"` : null;
    case "board.deleted":
      return `${who} deleted a board`;
    case "section.created":
      return section ? `${who} created section "${section}"` : null;
    case "section.updated":
      return section ? `${who} renamed section "${section}"` : null;
    case "section.deleted":
      return `${who} deleted a section`;
    case "issue.created":
      return issue
        ? `${who} created issue "${issue}" in "${data.sectionTitle ?? "a section"}"`
        : null;
    case "issue.updated":
      return issue ? `${who} updated issue "${issue}"` : null;
    case "issue.moved":
      return issue
        ? `${who} moved issue "${issue}" from "${data.fromSectionTitle ?? "?"}" to "${data.toSectionTitle ?? "?"}"`
        : null;
    case "issue.deleted":
      return `${who} deleted an issue`;
    case "issue.assignees":
      return issue ? `${who} changed assignees on "${issue}"` : null;
    case "comment.created":
      return issue ? `${who} commented on "${issue}"` : null;
    case "comment.updated":
      return issue ? `${who} edited a comment on "${issue}"` : null;
    case "comment.deleted":
      return `${who} deleted a comment`;
    default:
      return null;
  }
};

const notify = (msg: WsMessage) => {
  // skip your own actions: applyEvent still syncs the board so other tabs of
  // the same account stay in sync, only the bell is suppressed.
  if (msg.actor.id === useAuthStore.getState().user?.id) return;
  const text = describeEvent(msg);
  if (!text) return;
  if (usePlana.getState().notifications[0]?.text === text) return;
  usePlana.getState().pushNotification({ text });
};

const applyEvent = (msg: WsMessage) => {
  const store = usePlana.getState();
  const board = store.board;
  if (!board || board.id !== msg.boardId) return;

  const { event, data } = msg;

  if (data.needsRefetch) {
    if (data.comment?.issueId) void store.loadComments(data.comment.issueId);
    else void store.loadBoard(msg.boardId);
    return;
  }

  switch (event) {
    case "board.updated":
      if (data.board) usePlana.setState({ board: { ...board, ...data.board } });
      break;

    case "board.deleted":
      usePlana.setState({ board: null });
      break;

    case "section.created":
      if (data.section) {
        usePlana.setState({
          board: withSortedSections({
            ...board,
            sections: [...board.sections, { ...data.section, issues: [] }],
          }),
        });
      }
      break;

    case "section.updated": {
      if (!data.section) break;
      const next = board.sections.map((s) =>
        s.id === data.section!.id ? { ...s, ...data.section! } : s,
      );
      usePlana.setState({ board: withSortedSections({ ...board, sections: next }) });
      break;
    }

    case "section.deleted":
      if (data.id) {
        usePlana.setState({
          board: { ...board, sections: board.sections.filter((s) => s.id !== data.id) },
        });
      }
      break;

    case "issue.created":
    case "issue.updated":
    case "issue.assignees":
    case "issue.moved": {
      if (!data.issue) break;
      const issue = data.issue;
      usePlana.setState({
        board: withSortedSections({
          ...board,
          sections: upsertIssue(board.sections, issue),
        }),
      });
      store.flashIssue(issue.id);
      break;
    }

    case "issue.deleted":
      if (data.id) {
        usePlana.setState({
          board: {
            ...board,
            sections: board.sections.map((s) => ({
              ...s,
              issues: s.issues.filter((i) => i.id !== data.id),
            })),
          },
        });
      }
      break;

    case "comment.created":
    case "comment.updated":
      if (data.comment && store.commentsIssueId === data.comment.issueId) {
        usePlana.setState({
          comments: [...store.comments.filter((c) => c.id !== data.comment!.id), data.comment],
        });
      }
      break;

    case "comment.deleted":
      if (data.id) {
        usePlana.setState({ comments: store.comments.filter((c) => c.id !== data.id) });
      }
      break;
  }
};

const setStatus = (status: RealtimeStatus) => usePlana.getState().setRealtimeStatus(status);

/** Open a realtime socket for one board. Returns a function that closes it. */
export function connectBoardSocket(boardId: string): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retries = 0;
  let timer: number | null = null;

  const scheduleReconnect = () => {
    const delay = Math.min(1000 * 2 ** retries, 15000);
    retries += 1;
    setStatus("disconnected");
    timer = window.setTimeout(connect, delay);
  };

  const connect = () => {
    if (closed) return;
    setStatus("connecting");
    void (async () => {
      let token: string;
      try {
        ({ token } = await getWsToken());
      } catch (error) {
        console.error("Realtime: ws token fetch failed", error);
        if (!closed) scheduleReconnect();
        return;
      }
      if (closed) return;

      const url =
        WS_URL ||
        `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:9000`;
      ws = new WebSocket(`${url}/ws?boardId=${boardId}&token=${token}`);
      ws.onopen = () => {
        retries = 0;
        setStatus("connected");
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as WsMessage;
          if (msg.boardId === boardId) {
            applyEvent(msg);
            notify(msg);
          }
        } catch {
          // ignore malformed payloads
        }
      };
      ws.onclose = () => {
        ws = null;
        if (closed) {
          setStatus("off");
          return;
        }
        scheduleReconnect();
      };
      ws.onerror = () => {
        // onclose fires right after; closing here guarantees the reconnect path
        ws?.close();
      };
    })();
  };

  connect();

  const close = () => {
    closed = true;
    if (timer !== null) window.clearTimeout(timer);
    setStatus("off");
    ws?.close();
  };

  return close;
}
