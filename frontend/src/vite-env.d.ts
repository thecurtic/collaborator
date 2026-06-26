/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional explicit API base URL. Empty in dev (Vite proxy handles /api). */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
