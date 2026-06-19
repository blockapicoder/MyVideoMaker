import { spawn } from "node:child_process";
import { join } from "node:path";

const node = process.execPath;
const server = spawn(node, [join(process.cwd(), "server", "server.mjs")], {
  stdio: "inherit",
});
const frontend = spawn(node, [join(process.cwd(), "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1"], {
  stdio: "inherit",
});

const children = [server, frontend];
let stopping = false;

function stop(exitCode = 0) {
  if (stopping) {
    return;
  }
  stopping = true;
  children.forEach((child) => child.kill());
  process.exit(exitCode);
}

children.forEach((child) => {
  child.on("exit", (code, signal) => {
    if (!stopping && code !== 0 && signal !== "SIGTERM") {
      stop(code ?? 1);
    }
  });
});

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
