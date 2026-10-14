/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend base URL (default http://localhost:4000) */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
