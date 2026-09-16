/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ZENITH_QA?: string;
  readonly VITE_ZENITH_QA_AUTO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  __zenithQA?: {
    runSmoke: () => Promise<unknown>;
    runFull: () => Promise<unknown>;
    runSocial: () => Promise<unknown>;
    runRelease: () => Promise<unknown>;
    snapshot: () => unknown;
    dump?: (name?: string) => Promise<string>;
    plugins?: () => unknown;
    hooks?: unknown;
  };
}
