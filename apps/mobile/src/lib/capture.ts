import { type CaptureStatus, type DiscoveredDevice, OmiCapture } from "omi-capture";
import { useEffect, useState } from "react";

export function useCaptureStatus(): CaptureStatus {
  const [status, setStatus] = useState<CaptureStatus>(() => OmiCapture.getStatus());
  useEffect(() => {
    const sub = OmiCapture.addListener("onStatus", setStatus);
    setStatus(OmiCapture.getStatus());
    return () => sub.remove();
  }, []);
  return status;
}

export function useDiscoveredDevices(active: boolean): DiscoveredDevice[] {
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  useEffect(() => {
    if (!active) return;
    const sub = OmiCapture.addListener("onDevices", (e) => setDevices(e.devices));
    OmiCapture.startScan();
    return () => {
      sub.remove();
      OmiCapture.stopScan();
    };
  }, [active]);
  return devices;
}

export const BLE_LABEL: Record<CaptureStatus["ble"], string> = {
  unknown: "Starting Bluetooth…",
  poweredOff: "Bluetooth is off",
  unauthorized: "Bluetooth permission needed",
  unsupported: "Bluetooth unavailable",
  idle: "Not connected",
  scanning: "Scanning…",
  connecting: "Waiting for pendant…",
  discovering: "Connecting…",
  ready: "Listening",
};

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function timeAgo(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  if (d < 5000) return "just now";
  return `${formatDuration(d)} ago`;
}
