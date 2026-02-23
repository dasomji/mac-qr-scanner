/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Camera Warmup Delay - Time to wait for camera exposure adjustment before capturing */
  "warmupDelay": "1" | "2" | "3"
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `scan-qr-code` command */
  export type ScanQrCode = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `scan-qr-code` command */
  export type ScanQrCode = {}
}

