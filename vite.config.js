import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/my-game/' : '/',
  server: {
    host: true,
    port: 8080,
    allowedHosts: ['.cloudshell.dev'],
    hmr: { clientPort: 443 },
  },
}));
