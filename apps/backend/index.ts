import express from "express";
import authRouter from "./src/routers/auth";
import onboardingRouter from "./src/routers/onboarding"
import profileRouter from "./src/routers/profile"
import cookieParser from "cookie-parser";
import cors from "cors"

const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(cors())

app.use("/api/v1/auth", authRouter);
app.use("/api/v1/onboarding", onboardingRouter);
app.use("/api/v1/profile",profileRouter );

app.listen(8000, () => {
    console.log("Server running on http://localhost:8000");
});