import { defineConfig, loadEnv } from 'vite';

// Адрес сервера задаётся переменной окружения: при запуске на машине это
// localhost, а в docker-compose — имя службы, под которым поднят API.
// host: true нужен в контейнере, иначе Vite слушает только петлевой адрес
// и наружу ничего не отдаёт.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxy = {
    '/api': {
      target: env.API_URL || 'http://127.0.0.1:8080',
      changeOrigin: true,
      ws: true,
    },
  };

  return {
    server: { port: 3000, host: true, proxy },
    preview: { port: 3000, host: true, proxy },
  };
});
