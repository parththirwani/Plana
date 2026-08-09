import { create } from "zustand";
import * as api from "./api";
import type { Board, BoardDetail, Comment, Issue, Member, Organization, Role } from "./plana-types";

type IssuePatch = {
  title?: string;
  description?: string | null;
  priority?: string;
  dueDate?: string | null;
};

type PlanaState = {
  orgs: Organization[];
  orgsLoading: boolean;
  boards: Board[];
  boardsLoading: boolean;
  members: Member[];
  membersLoading: boolean;
  board: BoardDetail | null;
  boardLoading: boolean;
  comments: Comment[];
  commentsLoading: boolean;
  commentsIssueId: string | null;
  flash: string[];
  error: string | null;

  loadOrgs: () => Promise<void>;
  createOrg: (data: {
    name: string;
    description?: string;
    orgImage?: string;
  }) => Promise<Organization>;
  updateOrg: (
    id: string,
    patch: { name?: string; description?: string; orgImage?: string },
  ) => Promise<void>;
  deleteOrg: (id: string) => Promise<void>;
  leaveOrg: (id: string) => Promise<void>;

  loadBoards: (orgId: string) => Promise<void>;
  createBoard: (orgId: string, data: { title: string; description?: string }) => Promise<Board>;
  updateBoard: (id: string, patch: { title?: string; description?: string }) => Promise<void>;
  deleteBoard: (id: string) => Promise<void>;

  loadMembers: (orgId: string) => Promise<void>;
  inviteMember: (orgId: string, email: string) => Promise<void>;
  changeMemberRole: (orgId: string, userId: string, role: Role) => Promise<void>;
  removeMember: (orgId: string, userId: string) => Promise<void>;

  loadBoard: (boardId: string) => Promise<void>;
  createSection: (boardId: string, title: string) => Promise<void>;
  renameSection: (sectionId: string, title: string) => Promise<void>;
  deleteSection: (sectionId: string) => Promise<void>;
  moveSection: (sectionId: string, order: number) => Promise<void>;

  createIssue: (sectionId: string, title: string) => Promise<void>;
  updateIssue: (id: string, patch: IssuePatch) => Promise<void>;
  deleteIssue: (id: string) => Promise<void>;
  moveIssue: (id: string, sectionId: string, order?: number) => Promise<void>;
  setAssignees: (id: string, assigneeIds: string[]) => Promise<void>;

  loadComments: (issueId: string) => Promise<void>;
  addComment: (issueId: string, content: string) => Promise<void>;
  updateComment: (id: string, content: string) => Promise<void>;
  deleteComment: (id: string) => Promise<void>;

  flashIssue: (id: string) => void;
};

const errMessage = (e: unknown) =>
  e instanceof api.ApiError ? e.message : "Something went wrong. Please try again.";

export const usePlana = create<PlanaState>()((set, get) => ({
  orgs: [],
  orgsLoading: false,
  boards: [],
  boardsLoading: false,
  members: [],
  membersLoading: false,
  board: null,
  boardLoading: false,
  comments: [],
  commentsLoading: false,
  commentsIssueId: null,
  flash: [],
  error: null,

  loadOrgs: async () => {
    set({ orgsLoading: true, error: null });
    try {
      const { organizations } = await api.listOrganizations();
      set({ orgs: organizations, orgsLoading: false });
    } catch (e) {
      set({ orgsLoading: false, error: errMessage(e) });
    }
  },

  createOrg: async (data) => {
    const { organization } = await api.createOrganization(data);
    await get().loadOrgs();
    return organization;
  },

  updateOrg: async (id, patch) => {
    await api.updateOrganization(id, patch);
    await get().loadOrgs();
  },

  deleteOrg: async (id) => {
    await api.deleteOrganization(id);
    await get().loadOrgs();
    if (get().board?.organizationId === id) set({ board: null });
  },

  leaveOrg: async (id) => {
    await api.leaveOrganization(id);
    await get().loadOrgs();
    if (get().board?.organizationId === id) set({ board: null });
  },

  loadBoards: async (orgId) => {
    set({ boardsLoading: true, error: null });
    try {
      const { boards } = await api.listBoards(orgId);
      set({ boards, boardsLoading: false });
    } catch (e) {
      set({ boardsLoading: false, error: errMessage(e) });
    }
  },

  createBoard: async (orgId, data) => {
    const { board } = await api.createBoard(orgId, data);
    await get().loadBoards(orgId);
    return board;
  },

  updateBoard: async (id, patch) => {
    await api.updateBoard(id, patch);
    if (get().board?.id === id) await get().loadBoard(id);
  },

  deleteBoard: async (id) => {
    await api.deleteBoard(id);
    if (get().board?.id === id) set({ board: null });
  },

  loadMembers: async (orgId) => {
    set({ membersLoading: true, error: null });
    try {
      const { members } = await api.listMembers(orgId);
      set({ members, membersLoading: false });
    } catch (e) {
      set({ membersLoading: false, error: errMessage(e) });
    }
  },

  inviteMember: async (orgId, email) => {
    await api.inviteMember(orgId, email);
    await get().loadMembers(orgId);
  },

  changeMemberRole: async (orgId, userId, role) => {
    await api.changeMemberRole(orgId, userId, role);
    await get().loadMembers(orgId);
  },

  removeMember: async (orgId, userId) => {
    await api.removeMember(orgId, userId);
    await get().loadMembers(orgId);
  },

  loadBoard: async (boardId) => {
    set({ boardLoading: true, error: null });
    try {
      const { board } = await api.getBoard(boardId);
      set({ board, boardLoading: false });
    } catch (e) {
      set({ boardLoading: false, error: errMessage(e) });
    }
  },

  createSection: async (boardId, title) => {
    await api.createSection(boardId, title);
    await get().loadBoard(boardId);
  },

  renameSection: async (sectionId, title) => {
    await api.updateSection(sectionId, { title });
    const boardId = get().board?.id;
    if (boardId) await get().loadBoard(boardId);
  },

  deleteSection: async (sectionId) => {
    await api.deleteSection(sectionId);
    const boardId = get().board?.id;
    if (boardId) await get().loadBoard(boardId);
  },

  moveSection: async (sectionId, order) => {
    await api.updateSection(sectionId, { order });
    const boardId = get().board?.id;
    if (boardId) await get().loadBoard(boardId);
  },

  createIssue: async (sectionId, title) => {
    await api.createIssue(sectionId, { title });
    const boardId = get().board?.id;
    if (boardId) await get().loadBoard(boardId);
  },

  updateIssue: async (id, patch) => {
    await api.updateIssue(id, patch);
    const boardId = get().board?.id;
    if (boardId) await get().loadBoard(boardId);
  },

  deleteIssue: async (id) => {
    await api.deleteIssue(id);
    const boardId = get().board?.id;
    if (boardId) await get().loadBoard(boardId);
  },

  moveIssue: async (id, sectionId, order) => {
    await api.moveIssue(id, { sectionId, ...(order !== undefined && { order }) });
    const boardId = get().board?.id;
    if (boardId) await get().loadBoard(boardId);
  },

  setAssignees: async (id, assigneeIds) => {
    await api.setAssignees(id, assigneeIds);
    const boardId = get().board?.id;
    if (boardId) await get().loadBoard(boardId);
  },

  loadComments: async (issueId) => {
    set({ commentsLoading: true, error: null, commentsIssueId: issueId });
    try {
      const { comments } = await api.listComments(issueId);
      set({ comments, commentsLoading: false });
    } catch (e) {
      set({ commentsLoading: false, error: errMessage(e) });
    }
  },

  addComment: async (issueId, content) => {
    await api.createComment(issueId, content);
    await get().loadComments(issueId);
  },

  updateComment: async (id, content) => {
    await api.updateComment(id, content);
    const issueId = get().comments.find((c) => c.id === id)?.issueId;
    if (issueId) await get().loadComments(issueId);
  },

  deleteComment: async (id) => {
    await api.deleteComment(id);
    const issueId = get().comments.find((c) => c.id === id)?.issueId;
    if (issueId) await get().loadComments(issueId);
  },

  flashIssue: (id) => {
    if (get().flash.includes(id)) return;
    set({ flash: [...get().flash, id] });
    window.setTimeout(() => {
      set({ flash: get().flash.filter((f) => f !== id) });
    }, 1600);
  },
}));

export function roleFor(orgs: Organization[], orgId: string): Role | null {
  return orgs.find((o) => o.id === orgId)?.role ?? null;
}
