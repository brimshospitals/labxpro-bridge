LabXpro Bridge
==============
Sends results from your lab analyzers to LabXpro. Install it on the computer the analyzers
are connected to (serial / USB-serial cable or LAN). Keep that computer on during lab hours.

1. In LabXpro: Machines > Add a machine. Copy the machine key (shown once).
2. In this folder: copy bridge.config.example.json to bridge.config.json and open it in Notepad.
   Paste one key per analyzer. "server" is your LabXpro address (https://www.labxpro.in).
   The port, speed and protocol come from LabXpro (Machines > Set up). To use another COM port
   on this computer only, add  "connection": { "port": "COM4" }  next to that key.
3. Double-click start-bridge.bat to try it. Open http://localhost:4545 to see each machine.
4. When it works: right-click install-autostart.ps1 > Run with PowerShell (as Administrator).
   The bridge then starts with Windows and restarts by itself.

On the analyzer: switch on "LIS" / "Host" output, set the same speed (baud) or LAN port,
and use the sample ID printed on the tube label (e.g. 261119001A).

If the internet goes off, results wait in the data\queue folder and are sent when it is back.
The logs folder keeps a daily log and a raw log of what each analyzer sent (for setting up codes).

Try without an analyzer (LAN machines):  node.exe tools\analyzer.js astm --port 5100 --sample 261119001A --values "WBC=7.8,HGB=13.5"
