export type BoardSocket = {
    data: { boardIds: Set<string> };
    send: (message: string) => void;
};

const sockets = new Set<BoardSocket>();

export const addSocket = (socket: BoardSocket): void => {
    sockets.add(socket);
};

export const removeSocket = (socket: BoardSocket): void => {
    sockets.delete(socket);
};

export const clearSockets = (): void => {
    sockets.clear();
};

export const relayToBoard = (boardId: string, message: string): number => {
    let sent = 0;
    for (const socket of sockets) {
        if (socket.data.boardIds.has(boardId)) {
            socket.send(message);
            sent += 1;
        }
    }
    return sent;
};
