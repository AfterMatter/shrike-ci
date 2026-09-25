// Covers the example page helpers: counting pages with a partial
// last page, and slicing out a single page of items.
import { expect, test } from "bun:test";
import { pageCount, pageOf } from "./pages";

test("a partial last page still counts", () => {
  expect(pageCount(10, 3)).toBe(4);
  expect(pageCount(9, 3)).toBe(3);
  expect(pageCount(0, 3)).toBe(0);
});

test("one page holds its slice of the items", () => {
  expect(pageOf([1, 2, 3, 4, 5], 1, 2)).toEqual([3, 4]);
  expect(pageOf([1, 2, 3, 4, 5], 2, 2)).toEqual([5]);
});
