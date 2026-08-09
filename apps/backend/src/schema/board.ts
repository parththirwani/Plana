import { z } from "zod";

export const createBoard = z.object({
    title: z.string().trim().min(1, "Title is required").max(100),
    description: z.string().max(500).optional(),
});

export const updateBoard = z.object({
    title: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
});

export const createSection = z.object({
    title: z.string().trim().min(1, "Title is required").max(100),
});

export const updateSection = z.object({
    title: z.string().trim().min(1).max(100).optional(),
    order: z.number().int().min(0).optional(),
});
