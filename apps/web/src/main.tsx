import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ThemeProvider } from "./components/theme-provider.js";
import "blobatar/motion.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
