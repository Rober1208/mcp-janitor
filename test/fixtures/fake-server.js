// A stand-in for an MCP server that keeps running after its agent is gone,
// like the servers that leak: it ignores the end of its input.
process.stdin.on('data', () => {});
process.stdin.on('error', () => {});
process.stdout.on('error', () => {});
setInterval(() => {}, 1 << 30);
