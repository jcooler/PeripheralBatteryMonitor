import { spawn } from "node:child_process";
import type { BatteryInfo } from "../types";

/** Discrete level (0-3) → percentage approximation for display */
const LEVEL_PCT = [10, 33, 66, 100];

interface XboxControllerStatus {
  index: number;
  connected: boolean;
  batteryType: number; // 0=disconnected 1=wired 2=alkaline 3=NiMH 0xFF=unknown
  batteryLevel: number; // 0=empty 1=low 2=medium 3=full
}

/**
 * Xbox controller battery via XInput (Windows only).
 * Reads up to 4 wireless controllers connected via USB dongle.
 */
export class XboxClient {
  private cached: XboxControllerStatus[] = [];

  async initialize(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    const status = await this.queryControllers();
    this.cached = status;
    return status.some((c) => c.connected);
  }

  /** Query all 4 XInput slots via PowerShell */
  private queryControllers(): Promise<XboxControllerStatus[]> {
    return new Promise((resolve) => {
      const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class XI {
    [DllImport("XInput1_4.dll")]
    public static extern uint XInputGetBatteryInformation(uint i, byte t, out byte bt, out byte bl);
    [DllImport("XInput1_4.dll")]
    public static extern uint XInputGetState(uint i, IntPtr p);
}
'@ -ErrorAction Stop

$results = @()
for ($i = 0; $i -lt 4; $i++) {
  $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(16)
  $s = [XI]::XInputGetState($i, $buf)
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
  $connected = ($s -eq 0)
  [byte]$bt = 0
  [byte]$bl = 0
  if ($connected) {
    [XI]::XInputGetBatteryInformation($i, 0, [ref]$bt, [ref]$bl) | Out-Null
  }
  $results += [PSCustomObject]@{ index = $i; connected = $connected; batteryType = [int]$bt; batteryLevel = [int]$bl }
}
$results | ConvertTo-Json -Compress
`;
      const ps = spawn(
        "powershell.exe",
        ["-ExecutionPolicy", "Bypass", "-NoProfile", "-Command", script],
        { windowsHide: true }
      );
      let output = "";
      ps.stdout.on("data", (d) => { output += d.toString(); });
      ps.on("close", () => {
        try {
          const trimmed = output.trim();
          if (!trimmed) return resolve([]);
          const parsed = JSON.parse(trimmed);
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch {
          resolve([]);
        }
      });
      ps.on("error", () => resolve([]));
      // Timeout after 5s
      setTimeout(() => { try { ps.kill(); } catch {} resolve([]); }, 5000);
    });
  }

  async getDevices(): Promise<XboxControllerStatus[]> {
    const status = await this.queryControllers();
    this.cached = status;
    return status.filter((c) => c.connected);
  }

  async getBatteryInfo(controller: XboxControllerStatus): Promise<BatteryInfo> {
    const isWired = controller.batteryType === 1;
    const isWireless = controller.batteryType === 2 || controller.batteryType === 3;

    return {
      deviceId: 90000 + controller.index, // unique ID range for Xbox controllers
      deviceName: `Xbox Controller ${controller.index + 1}`,
      deviceType: "Controller",
      batteryLevel: isWired ? 100 : isWireless ? LEVEL_PCT[controller.batteryLevel] ?? 0 : -1,
      isCharging: isWired,
      isConnected: controller.connected,
    };
  }
}
