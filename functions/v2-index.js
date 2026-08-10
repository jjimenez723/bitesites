// Compatibility entrypoint for Hybrid Dialer V2.
// Keep every existing Cloud Function export while adding the V2 control-plane
// functions without rewriting the large legacy index module in one migration.

export * from './index.js';
export * from './hybrid-dialer-api.js';
export * from './hybrid-session-api.js';
export * from './hybrid-ai-sip-dispatch.js';
export * from './hybrid-sideband-control.js';
export * from './hybrid-ai-carrier-control.js';
export * from './hybrid-voicemail.js';
