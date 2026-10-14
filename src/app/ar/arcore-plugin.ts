import { Capacitor, PluginListenerHandle, registerPlugin } from '@capacitor/core';

/** Datos que envía el plugin nativo en cada fotograma (matrices 4x4 en orden de columnas). */
export interface ArCoreFrame {
  /** Número de fotograma de la cámara (se devuelve con ack). */
  id: number;
  tracking: 'TRACKING' | 'PAUSED' | 'STOPPED';
  failure: 'NONE' | 'BAD_STATE' | 'INSUFFICIENT_LIGHT' | 'EXCESSIVE_MOTION' | 'INSUFFICIENT_FEATURES' | 'CAMERA_UNAVAILABLE';
  /** Pose de la cámara en el mundo (world-from-camera). */
  pose: number[];
  /** Solo llega cuando cambia (normalmente en el primer fotograma). */
  proj?: number[];
  /** Punto del suelo bajo el centro de la pantalla, si se detectó. */
  reticle?: number[];
  /** Pose del ancla donde se colocó el Pokémon. */
  anchor?: number[];
}

/** Plugin nativo implementado en android/app/src/main/java/com/osdam/pokedexar/ar/ArCorePlugin.java */
interface ArCorePlugin {
  checkAvailability(): Promise<{ supported: boolean; transient: boolean; status: string }>;
  start(): Promise<void>;
  stop(): Promise<void>;
  placeAnchor(): Promise<{ placed: boolean }>;
  /** Confirma que ya se dibujó ese fotograma: el fondo nativo muestra esa misma imagen. */
  ack(options: { id: number }): void;
  addListener(event: 'frame', listener: (frame: ArCoreFrame) => void): Promise<PluginListenerHandle>;
}

export const ArCore = registerPlugin<ArCorePlugin>('ArCore');

/** ¿Estamos en la app de Android y el teléfono soporta ARCore? */
export async function isArCoreAvailable(): Promise<boolean> {
  if (Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('ArCore')) return false;
  try {
    // La primera consulta puede devolver "comprobando"; reintentamos un poco.
    for (let i = 0; i < 10; i++) {
      const result = await ArCore.checkAvailability();
      if (!result.transient) return result.supported;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  } catch {
    // Plugin no registrado o error nativo.
  }
  return false;
}
