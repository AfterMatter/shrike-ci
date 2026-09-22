import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export const readUpload = (root: string, name: string) => readFile(join(root, name), "utf8");

export const removeUpload = (root: string, name: string) => rm(join(root, name));
