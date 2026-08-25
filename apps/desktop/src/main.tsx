import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "./index.css";

async function bootstrap() {
  // Dev-only browser harness; stripped from production builds and inert
  // inside the real Tauri shell (which injects __TAURI_INTERNALS__ first).
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    await import("./dev/mockTauri");
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  // The window is created hidden; tell the backend the first frame exists so
  // it can show the window already painted (double rAF = after first paint).
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      invoke("frontend_ready").catch(() => {});
    });
  });
}

void bootstrap();
