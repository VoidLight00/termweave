import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// styles.css first: it holds the primitives (.btn, .input, .menu…) that component
// stylesheets override, and Vite emits CSS in import order
import "./styles.css";
import "katex/dist/katex.min.css";
import { App } from "./App.tsx";
import { TmuxConsole } from "./components/TmuxConsole.tsx";
import { SettingsProvider } from "./lib/settings.ts";
import "./lib/viewport.ts";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <SettingsProvider>
      {location.pathname === "/tmux" ? <TmuxConsole /> : <App />}
    </SettingsProvider>
  </StrictMode>,
);
