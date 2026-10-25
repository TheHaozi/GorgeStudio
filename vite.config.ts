import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process 是 Node.js 的全局变量，此处无类型声明
const host = process.env.TAURI_DEV_HOST;

// Vite 配置参考：https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // 以下 Vite 选项专为 Tauri 开发与构建（tauri dev / tauri build）定制。

  // 1. 关闭清屏，避免 Vite 清屏掩盖 Rust 侧的编译错误。
  clearScreen: false,
  // 2. Tauri 要求使用固定端口，端口被占用时直接失败。
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. 忽略监听 src-tauri 目录，避免 Rust 源码变更触发前端热更新。
      ignored: ["**/src-tauri/**"],
    },
  },
}));
