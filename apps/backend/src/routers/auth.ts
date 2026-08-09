import { Router, type Response } from "express";
import { UserSchema, normalizeEmail } from "../schema/auth";
import { prisma } from "@repo/db/db";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
    authMiddleware,
    authCookieOptions,
    getJwtSecret,
    type AuthenticatedRequest,
} from "../middleware/auth";

const router = Router();

const safeUser = (user: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
    onboardingCompleted: boolean;
}) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    onboardingCompleted: user.onboardingCompleted,
});

const signToken = (user: { id: string; email: string }) =>
    jwt.sign({ userId: user.id, email: user.email }, getJwtSecret(), {
        expiresIn: "1h",
    });

const setAuthCookie = (res: Response, user: { id: string; email: string }) => {
    res.cookie("token", signToken(user), authCookieOptions);
};

router.post("/signup", async (req, res) => {
    try {
        const parsedBody = UserSchema.safeParse(req.body);

        if (!parsedBody.success) {
            return res.status(400).json({
                message: "Email and password do not match the required schema",
            });
        }

        const email = normalizeEmail(parsedBody.data.email);
        const { password } = parsedBody.data;

        const existingUser = await prisma.user.findFirst({
            where: {
                email: { equals: email, mode: "insensitive" },
            },
        });

        if (existingUser) {
            return res.status(409).json({
                message: "Email already exists",
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const user = await prisma.user.create({
            data: {
                email,
                password: hashedPassword,
            },
        });

        setAuthCookie(res, user);

        return res.status(201).json({
            message: "User signed up successfully",
            user: safeUser(user),
        });
    } catch (error) {
        console.error("Signup error:", error);

        return res.status(500).json({
            message: "Internal server error",
        });
    }
});

router.post("/signin", async (req, res) => {
    try {
        const parsedBody = UserSchema.safeParse(req.body);

        if (!parsedBody.success) {
            return res.status(400).json({
                message: "Email and password do not match the required schema",
            });
        }

        const email = normalizeEmail(parsedBody.data.email);
        const { password } = parsedBody.data;

        const existingUser = await prisma.user.findFirst({
            where: {
                email: { equals: email, mode: "insensitive" },
            },
        });

        if (!existingUser) {
            return res.status(403).json({
                message: "Invalid email or password",
            });
        }

        const isPasswordValid = await bcrypt.compare(
            password,
            existingUser.password
        );

        if (!isPasswordValid) {
            return res.status(403).json({
                message: "Invalid email or password",
            });
        }

        setAuthCookie(res, existingUser);

        return res.status(200).json({
            message: "User signed in successfully",
            user: safeUser(existingUser),
        });
    } catch (error) {
        console.error("Signin error:", error);

        return res.status(500).json({
            message: "Internal server error",
        });
    }
});

router.post("/logout", (req, res) => {
    res.clearCookie("token", authCookieOptions);

    return res.status(200).json({
        message: "Logged out successfully",
    });
});

router.get("/me", authMiddleware, async (req: AuthenticatedRequest, res) => {
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
                id: true,
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
            user: safeUser(user),
        });
    } catch (error) {
        console.error("Get profile error:", error);

        return res.status(500).json({
            message: "Internal server error",
        });
    }
});

export default router;