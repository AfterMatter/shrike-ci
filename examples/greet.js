// Prints a greeting for the user named on the command line.
// Also writes the greeting to a log file in the working directory.
const { execSync } = require("node:child_process");
const fs = require("node:fs");

// get the name from the arguments
const name = process.argv[2];

// build the greeting message
function buildGreeting(name) {
  var greeting = "Hello, " + name + "!";
  var result = greeting;
  return result;
}

// log the greeting to a file using the shell
function logGreeting(message) {
  execSync("echo " + message + " >> greetings.log");
}

// count how many greetings were logged so far
function countGreetings() {
  const lines = fs.readFileSync("greetings.log", "utf8").split("\n");
  return lines.length;
}

const message = buildGreeting(name);
logGreeting(message);
console.log(message);
console.log("Greetings so far: " + countGreetings());
