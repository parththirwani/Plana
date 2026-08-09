import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import authRouter from "./src/routers/auth";
import profileRouter from "./src/routers/profile";
import organizationRouter from "./src/routers/organization";
import boardRouter from "./src/routers/board";
import issueRouter from "./src/routers/issue";
import commentRouter from "./src/routers/comment";

export const app = express();

app.use(
    cors({
        origin: process.env.CORS_ORIGIN?.split(",") ?? true,
        credentials: true,
    })
);
app.use(express.json());
app.use(cookieParser());

app.use("/api/v1/auth", authRouter);
app.use("/api/v1/profile", profileRouter);
app.use("/api/v1/organizations", organizationRouter);
app.use("/api/v1", boardRouter);
app.use("/api/v1", issueRouter);
app.use("/api/v1", commentRouter);

if (process.env.NODE_ENV !== "test") {
    app.listen(8000, () => {
        console.log("Server running on http://localhost:8000");
    });
}