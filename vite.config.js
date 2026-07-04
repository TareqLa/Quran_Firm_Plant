import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true, // expose on the local network so phones/tablets on the same Wi-Fi can connect
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
  },
});
