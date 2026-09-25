// Puts a working directory at a pull request head or branch commit.
// Clones when missing, otherwise fetches the ref and any extra refspecs.
import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface CheckoutTarget {
  dir: string;
  cloneUrl: string;
  ref: string;
  headSha: string;
  token?: string;
  also?: string[];
}

export function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args.find((arg, at) => !arg.startsWith("-") && args[at - 1] !== "-c")} failed (${code}): ${err.trim() || out.trim()}`))));
  });
}

export const authArgs = (token?: string): string[] => (token ? ["-c", `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`] : []);

export async function ensureCheckout({ dir, cloneUrl, ref, headSha, token, also = [] }: CheckoutTarget, log: (line: string) => void): Promise<void> {
  const auth = authArgs(token);
  const cloned = await access(join(dir, ".git")).then(() => true, () => false);
  if (!cloned) {
    await mkdir(dir, { recursive: true });
    log(`cloning into ${dir}`);
    await git(dir, [...auth, "clone", "--quiet", "--no-checkout", cloneUrl, "."]);
  }
  if (!also.length && (await git(dir, ["rev-parse", "HEAD"]).catch(() => "")) === headSha) return;
  log(`fetching ${ref.replace(/^refs\/(heads\/)?/, "")} (${headSha.slice(0, 7)})${also.length ? ` and ${also.length} more refs` : ""}`);
  await git(dir, [...auth, "fetch", "--quiet", "--depth", "50", "origin", `+${ref}`, ...also]);
  await git(dir, ["checkout", "--quiet", "--detach", headSha]);
}
