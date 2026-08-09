import { z } from "zod"

export const UserSchema = z.object({
    email: z.string().trim().email("Invalid email format"),
    password: z.string().min(5, "Password must be at least 5 chars")
})

export const normalizeEmail = (email: string) => email.trim().toLowerCase()
