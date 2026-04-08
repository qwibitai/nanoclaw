// wait-for-xpc-service.swift
//
// Waits for an Apple XPC/Mach service to become available.
//
// Usage:
//   wait-for-xpc-service <service-name> [timeout-seconds]
//
// Arguments:
//   service-name       The Mach service name to connect to (e.g. com.apple.container.apiserver)
//   timeout-seconds    Maximum time to wait before giving up (default: 120)
//
// Exit codes:
//   0  Service became available within the timeout
//   1  Timeout reached or invalid arguments
//
// This tool is called by NanoClaw's Node.js bootstrap before starting the Apple Container
// runtime on boot. It blocks efficiently using a GCD semaphore with periodic retries
// (every 2 seconds) via XPC Mach port messaging — zero CPU overhead while waiting.

import Foundation

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

guard CommandLine.arguments.count >= 2 else {
    fputs("Usage: wait-for-xpc-service <service-name> [timeout-seconds]\n", stderr)
    exit(1)
}

let serviceName = CommandLine.arguments[1]
let timeoutSeconds: Double = {
    if CommandLine.arguments.count >= 3, let raw = Double(CommandLine.arguments[2]), raw > 0 {
        return raw
    }
    return 120.0
}()

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Signaled when the XPC connection succeeds.
let connectedSemaphore = DispatchSemaphore(value: 0)

/// Protects the `timedOut` flag across concurrent handlers.
let stateLock = NSLock()
var timedOut = false

/// Caches the XPC error type for pointer comparison.
let xpcErrorType = xpc_error_get_type()

// ---------------------------------------------------------------------------
// Helper: attempt a single XPC connection
// ---------------------------------------------------------------------------

func attemptConnection() {
    let connection = xpc_connection_create_mach_service(
        serviceName,
        DispatchQueue.main,
        0
    )

    xpc_connection_set_event_handler(connection) { event in
        // If we already hit the timeout, do nothing.
        stateLock.lock()
        let alreadyTimedOut = timedOut
        stateLock.unlock()

        if alreadyTimedOut {
            return
        }

        if xpc_get_type(event) == xpcErrorType {
            // Connection failed with an XPC error — the service is not yet ready.
            // Retry after 2 seconds on a background queue.
            DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) {
                attemptConnection()
            }
        } else {
            // Connection succeeded — signal the main thread.
            connectedSemaphore.signal()
        }
    }

    xpc_connection_resume(connection)
}

// ---------------------------------------------------------------------------
// Main wait loop
// ---------------------------------------------------------------------------

// Kick off the first connection attempt.
attemptConnection()

// Block the main thread until either:
//   a) the service connects (semaphore signaled), or
//   b) the deadline expires.
let waitResult = connectedSemaphore.wait(timeout: .now() + timeoutSeconds)

if waitResult == .success {
    // Service connected.
    fputs("Connected to \(serviceName)\n", stderr)
    exit(0)
} else {
    // Timeout.
    stateLock.lock()
    timedOut = true
    stateLock.unlock()

    fputs("Timeout waiting for \(serviceName) after \(Int(timeoutSeconds))s\n", stderr)
    exit(1)
}
