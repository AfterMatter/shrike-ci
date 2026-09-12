// Prints a greeting for the name given on the command line and appends
// it to greetings.log, then reports how many greetings the log holds.
const fs = require("node:fs");

const LOG = "greetings.log";

function countGreetings() {
  if (!fs.existsSync(LOG)) return 0;
  return fs
    .readFileSync(LOG, "utf8")
    .split("\n")
    .filter((line) => line.length > 0).length;
}

const name = process.argv[2];
if (!name) {
  console.error("usage: node examples/greet.js <name>");
  process.exit(1);
}

const message = `Hello, ${name}!`;
fs.appendFileSync(LOG, `${message}\n`);
console.log(message);
console.log(`Greetings so far: ${countGreetings()}`);
