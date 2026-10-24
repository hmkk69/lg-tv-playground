# LG TV Playground

Experimenting with LG webOS TVs using Node.js and [`lgtv2`](https://www.npmjs.com/package/lgtv2).

This project lets you control an LG webOS TV over the local network from a PC:
- `notify.js` sends a toast notification to the TV.
- `remote.js` runs a web-based remote control UI (Express) on port `8787`.

## Requirements

- Node.js 18+
- An LG webOS TV on the same local network as the PC
- TV and PC on the same Wi-Fi/LAN

## Install

```bash
npm install
```

## Usage

### Send a toast notification

```bash
node notify.js
```

Edit `TV_IP` in `notify.js` to match your TV's IP address before running.

### Run the web remote

```bash
node remote.js
```

Then open:

- On the PC: `http://localhost:8787`
- On a phone on the same Wi-Fi: `http://<PC_LAN_IP>:8787`

Enter the TV's IP address in the UI and click **Connect**. The first connection may require accepting a pairing prompt on the TV.

## Features

- D-pad navigation, OK/Back/Home/Menu/Info/Mute
- Volume up/down and mute
- Media controls (play/pause/rewind)
- App list and launch
- HDMI/input switching
- Power status, turn off, Wake-on-LAN
- Open the remote page on the TV browser

## API endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/status` | Connection status, host, volume, power |
| POST | `/api/connect` | Connect to a TV by host |
| POST | `/api/key` | Send a remote key |
| POST | `/api/action` | Run an action (`volume`, `mute`, `apps`, `inputs`, `power`, `off`, `wake`, `youtube`, `browser`) |
| POST | `/api/launch` | Launch an app by id |
| POST | `/api/input` | Switch to an input by id |

## Notes

- Some commands depend on the TV model and webOS firmware.
- Desktop screen mirroring is not provided by the remote API; use Windows `Win + K` (Miracast) or an HDMI cable.
- Only use on a trusted local network.

## License

MIT
