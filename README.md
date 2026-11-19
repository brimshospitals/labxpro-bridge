# LabXpro Bridge

Sends results from lab analyzers to [LabXpro](https://www.labxpro.in). It runs on the Windows computer the analyzers are connected to.

- **Wires:** serial (RS-232 or a USB-serial cable) and LAN (TCP, as server or client).
- **Protocols:** ASTM E1381/E1394, HL7 v2 over MLLP, and plain-text print-outs from semi-auto analyzers.
- **Host query:** when the analyzer scans a tube, it asks LabXpro which tests to run.
- **Internet cuts:** results wait on disk and are sent when the connection is back. Each result is stored once.
- **Status page:** http://localhost:4545 on that computer. The raw analyzer log is kept for setting up test codes.

## Install on the lab computer

1. Download **LabXpro-Bridge.zip** from the [latest release](https://github.com/brimshospitals/labxpro-bridge/releases/latest) and unzip it, for example to `C:\LabXpro-Bridge`. Node is included, so nothing else needs installing.
2. In LabXpro, go to **Machines → Add a machine** and copy the machine key.
3. Copy `bridge.config.example.json` to `bridge.config.json` and paste the keys, one per analyzer.
4. Double-click `start-bridge.bat` and check http://localhost:4545.
5. Right-click `install-autostart.ps1` and choose **Run with PowerShell** as Administrator. The bridge then starts with Windows.

The full steps are in `README.txt` inside the zip.

## Develop

```
npm install
npm test           # protocol tests and a pretend analyzer over TCP
npm run package    # dist/LabXpro-Bridge.zip (Windows x64, bundles this node.exe)
node tools/analyzer.js astm --port 5100 --sample 261119001A --values "WBC=7.8,HGB=13.5"
```

The source of truth is `lims/bridge` in the LabXpro repository. This repository is a published copy.
