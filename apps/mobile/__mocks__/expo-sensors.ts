// Manual Jest mock, applied to every suite (root __mocks__): every motion sensor is a `MockSensor`
// that never emits on its own; a test pushes readings with `emit` and reads the listeners back.
import { PermissionStatus, type PermissionResponse } from "expo-modules-core";
import type * as SensorsModule from "expo-sensors";

type Listener<Measurement> = (measurement: Measurement) => void;

const GRANTED: PermissionResponse = {
  status: PermissionStatus.GRANTED,
  granted: true,
  canAskAgain: true,
  expires: "never",
};

export class MockSensor<Measurement> {
  /** What `isAvailableAsync` answers; a test flips it before the hook under test mounts. */
  available = true;
  /** The last `setUpdateInterval` value, null until it is called. */
  updateIntervalMs: number | null = null;
  private readonly listeners = new Set<Listener<Measurement>>();

  isAvailableAsync = jest.fn(async (): Promise<boolean> => this.available);
  setUpdateInterval = jest.fn((intervalMs: number): void => {
    this.updateIntervalMs = intervalMs;
  });
  addListener = jest.fn((listener: Listener<Measurement>) => {
    this.listeners.add(listener);
    return {
      remove: () => {
        this.listeners.delete(listener);
      },
    };
  });
  removeAllListeners = jest.fn((): void => {
    this.listeners.clear();
  });
  getPermissionsAsync = jest.fn(async (): Promise<PermissionResponse> => GRANTED);
  requestPermissionsAsync = jest.fn(async (): Promise<PermissionResponse> => GRANTED);

  hasListeners(): boolean {
    return this.listeners.size > 0;
  }

  getListenerCount(): number {
    return this.listeners.size;
  }

  /** Delivers one reading to every listener, as the native sensor would. */
  emit(measurement: Measurement): void {
    for (const listener of this.listeners) listener(measurement);
  }

  /** Back to the fresh state; call it in `beforeEach` when a file has more than one test. */
  reset(): void {
    this.available = true;
    this.updateIntervalMs = null;
    this.listeners.clear();
    this.isAvailableAsync.mockClear();
    this.setUpdateInterval.mockClear();
    this.addListener.mockClear();
    this.removeAllListeners.mockClear();
  }
}

export const Accelerometer = new MockSensor<SensorsModule.AccelerometerMeasurement>();
export const Barometer = new MockSensor<SensorsModule.BarometerMeasurement>();
export const DeviceMotion = new MockSensor<SensorsModule.DeviceMotionMeasurement>();
export const Gyroscope = new MockSensor<SensorsModule.GyroscopeMeasurement>();
export const LightSensor = new MockSensor<SensorsModule.LightSensorMeasurement>();
export const Magnetometer = new MockSensor<SensorsModule.MagnetometerMeasurement>();
export const MagnetometerUncalibrated =
  new MockSensor<SensorsModule.MagnetometerUncalibratedMeasurement>();

// The step counter and the enums keep their real (jest-expo mocked) implementation.
export const { DeviceMotionOrientation, DeviceSensor, Pedometer } =
  jest.requireActual<typeof SensorsModule>("expo-sensors");
