import { z } from "zod";

export const createComment = z.object({
    content: z.string().trim().min(1, "Content is required").max(2000),
});

export const updateComment = z.object({
    content: z.string().trim().min(1).max(2000),
});
