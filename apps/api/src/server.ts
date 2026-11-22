import { createApp } from "./app";
import { readConfig } from "./config";

const config = readConfig();
const { app, pool } = createApp(config);
const server = app.listen(config.port, config.host, () => {
  console.log(`Kinlilo API listening on ${config.host}:${config.port}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void pool.end();
    });
  });
}
