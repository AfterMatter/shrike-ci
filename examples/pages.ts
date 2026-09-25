// Page helpers for the examples: how many pages a list needs
// and the items on one page, for a fixed page size.
export const pageCount = (total: number, size: number): number => (size > 0 ? Math.ceil(total / size) : 0);

export const pageOf = <T>(items: T[], page: number, size: number): T[] => items.slice(page * size, page * size + size);
