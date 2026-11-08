import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/01-base.css";
import "./styles/04-legacy.css";
import "./styles/02-shell.css";
import "./styles/03-components.css";
import "./styles/05-agents.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
