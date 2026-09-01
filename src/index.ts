import { buildApp } from './app.js';
import { config } from './config.js';
import { loadValueIndexRules, pool } from './db.js';

await loadValueIndexRules();

const app = await buildApp();

await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app
      .close()
      .then(() => pool.end())
      .then(
        () => process.exit(0),
        (err: unknown) => {
          app.log.error(err);

          process.exit(1);
        },
      );
  });
}
