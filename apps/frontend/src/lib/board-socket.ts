import { getWsToken } from "./api";
import { usePlana } from "./plana-store";
import type { BoardSection, Comment, Issue, Section } from "./plana-types";

const WS_URL = import.meta.env["VITE_WS_URL"] ?? "ws://localhost:9000";

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
    .map((section) => {
      const present = section.issues.some((i) => i.id === issue.id);
      if (!present) return section;
      return {
        ...section,
        issues: section.issues.map((i) => (i.id === issue.id ? issue : i)),
      };
    })
    .map((s) => ({ ...s, issues: [...s.issues].sort(sortByOrder) }));

const applyEvent = (msg: WsMessage) => {
  const store = usePlana.getState();
  const board = store.board;
  if (!board || board.id !== msg.boardId) return;

  const { event, data } = msg;

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
      const sections = upsertIssue(board.sections, issue);
      usePlana.setState({
        board: withSortedSections({
          ...board,
          sections: sections.map((s) =>
            s.id === issue.sectionId && !s.issues.some((i) => i.id === issue.id)
              ? { ...s, issues: [...s.issues, issue].sort(sortByOrder) }
              : s,
          ),
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

/** Open a realtime socket for one board. Returns a function that closes it. */
export function connectBoardSocket(boardId: string): () => void {
  let ws: WebSocket | null = null;
  let closed = false;

  const close = () => {
    closed = true;
    ws?.close();
  };

  void (async () => {
    if (closed) return;
    try {
      const { token } = await getWsToken();
      if (closed) return;
      ws = new WebSocket(`${WS_URL}/ws?boardId=${boardId}&token=${token}`);
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as WsMessage;
          if (msg.boardId === boardId) applyEvent(msg);
        } catch {
          // ignore malformed payloads
        }
      };
      ws.onclose = () => {
        if (!closed) ws = null;
      };
    } catch {
      // token fetch failed — realtime simply won't connect
    }
  })();

  return close;
}
