import { Detail, Action, ActionPanel, getPreferenceValues, Clipboard, showHUD, showToast, Toast } from "@raycast/api";
import { useState, useEffect, useRef } from "react";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { Jimp } from "jimp";
import jsQR from "jsqr";

const execFileAsync = promisify(execFile);

const PREVIEW_WIDTH = 320;

interface Preferences {
  warmupDelay: string;
}

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

  // Strip "WIFI:" prefix and trailing ";;"
  const body = text.slice(5).replace(/;;\s*$/, "");
  const params: Record<string, string> = {};

  // Parse key:value pairs separated by ";"
  // Values may contain escaped semicolons (\;)
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
  // Find the Wi-Fi interface name
  const { stdout } = await execFileAsync("/usr/sbin/networksetup", ["-listallhardwareports"]);
  const match = stdout.match(/Hardware Port: Wi-Fi\nDevice: (\w+)/);
  const iface = match ? match[1] : "en0";

  const args = ["-setairportnetwork", iface, network.ssid];
  if (network.password) args.push(network.password);

  await execFileAsync("/usr/sbin/networksetup", args);
}

async function resolveImagesnap(): Promise<string> {
  const { stdout } = await execFileAsync("/bin/zsh", ["-lc", "which imagesnap"]);
  return stdout.trim();
}

export default function Command() {
  const [status, setStatus] = useState<ScanStatus>("scanning");
  const [frameBase64, setFrameBase64] = useState<string>("");
  const [decoded, setDecoded] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    async function scanLoop() {
      const { warmupDelay } = getPreferenceValues<Preferences>();

      let imagesnapPath: string;
      try {
        imagesnapPath = await resolveImagesnap();
      } catch {
        setStatus("error");
        setErrorMessage("imagesnap not found. Install it with: brew install imagesnap");
        return;
      }

      let delay = warmupDelay;

      while (!cancelledRef.current) {
        const tmpFile = `/tmp/raycast-qr-${randomUUID()}.jpg`;

        try {
          await execFileAsync(imagesnapPath, ["-w", delay, tmpFile]);
          if (cancelledRef.current) {
            unlink(tmpFile).catch(() => {});
            return;
          }

          const fileBuffer = await readFile(tmpFile);

          const image = await Jimp.read(fileBuffer);
          const { data, width, height } = image.bitmap;
          const imageData = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
          const result = jsQR(imageData, width, height);

          // Resize for preview (smaller = faster rendering, fits without scrolling)
          const preview = image.clone().resize({ w: PREVIEW_WIDTH });
          const previewBuf = await preview.getBuffer("image/jpeg");
          setFrameBase64(previewBuf.toString("base64"));

          unlink(tmpFile).catch(() => {});

          if (result) {
            await Clipboard.copy(result.data);
            setDecoded(result.data);
            setStatus("found");
            return;
          }
        } catch (error) {
          unlink(tmpFile).catch(() => {});
          if (cancelledRef.current) return;
          setStatus("error");
          setErrorMessage(error instanceof Error ? error.message : String(error));
          return;
        }

        delay = "0";
      }
    }

    scanLoop();

    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const wifi = status === "found" ? parseWifi(decoded) : null;
  const isUrl = status === "found" && looksLikeUrl(decoded);
  const markdown = buildMarkdown(status, frameBase64, decoded, errorMessage, wifi);

  return (
    <Detail
      markdown={markdown}
      actions={
        <ActionPanel>
          {status === "found" && wifi && (
            <Action
              title="Connect to Network"
              onAction={async () => {
                try {
                  await showToast({ style: Toast.Style.Animated, title: `Connecting to ${wifi.ssid}…` });
                  await connectToWifi(wifi);
                  await showHUD(`Connected to ${wifi.ssid}`);
                } catch (error) {
                  await showToast({
                    style: Toast.Style.Failure,
                    title: "Connection failed",
                    message: error instanceof Error ? error.message : String(error),
                  });
                }
              }}
            />
          )}
          {status === "found" && isUrl && <Action.OpenInBrowser url={decoded} />}
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
  frameBase64: string,
  decoded: string,
  errorMessage: string,
  wifi: WifiNetwork | null,
): string {
  switch (status) {
    case "scanning": {
      const frame = frameBase64 ? `![Camera Preview](data:image/jpeg;base64,${frameBase64})\n\n` : "";
      return `${frame}**Scanning…** Point a QR code at your camera.`;
    }
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
