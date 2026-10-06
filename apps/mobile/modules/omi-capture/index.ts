import { type EventSubscription, requireNativeModule } from "expo-modules-core";

export type BleState =
  | "unknown"
  | "poweredOff"
  | "unauthorized"
  | "unsupported"
  | "idle"
  | "scanning"
  | "connecting"
  | "discovering"
  | "ready";

export type UplinkState = "idle" | "connecting" | "open" | "waiting";

export interface WearableInfo {
  peripheralId: string;
  name: string;
  model?: string;
  firmware?: string;
  hardwareRev?: string;
  serial?: string;
  battery?: number;
}

export interface CaptureStatus {
  configured: boolean;
  captureEnabled: boolean;
  muted: boolean;
  paired: boolean;
  ble: BleState;
  uplink: UplinkState;
  backlogFrames: number;
  journalBytes: number;
  framesThisStream: number;
  charging: boolean;
  /** Recordings stored on the pendant while the phone was away. */
  /** Download of recordings the pendant made while the phone was away. `ms`: audio saved this sync. */
  offline: {
    state: "idle" | "requesting" | "downloading" | "advancing";
    frames: number;
    ms: number;
    unreadPackets: number;
  };
  button: { tap: string; doubleTap: string; hold: string };
  serverURL?: string;
  pairedPeripheralId?: string;
  wearable?: WearableInfo;
  codec?: number;
  lastAckAt?: number;
  uplinkError?: string;
  serverError?: string;
  /** e.g. `unknown_phone` (the app re-registers), `protocol_version`, `codec`, `stream`. */
  serverErrorCode?: string;
  /** Streams the server refused; kept on the phone, not retried until the account changes. */
  rejectedStreams?: number;
  streamId?: string;
}

export interface DiscoveredDevice {
  id: string;
  name: string;
  rssi: number;
}

type Events = {
  onStatus: (status: CaptureStatus) => void;
  onDevices: (event: { devices: DiscoveredDevice[] }) => void;
  onButton: (event: { action: string }) => void;
};

interface OmiCaptureNative {
  getStatus(): CaptureStatus;
  configure(serverURL: string, token: string, phoneId: string): void;
  signOut(): void;
  startScan(): void;
  stopScan(): void;
  pair(peripheralId: string): void;
  forget(): void;
  setCaptureEnabled(enabled: boolean): void;
  setMuted(muted: boolean): void;
  testHaptic(pattern: 1 | 2 | 3): void;
  getLogs(): string[];
  addListener<E extends keyof Events>(event: E, listener: Events[E]): EventSubscription;
}

/** Native capture engine (Swift). Runs independently of JS; this is a thin control/status bridge. */
export const OmiCapture = requireNativeModule<OmiCaptureNative>("OmiCapture");
