// Puts a working directory at the pull request head commit.
// Clones when missing, otherwise fetches refs/pull/N/head.
import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface CheckoutTarget {
  dir: string;
  cloneUrl: string;
  pr: number;
  headSha: string;
  token?: string;
}

export function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args.find((a) => !a.startsWith("-") && a !== "http.extraheader")} failed (${code}): ${err.trim() || out.trim()}`))));
  });
}

export const authArgs = (token?: string): string[] => (token ? ["-c", `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`] : []);

export async function ensureCheckout({ dir, cloneUrl, pr, headSha, token }: CheckoutTarget, log: (line: string) => void): Promise<void> {
  const auth = authArgs(token);
  const cloned = await access(join(dir, ".git")).then(() => true, () => false);
  if (!cloned) {
    await mkdir(dir, { recursive: true });
    log(`cloning into ${dir}`);
    await git(dir, [...auth, "clone", "--quiet", "--no-checkout", cloneUrl, "."]);
  }
  if ((await git(dir, ["rev-parse", "HEAD"]).catch(() => "")) === headSha) return;
  log(`fetching pull/${pr}/head (${headSha.slice(0, 7)})`);
  await git(dir, [...auth, "fetch", "--quiet", "--depth", "50", "origin", `+refs/pull/${pr}/head`]);
  await git(dir, ["checkout", "--quiet", "--detach", headSha]);
}
