import { Router } from "express";
import jwt from "jsonwebtoken";
import {
  authMiddleware,
  getJwtSecret,
  type AuthenticatedRequest,
} from "../middleware/auth";

const router = Router();

router.get("/ws-token", authMiddleware, (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({
      message: "Unauthorized",
    });
  }

  const token = jwt.sign(
    { userId: req.user.userId, email: req.user.email },
    getJwtSecret(),
    { expiresIn: "1h" },
  );

  return res.status(200).json({
    message: "WebSocket token issued",
    token,
  });
});

export default router;
