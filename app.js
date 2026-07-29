/**
 * Scope — browser-only UseePlus camera viewer.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  USEEPLUS_USB,
  UseeplusFrameParser,
} from "./protocol.js?v=20260729-3";

const elements = {
  viewer: document.querySelector("#viewer"),
  canvas: document.querySelector("#frameCanvas"),
  emptyState: document.querySelector("#emptyState"),
  stateDot: document.querySelector("#stateDot"),
  connectionLabel: document.querySelector("#connectionLabel"),
  connectButton: document.querySelector("#connectButton"),
  heroConnectButton: document.querySelector("#heroConnectButton"),
  compatibilityNote: document.querySelector("#compatibilityNote"),
  snapshotButton: document.querySelector("#snapshotButton"),
  cameraSwitchButton: document.querySelector("#cameraSwitchButton"),
  cameraSwitchLabel: document.querySelector("#cameraSwitchLabel"),
  fullscreenButton: document.querySelector("#fullscreenButton"),
  fitButton: document.querySelector("#fitButton"),
  fitButtonLabel: document.querySelector("#fitButtonLabel"),
  mirrorButton: document.querySelector("#mirrorButton"),
  rotateButton: document.querySelector("#rotateButton"),
  diagnosticsButton: document.querySelector("#diagnosticsButton"),
  diagnostics: document.querySelector("#diagnostics"),
  diagnosticLog: document.querySelector("#diagnosticLog"),
  copyLogButton: document.querySelector("#copyLogButton"),
  viewerHudTop: document.querySelector("#viewerHudTop"),
  viewerHudBottom: document.querySelector("#viewerHudBottom"),
  resolutionLabel: document.querySelector("#resolutionLabel"),
  fpsValue: document.querySelector("#fpsValue"),
  framesValue: document.querySelector("#framesValue"),
  transferValue: document.querySelector("#transferValue"),
  toast: document.querySelector("#toast"),
};

const context = elements.canvas.getContext("2d", { alpha: false });

let device = null;
let isStreaming = false;
let streamToken = 0;
let frameCount = 0;
let byteCount = 0;
let statsFrameMark = 0;
let statsByteMark = 0;
let statsTimeMark = performance.now();
let rotation = 0;
let mirrored = false;
let toastTimer = null;
let invalidPacketReports = 0;
let recoveryAttempts = 0;
let hardwareSnapshotPending = false;
let lastHardwareSnapshotAt = -Infinity;

const parser = new UseeplusFrameParser({
  onFrame: displayFrame,
  onSnapshotButton: () => {
    const now = performance.now();
    if (now - lastHardwareSnapshotAt < 500) return;
    lastHardwareSnapshotAt = now;
    hardwareSnapshotPending = true;
    log("Physical snapshot button pressed.");
  },
  onLensSwitchButton: () => {
    showToast("Lens switched.");
    log("Physical lens-switch event received.");
  },
  onDeviceInfo: (info) => {
    const supportedCodes = info.resolutionCodes.length
      ? info.resolutionCodes
          .map((code) => `0x${code.toString(16).padStart(2, "0")}`)
          .join(", ")
      : "not reported";
    log(
      `Device info: ${info.cameraCount} camera(s), current index ${info.cameraIndex}, ` +
        `resolution code 0x${info.resolutionCode.toString(16).padStart(2, "0")}, ` +
        `capabilities 0x${info.capacity.toString(16).padStart(2, "0")}, ` +
        `resolution list ${supportedCodes}.`,
    );
    if (info.cameraCount < 2 || !info.supportsMultipleCameras) {
      log(
        "The firmware information does not advertise multi-camera switching; an attempt is still allowed.",
        "warn",
      );
    }
  },
  onCameraState: ({ cameraIndex, resolutionCode }) => {
    log(
      `Camera acknowledged index ${cameraIndex}, resolution code ` +
        `0x${resolutionCode.toString(16).padStart(2, "0")}.`,
    );
  },
  onPacketIgnored: (bytes) => {
    invalidPacketReports += 1;
    if (invalidPacketReports <= 4) {
      log(`Ignored packet without a recognized UseePlus header (${bytes.length} bytes).`);
    }
  },
});

function timestamp() {
  return new Date().toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

function log(message, level = "info") {
  const prefix = level === "error" ? "ERROR" : level === "warn" ? "WARN " : "INFO ";
  elements.diagnosticLog.textContent += `[${timestamp()}] ${prefix}  ${message}\n`;
  elements.diagnosticLog.scrollTop = elements.diagnosticLog.scrollHeight;
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 2200);
}

function describeError(error) {
  if (error?.name === "NotFoundError") return "No camera selected.";
  if (error?.name === "SecurityError") {
    return "USB access was blocked. Use Chrome or Edge on HTTPS or localhost.";
  }
  if (error?.name === "NetworkError") {
    return "The camera interface is busy or unavailable. Close other camera tools and reconnect it.";
  }
  return error?.message || String(error);
}

function setConnectionState(state, label) {
  elements.stateDot.classList.toggle("is-live", state === "live");
  elements.stateDot.classList.toggle("is-error", state === "error");
  elements.connectionLabel.textContent = label;
}

function setControlsEnabled(enabled) {
  [
    elements.snapshotButton,
    elements.cameraSwitchButton,
    elements.fullscreenButton,
    elements.fitButton,
    elements.mirrorButton,
    elements.rotateButton,
  ].forEach((button) => {
    button.disabled = !enabled;
  });
}

function updateCameraSwitchLabel() {
  elements.cameraSwitchLabel.textContent = "Switch lens";
  elements.cameraSwitchButton.setAttribute(
    "aria-label",
    "How to switch between the camera lenses",
  );
  elements.cameraSwitchButton.title =
    "Hold the physical camera button to switch lenses";
}

function updateCanvasTransform() {
  const scaleX = mirrored ? -1 : 1;
  elements.canvas.style.transform = `rotate(${rotation}deg) scaleX(${scaleX})`;
  elements.mirrorButton.classList.toggle("is-active", mirrored);
  elements.rotateButton.classList.toggle("is-active", rotation !== 0);
}

async function connect() {
  if (!("usb" in navigator)) {
    const message = "WebUSB is unavailable in this browser. Open this page in desktop Chrome or Edge.";
    setConnectionState("error", "Browser unsupported");
    showToast(message);
    log(message, "error");
    return;
  }

  if (device) {
    await disconnect();
    return;
  }

  try {
    setConnectionState("busy", "Waiting for permission");
    elements.connectButton.disabled = true;
    elements.heroConnectButton.disabled = true;
    const permittedDevices = await navigator.usb.getDevices();
    device = permittedDevices.find(
      (candidate) =>
        candidate.vendorId === USEEPLUS_USB.vendorId &&
        candidate.productId === USEEPLUS_USB.productId,
    );

    if (device) {
      log("Reusing the existing browser permission for this camera.");
    } else {
      log("Opening the browser's USB device picker.");
      device = await navigator.usb.requestDevice({
        filters: [
          {
            vendorId: USEEPLUS_USB.vendorId,
            productId: USEEPLUS_USB.productId,
          },
        ],
      });
    }

    log(
      `Selected ${device.manufacturerName || "UseePlus"} ${device.productName || "camera"} ` +
        `(${device.vendorId.toString(16).padStart(4, "0")}:${device.productId
          .toString(16)
          .padStart(4, "0")}).`,
    );

    await device.open();
    if (!device.configuration) {
      await device.selectConfiguration(USEEPLUS_USB.configuration);
    }

    await device.claimInterface(USEEPLUS_USB.interfaceNumber);
    log(`Claimed interface ${USEEPLUS_USB.interfaceNumber}.`);

    recoveryAttempts = 0;
    await startStreaming();
  } catch (error) {
    const message = describeError(error);
    if (error?.name !== "NotFoundError") {
      setConnectionState("error", "Connection failed");
      showToast(message);
      log(message, "error");
      await closeDeviceQuietly();
    } else {
      setConnectionState("idle", "Camera offline");
      log(message, "warn");
      device = null;
    }
  } finally {
    elements.connectButton.disabled = false;
    elements.heroConnectButton.disabled = false;
  }
}

async function startStreaming() {
  parser.reset();
  invalidPacketReports = 0;
  frameCount = 0;
  byteCount = 0;
  statsFrameMark = 0;
  statsByteMark = 0;
  statsTimeMark = performance.now();
  hardwareSnapshotPending = false;
  lastHardwareSnapshotAt = -Infinity;
  updateCameraSwitchLabel();

  await device.selectAlternateInterface(
    USEEPLUS_USB.interfaceNumber,
    USEEPLUS_USB.idleAlternate,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  await device.selectAlternateInterface(
    USEEPLUS_USB.interfaceNumber,
    USEEPLUS_USB.streamingAlternate,
  );
  log(`Selected streaming alternate ${USEEPLUS_USB.streamingAlternate}.`);

  const result = await device.transferOut(
    USEEPLUS_USB.endpointOut,
    USEEPLUS_USB.startCommand,
  );
  if (result.status !== "ok" || result.bytesWritten !== USEEPLUS_USB.startCommand.length) {
    throw new Error(`Camera start command failed (${result.status}).`);
  }

  log("Sent start command BB AA 05 00 00.");
  isStreaming = true;
  streamToken += 1;
  const token = streamToken;

  elements.viewer.classList.add("is-streaming");
  elements.viewerHudTop.hidden = false;
  elements.viewerHudBottom.hidden = false;
  elements.connectButton.textContent = "Disconnect";
  setConnectionState("live", "Camera live");
  setControlsEnabled(true);

  void readLoop(token);
  setTimeout(() => {
    if (isStreaming && token === streamToken && frameCount === 0) {
      void recoverStaleStream(token);
    }
  }, 3000);
}

async function recoverStaleStream(token) {
  if (!device?.opened || token !== streamToken || frameCount > 0) return;

  if (recoveryAttempts >= 1) {
    const message = "The camera stopped responding. Unplug it once, reconnect it, and try again.";
    log(message, "error");
    showToast(message);
    setConnectionState("error", "Camera not responding");
    await disconnect();
    return;
  }

  recoveryAttempts += 1;
  isStreaming = false;
  streamToken += 1;
  setConnectionState("busy", "Restarting camera");
  log("No frames arrived; sending the vendor stop command to clear stale USB state.", "warn");

  try {
    await device.transferOut(
      USEEPLUS_USB.endpointOut,
      USEEPLUS_USB.stopCommand,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    await device.selectAlternateInterface(
      USEEPLUS_USB.interfaceNumber,
      USEEPLUS_USB.idleAlternate,
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    log("Sent stop command BB AA 06 00 00; restarting the stream.");
    await startStreaming();
  } catch (error) {
    const message = `Automatic stream restart failed: ${describeError(error)}`;
    log(message, "error");
    showToast(message);
    setConnectionState("error", "Restart failed");
    await disconnect();
  }
}

async function readLoop(token) {
  log(`Reading JPEG packets from bulk endpoint 0x8${USEEPLUS_USB.endpointIn}.`);

  while (isStreaming && device?.opened && token === streamToken) {
    try {
      const result = await device.transferIn(
        USEEPLUS_USB.endpointIn,
        USEEPLUS_USB.transferSize,
      );

      if (result.status === "stall") {
        log("Input endpoint stalled; clearing halt.", "warn");
        await device.clearHalt("in", USEEPLUS_USB.endpointIn);
        continue;
      }

      if (result.status !== "ok" || !result.data?.byteLength) continue;

      const bytes = new Uint8Array(
        result.data.buffer,
        result.data.byteOffset,
        result.data.byteLength,
      );
      byteCount += bytes.byteLength;
      parser.pushTransfer(bytes);
    } catch (error) {
      if (!isStreaming || token !== streamToken) return;
      log(describeError(error), "error");
      setConnectionState("error", "Stream interrupted");
      showToast("The camera stream stopped.");
      await disconnect();
      return;
    }
  }
}

async function displayFrame(jpegBytes) {
  const blob = new Blob([jpegBytes], { type: "image/jpeg" });

  try {
    const bitmap = await createImageBitmap(blob);
    if (elements.canvas.width !== bitmap.width || elements.canvas.height !== bitmap.height) {
      elements.canvas.width = bitmap.width;
      elements.canvas.height = bitmap.height;
      elements.resolutionLabel.textContent = `${bitmap.width} × ${bitmap.height}`;
      log(`Frame geometry: ${bitmap.width} × ${bitmap.height}.`);
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    frameCount += 1;
    elements.framesValue.textContent = frameCount.toLocaleString();
    updateStats();

    if (hardwareSnapshotPending) {
      hardwareSnapshotPending = false;
      takeSnapshot("hardware");
    }
  } catch (error) {
    log(`JPEG decode failed: ${describeError(error)}`, "warn");
  }
}

function updateStats() {
  const now = performance.now();
  const elapsed = now - statsTimeMark;
  if (elapsed < 750) return;

  const seconds = elapsed / 1000;
  const fps = (frameCount - statsFrameMark) / seconds;
  const bytesPerSecond = (byteCount - statsByteMark) / seconds;

  elements.fpsValue.textContent = `${fps.toFixed(1)} fps`;
  elements.transferValue.textContent =
    bytesPerSecond >= 1024 * 1024
      ? `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`
      : `${Math.round(bytesPerSecond / 1024)} KB/s`;

  statsFrameMark = frameCount;
  statsByteMark = byteCount;
  statsTimeMark = now;
}

async function closeDeviceQuietly() {
  if (!device) return;
  try {
    if (device.opened) {
      try {
        await device.transferOut(
          USEEPLUS_USB.endpointOut,
          USEEPLUS_USB.stopCommand,
        );
        await new Promise((resolve) => setTimeout(resolve, 60));
        log("Sent stop command BB AA 06 00 00.");
      } catch {
        // The endpoint may already be unavailable after an unplug.
      }

      try {
        await device.selectAlternateInterface(
          USEEPLUS_USB.interfaceNumber,
          USEEPLUS_USB.idleAlternate,
        );
        await device.releaseInterface(USEEPLUS_USB.interfaceNumber);
      } catch {
        // Releasing is best-effort when the device has already gone away.
      }
      await device.close();
    }
  } catch {
    // Closing is best-effort; unplugged devices will reject here.
  }
  device = null;
}

async function disconnect() {
  if (!device) return;

  isStreaming = false;
  streamToken += 1;
  setConnectionState("busy", "Disconnecting");
  log("Stopping stream and releasing the camera.");
  await closeDeviceQuietly();

  parser.reset();
  hardwareSnapshotPending = false;
  updateCameraSwitchLabel();
  setControlsEnabled(false);
  elements.viewer.classList.remove("is-streaming");
  elements.viewerHudTop.hidden = true;
  elements.viewerHudBottom.hidden = true;
  elements.connectButton.textContent = "Connect camera";
  setConnectionState("idle", "Camera offline");
  log("Camera disconnected.");
}

function takeSnapshot(source = "screen") {
  if (!frameCount) {
    showToast("No frame is ready yet.");
    return;
  }

  elements.canvas.toBlob(
    (blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
      link.href = url;
      link.download = `useeplus-${stamp}.jpg`;
      link.click();
      URL.revokeObjectURL(url);
      showToast("Snapshot saved.");
      log(source === "hardware" ? "Saved a snapshot from the physical button." : "Saved a snapshot.");
    },
    "image/jpeg",
    0.96,
  );
}

function showLensSwitchHelp() {
  if (!device?.opened || !isStreaming) return;
  const message = "Hold the camera’s physical button to switch lenses.";
  showToast(message);
  log(message);
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await elements.viewer.requestFullscreen();
    }
  } catch (error) {
    showToast(describeError(error));
  }
}

function toggleFit() {
  const isCover = elements.viewer.classList.toggle("is-cover");
  elements.fitButton.classList.toggle("is-active", isCover);
  elements.fitButtonLabel.textContent = isCover ? "Fill" : "Fit";
}

function toggleMirror() {
  mirrored = !mirrored;
  updateCanvasTransform();
}

function rotateCanvas() {
  rotation = (rotation + 90) % 360;
  updateCanvasTransform();
}

function toggleDiagnostics() {
  const isOpen = elements.diagnostics.hidden;
  elements.diagnostics.hidden = !isOpen;
  elements.diagnosticsButton.classList.toggle("is-active", isOpen);
  elements.diagnosticsButton.setAttribute("aria-expanded", String(isOpen));
}

async function copyDiagnostics() {
  try {
    await navigator.clipboard.writeText(elements.diagnosticLog.textContent);
    showToast("Diagnostics copied.");
  } catch {
    showToast("Could not copy the log.");
  }
}

elements.connectButton.addEventListener("click", connect);
elements.heroConnectButton.addEventListener("click", connect);
elements.snapshotButton.addEventListener("click", () => takeSnapshot());
elements.cameraSwitchButton.addEventListener("click", showLensSwitchHelp);
elements.fullscreenButton.addEventListener("click", toggleFullscreen);
elements.fitButton.addEventListener("click", toggleFit);
elements.mirrorButton.addEventListener("click", toggleMirror);
elements.rotateButton.addEventListener("click", rotateCanvas);
elements.diagnosticsButton.addEventListener("click", toggleDiagnostics);
elements.copyLogButton.addEventListener("click", copyDiagnostics);

if ("usb" in navigator) {
  navigator.usb.addEventListener("disconnect", (event) => {
    if (device && event.device === device) {
      log("USB disconnect event received.", "warn");
      void disconnect();
    }
  });
  log("WebUSB available. Ready for UseePlus 2CE3:3828.");
} else {
  elements.compatibilityNote.textContent =
    "This browser has no WebUSB support. Use desktop Chrome or Edge.";
  elements.compatibilityNote.classList.add("is-error");
  setConnectionState("error", "Browser unsupported");
  log("WebUSB is not available in this browser.", "error");
}

window.addEventListener("beforeunload", () => {
  isStreaming = false;
  if (device?.opened) {
    void device
      .transferOut(USEEPLUS_USB.endpointOut, USEEPLUS_USB.stopCommand)
      .finally(() => device?.close());
  }
});

updateCameraSwitchLabel();
