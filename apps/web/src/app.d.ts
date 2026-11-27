// See https://svelte.dev/docs/kit/types#app.d.ts

declare global {
  /** The root package.json version, injected by Vite's `define` (vite.config.ts). */
  const __APP_VERSION__: string;

  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
