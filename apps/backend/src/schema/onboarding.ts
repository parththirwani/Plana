import { z } from "zod"

export const onboardingSchema = z.object({
    name: z.string().trim().min(3).max(50),
    avatarUrl: z.string().url().optional()
})

export const updateProfileSchema = z.object({
    name: z.string().min(3).max(50).optional(),
    avatarUrl: z.string().url().optional(),
});