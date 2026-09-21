import http from "node:http";

const portIndex = process.argv.indexOf("--port");
const port = Number(process.argv[portIndex + 1]);
if (!Number.isInteger(port)) throw new Error("gateway fixture requires --port");

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health/liveliness") {
    const body = Buffer.from(JSON.stringify({ status: "healthy" }));
    response.writeHead(200, { "content-type": "application/json", "content-length": body.length });
    response.end(body);
    return;
  }
  response.writeHead(503, { "content-type": "application/json" });
  response.end('{"error":{"message":"synthetic gateway accepts health only"}}');
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => { process.exitCode = 0; }));
}
