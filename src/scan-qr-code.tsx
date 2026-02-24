import {
  Detail,
  Action,
  ActionPanel,
  Clipboard,
  showHUD,
  showToast,
  Toast,
  environment,
} from "@raycast/api";
import { useState, useEffect, useRef } from "react";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { Jimp } from "jimp";
import jsQR from "jsqr";

const execFileAsync = promisify(execFile);

const STARTUP_TIMEOUT_MS = 5000;

type ScanStatus = "scanning" | "found" | "error";

interface WifiNetwork {
  ssid: string;
  password: string;
  security: string;
  hidden: boolean;
}

function looksLikeUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseWifi(text: string): WifiNetwork | null {
  if (!text.startsWith("WIFI:")) return null;

  const body = text.slice(5).replace(/;;\s*$/, "");
  const params: Record<string, string> = {};

  for (const part of body.split(/(?<!\\);/)) {
    const colonIdx = part.indexOf(":");
    if (colonIdx === -1) continue;
    const key = part.slice(0, colonIdx).toUpperCase();
    const value = part.slice(colonIdx + 1).replace(/\\(.)/g, "$1");
    params[key] = value;
  }

  if (!params.S) return null;

  return {
    ssid: params.S,
    password: params.P || "",
    security: params.T || "nopass",
    hidden: params.H === "true",
  };
}

async function connectToWifi(network: WifiNetwork): Promise<void> {
  const { stdout } = await execFileAsync("/usr/sbin/networksetup", [
    "-listallhardwareports",
  ]);
  const match = stdout.match(/Hardware Port: Wi-Fi\nDevice: (\w+)/);
  const iface = match ? match[1] : "en0";

  const args = ["-setairportnetwork", iface, network.ssid];
  if (network.password) args.push(network.password);

  await execFileAsync("/usr/sbin/networksetup", args);
}

export default function Command() {
  const [status, setStatus] = useState<ScanStatus>("scanning");
  const [cameraReady, setCameraReady] = useState(false);
  const [decoded, setDecoded] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const procRef = useRef<ChildProcess | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    doneRef.current = false;
    let startupTimer: ReturnType<typeof setTimeout> | null = null;

    async function startCapture() {
      const binaryPath = join(environment.assetsPath, "capture-frame");

      try {
        await chmod(binaryPath, 0o755);
      } catch {
        // Ignore — may already be executable
      }

      const proc = spawn(binaryPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      procRef.current = proc;

      startupTimer = setTimeout(() => {
        if (!doneRef.current) {
          setStatus("error");
          setErrorMessage(
            "Camera did not produce frames. Check camera permissions in System Settings > Privacy & Security > Camera.",
          );
          proc.kill("SIGTERM");
        }
      }, STARTUP_TIMEOUT_MS);

      let stderrOutput = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrOutput += chunk.toString();
      });

      proc.on("close", (code) => {
        if (doneRef.current) return;
        if (code !== 0 && code !== null) {
          setStatus("error");
          setErrorMessage(
            stderrOutput.trim() || `Camera process exited with code ${code}`,
          );
        }
      });

      proc.on("error", (err) => {
        if (doneRef.current) return;
        setStatus("error");
        setErrorMessage(err.message);
      });

      const rl = createInterface({ input: proc.stdout! });

      // QR detection state
      let latestLine: string | null = null;
      let processing = false;

      async function detectQR(base64Line: string) {
        if (doneRef.current) return;
        processing = true;

        try {
          const buffer = Buffer.from(base64Line, "base64");
          const image = await Jimp.read(buffer);
          const { data, width, height } = image.bitmap;
          const imageData = new Uint8ClampedArray(
            data.buffer,
            data.byteOffset,
            data.byteLength,
          );
          const result = jsQR(imageData, width, height);

          if (result && !doneRef.current) {
            doneRef.current = true;
            await Clipboard.copy(result.data);
            setDecoded(result.data);
            setStatus("found");
            rl.close();
            proc.kill("SIGTERM");
            return;
          }
        } catch {
          // Corrupted frame — skip
        }

        processing = false;

        if (latestLine && !doneRef.current) {
          const next = latestLine;
          latestLine = null;
          detectQR(next);
        }
      }

      rl.on("line", (line) => {
        if (doneRef.current) return;

        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
        setCameraReady(true);

        // QR detection (every frame, with frame dropping)
        if (processing) {
          latestLine = line;
        } else {
          detectQR(line);
        }
      });
    }

    startCapture();

    return () => {
      doneRef.current = true;
      if (startupTimer) clearTimeout(startupTimer);
      if (procRef.current) {
        procRef.current.kill("SIGTERM");
        procRef.current = null;
      }
    };
  }, []);

  const wifi = status === "found" ? parseWifi(decoded) : null;
  const isUrl = status === "found" && looksLikeUrl(decoded);
  const markdown = buildMarkdown(
    status,
    cameraReady,
    decoded,
    errorMessage,
    wifi,
  );

  return (
    <Detail
      isLoading={status === "scanning"}
      navigationTitle={
        status === "scanning" ? "Point a QR code at your camera" : undefined
      }
      markdown={markdown}
      actions={
        <ActionPanel>
          {status === "found" && wifi && (
            <Action
              title="Connect to Network"
              onAction={async () => {
                try {
                  await showToast({
                    style: Toast.Style.Animated,
                    title: `Connecting to ${wifi.ssid}…`,
                  });
                  await connectToWifi(wifi);
                  await showHUD(`Connected to ${wifi.ssid}`);
                } catch (error) {
                  await showToast({
                    style: Toast.Style.Failure,
                    title: "Connection failed",
                    message:
                      error instanceof Error ? error.message : String(error),
                  });
                }
              }}
            />
          )}
          {status === "found" && isUrl && (
            <Action.OpenInBrowser url={decoded} />
          )}
          {status === "found" && (
            <Action.CopyToClipboard
              title="Copy to Clipboard"
              content={decoded}
              onCopy={() => showHUD("Copied to clipboard")}
            />
          )}
        </ActionPanel>
      }
    />
  );
}

function buildMarkdown(
  status: ScanStatus,
  cameraReady: boolean,
  decoded: string,
  errorMessage: string,
  wifi: WifiNetwork | null,
): string {
  switch (status) {
    case "scanning":
      if (!cameraReady) {
        return `🟠 **Camera is loading…**`;
      }
      return `🟢 **Camera is ready**\n\nSimply hold the QR code in front of your camera.`;
    case "found": {
      if (wifi) {
        return [
          `**Wi-Fi Network Found**`,
          `| | |`,
          `|---|---|`,
          `| **Network** | ${wifi.ssid} |`,
          `| **Security** | ${wifi.security.toUpperCase()} |`,
          wifi.hidden ? `| **Hidden** | Yes |` : "",
          ``,
          `Copied to clipboard.`,
        ]
          .filter(Boolean)
          .join("\n");
      }
      return `**QR Code Found!**\n\n\`${decoded}\`\n\nCopied to clipboard.`;
    }
    case "error":
      return `**Error**\n\n${errorMessage}`;
  }
}
