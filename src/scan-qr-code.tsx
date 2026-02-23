import { Detail, Action, ActionPanel, getPreferenceValues, Clipboard, showHUD } from "@raycast/api";
import { useState, useEffect, useRef } from "react";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { Jimp } from "jimp";
import jsQR from "jsqr";

const execFileAsync = promisify(execFile);

interface Preferences {
  warmupDelay: string;
}

type ScanStatus = "scanning" | "found" | "error";

function looksLikeUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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
          setFrameBase64(fileBuffer.toString("base64"));

          const image = await Jimp.read(fileBuffer);
          const { data, width, height } = image.bitmap;
          const imageData = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
          const result = jsQR(imageData, width, height);

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

        // After first capture, camera is warm — no delay needed
        delay = "0";
      }
    }

    scanLoop();

    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const markdown = buildMarkdown(status, frameBase64, decoded, errorMessage);

  return (
    <Detail
      markdown={markdown}
      actions={
        <ActionPanel>
          {status === "found" && looksLikeUrl(decoded) && <Action.OpenInBrowser url={decoded} />}
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

function buildMarkdown(status: ScanStatus, frameBase64: string, decoded: string, errorMessage: string): string {
  const frame = frameBase64 ? `![Camera Preview](data:image/jpeg;base64,${frameBase64})\n\n` : "";

  switch (status) {
    case "scanning":
      return `${frame}**Scanning…** Point a QR code at your camera.`;
    case "found":
      return `${frame}**QR Code Found!**\n\n\`${decoded}\`\n\nCopied to clipboard.`;
    case "error":
      return `**Error**\n\n${errorMessage}`;
  }
}
