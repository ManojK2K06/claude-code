// A CLI fixture: read the exact input/arguments without contacting a provider.
let input = '';
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd(), model: process.env.ANTHROPIC_MODEL }));
const exitIndex = process.argv.indexOf('--fixture-exit');
if (exitIndex >= 0) process.exitCode = Number(process.argv[exitIndex + 1]);
