import { z }  from "zod";

export const createOrg = z.object({
    name: z.string(),
    description: z.string().optional(),
    orgImage: z.string().url().optional()
});