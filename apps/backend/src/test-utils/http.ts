export const tokenCookieFrom = (res: Response): string | null => {
    const token = res.headers
        .getSetCookie()
        .find((c) => c.startsWith("token="));
    return token?.split(";")[0] ?? null;
};

export const startTestServer = async () => {
    const { app } = await import("../../index");
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const baseUrl = `http://localhost:${(server.address() as any).port}`;
    return { server, baseUrl };
};

export const makeHttp = (baseUrl: string) => {
    const send = (method: string, path: string, body?: unknown, cookie?: string | null) =>
        fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
                ...(cookie ? { Cookie: cookie } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });

    return {
        post: (path: string, body?: unknown, cookie?: string | null) =>
            send("POST", path, body, cookie),
        get: (path: string, cookie?: string | null) =>
            send("GET", path, undefined, cookie),
        put: (path: string, body: unknown, cookie?: string | null) =>
            send("PUT", path, body, cookie),
        patch: (path: string, body: unknown, cookie?: string | null) =>
            send("PATCH", path, body, cookie),
        del: (path: string, cookie?: string | null) =>
            send("DELETE", path, undefined, cookie),
        login: async (email: string, password = "password123") => {
            const res = await send("POST", "/api/v1/auth/signin", {
                email,
                password,
            });
            if (res.status !== 200) {
                throw new Error(`login failed for ${email}: ${res.status}`);
            }
            return tokenCookieFrom(res)!;
        },
    };
};
