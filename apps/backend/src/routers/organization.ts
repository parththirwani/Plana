import { Router } from "express";
import { authMiddleware, type AuthenticatedRequest } from "../middleware/auth";
import { prisma } from "@repo/db/db";
import { createOrg } from "../schema/organization";
import { slugify } from "../lib/slug";

const router = Router();

const uniqueSlug = async (name: string) => {
    const base = slugify(name);
    let slug = base;
    let i = 2;

    while (await prisma.organization.findUnique({ where: { slug } })) {
        slug = `${base}-${i++}`;
    }

    return slug;
};

router.post(
    "/",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            const parsedBody = createOrg.safeParse(req.body);

            if (!parsedBody.success) {
                return res.status(400).json({
                    message: "Fields not according to schema",
                });
            }

            if (!req.user) {
                return res.status(401).json({
                    message: "Unauthorized",
                });
            }

            const { name, description, orgImage } = parsedBody.data;
            const slug = await uniqueSlug(name);
            const userId = req.user.userId;

            const organization = await prisma.$transaction(async (tx) => {
                const org = await tx.organization.create({
                    data: { name, slug, description, orgImage },
                });

                await tx.membership.create({
                    data: {
                        userId,
                        organizationId: org.id,
                        role: "ADMIN",
                    },
                });

                return org;
            });

            return res.status(201).json({
                message: "Organization created successfully",
                organization,
            });
        } catch (error) {
            console.error("Create org error:", error);

            return res.status(500).json({
                message: "Internal server error",
            });
        }
    }
);

export default router;
