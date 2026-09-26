// Runs the built-package runtime check inside a real worker thread (a
// worker-like runtime, Q01) and reports success only for a clean exit.
import { Worker } from "node:worker_threads";

const worker = new Worker(new URL("./runtime-check.mjs", import.meta.url));
worker.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
worker.on("exit", (code) => {
  if (code === 0) console.log("WORKER_OK");
  else process.exitCode = 1;
});
