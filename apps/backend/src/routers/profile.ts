import { Router } from "express";
import { prisma } from "@repo/db/db";
import { authMiddleware, type AuthenticatedRequest } from "../middleware/auth";
import { updateProfileSchema } from "../schema/onboarding";


const router = Router();

router.put(
    "/",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({
                    message: "Unauthorized",
                });
            }

            const parsedBody = updateProfileSchema.safeParse(req.body);

            if (!parsedBody.success) {
                return res.status(400).json({
                    message: "Invalid profile data",
                });
            }

            const { name, avatarUrl } = parsedBody.data;

            const user = await prisma.user.update({
                where: {
                    id: req.user.userId,
                },
                data: {
                    ...(name !== undefined && { name }),
                    ...(avatarUrl !== undefined && { avatarUrl }),
                },
                select: {
                    id: true,
                    email: true,
                    name: true,
                    avatarUrl: true,
                },
            });

            return res.status(200).json({
                message: "Profile updated successfully",
                user,
            });
        } catch (error) {
            console.error("Profile update error:", error);

            return res.status(500).json({
                message: "Internal server error",
            });
        }
    }
);

router.get(
    "",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({
                    message: "Unauthorized",
                });
            }

            const user = await prisma.user.findUnique({
                where: {
                    id: req.user.userId,
                },
                select: {
                    email: true,
                    name: true,
                    avatarUrl: true,
                    onboardingCompleted: true,
                },
            });

            if (!user) {
                return res.status(404).json({
                    message: "User not found",
                });
            }

            return res.status(200).json({
                message: "Profile fetched successfully",
                user,
            });
        } catch (error) {
            console.error("Get profile error:", error);

            return res.status(500).json({
                message: "Internal server error",
            });
        }
    }
);

export default router;