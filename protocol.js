/**
 * UseePlus WebUSB protocol helpers.
 *
 * Derived from the USB protocol documented by MAkcanca/useeplus-linux-driver
 * and linus-skold/useeplus-windows-viewer. This adaptation was created in 2026.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const USEEPLUS_USB = Object.freeze({
  vendorId: 0x2ce3,
  productId: 0x3828,
  configuration: 1,
  interfaceNumber: 1,
  idleAlternate: 0,
  streamingAlternate: 1,
  endpointIn: 1,
  endpointOut: 1,
  transferSize: 64 * 1024,
  packetHeaderSize: 12,
  controlsByteOffset: 7,
  snapshotButtonMask: 0x02,
  lensSwitchButtonMask: 0x20,
  startCommand: new Uint8Array([0xbb, 0xaa, 0x05, 0x00, 0x00]),
  stopCommand: new Uint8Array([0xbb, 0xaa, 0x06, 0x00, 0x00]),
});

export const USEEPLUS_RESOLUTION_CODES = Object.freeze({
  "320x240": 0x01,
  "480x480": 0x02,
  "640x480": 0x04,
  "1280x720": 0x08,
  "1280x960": 0x10,
  "1920x1080": 0x20,
  "1920x1440": 0x40,
  "2592x1944": 0x80,
});

const JPEG_SOI = [0xff, 0xd8];
const JPEG_EOI = [0xff, 0xd9];
const PACKET_PREFIX = [0xaa, 0xbb, 0x07];
const CONTROL_PREFIXES = [
  [0xaa, 0xbb],
  [0xbb, 0xaa],
];
const DEVICE_INFO_TYPE = 0x05;
const CAMERA_STATE_TYPE = 0x0b;
const DEVICE_INFO_SIZE = 0x62;

function findPair(bytes, pair, startAt = 0) {
  for (let index = Math.max(0, startAt); index < bytes.length - 1; index += 1) {
    if (bytes[index] === pair[0] && bytes[index + 1] === pair[1]) {
      return index;
    }
  }
  return -1;
}

function startsWith(bytes, prefix) {
  return prefix.every((value, index) => bytes[index] === value);
}

function joinBytes(left, right) {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

export function createCameraSwitchCommand(cameraIndex, resolutionCode = 0x04) {
  if (!Number.isInteger(cameraIndex) || cameraIndex < 0 || cameraIndex > 0xff) {
    throw new RangeError("Camera index must fit in one byte.");
  }
  if (
    !Number.isInteger(resolutionCode) ||
    resolutionCode < 0 ||
    resolutionCode > 0xffff
  ) {
    throw new RangeError("Resolution code must fit in two bytes.");
  }

  return new Uint8Array([
    0xbb,
    0xaa,
    0x0b,
    0x00,
    0x02,
    cameraIndex,
    resolutionCode & 0xff,
    resolutionCode >> 8,
  ]);
}

function parseDeviceInfo(payload) {
  const resolutionCodes = [...payload.subarray(78, 86)].filter(Boolean);
  const capacity =
    payload[94] |
    (payload[95] << 8) |
    (payload[96] << 16) |
    (payload[97] << 24);

  return {
    cameraCount: payload[74],
    cameraIndex: payload[75],
    resolutionCode: payload[76] | (payload[77] << 8),
    resolutionCodes,
    capacity: capacity >>> 0,
    supportsMultipleCameras: Boolean(capacity & 0x02),
  };
}

export class UseeplusFrameParser {
  constructor({
    onFrame,
    onSnapshotButton,
    onLensSwitchButton,
    onDeviceInfo,
    onCameraState,
    onPacketIgnored,
    minimumFrameSize = 1000,
    maximumFrameSize = 2 * 1024 * 1024,
  } = {}) {
    this.onFrame = onFrame ?? (() => {});
    this.onSnapshotButton = onSnapshotButton ?? (() => {});
    this.onLensSwitchButton = onLensSwitchButton ?? (() => {});
    this.onDeviceInfo = onDeviceInfo ?? (() => {});
    this.onCameraState = onCameraState ?? (() => {});
    this.onPacketIgnored = onPacketIgnored ?? (() => {});
    this.minimumFrameSize = minimumFrameSize;
    this.maximumFrameSize = maximumFrameSize;
    this.currentFrame = new Uint8Array();
    this.snapshotButtonDown = false;
    this.lensSwitchButtonDown = false;
    this.packets = 0;
    this.ignoredPackets = 0;
  }

  reset() {
    this.currentFrame = new Uint8Array();
    this.snapshotButtonDown = false;
    this.lensSwitchButtonDown = false;
    this.packets = 0;
    this.ignoredPackets = 0;
  }

  pushTransfer(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.packets += 1;

    const foundControlPacket = this.scanControlPackets(bytes);
    const isFramePacket = startsWith(bytes, PACKET_PREFIX);

    if (bytes.length <= USEEPLUS_USB.packetHeaderSize || !isFramePacket) {
      if (!foundControlPacket) {
        this.ignoredPackets += 1;
        this.onPacketIgnored(bytes);
      }
      return;
    }

    const controls = bytes[USEEPLUS_USB.controlsByteOffset];
    const snapshotButtonDown = Boolean(controls & USEEPLUS_USB.snapshotButtonMask);
    if (snapshotButtonDown && !this.snapshotButtonDown) {
      this.onSnapshotButton();
    }
    this.snapshotButtonDown = snapshotButtonDown;

    const lensSwitchButtonDown = Boolean(
      controls & USEEPLUS_USB.lensSwitchButtonMask,
    );
    if (lensSwitchButtonDown && !this.lensSwitchButtonDown) {
      this.onLensSwitchButton();
    }
    this.lensSwitchButtonDown = lensSwitchButtonDown;

    this.pushPayload(bytes.subarray(USEEPLUS_USB.packetHeaderSize));
  }

  scanControlPackets(bytes) {
    let found = false;

    for (let offset = 0; offset <= bytes.length - 6; offset += 1) {
      const hasPrefix = CONTROL_PREFIXES.some(
        ([first, second]) => bytes[offset] === first && bytes[offset + 1] === second,
      );
      if (!hasPrefix) continue;

      const type = bytes[offset + 2];
      const payloadLength = bytes[offset + 3] | (bytes[offset + 4] << 8);
      const payloadOffset = offset + 6;
      const payloadEnd = payloadOffset + payloadLength;
      if (payloadEnd > bytes.length) continue;

      if (type === DEVICE_INFO_TYPE && payloadLength >= DEVICE_INFO_SIZE) {
        this.onDeviceInfo(
          parseDeviceInfo(bytes.subarray(payloadOffset, payloadOffset + DEVICE_INFO_SIZE)),
        );
        found = true;
        offset = payloadEnd - 1;
      } else if (type === CAMERA_STATE_TYPE && payloadLength >= 3) {
        this.onCameraState({
          cameraIndex: bytes[payloadOffset],
          resolutionCode: bytes[payloadOffset + 1] | (bytes[payloadOffset + 2] << 8),
        });
        found = true;
        offset = payloadEnd - 1;
      }
    }

    return found;
  }

  pushPayload(payload) {
    if (!payload.length) return;

    if (payload[0] === JPEG_SOI[0] && payload[1] === JPEG_SOI[1]) {
      // The device starts each JPEG at the beginning of a protocol payload.
      this.currentFrame = payload.slice();
    } else if (this.currentFrame.length) {
      this.currentFrame = joinBytes(this.currentFrame, payload);
    } else {
      // On a mid-stream connection, discard bytes until the next SOI.
      const soiIndex = findPair(payload, JPEG_SOI);
      if (soiIndex < 0) return;
      this.currentFrame = payload.slice(soiIndex);
    }

    if (this.currentFrame.length > this.maximumFrameSize) {
      this.currentFrame = new Uint8Array();
      return;
    }

    const eoiIndex = findPair(this.currentFrame, JPEG_EOI, 2);
    if (eoiIndex < 0) return;

    const frameEnd = eoiIndex + 2;
    const frame = this.currentFrame.slice(0, frameEnd);
    const leftover = this.currentFrame.slice(frameEnd);
    this.currentFrame = new Uint8Array();

    if (
      frame.length >= this.minimumFrameSize &&
      frame[0] === JPEG_SOI[0] &&
      frame[1] === JPEG_SOI[1]
    ) {
      this.onFrame(frame);
    }

    if (leftover.length) this.pushPayload(leftover);
  }
}
