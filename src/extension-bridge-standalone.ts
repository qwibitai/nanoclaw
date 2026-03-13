/**
 * Standalone bridge server entry point.
 * Run with: npm run bridge
 *
 * Use this when you want to start the extension bridge independently
 * (e.g., for development, or if NanoClaw isn't running).
 */

import { startExtensionBridge } from './extension-bridge.js';

console.log('Starting NanoClaw Extension Bridge (standalone)...');
startExtensionBridge();
