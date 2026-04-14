import type { BatteryInfo } from "../types";

const SIZE = 144;

export interface IconOptions {
  showPercentage?: boolean;
  showDeviceType?: boolean;
  showDeviceName?: boolean;
  showStatusText?: boolean;
  deviceTypeFontSize?: number;
  backgroundColor?: string;
}

const DEFAULTS: Required<IconOptions> = {
  showPercentage: true,
  showDeviceType: false,
  showDeviceName: false,
  showStatusText: false,
  deviceTypeFontSize: 13,
  backgroundColor: "#0d1117",
};

function opts(o?: IconOptions): Required<IconOptions> {
  return { ...DEFAULTS, ...o };
}

function getBatteryColor(level: number, isCharging: boolean): string {
  if (isCharging) return "#4CAF50";
  if (level > 60) return "#4CAF50";
  if (level > 30) return "#FFA726";
  if (level > 15) return "#FF7043";
  return "#EF5350";
}

export function generateBatteryIcon(info: BatteryInfo, options?: IconOptions): string {
  const o = opts(options);
  const level = Math.max(0, Math.min(100, info.batteryLevel));
  const color = getBatteryColor(level, info.isCharging);

  // Compute vertical layout based on which labels are shown
  const topLabel = o.showDeviceType;
  const bottomLabel1 = o.showDeviceName;
  const bottomLabel2 = o.showStatusText && (info.isCharging || level <= 15);

  // Battery vertical center shifts based on labels
  const topOffset = topLabel ? 14 : 0;
  const bottomOffset = (bottomLabel1 ? 14 : 0) + (bottomLabel2 ? 12 : 0);
  const centerY = (SIZE + topOffset - bottomOffset) / 2;

  // Battery body (horizontal)
  const bw = 112;
  const bh = 54;
  const bx = (SIZE - bw - 10) / 2; // account for tip
  const by = centerY - bh / 2;
  const br = 7;
  const tipW = 10;
  const tipH = 24;

  // Fill
  const pad = 3;
  const fillMaxW = bw - pad * 2;
  const fillW = Math.round(fillMaxW * (level / 100));
  const fillH = bh - pad * 2;
  const fillX = bx + pad;
  const fillY = by + pad;

  // Charging bolt centered in battery
  const boltCx = bx + bw / 2;
  const boltCy = by + bh / 2;
  const bolt = info.isCharging
    ? `<polygon points="${boltCx + 8},${boltCy - 12} ${boltCx - 4},${boltCy + 2} ${boltCx + 4},${boltCy + 2} ${boltCx - 2},${boltCy + 16} ${boltCx + 14},${boltCy - 2} ${boltCx + 5},${boltCy - 2}" fill="#FFD700" stroke="#B8860B" stroke-width="1"/>`
    : "";

  // Optional labels
  const typeLabel = topLabel
    ? `<text x="72" y="${by - 10}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${o.deviceTypeFontSize}" font-weight="600" fill="#8b949e" letter-spacing="1">${detectType(info).toUpperCase()}</text>`
    : "";

  const nameLabel = bottomLabel1
    ? `<text x="72" y="${by + bh + 16}" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#8b949e">${esc(truncate(info.deviceName, 20))}</text>`
    : "";

  const statusLabel = bottomLabel2
    ? `<text x="72" y="${by + bh + (bottomLabel1 ? 30 : 16)}" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="${color}">${info.isCharging ? "Charging" : "Low Battery"}</text>`
    : "";

  // Percentage text — centered in the battery rectangle
  const battCenterX = bx + bw / 2;
  const battCenterY = by + bh / 2 + 9;
  const pctText = o.showPercentage
    ? `<text x="${battCenterX}" y="${battCenterY}" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="bold" fill="white">${level}%</text>`
    : "";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" fill="${validateColor(o.backgroundColor)}"/>
  ${typeLabel}
  <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${br}" fill="none" stroke="#30363d" stroke-width="3"/>
  <rect x="${bx + bw - 1}" y="${by + (bh - tipH) / 2}" width="${tipW}" height="${tipH}" rx="3" fill="#30363d"/>
  <rect x="${fillX}" y="${fillY}" width="${fillW}" height="${fillH}" rx="${br - 1}" fill="${color}" opacity="0.85"/>
  ${bolt}
  ${pctText}
  ${nameLabel}
  ${statusLabel}
</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export function generateErrorIcon(message: string = "No Device", bgColor?: string): string {
  const bg = validateColor(bgColor || DEFAULTS.backgroundColor);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" fill="${esc(bg)}"/>
  <rect x="16" y="48" width="100" height="48" rx="6" fill="none" stroke="#21262d" stroke-width="3"/>
  <rect x="115" y="62" width="8" height="20" rx="3" fill="#21262d"/>
  <line x1="46" y1="60" x2="82" y2="84" stroke="#484f58" stroke-width="3" stroke-linecap="round"/>
  <line x1="82" y1="60" x2="46" y2="84" stroke="#484f58" stroke-width="3" stroke-linecap="round"/>
  <text x="72" y="116" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#484f58">${esc(message)}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export function generateLoadingIcon(bgColor?: string): string {
  const bg = validateColor(bgColor || DEFAULTS.backgroundColor);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" fill="${esc(bg)}"/>
  <rect x="16" y="48" width="100" height="48" rx="6" fill="none" stroke="#21262d" stroke-width="3"/>
  <rect x="115" y="62" width="8" height="20" rx="3" fill="#21262d"/>
  <circle cx="44" cy="72" r="4" fill="#8b949e" opacity="0.4"/>
  <circle cx="64" cy="72" r="4" fill="#8b949e" opacity="0.7"/>
  <circle cx="84" cy="72" r="4" fill="#8b949e" opacity="1"/>
  <text x="72" y="116" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#484f58">Loading...</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function detectType(info: BatteryInfo): string {
  const c = `${info.deviceName} ${info.deviceType}`.toLowerCase();
  if (c.includes("mouse") || c.includes("aerox") || c.includes("rival") || c.includes("sensei")) return "Mouse";
  if (c.includes("keyboard") || c.includes("apex")) return "Keyboard";
  if (c.includes("headset") || c.includes("arctis") || c.includes("nova")) return "Headset";
  return info.deviceType || "Device";
}

function truncate(name: string, maxLen: number): string {
  if (!name) return "";
  if (name.length <= maxLen) return name;
  return name.substring(0, maxLen - 1) + "\u2026";
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function validateColor(c: string): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : "#0d1117";
}
