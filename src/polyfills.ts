import { Buffer } from 'buffer';

// Make Buffer available globally
(globalThis as any).Buffer = Buffer;
(globalThis as any).global = globalThis;

// For TypeScript, we need to extend the global interface
declare global {
  var Buffer: typeof import('buffer').Buffer;
  var global: typeof globalThis;
}

export {}; 