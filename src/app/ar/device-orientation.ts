import { Euler, MathUtils, Quaternion, Vector3 } from 'three';

type IosOrientationEvent = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

/** Generic Sensor API (Chrome / WebView de Android). No está en lib.dom. */
interface OrientationSensor extends EventTarget {
  quaternion?: number[];
  start(): void;
  stop(): void;
}
type OrientationSensorCtor = new (options: { frequency: number; referenceFrame: 'device' | 'screen' }) => OrientationSensor;

const X_AXIS = new Vector3(1, 0, 0);
const Z_AXIS = new Vector3(0, 0, 1);
// La cámara mira hacia -Z; el dispositivo "mira" hacia abajo cuando está plano.
const SCREEN_TO_CAMERA = new Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
// El sensor usa Z hacia arriba; Three.js usa Y hacia arriba.
const EARTH_TO_WORLD = new Quaternion().setFromAxisAngle(X_AXIS, -Math.PI / 2);

/**
 * Convierte la orientación del teléfono en la orientación de una cámara de Three.js.
 *
 * Usa `RelativeOrientationSensor` (giroscopio + acelerómetro fusionados, 60 Hz)
 * cuando existe y si no recurre al evento `deviceorientation`.
 */
export class DeviceOrientationTracker {
  private sensor?: OrientationSensor;
  private sensorHasData = false;
  private eventsHasData = false;
  private listeningEvents = false;
  private fallbackTimer?: ReturnType<typeof setTimeout>;

  private alpha = 0;
  private beta = 0;
  private gamma = 0;
  private readonly sensorQuat = new Quaternion();
  private readonly euler = new Euler();
  private readonly screenQuat = new Quaternion();
  private readonly target = new Quaternion();

  get hasData(): boolean {
    return this.sensorHasData || this.eventsHasData;
  }

  /** En iOS el permiso debe pedirse dentro de un gesto del usuario (un click). */
  static async requestPermission(): Promise<boolean> {
    const DOE = (window as unknown as { DeviceOrientationEvent?: IosOrientationEvent }).DeviceOrientationEvent;
    if (!DOE) return false;
    if (typeof DOE.requestPermission === 'function') {
      try {
        return (await DOE.requestPermission()) === 'granted';
      } catch {
        return false;
      }
    }
    return true;
  }

  connect(): void {
    const Ctor = (window as unknown as { RelativeOrientationSensor?: OrientationSensorCtor }).RelativeOrientationSensor;
    if (Ctor) {
      try {
        const sensor = new Ctor({ frequency: 60, referenceFrame: 'screen' });
        sensor.addEventListener('reading', () => {
          if (!sensor.quaternion) return;
          this.sensorQuat.fromArray(sensor.quaternion);
          this.sensorHasData = true;
        });
        sensor.addEventListener('error', () => {
          sensor.stop();
          this.sensor = undefined;
          this.sensorHasData = false;
          this.listenEvents();
        });
        sensor.start();
        this.sensor = sensor;
        // Si el sensor no entrega lecturas (permiso bloqueado), usamos el evento.
        this.fallbackTimer = setTimeout(() => {
          if (!this.sensorHasData) this.listenEvents();
        }, 800);
        return;
      } catch {
        // Constructor bloqueado por política: seguimos con el evento.
      }
    }
    this.listenEvents();
  }

  disconnect(): void {
    clearTimeout(this.fallbackTimer);
    this.sensor?.stop();
    this.sensor = undefined;
    window.removeEventListener('deviceorientation', this.onOrientation);
    this.listeningEvents = false;
  }

  /**
   * Aplica la orientación actual al cuaternión dado. Un suavizado pequeño
   * elimina el temblor sin que la imagen 3D vaya "por detrás" de la cámara.
   */
  applyTo(quaternion: Quaternion): void {
    if (this.sensorHasData) {
      this.target.copy(EARTH_TO_WORLD).multiply(this.sensorQuat);
      quaternion.slerp(this.target, 0.85);
    } else if (this.eventsHasData) {
      const orient = MathUtils.degToRad(screen.orientation?.angle ?? 0);
      this.euler.set(this.beta, this.alpha, -this.gamma, 'YXZ');
      this.target.setFromEuler(this.euler);
      this.target.multiply(SCREEN_TO_CAMERA);
      this.target.multiply(this.screenQuat.setFromAxisAngle(Z_AXIS, -orient));
      quaternion.slerp(this.target, 0.75);
    }
  }

  private listenEvents(): void {
    if (this.listeningEvents) return;
    this.listeningEvents = true;
    window.addEventListener('deviceorientation', this.onOrientation);
  }

  private readonly onOrientation = (e: DeviceOrientationEvent): void => {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    this.alpha = MathUtils.degToRad(e.alpha);
    this.beta = MathUtils.degToRad(e.beta);
    this.gamma = MathUtils.degToRad(e.gamma);
    this.eventsHasData = true;
  };
}
