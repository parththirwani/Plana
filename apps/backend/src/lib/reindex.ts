export const reindex = <T extends { id: string; order: number }>(
    items: T[]
): T[] =>
    [...items]
        .sort((a, b) => a.order - b.order)
        .map((item, i) => ({ ...item, order: i }));

export const moveTo = <T extends { id: string; order: number }>(
    items: T[],
    id: string,
    to: number
): T[] => {
    const sorted = [...items].sort((a, b) => a.order - b.order);
    const from = sorted.findIndex((item) => item.id === id);
    if (from < 0) return items;
    const [item] = sorted.splice(from, 1);
    sorted.splice(Math.max(0, Math.min(to, sorted.length)), 0, item!);
    return sorted.map((item, i) => ({ ...item, order: i }));
};
