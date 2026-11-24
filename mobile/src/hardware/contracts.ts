// Types only. Availability and protocol details require an actual hardware integration.
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type CapabilityState = 'not_configured' | 'unsupported' | 'available';
export type CapabilityStatus = { state: CapabilityState; reason: string };
export type HardwareCapabilities = {
  provider: string | null;
  ble_pairing: CapabilityStatus;
  telemetry: CapabilityStatus;
  remote_commands: CapabilityStatus;
};

export type TelemetryTransport = 'cellular' | 'phone_gateway' | 'vendor_cloud' | 'simulator';
export type LocationSource = 'gnss' | 'wifi' | 'cellular' | 'ble' | 'vendor';
export type CoordinateSystem = 'WGS84' | 'GCJ-02' | 'BD-09' | 'unknown';

// Adapter input metadata, separate from the backend Envelope. Establish the source
// coordinate system and convert when needed before producing WGS84 ingress payloads.
export type LocationReading = {
  sampled_at: string | null;
  coordinate_system: CoordinateSystem;
  lat: number;
  lon: number;
  accuracy_m: number | null;
  source: LocationSource;
};

type StatePayload = { battery_pct?: number; signal?: Record<string, JsonValue> };
type EnvelopeBase = {
  schema_version: '1.0';
  event_id: string;
  device_id: string;
  device_ts: string;
  seq: number;
  boot_id: string;
  firmware_version?: string;
  transport?: TelemetryTransport;
  source_metadata?: Record<string, JsonValue>;
};

// Matches existing /api/v1/ingest/events and normalized vendor/events bodies.
// device_ts is sampling time; received_at is assigned by the backend.
// TypeScript types do not replace the backend's identity, range or time checks.
export type TelemetryEnvelopeV1 = EnvelopeBase & (
  | { event_type: 'location.reported'; payload: StatePayload & {
      lat: number; lon: number; accuracy_m: number; source: LocationSource;
    } }
  | { event_type: 'state.reported'; payload: StatePayload }
  | { event_type: 'activity.reported'; payload: StatePayload & {
      start_at: string; end_at: string;
      steps?: number | null; active_seconds?: number | null;
      distance_m?: number | null; sleep_seconds?: number | null;
      estimated?: boolean; source?: string; raw_metrics?: Record<string, JsonValue>;
    } }
);

// A reference to a future backend-authorized, short-lived gateway session.
// The proof/handshake is not defined here; device IDs alone never authorize relay.
// No device permanent token, BLE UUID or MQTT topic belongs in this contract.
export type GatewaySessionReference = {
  session_id: string;
  user_id: string;
  device_id: string;
  binding_id: string;
  expires_at: string;
};
export type NearbyPeripheral = { discovery_ref: string; display_name: string | null };
export type BleLinkState = {
  status: 'not_configured' | 'disconnected' | 'pairing' | 'connected';
  observed_at: string | null;
  device_id: string | null;
};
export interface BlePairingPort {
  readonly capability: CapabilityStatus;
  discover(signal?: AbortSignal): Promise<NearbyPeripheral[]>;
  pair(input: { discovery_ref: string; authorization: GatewaySessionReference }, signal?: AbortSignal): Promise<BleLinkState>;
  disconnect(): Promise<void>;
}
