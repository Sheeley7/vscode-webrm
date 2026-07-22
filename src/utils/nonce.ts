import * as crypto from "crypto";

/** Generates a per-webview-instance nonce for CSP `script-src 'nonce-...'`. */
export function generateNonce(): string {
    return crypto.randomBytes(16).toString("base64");
}
