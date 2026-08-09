import { z } from "zod"

const imageUrl = z.string().url().or(z.literal(""))

export const onboardingSchema = z.object({
    name: z.string().trim().min(3).max(50),
    avatarUrl: imageUrl.optional()
})

export const updateProfileSchema = z.object({
    name: z.string().min(3).max(50).optional(),
    avatarUrl: imageUrl.optional(),
});