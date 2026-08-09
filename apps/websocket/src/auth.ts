import jwt from "jsonwebtoken";

export const getJwtSecret = (): string => {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error("JWT_SECRET is not set");
    }
    return secret;
};

export const verifySocketToken = (
    token: string
): { userId: string } | null => {
    try {
        const decoded = jwt.verify(token, getJwtSecret()) as {
            userId: string;
        };
        return decoded.userId ? { userId: decoded.userId } : null;
    } catch {
        return null;
    }
};

export const tokenFromRequest = (req: Request): string | null => {
    const url = new URL(req.url);
    const queryToken = url.searchParams.get("token");
    if (queryToken) return queryToken;

    const match = req.headers.get("cookie")?.match(/(?:^|;\s*)token=([^;]+)/);
    return match?.[1] ?? null;
};
