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

document.title = APP_NAME;
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
