// Preload (inherited by worker threads through --import): CPU-profile each worker thread and flush a profile file
// every two seconds, because pool teardown terminates workers without running their exit handlers.
import fs from "node:fs";
import path from "node:path";
import { Session } from "node:inspector";
import { isMainThread, threadId } from "node:worker_threads";

const dir = process.env.WORKER_PROFILE_DIR;
if (!isMainThread && dir) {
  const session = new Session();
  session.connect();
  session.post("Profiler.enable");
  session.post("Profiler.setSamplingInterval", { interval: 1000 });
  session.post("Profiler.start");
  let part = 0;
  const flush = () => {
    session.post("Profiler.stop", (error, result) => {
      if (!error && result?.profile) {
        fs.writeFileSync(
          path.join(dir, `worker-${process.pid}-${threadId}-${String(part).padStart(4, "0")}.cpuprofile`),
          JSON.stringify(result.profile),
        );
        part += 1;
      }
      session.post("Profiler.start");
    });
  };
  const timer = setInterval(flush, 2000);
  timer.unref();
  process.on("exit", flush);
}
