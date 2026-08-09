import type { Request, Response, NextFunction, CookieOptions } from "express";
import jwt from "jsonwebtoken";

export interface AuthenticatedRequest extends Request {
    user?: {
        userId: string;
        email: string;
    };
}

export const getJwtSecret = (): string => {
    if (!process.env.JWT_SECRET) {
        throw new Error("JWT_SECRET is not set");
    }
    return process.env.JWT_SECRET;
};

export const authCookieOptions: CookieOptions = {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: 60 * 60 * 1000, // 1h, matches JWT expiry
};

export const authMiddleware = (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
) => {
    try {
        const token = req.cookies?.token;

        if (!token) {
            return res.status(401).json({
                message: "Authentication required",
            });
        }

        const decoded = jwt.verify(token, getJwtSecret()) as {
            userId: string;
            email: string;
        };

        req.user = {
            userId: decoded.userId,
            email: decoded.email,
        };

        next();
    } catch (error) {
        return res.status(401).json({
            message: "Invalid or expired token",
        });
    }
};