/**
 * Omi pendant BLE constants (consumer pendant "CV1", firmware >= 3.0.20).
 * Source: BasedHardware/omi `omi/firmware/omi/src/lib/core/transport.c`.
 */

const omiUuid = (short: string) => `${short}-E8F2-537E-4F6C-D104768A1214`;

export const OMI_GATT = {
  audioService: omiUuid("19B10000"),
  audioData: omiUuid("19B10001"),
  audioCodec: omiUuid("19B10002"),
  settingsService: omiUuid("19B10010"),
  ledDim: omiUuid("19B10011"),
  micGain: omiUuid("19B10012"),
  chargingStatus: omiUuid("19B10013"),
  featuresService: omiUuid("19B10020"),
  features: omiUuid("19B10021"),
  timeService: omiUuid("19B10030"),
  timeSet: omiUuid("19B10031"),
  timeRead: omiUuid("19B10032"),
  storageService: "30295780-4301-EABD-2904-2849ADFEAE43",
  storageControl: "30295781-4301-EABD-2904-2849ADFEAE43",
  storageStatus: "30295782-4301-EABD-2904-2849ADFEAE43",
  buttonService: "23BA7924-0000-1000-7450-346EAC492E92",
  buttonState: "23BA7925-0000-1000-7450-346EAC492E92",
  hapticService: "CAB1AB95-2EA5-4F4D-BB56-874B72CFC984",
  hapticTrigger: "CAB1AB96-2EA5-4F4D-BB56-874B72CFC984",
  batteryService: "180F",
  batteryLevel: "2A19",
  deviceInfoService: "180A",
} as const;

export const OMI_CODEC = {
  PCM16: 0,
  PCM8: 1,
  OPUS_16K_10MS: 20,
  OPUS_16K_20MS: 21,
} as const;

export type OmiCodec = (typeof OMI_CODEC)[keyof typeof OMI_CODEC];

export const SUPPORTED_CODECS: ReadonlySet<number> = new Set([
  OMI_CODEC.OPUS_16K_10MS,
  OMI_CODEC.OPUS_16K_20MS,
]);

export function codecFrameMs(codec: number): number {
  if (codec === OMI_CODEC.OPUS_16K_10MS) return 10;
  if (codec === OMI_CODEC.OPUS_16K_20MS) return 20;
  throw new Error(`unsupported codec ${codec}`);
}

/** Button notification values (int32 LE). Codes 3/4 exist in firmware but are never sent. */
export const OMI_BUTTON = { SINGLE_TAP: 1, DOUBLE_TAP: 2, HOLD_RELEASE: 5 } as const;

/** Haptic trigger values: pulse length. */
export const OMI_HAPTIC = { SHORT: 1, MEDIUM: 2, LONG: 3 } as const;

/** Feature bitmask from the features characteristic (u32 LE). */
export const OMI_FEATURE = {
  speaker: 1 << 0,
  accelerometer: 1 << 1,
  button: 1 << 2,
  battery: 1 << 3,
  usb: 1 << 4,
  haptic: 1 << 5,
  offlineStorage: 1 << 6,
  ledDimming: 1 << 7,
  micGain: 1 << 8,
} as const;

/**
 * Reassembles Omi audio notifications into whole codec frames.
 *
 * Each notification is `[pkt_idx u16 LE][sub_idx u8][payload]`. With MTU >= 166 every
 * notification carries exactly one frame (sub_idx = 0). Frames split across notifications
 * have sub_idx 1, 2, ... and a frame is complete when the next sub_idx = 0 arrives.
 * A pkt_idx gap means notifications were lost (not silence: during mic sleep the firmware
 * simply stops sending and pkt_idx continues consecutively afterwards). A single-part frame
 * before a gap is kept; a multi-part frame interrupted by a gap is dropped.
 */
export class OmiFrameAssembler {
  private lastPkt = -1;
  private lastSub = -1;
  private parts: Uint8Array[] = [];

  /** Feed one notification; returns zero or one completed frame plus a gap flag. */
  push(packet: Uint8Array): { frame?: Uint8Array; gap: boolean } {
    if (packet.length < 4) return { gap: false };
    const pkt = packet[0]! | (packet[1]! << 8);
    const sub = packet[2]!;
    const payload = packet.subarray(3);

    const expectedPkt = this.lastPkt === -1 ? pkt : (this.lastPkt + 1) & 0xffff;
    const gap = this.lastPkt !== -1 && pkt !== expectedPkt;

    let frame: Uint8Array | undefined;
    if (sub === 0) {
      if (this.parts.length === 1 || (this.parts.length > 1 && !gap)) frame = concat(this.parts);
      this.parts = [payload];
    } else if (!gap && sub === this.lastSub + 1 && this.parts.length > 0) {
      this.parts.push(payload);
    } else {
      this.parts = [];
    }
    this.lastPkt = pkt;
    this.lastSub = sub;
    return { frame, gap };
  }

  /** Emit the in-progress frame (call when the stream pauses, e.g. mic sleep). */
  flush(): Uint8Array | undefined {
    const frame = this.parts.length > 0 ? concat(this.parts) : undefined;
    this.parts = [];
    return frame;
  }

  reset(): void {
    this.lastPkt = -1;
    this.lastSub = -1;
    this.parts = [];
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
