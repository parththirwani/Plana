import { Router } from "express";
import { UserSchema } from "../schema/auth";
import { prisma } from "@repo/db/db";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const router = Router();

router.post("/signup", async (req, res) => {
    try {
        const parsedBody = UserSchema.safeParse(req.body);

        if (!parsedBody.success) {
            return res.status(400).json({
                message: "Email and password do not match the required schema",
            });
        }

        const { email, password } = parsedBody.data;

        const existingUser = await prisma.user.findUnique({
            where: {
                email,
            },
        });

        if (existingUser) {
            return res.status(403).json({
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

        return res.status(201).json({
            message: "User signed up successfully",
        });
    } catch (error) {
        console.error("Signup error:", error);

        return res.status(500).json({
            message: "Internal server error",
        });
    }
});

router.post("/login", async (req, res) => {
    try {
        const parsedBody = UserSchema.safeParse(req.body);

        if (!parsedBody.success) {
            return res.status(400).json({
                message: "Email and password do not match the required schema",
            });
        }

        const { email, password } = parsedBody.data;

        const existingUser = await prisma.user.findUnique({
            where: {
                email,
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

        const token = jwt.sign(
            {
                userId: existingUser.id,
                email: existingUser.email,
            },
            process.env.JWT_SECRET!,
            {
                expiresIn: "1h",
            }
        );

        res.cookie("token", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 60 * 60 * 1000,
        });

        return res.status(200).json({
            message: "User signed in successfully",
        });
    } catch (error) {
        console.error("Signin error:", error);

        return res.status(500).json({
            message: "Internal server error",
        });
    }
});

router.post("/logout", (req, res) => {
    res.clearCookie("token", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
    });

    return res.status(200).json({
        message: "User signed out successfully",
    });
});

export default router;