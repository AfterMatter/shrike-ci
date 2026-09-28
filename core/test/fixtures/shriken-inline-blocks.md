This pull request adds one example file to exercise Shrike's review thread lifecycle across two pushes. The first push [commit:23400b1] introduced an off-by-one loop that read past the end of the array, and the second push [commit:e24da50] fixed the bound to `i < prices.length`; [review:code-review], [review:house-style], [review:slop-review], and [review:cleanup] all pass at head. The file is examples/cart.js [file:examples/cart.js:1].
```diff
+const prices = process.argv.slice(2).map(Number);
+
+let total = 0;
+for (let i = 0; i < prices.length; i++) total += prices[i];
+
+console.log(`Total: ${total.toFixed(2)}`);
```
[review:house-style] and [review:slop-review] found nothing to change. [review:code-review] leaves one info note: non-numeric arguments silently yield `Total: NaN` [finding:code-review#1], which it calls not a blocker for this fixture. [review:cleanup] leaves one info note proposing to replace the manual accumulation loop [file:examples/cart.js:6] with a reduce [finding:cleanup#1], and it offers this suggestion:
```suggestion
const total = prices.reduce((sum, price) => sum + price, 0);
```
Hold and do not merge. The deciding thing is the pull request's own do-not-merge instruction, since this is a lifecycle test fixture rather than a change meant to land, even though the fix in [commit:e24da50] is verified and every review — [review:code-review], [review:house-style], [review:slop-review], [review:cleanup] — passes. I would change my mind if the author updates the description to drop that instruction and asks for the pull request to be merged.
