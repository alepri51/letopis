import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Интерфейс документов: React + Tailwind + shadcn/ui. В разработке /api проксируется на сервер документов.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: { port: 5184, proxy: { '/api': 'http://127.0.0.1:8084' } },
});
