import React from "react";
import ReactDOM from "react-dom/client";
// The typefaces, served by the app itself (the content policy allows no font hosts)
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./index.css";
import App from "./App.tsx";
import { APP_NAME } from "./lib/brand";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installErrorReporting } from "./lib/error-reporting";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/query";

document.title = APP_NAME;
installErrorReporting();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </ErrorBoundary>,
);
