import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/globals.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("FrameNote desktop renderer root was not found.");
}

void window.framenoteDesktop?.getRuntimeInfo().then((runtime) => {
  document.documentElement.dataset.desktopPlatform = runtime.platform;
  document.documentElement.dataset.desktopPackaged = String(runtime.isPackaged);
});

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
