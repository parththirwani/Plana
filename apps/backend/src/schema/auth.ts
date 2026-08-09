import { z } from "zod"

export const UserSchema = z.object({
    email: z.string(),
    password: z.string().min(5, "Password must be atleast 5 chars")
})