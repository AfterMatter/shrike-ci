// Totals a shopping cart from the command line for the lifecycle test.
// Usage: node examples/cart.js 3.50 2 10 prints the sum of the prices.

const prices = process.argv.slice(2).map(Number);

let total = 0;
for (let i = 0; i < prices.length; i++) total += prices[i];

console.log(`Total: ${total.toFixed(2)}`);
