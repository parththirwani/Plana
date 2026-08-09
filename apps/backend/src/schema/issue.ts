import { z } from "zod";

const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;

export const createIssue = z.object({
    title: z.string().trim().min(1, "Title is required").max(200),
    description: z.string().max(2000).optional(),
    priority: z.enum(PRIORITIES).optional(),
    dueDate: z.coerce.date().nullable().optional(),
});

export const updateIssue = z.object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    priority: z.enum(PRIORITIES).optional(),
    dueDate: z.coerce.date().nullable().optional(),
});

export const moveIssue = z.object({
    sectionId: z.string().min(1),
    order: z.number().int().min(0).optional(),
});

export const setAssignees = z.object({
    assigneeIds: z.array(z.string().min(1)).max(100),
});
