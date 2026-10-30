import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Интерфейс кошелька: React + Tailwind + shadcn/ui. В разработке /api проксируется на сервер кошелька.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src'), '@shared': path.resolve(__dirname, '../../shared/web') },
    // общая панель «Под капотом» (@shared) лежит вне приложения, рядом с ней нет node_modules: react — одна копия, из приложения
    dedupe: ['react', 'react-dom'],
  },
  server: { port: 5182, proxy: { '/api': 'http://127.0.0.1:8082' } },
});
