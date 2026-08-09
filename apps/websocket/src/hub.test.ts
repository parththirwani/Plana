import { describe, test, expect, beforeEach } from "bun:test";
import { addSocket, clearSockets, relayToBoard, removeSocket } from "./hub";

const makeSocket = (boardIds: string[] = []) => {
    const received: string[] = [];
    const socket = {
        data: { boardIds: new Set(boardIds) },
        send: (message: string) => received.push(message),
    };
    return { socket, received };
};

describe("relayToBoard", () => {
    beforeEach(() => {
        clearSockets();
    });

    test("relays only to sockets subscribed to the board", () => {
        const { socket: boardA, received: receivedA } = makeSocket(["brd_a"]);
        const { socket: boardB, received: receivedB } = makeSocket(["brd_b"]);
        addSocket(boardA);
        addSocket(boardB);

        const sent = relayToBoard("brd_a", "hello");

        expect(sent).toBe(1);
        expect(receivedA).toEqual(["hello"]);
        expect(receivedB).toEqual([]);
    });

    test("relays to multiple subscribers of the same board", () => {
        const { socket: s1, received: r1 } = makeSocket(["brd_a"]);
        const { socket: s2, received: r2 } = makeSocket(["brd_a"]);
        addSocket(s1);
        addSocket(s2);

        relayToBoard("brd_a", "msg");

        expect(r1).toEqual(["msg"]);
        expect(r2).toEqual(["msg"]);
    });

    test("sends nothing when no socket is subscribed", () => {
        const { socket, received } = makeSocket(["brd_a"]);
        addSocket(socket);

        const sent = relayToBoard("brd_b", "msg");

        expect(sent).toBe(0);
        expect(received).toEqual([]);
    });

    test("removed sockets stop receiving", () => {
        const { socket, received } = makeSocket(["brd_a"]);
        addSocket(socket);
        removeSocket(socket);

        relayToBoard("brd_a", "msg");

        expect(received).toEqual([]);
    });
});
