import { prisma } from "@repo/db/db";

export const isBoardMember = async (
    userId: string,
    boardId: string
): Promise<boolean> => {
    const board = await prisma.board.findUnique({ where: { id: boardId } });
    if (!board) return false;

    const membership = await prisma.membership.findFirst({
        where: { organizationId: board.organizationId, userId },
    });
    return membership !== null;
};
