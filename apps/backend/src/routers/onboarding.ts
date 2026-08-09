import { Router } from "express";
import { onboardingSchema } from "../schema/onboarding";
import { authMiddleware, type AuthenticatedRequest } from "../middleware/auth";
import { prisma } from "@repo/db/db";

const router = Router()

router.post(
    "/",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            const parsedBody = onboardingSchema.safeParse(req.body);

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

            const user = await prisma.user.findUnique({
                where: {
                    id: req.user.userId,
                },
            });

            if (!user) {
                return res.status(404).json({
                    message: "User not found",
                });
            }

            if (user.onboardingCompleted) {
                return res.status(409).json({
                    message: "Onboarding already completed",
                });
            }

            const { name, avatarUrl } = parsedBody.data;

            const updatedUser = await prisma.user.update({
                where: {
                    id: user.id,
                },
                data: {
                    name,
                    avatarUrl,
                    onboardingCompleted: true,
                },
            });

            return res.status(200).json({
                message: "Onboarding completed successfully",
                user: {
                    id: updatedUser.id,
                    email: updatedUser.email,
                    name: updatedUser.name,
                    avatarUrl: updatedUser.avatarUrl,
                },
            });
        } catch (error) {
            console.error("Onboarding error:", error);

            return res.status(500).json({
                message: "Internal server error",
            });
        }
    }
);

export default router;