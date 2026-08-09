import { z } from "zod";

export const createOrg = z.object({
    name: z.string().trim().min(1, "Name is required").max(50),
    description: z.string().max(500).optional(),
    orgImage: z.string().url().optional(),
});

export const updateOrg = z.object({
    name: z.string().trim().min(1).max(50).optional(),
    description: z.string().max(500).optional(),
    orgImage: z.string().url().optional(),
});

export const inviteMember = z.object({
    email: z.string().trim().email("Invalid email format"),
});

export const roleChange = z.object({
    role: z.enum(["MEMBER", "ADMIN", "MODERATOR"]),
});
