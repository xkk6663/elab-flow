import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 相对路径：dist/ 被 Python（cockpit/server.py）托管在 / 下，也可放到任意子路径
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // ★ 产物入库（N1/K3/K4）。故刻意**不**带内容哈希：
    //   文件内容变了就产生 diff，恰好是"你改了 tsx 但没重新 build"的守卫信号；
    //   而带哈希会让每次改动多出一堆"新增+删除"的噪声。
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
    sourcemap: false,
    target: "es2020",
  },
  server: {
    port: 5273,
    strictPort: true,
    // 开发时把 /api 代理到后端（SSE 会被 http-proxy 原样透传流式响应）
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3333",
        changeOrigin: true,
      },
    },
  },
});
