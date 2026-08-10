import type {
  Board,
  BoardDetail,
  Comment,
  Invitation,
  Issue,
  Member,
  Organization,
  Role,
  Section,
  User,
} from "./plana-types";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type ApiResponse<T> = { message: string } & T;

const BASE_URL = "/api/v1";

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/** Register a callback fired on any 401 from an authenticated API call. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler) {
  unauthorizedHandler = handler;
}

export async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; unauthorizedRedirect?: boolean } = {},
): Promise<ApiResponse<T>> {
  const { method = "GET", body, unauthorizedRedirect = true } = options;

  const init: RequestInit = {
    method,
    credentials: "include",
  };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }

  const response = await fetch(`${BASE_URL}${path}`, init);

  const data = (await response.json().catch(() => ({}))) as ApiResponse<T>;

  if (!response.ok) {
    if (response.status === 401 && unauthorizedRedirect) {
      unauthorizedHandler?.();
    }
    throw new ApiError(response.status, data.message ?? "Something went wrong");
  }

  return data;
}

/* ---------- Auth ---------- */

export const signup = (email: string, password: string) =>
  request<{ user: User }>("/auth/signup", { method: "POST", body: { email, password } });

export const signin = (email: string, password: string) =>
  request<{ user: User }>("/auth/signin", { method: "POST", body: { email, password } });

export const logout = () => request<Record<string, never>>("/auth/logout", { method: "POST" });

export const me = () => request<{ user: User }>("/auth/me", { unauthorizedRedirect: false });

/* ---------- Onboarding & profile ---------- */

export const completeOnboarding = (name: string, avatarUrl?: string) =>
  request<{ user: Pick<User, "id" | "email" | "name" | "avatarUrl"> }>("/onboarding", {
    method: "POST",
    body: { name, avatarUrl },
  });

export const updateProfile = (patch: { name?: string; avatarUrl?: string }) =>
  request<{ user: Pick<User, "id" | "email" | "name" | "avatarUrl"> }>("/profile", {
    method: "PUT",
    body: patch,
  });

export const getProfile = () =>
  request<{ user: Pick<User, "email" | "name" | "avatarUrl" | "onboardingCompleted"> }>("/profile");

/* ---------- Organizations ---------- */

export const listOrganizations = () => request<{ organizations: Organization[] }>("/organizations");

export const getOrganization = (id: string) =>
  request<{ organization: Organization }>(`/organizations/${id}`);

export const getOrganizationBySlug = (slug: string) =>
  request<{ organization: Organization }>(`/organizations/by-slug/${slug}`);

export const createOrganization = (data: {
  name: string;
  description?: string;
  orgImage?: string;
}) => request<{ organization: Organization }>("/organizations", { method: "POST", body: data });

export const updateOrganization = (
  id: string,
  data: { name?: string; description?: string; orgImage?: string },
) =>
  request<{ organization: Omit<Organization, "role"> }>(`/organizations/${id}`, {
    method: "PUT",
    body: data,
  });

export const deleteOrganization = (id: string) =>
  request<Record<string, never>>(`/organizations/${id}`, { method: "DELETE" });

/* ---------- Members ---------- */

export const listMembers = (organizationId: string) =>
  request<{ members: Member[] }>(`/organizations/${organizationId}/members`);

export const inviteMember = (organizationId: string, email: string) =>
  request<{ invitation: { id: string; organizationId: string; email: string; role: Role } }>(
    `/organizations/${organizationId}/members`,
    { method: "POST", body: { email } },
  );

export const changeMemberRole = (organizationId: string, userId: string, role: Role) =>
  request<{ membership: Omit<Member, "user"> }>(
    `/organizations/${organizationId}/members/${userId}`,
    {
      method: "PATCH",
      body: { role },
    },
  );

export const removeMember = (organizationId: string, userId: string) =>
  request<Record<string, never>>(`/organizations/${organizationId}/members/${userId}`, {
    method: "DELETE",
  });

export const leaveOrganization = (organizationId: string) =>
  request<Record<string, never>>(`/organizations/${organizationId}/leave`, { method: "POST" });

/* ---------- Invitations ---------- */

export const listInvitations = () => request<{ invitations: Invitation[] }>("/invitations");

export const acceptInvitation = (id: string) =>
  request<{ organization: Organization }>(`/invitations/${id}/accept`, { method: "POST" });

export const declineInvitation = (id: string) =>
  request<Record<string, never>>(`/invitations/${id}/decline`, { method: "POST" });

/* ---------- Boards ---------- */

export const createBoard = (
  organizationId: string,
  data: { title: string; description?: string },
) =>
  request<{ board: Board }>(`/organizations/${organizationId}/boards`, {
    method: "POST",
    body: data,
  });

export const listBoards = (organizationId: string) =>
  request<{ boards: Board[] }>(`/organizations/${organizationId}/boards`);

export const getBoard = (id: string) => request<{ board: BoardDetail }>(`/boards/${id}`);

export const updateBoard = (id: string, data: { title?: string; description?: string }) =>
  request<{ board: Board }>(`/boards/${id}`, { method: "PUT", body: data });

export const deleteBoard = (id: string) =>
  request<Record<string, never>>(`/boards/${id}`, { method: "DELETE" });

/* ---------- Sections ---------- */

export const createSection = (boardId: string, title: string) =>
  request<{ section: Section }>(`/boards/${boardId}/sections`, {
    method: "POST",
    body: { title },
  });

export const updateSection = (id: string, patch: { title?: string; order?: number }) =>
  request<{ section: Section }>(`/sections/${id}`, { method: "PATCH", body: patch });

export const deleteSection = (id: string) =>
  request<Record<string, never>>(`/sections/${id}`, { method: "DELETE" });

/* ---------- Issues ---------- */

export const createIssue = (
  sectionId: string,
  data: { title: string; description?: string; priority?: string; dueDate?: string | null },
) =>
  request<{ issue: Issue }>(`/sections/${sectionId}/issues`, {
    method: "POST",
    body: data,
  });

export const updateIssue = (
  id: string,
  patch: {
    title?: string;
    description?: string | null;
    priority?: string;
    dueDate?: string | null;
  },
) => request<{ issue: Issue }>(`/issues/${id}`, { method: "PATCH", body: patch });

export const deleteIssue = (id: string) =>
  request<Record<string, never>>(`/issues/${id}`, { method: "DELETE" });

export const moveIssue = (id: string, data: { sectionId: string; order?: number }) =>
  request<{ issue: Issue }>(`/issues/${id}/move`, { method: "POST", body: data });

export const setAssignees = (id: string, assigneeIds: string[]) =>
  request<{ issue: Issue }>(`/issues/${id}/assignees`, {
    method: "PUT",
    body: { assigneeIds },
  });

/* ---------- Comments ---------- */

export const listComments = (issueId: string) =>
  request<{ comments: Comment[] }>(`/issues/${issueId}/comments`);

export const createComment = (issueId: string, content: string) =>
  request<{ comment: Comment }>(`/issues/${issueId}/comments`, {
    method: "POST",
    body: { content },
  });

export const updateComment = (id: string, content: string) =>
  request<{ comment: Comment }>(`/comments/${id}`, { method: "PATCH", body: { content } });

export const deleteComment = (id: string) =>
  request<Record<string, never>>(`/comments/${id}`, { method: "DELETE" });

/* ---------- Realtime ---------- */

export const getWsToken = () => request<{ token: string }>("/ws-token");
