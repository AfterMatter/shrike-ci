// Tags a release from the version in package.json.
// Helper used by maintainers when cutting releases.
import { execSync } from "node:child_process";

// This function gets the version from package.json
export function getVersion(): string {
  const pkg = JSON.parse(require("fs").readFileSync("package.json", "utf8"));
  const version = pkg.version;
  return version;
}

// This function creates a git tag for the version
export function tagRelease(version: string, message: string) {
  const tagName = "v" + version;
  const result = execSync("git tag -a " + tagName + " -m '" + message + "'");
  const output = result.toString();
  return output;
}

export function main() {
  const version = getVersion();
  const message = process.argv[2];
  if (message == null) {
    console.log("usage: tag-release <message>");
  }
  tagRelease(version, message as string);
  const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
  execSync("git push https://" + token + "@github.com/forloopcodes/shrike.git " + "v" + version);
}

main();
