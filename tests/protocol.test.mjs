import assert from "node:assert/strict";
import test from "node:test";

import {
  USEEPLUS_USB,
  UseeplusFrameParser,
  createCameraSwitchCommand,
} from "../protocol.js";

function packet(payload, controls = 0) {
  const bytes = new Uint8Array(USEEPLUS_USB.packetHeaderSize + payload.length);
  bytes.set([0xaa, 0xbb, 0x07], 0);
  bytes[USEEPLUS_USB.controlsByteOffset] = controls;
  bytes.set(payload, USEEPLUS_USB.packetHeaderSize);
  return bytes;
}

function fakeJpeg(bodySize = 1000) {
  const jpeg = new Uint8Array(bodySize + 4);
  jpeg.set([0xff, 0xd8], 0);
  jpeg.fill(0x31, 2, jpeg.length - 2);
  jpeg.set([0xff, 0xd9], jpeg.length - 2);
  return jpeg;
}

test("assembles a JPEG split across protocol packets", () => {
  const frames = [];
  const jpeg = fakeJpeg();
  const parser = new UseeplusFrameParser({ onFrame: (frame) => frames.push(frame) });

  parser.pushTransfer(packet(jpeg.subarray(0, 350)));
  parser.pushTransfer(packet(jpeg.subarray(350, 800)));
  parser.pushTransfer(packet(jpeg.subarray(800)));

  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], jpeg);
});

test("ignores transfers without the proprietary header", () => {
  let ignored = 0;
  const parser = new UseeplusFrameParser({ onPacketIgnored: () => ignored++ });
  parser.pushTransfer(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal(ignored, 1);
});

test("drops an incomplete frame when a new JPEG starts", () => {
  const frames = [];
  const complete = fakeJpeg();
  const parser = new UseeplusFrameParser({ onFrame: (frame) => frames.push(frame) });

  parser.pushTransfer(packet(new Uint8Array([0xff, 0xd8, 1, 2, 3])));
  parser.pushTransfer(packet(complete));

  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], complete);
});

test("uses the vendor start and stop commands for camera type 1", () => {
  assert.deepEqual(
    [...USEEPLUS_USB.startCommand],
    [0xbb, 0xaa, 0x05, 0x00, 0x00],
  );
  assert.deepEqual(
    [...USEEPLUS_USB.stopCommand],
    [0xbb, 0xaa, 0x06, 0x00, 0x00],
  );
});

test("reports a physical snapshot button on the rising edge of header bit 1", () => {
  let presses = 0;
  const parser = new UseeplusFrameParser({
    onSnapshotButton: () => presses++,
    minimumFrameSize: 1,
  });
  const payload = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

  parser.pushTransfer(packet(payload, 0x02));
  parser.pushTransfer(packet(payload, 0x02));
  parser.pushTransfer(packet(payload, 0x00));
  parser.pushTransfer(packet(payload, 0x02));

  assert.equal(presses, 2);
});

test("reports the physical lens-switch signal on the rising edge of header bit 5", () => {
  let switches = 0;
  const parser = new UseeplusFrameParser({
    onLensSwitchButton: () => switches++,
    minimumFrameSize: 1,
  });
  const payload = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

  parser.pushTransfer(packet(payload, 0x20));
  parser.pushTransfer(packet(payload, 0x20));
  parser.pushTransfer(packet(payload, 0x00));
  parser.pushTransfer(packet(payload, 0x20));

  assert.equal(switches, 2);
});

test("builds the vendor dual-camera command", () => {
  assert.deepEqual(
    [...createCameraSwitchCommand(1, 0x04)],
    [0xbb, 0xaa, 0x0b, 0x00, 0x02, 0x01, 0x04, 0x00],
  );
  assert.throws(() => createCameraSwitchCommand(-1), RangeError);
  assert.throws(() => createCameraSwitchCommand(256), RangeError);
});

test("parses a camera-switch acknowledgement", () => {
  let cameraState = null;
  const parser = new UseeplusFrameParser({
    onCameraState: (state) => {
      cameraState = state;
    },
  });
  parser.pushTransfer(
    new Uint8Array([0xaa, 0xbb, 0x0b, 0x03, 0x00, 0x00, 0x01, 0x04, 0x00]),
  );

  assert.deepEqual(cameraState, { cameraIndex: 1, resolutionCode: 0x04 });
  assert.equal(parser.ignoredPackets, 0);
});

test("finds a camera-switch acknowledgement inside a larger USB transfer", () => {
  let cameraState = null;
  const parser = new UseeplusFrameParser({
    onCameraState: (state) => {
      cameraState = state;
    },
  });
  parser.pushTransfer(
    new Uint8Array([
      0x31,
      0x32,
      0x33,
      0xaa,
      0xbb,
      0x0b,
      0x03,
      0x00,
      0x00,
      0x02,
      0x08,
      0x00,
      0x34,
    ]),
  );

  assert.deepEqual(cameraState, { cameraIndex: 2, resolutionCode: 0x08 });
  assert.equal(parser.ignoredPackets, 0);
});

test("parses startup device information", () => {
  let deviceInfo = null;
  const payload = new Uint8Array(0x62);
  payload[74] = 2;
  payload[75] = 1;
  payload[76] = 0x08;
  payload.set([0x01, 0x04, 0x08], 78);
  payload[94] = 0x02;

  const response = new Uint8Array(6 + payload.length);
  response.set([0xaa, 0xbb, 0x05, 0x62, 0x00, 0x00]);
  response.set(payload, 6);

  const parser = new UseeplusFrameParser({
    onDeviceInfo: (info) => {
      deviceInfo = info;
    },
  });
  parser.pushTransfer(response);

  assert.deepEqual(deviceInfo, {
    cameraCount: 2,
    cameraIndex: 1,
    resolutionCode: 0x08,
    resolutionCodes: [0x01, 0x04, 0x08],
    capacity: 0x02,
    supportsMultipleCameras: true,
  });
  assert.equal(parser.ignoredPackets, 0);
});
