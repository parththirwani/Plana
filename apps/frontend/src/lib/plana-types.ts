export type Role = "ADMIN" | "MODERATOR" | "MEMBER";

export type Priority = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT";

export const PRIORITIES: Priority[] = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"];

export const priorityColor: Record<Priority, string> = {
  NONE: "bg-priority-none",
  LOW: "bg-priority-low",
  MEDIUM: "bg-priority-medium",
  HIGH: "bg-priority-high",
  URGENT: "bg-priority-urgent",
};

export interface User {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  onboardingCompleted: boolean;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  orgImage: string | null;
  role: Role;
}

export interface Member {
  id: string;
  userId: string;
  role: Role;
  user: User;
}

export interface Invitation {
  id: string;
  organizationId: string;
  organizationName: string;
  organizationImage: string | null;
  role: Role;
  createdAt: string;
}

export interface Board {
  id: string;
  title: string;
  description: string | null;
  organizationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Section {
  id: string;
  title: string;
  order: number;
  boardId: string;
}

export interface Issue {
  id: string;
  title: string;
  description: string | null;
  order: number;
  priority: Priority;
  dueDate: string | null;
  sectionId: string;
  assignees: User[];
}

export interface Comment {
  id: string;
  content: string;
  issueId: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
  author: User | null;
}

export interface BoardSection extends Section {
  issues: Issue[];
}

export interface BoardDetail extends Board {
  sections: BoardSection[];
}

export const roleRank: Record<Role, number> = { MEMBER: 1, MODERATOR: 2, ADMIN: 3 };

export function atLeast(role: Role, min: Role) {
  return roleRank[role] >= roleRank[min];
}
