# Scope — UseePlus WebUSB viewer

A zero-install, browser-only viewer for UseePlus USB endoscope and microscope
cameras using the Geek szitman `supercamera` chipset.

The page talks directly to the camera with WebUSB. Frames are decoded locally
and never leave the browser.

## Compatible camera

- USB vendor ID: `0x2ce3`
- USB product ID: `0x3828`
- Protocol interface: `1`
- Streaming alternate: `1`
- Bulk endpoints: `0x01` out / `0x81` in
- Start command: `BB AA 05 00 00`
- Stop command: `BB AA 06 00 00`
- Frame format: JPEG data in packets with a 12-byte `AA BB 07…` header
- Physical snapshot button: bit `0x02` in byte 7 of the frame packet header
- Physical lens-switch event: bit `0x20` in byte 7 of the frame packet header
- Camera switch command exposed by some firmware:
  `BB AA 0B 00 02 <camera index> <resolution low> <resolution high>`
- Startup device information: camera count, current index, active resolution, and
  the multi-camera capability flag are read from the `AA BB 05…` reply

This particular dual-lens hardware switches lenses in its inline controller:
short-press the physical camera button for a snapshot, or hold it to switch
lenses. Its firmware does not acknowledge the software camera-switch command,
so the viewer presents the hardware instruction instead of pretending that a
software request succeeded.

## Run locally

WebUSB requires a secure context. `localhost` counts as secure:

```sh
npm run serve
```

Then open <http://localhost:4173> in desktop Chrome or Edge and choose
**Connect camera**. Safari and Firefox do not currently expose WebUSB.

## Publish with GitHub Pages

This project is deliberately build-free. Put these files at the root of a
GitHub repository, enable Pages for the `main` branch in
**Settings → Pages**, and select **Deploy from a branch**.

GitHub Pages serves the site over HTTPS, which satisfies WebUSB's secure-context
requirement.

## Privacy and security

- The device picker is restricted to `2ce3:3828`.
- No analytics, third-party scripts, cookies, account, or network API exists.
- Camera frames remain in memory until drawn and are not uploaded.
- Snapshots are created locally and saved through the browser.

## Protocol credit and license

The protocol implementation is based on the reverse-engineering work in:

- [MAkcanca/useeplus-linux-driver](https://github.com/MAkcanca/useeplus-linux-driver)
- [linus-skold/useeplus-windows-viewer](https://github.com/linus-skold/useeplus-windows-viewer)

Because the reference implementations are GPLv3, this adaptation is released
under GPL-3.0-or-later. See `LICENSE`.
