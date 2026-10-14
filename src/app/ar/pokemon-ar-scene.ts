import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { PluginListenerHandle } from '@capacitor/core';

import { ArCore, ArCoreFrame } from './arcore-plugin';
import { DeviceOrientationTracker } from './device-orientation';

export type ArMode = 'native' | 'webxr' | 'camera' | 'viewer';

const TRACKING_MESSAGES: Record<string, string> = {
  INSUFFICIENT_LIGHT: 'Hay poca luz. Busca un sitio más iluminado.',
  EXCESSIVE_MOTION: 'Mueve el móvil más despacio.',
  INSUFFICIENT_FEATURES: 'Apunta a una zona con más detalles (no a una pared lisa).',
};

export interface ArSceneOptions {
  artworkUrl: string;
  label: string;
  color: string;
  /** Altura real del Pokémon en metros (dato de PokeAPI). */
  realHeight: number;
}

export interface ArSceneCallbacks {
  onStatus?: (message: string) => void;
  onPlaced?: () => void;
  onHeightChange?: (meters: number) => void;
  onSessionEnd?: () => void;
}

const FIGURE_LAYERS = 7; // capas apiladas que dan volumen al artwork
const FIGURE_THICKNESS = 0.05; // relativo a la altura
const BASE_HEIGHT = 0.03;
const CAMERA_EYE_HEIGHT = 1.4; // metros, altura aproximada del móvil en modo cámara
const MIN_CAMERA_DISTANCE = 2.3; // metros mínimos entre el usuario y el Pokémon en modo cámara
const MAX_GROUND_DISTANCE = 40; // más lejos de esto el punto del suelo deja de ser fiable
/** Resolución máxima del canvas en RA: se mezcla con la cámara y no necesita más. */
const AR_MAX_PIXEL_RATIO = 1.75;
const VIEWER_MAX_PIXEL_RATIO = 2;
const MIN_PIXEL_RATIO = 1;
/** Fotogramas que se analizan antes de decidir si bajar la resolución. */
const QUALITY_WINDOW = 90;
const TARGET_FRAME_MS = 1000 / 60;
const MIN_HEIGHT = 0.1;
const MAX_HEIGHT = 20;

/**
 * Escena de Three.js con el Pokémon como figura 3D sobre una plataforma.
 *
 * - `native`: ARCore nativo en la app de Android (detección de suelo y anclas).
 * - `webxr`: AR real con detección de superficies (Chrome en Android con ARCore).
 * - `camera`: vídeo de la cámara trasera + giroscopio (funciona en WebView/iOS).
 * - `viewer`: visor 3D sin cámara con OrbitControls.
 */
export class PokemonArScene {
  readonly ready: Promise<void>;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 0.01, 200);
  private readonly timer = new THREE.Timer();

  /** Posición del Pokémon en el mundo. */
  private readonly root = new THREE.Group();
  /** Escalado (altura) y rotación del usuario. */
  private readonly model = new THREE.Group();
  private readonly figure = new THREE.Group();
  private glowRing?: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private sparkles?: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private reticle?: THREE.Mesh;
  /** Círculo en el suelo (modo cámara) con el tamaño que ocupará el Pokémon. */
  private groundReticle?: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private baseRadius = 0.35;

  private mode: ArMode | null = null;
  private height = 1;
  private figureAspect = 1;
  private spawnProgress = 1;
  private disposed = false;

  private controls?: OrbitControls;
  private orientation?: DeviceOrientationTracker;
  private stream?: MediaStream;
  private xrSession?: XRSession;
  private hitTestSource?: XRHitTestSource;
  private placedInFront = false;
  private nativeFrame?: ArCoreFrame;
  private nativeListener?: PluginListenerHandle;
  private lastStatus = '';
  private readonly nativeProj = new THREE.Matrix4();
  private hasNativeProj = false;
  private lastRenderedFrameId = -1;

  // Resolución adaptativa: si se pierden fotogramas, se baja la resolución.
  private pixelRatio = 1;
  private qualityFrames = 0;
  private qualityDrops = 0;
  private lastRenderTime = 0;

  // Objetos reutilizados en cada fotograma para no generar basura.
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpVector = new THREE.Vector3();

  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchStart?: { distance: number; height: number };
  private tapStart?: { x: number; y: number; time: number };
  private readonly resizeObserver: ResizeObserver;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: ArSceneOptions,
    private readonly callbacks: ArSceneCallbacks = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.setMaxPixelRatio(VIEWER_MAX_PIXEL_RATIO);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.style.touchAction = 'none';
    container.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 3, 2);
    this.scene.add(sun);

    this.root.visible = false;
    this.root.add(this.model);
    this.scene.add(this.root);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    // Se carga en paralelo: los métodos start* hacen primero lo que requiere
    // el gesto del usuario (permisos, sesión XR) y luego esperan a `ready`.
    this.ready = this.buildModel();
  }

  static async isWebXrSupported(): Promise<boolean> {
    try {
      return (await navigator.xr?.isSessionSupported('immersive-ar')) ?? false;
    } catch {
      return false;
    }
  }

  get currentMode(): ArMode | null {
    return this.mode;
  }

  get realHeight(): number {
    return this.options.realHeight;
  }

  /* ------------------------------------------------------------------ */
  /* Modos                                                               */
  /* ------------------------------------------------------------------ */

  async startWebXr(overlayRoot: HTMLElement): Promise<void> {
    const xr = navigator.xr;
    if (!xr) throw new Error('WebXR no disponible');

    const session = await xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: overlayRoot },
    });
    this.xrSession = session;
    this.mode = 'webxr';

    // Los toques sobre botones del overlay no deben colocar al Pokémon.
    overlayRoot.addEventListener('beforexrselect', this.onBeforeXrSelect);

    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local');
    await this.renderer.xr.setSession(session);

    const viewerSpace = await session.requestReferenceSpace('viewer');
    this.hitTestSource = await session.requestHitTestSource?.({ space: viewerSpace });

    session.addEventListener('select', () => this.placeAtReticle());
    session.addEventListener('end', () => {
      overlayRoot.removeEventListener('beforexrselect', this.onBeforeXrSelect);
      this.hitTestSource?.cancel();
      this.hitTestSource = undefined;
      this.xrSession = undefined;
      this.renderer.xr.enabled = false;
      this.callbacks.onSessionEnd?.();
    });

    this.reticle = this.createReticle();
    this.scene.add(this.reticle);

    await this.ready;
    this.setHeight(this.options.realHeight);
    this.status('Mueve el móvil lentamente para detectar el suelo y toca la pantalla para colocar al Pokémon.');
    this.renderer.setAnimationLoop((_t, frame) => this.renderXrFrame(frame));
  }

  /**
   * ARCore nativo: la cámara la dibuja Android detrás del WebView y aquí solo
   * pintamos el Pokémon con la pose real del teléfono que llega en cada fotograma.
   */
  async startNative(): Promise<void> {
    this.mode = 'native';
    this.nativeListener = await ArCore.addListener('frame', (frame) => (this.nativeFrame = frame));
    await ArCore.start();
    if (this.disposed) return;
    document.body.classList.add('ar-native-active');

    this.camera.matrixAutoUpdate = false;
    this.setMaxPixelRatio(AR_MAX_PIXEL_RATIO);
    this.reticle = this.createReticle();
    this.scene.add(this.reticle);
    this.attachGestures();

    await this.ready;
    this.setHeight(this.options.realHeight);
    this.renderer.setAnimationLoop(() => this.renderNativeFrame());
  }

  async startCamera(video: HTMLVideoElement): Promise<void> {
    // Primero el permiso del giroscopio (iOS exige que sea dentro del click).
    const orientationAllowed = await DeviceOrientationTracker.requestPermission();

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = this.stream;
    await video.play();
    this.mode = 'camera';

    if (orientationAllowed) {
      this.orientation = new DeviceOrientationTracker();
      this.orientation.connect();
    }

    this.camera.position.set(0, CAMERA_EYE_HEIGHT, 0);
    this.setMaxPixelRatio(AR_MAX_PIXEL_RATIO);
    this.resize();
    this.attachGestures();

    await this.ready;
    // Tamaño real: un Onix mide 8,8 m y un Joltik 0,1 m.
    this.setHeight(this.options.realHeight);
    this.groundReticle = this.createGroundReticle();
    this.scene.add(this.groundReticle);
    this.status('Apunta al suelo donde quieras ponerlo y toca la pantalla. El círculo muestra el espacio que ocupará.');

    // Si en 1 s no llega ningún dato del giroscopio (p. ej. en un PC),
    // colocamos al Pokémon delante con la cámara fija.
    setTimeout(() => {
      if (!this.orientation?.hasData && !this.placedInFront && !this.disposed) this.placeInFront();
    }, 1000);

    this.renderer.setAnimationLoop((time) => {
      if (this.paceFrame(time)) this.renderCameraFrame();
    });
  }

  async startViewer(): Promise<void> {
    this.mode = 'viewer';
    this.camera.fov = 45;
    this.camera.position.set(0, 0.9, 2.6);
    this.resize();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.5, 0);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.8;
    this.controls.maxDistance = 8;
    this.controls.maxPolarAngle = Math.PI * 0.55;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 1.5;
    this.controls.addEventListener('start', () => this.controls && (this.controls.autoRotate = false));

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(3, 64),
      new THREE.MeshBasicMaterial({ map: radialTexture('rgba(255,255,255,0.18)'), transparent: true, depthWrite: false }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    await this.ready;
    this.setHeight(1);
    // Alejamos la cámara lo suficiente para que quepa entero (también en vertical).
    const halfTan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const fitHeight = 1.5 / (2 * halfTan);
    const fitWidth = (Math.max(1, this.figureAspect) * 1.35) / (2 * halfTan * this.camera.aspect);
    const distance = Math.max(fitHeight, fitWidth) + 0.5;
    if (this.controls) this.controls.maxDistance = Math.max(8, distance * 1.5);
    this.camera.position.set(0, 0.9, distance);
    this.root.position.set(0, 0, 0);
    this.spawn();
    this.status('Arrastra para girar alrededor del Pokémon y pellizca para acercarte.');
    this.renderer.setAnimationLoop((time) => {
      if (!this.paceFrame(time)) return;
      this.update();
      this.controls?.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Acciones públicas                                                   */
  /* ------------------------------------------------------------------ */

  setHeight(meters: number): void {
    this.height = THREE.MathUtils.clamp(meters, MIN_HEIGHT, MAX_HEIGHT);
    this.applyScale();
    this.callbacks.onHeightChange?.(this.height);
  }

  scaleBy(factor: number): void {
    this.setHeight(this.height * factor);
  }

  /**
   * Pone al Pokémon delante de la cámara, a la distancia justa para que se vea
   * entero con su tamaño actual (los Pokémon enormes quedan más lejos).
   */
  placeInFront(): void {
    if (this.mode !== 'camera') return;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    forward.y = 0;
    if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1);
    forward.normalize().multiplyScalar(this.fitDistance());
    this.placeAt(new THREE.Vector3(forward.x, 0, forward.z).add(this.cameraGroundPosition()));
  }

  private placeAt(point: THREE.Vector3): void {
    this.root.position.set(point.x, 0, point.z);
    this.root.lookAt(this.camera.position.x, 0, this.camera.position.z);
    this.model.rotation.y = 0;
    this.placedInFront = true;
    this.spawn();
    this.status('Arrastra para girarlo y pellizca para cambiar su tamaño. Toca otro punto del suelo para moverlo.');
  }

  private cameraGroundPosition(): THREE.Vector3 {
    return new THREE.Vector3(this.camera.position.x, 0, this.camera.position.z);
  }

  /** Distancia mínima a la que el Pokémon cabe entero en pantalla mirando al frente. */
  private fitDistance(): number {
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const top = this.height * 1.15; // incluye la etiqueta con el nombre
    const halfWidth = Math.max(this.figureAspect / 2, this.baseRadius) * this.height;
    const forHeight = (top - CAMERA_EYE_HEIGHT) / tanHalf;
    const forWidth = halfWidth / (tanHalf * this.camera.aspect);
    return Math.max(MIN_CAMERA_DISTANCE, forHeight + 0.5, forWidth + 0.5);
  }

  async endXrSession(): Promise<void> {
    await this.xrSession?.end().catch(() => undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.xrSession?.end().catch(() => undefined);
    if (this.mode === 'native') {
      this.nativeListener?.remove();
      ArCore.stop().catch(() => undefined);
      document.body.classList.remove('ar-native-active');
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.orientation?.disconnect();
    this.controls?.dispose();
    this.timer.dispose();
    this.detachGestures();
    this.resizeObserver.disconnect();

    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) {
        (material as THREE.MeshBasicMaterial).map?.dispose();
        material.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /* ------------------------------------------------------------------ */
  /* Construcción del modelo                                             */
  /* ------------------------------------------------------------------ */

  private async buildModel(): Promise<void> {
    const { canvas, aspect } = await loadTrimmedArtwork(this.options.artworkUrl);
    this.figureAspect = aspect;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());

    const typeColor = new THREE.Color(this.options.color);

    // Figura: varias capas del artwork apiladas para darle grosor. Se fusionan
    // en dos mallas (caras y relleno) para hacer solo 2 llamadas de dibujo.
    const faces: THREE.BufferGeometry[] = [];
    const inner: THREE.BufferGeometry[] = [];
    for (let i = 0; i < FIGURE_LAYERS; i++) {
      const z = -FIGURE_THICKNESS / 2 + (i * FIGURE_THICKNESS) / (FIGURE_LAYERS - 1);
      const layer = new THREE.PlaneGeometry(aspect, 1).translate(0, 0.5, z);
      (i === 0 || i === FIGURE_LAYERS - 1 ? faces : inner).push(layer);
    }
    const figureMaterial = (color: THREE.ColorRepresentation) =>
      new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.5, side: THREE.DoubleSide, color });
    this.figure.add(
      new THREE.Mesh(mergeGeometries(faces), figureMaterial(0xffffff)),
      new THREE.Mesh(mergeGeometries(inner), figureMaterial(new THREE.Color(0x666666).lerp(typeColor, 0.25))),
    );
    [...faces, ...inner].forEach((g) => g.dispose());
    this.figure.position.y = BASE_HEIGHT;
    this.model.add(this.figure);

    // Plataforma estilo holograma de la Pokédex.
    const radius = Math.max(0.35, aspect * 0.45);
    this.baseRadius = radius;
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius * 1.06, BASE_HEIGHT, 48, 1),
      new THREE.MeshLambertMaterial({ color: 0x2a3040 }),
    );
    base.position.y = BASE_HEIGHT / 2;
    this.model.add(base);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.82, radius * 0.97, 64),
      new THREE.MeshBasicMaterial({ color: typeColor, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = BASE_HEIGHT + 0.001;
    this.model.add(ring);

    this.glowRing = new THREE.Mesh(
      new THREE.RingGeometry(radius * 1.0, radius * 1.35, 64),
      new THREE.MeshBasicMaterial({
        color: typeColor,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.glowRing.rotation.x = -Math.PI / 2;
    this.glowRing.position.y = 0.004;
    this.model.add(this.glowRing);

    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(radius * 1.6, 48),
      new THREE.MeshBasicMaterial({ map: radialTexture('rgba(0,0,0,0.55)'), transparent: true, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.002;
    this.model.add(shadow);

    this.sparkles = createSparkles(radius, typeColor);
    this.model.add(this.sparkles);

    const label = createLabel(this.options.label, this.options.color);
    label.position.y = BASE_HEIGHT + 1.12;
    this.model.add(label);

    this.applyScale();
  }

  private createGroundReticle(): THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> {
    const reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.88, 1, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(this.options.color),
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
    );
    const center = new THREE.Mesh(
      new THREE.CircleGeometry(0.06, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    reticle.add(center);
    reticle.visible = false;
    return reticle;
  }

  private createReticle(): THREE.Mesh {
    const reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.1, 0.13, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(this.options.color) }),
    );
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    return reticle;
  }

  /* ------------------------------------------------------------------ */
  /* Bucle de render                                                     */
  /* ------------------------------------------------------------------ */

  private renderXrFrame(frame?: XRFrame): void {
    const refSpace = this.renderer.xr.getReferenceSpace();
    if (frame && refSpace && this.hitTestSource && this.reticle) {
      const hit = frame.getHitTestResults(this.hitTestSource)[0];
      const pose = hit?.getPose(refSpace);
      this.reticle.visible = !!pose;
      if (pose) this.reticle.matrix.fromArray(pose.transform.matrix);
    }
    this.update();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Solo se dibuja cuando llega un fotograma nuevo de la cámara (30/60 fps),
   * aunque la pantalla vaya a 120 Hz. Después se confirma con `ack` para que
   * Android muestre exactamente esa imagen de cámara detrás.
   */
  private renderNativeFrame(): void {
    const frame = this.nativeFrame;
    if (frame?.proj) {
      this.nativeProj.fromArray(frame.proj);
      this.hasNativeProj = true;
    }
    if (!frame || !this.hasNativeProj || frame.id === this.lastRenderedFrameId) return;

    // Si se saltó algún fotograma de la cámara, vamos justos de rendimiento.
    if (this.lastRenderedFrameId >= 0) this.reportQuality(frame.id - this.lastRenderedFrameId > 1);
    this.lastRenderedFrameId = frame.id;

    // Cámara de Three.js = cámara real del teléfono.
    this.camera.matrix.fromArray(frame.pose);
    this.camera.matrix.decompose(this.camera.position, this.camera.quaternion, this.camera.scale);
    this.camera.matrixWorld.copy(this.camera.matrix);
    this.camera.matrixWorldInverse.copy(this.camera.matrix).invert();
    this.camera.projectionMatrix.copy(this.nativeProj);
    this.camera.projectionMatrixInverse.copy(this.nativeProj).invert();

    if (this.reticle) {
      this.reticle.visible = !!frame.reticle;
      if (frame.reticle) this.reticle.matrix.fromArray(frame.reticle);
    }
    // El ancla se corrige sola cuando ARCore entiende mejor la habitación.
    if (frame.anchor && this.placedInFront) {
      this.root.position.setFromMatrixPosition(this.tmpMatrix.fromArray(frame.anchor));
    }
    this.status(this.nativeStatus(frame));

    this.update();
    this.renderer.render(this.scene, this.camera);
    ArCore.ack({ id: frame.id });
  }

  /**
   * Limita a 60 fps los modos que dibujan en cada vsync (pantallas de 90/120 Hz)
   * y mide si se pierden fotogramas para ajustar la resolución.
   */
  private paceFrame(time: number): boolean {
    if (this.lastRenderTime && time - this.lastRenderTime < TARGET_FRAME_MS - 2) return false;
    if (this.lastRenderTime) this.reportQuality(time - this.lastRenderTime > TARGET_FRAME_MS * 1.6);
    this.lastRenderTime = time;
    return true;
  }

  private reportQuality(dropped: boolean): void {
    this.qualityFrames++;
    if (dropped) this.qualityDrops++;
    if (this.qualityFrames < QUALITY_WINDOW) return;
    // Más de un 15% de fotogramas perdidos: bajamos un escalón la resolución.
    if (this.qualityDrops / this.qualityFrames > 0.15 && this.pixelRatio > MIN_PIXEL_RATIO) {
      this.pixelRatio = Math.max(MIN_PIXEL_RATIO, this.pixelRatio - 0.25);
      this.renderer.setPixelRatio(this.pixelRatio);
    }
    this.qualityFrames = 0;
    this.qualityDrops = 0;
  }

  private setMaxPixelRatio(max: number): void {
    this.pixelRatio = Math.max(MIN_PIXEL_RATIO, Math.min(window.devicePixelRatio, max));
    this.renderer.setPixelRatio(this.pixelRatio);
  }

  private nativeStatus(frame: ArCoreFrame): string {
    if (frame.tracking !== 'TRACKING') {
      return TRACKING_MESSAGES[frame.failure] ?? 'Mueve el móvil despacio para que empiece a reconocer el entorno.';
    }
    if (this.placedInFront) {
      return 'Camina a su alrededor. Arrastra para girarlo, pellizca para cambiar su tamaño o toca el suelo para moverlo.';
    }
    return frame.reticle
      ? 'Suelo detectado. Toca la pantalla para colocar al Pokémon en el círculo.'
      : 'Apunta al suelo y mueve el móvil despacio de lado a lado para detectarlo.';
  }

  private async placeNative(): Promise<void> {
    const reticle = this.nativeFrame?.reticle;
    if (!reticle) return;
    const { placed } = await ArCore.placeAnchor();
    if (!placed || this.disposed) return;
    this.root.position.setFromMatrixPosition(new THREE.Matrix4().fromArray(reticle));
    this.root.lookAt(this.camera.position.x, this.root.position.y, this.camera.position.z);
    this.model.rotation.y = 0;
    this.placedInFront = true;
    this.spawn();
  }

  private renderCameraFrame(): void {
    if (this.orientation?.hasData) {
      this.orientation.applyTo(this.camera.quaternion);
      this.updateGroundReticle();
    } else if (this.placedInFront) {
      this.camera.lookAt(this.root.position.x, this.height * 0.4, this.root.position.z);
    }
    this.update();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Proyecta el centro de la pantalla sobre el suelo (plano y = 0) usando la
   * inclinación del móvil y la altura a la que se suele sostener.
   */
  private updateGroundReticle(): void {
    const reticle = this.groundReticle;
    if (!reticle) return;
    const forward = this.tmpVector.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const distance = forward.y < -0.02 ? CAMERA_EYE_HEIGHT / -forward.y : Infinity;
    reticle.visible = distance < MAX_GROUND_DISTANCE;
    if (!reticle.visible) return;

    reticle.position.copy(this.camera.position).addScaledVector(forward, distance);
    reticle.position.y = 0.005;
    const size = this.baseRadius * this.height * 1.1;
    reticle.scale.set(size, 1, size);
    // El punto central mantiene un tamaño visible aunque el círculo sea enorme.
    reticle.children[0].scale.set(1 / size, 1, 1 / size).multiplyScalar(Math.max(0.5, distance * 0.15));
    reticle.material.opacity = this.placedInFront ? 0.35 : 0.9;
  }

  private update(): void {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const t = this.timer.getElapsed();

    if (this.spawnProgress < 1) {
      this.spawnProgress = Math.min(1, this.spawnProgress + dt / 0.7);
      this.applyScale();
    }

    // "Respiración" de la figura y brillo de la plataforma.
    const breath = Math.sin(t * 2.6);
    this.figure.scale.set(1 - breath * 0.012, 1 + breath * 0.02, 1);
    if (this.glowRing) this.glowRing.material.opacity = 0.35 + 0.25 * (0.5 + 0.5 * Math.sin(t * 3));

    if (this.sparkles) {
      const positions = this.sparkles.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < positions.count; i++) {
        let y = positions.getY(i) + dt * (0.15 + (i % 5) * 0.04);
        if (y > 1.2) y = 0.02;
        positions.setY(i, y);
      }
      positions.needsUpdate = true;
    }
  }

  private spawn(): void {
    this.root.visible = true;
    this.spawnProgress = 0;
    this.applyScale();
    this.callbacks.onPlaced?.();
  }

  private applyScale(): void {
    const s = this.height * easeOutBack(this.spawnProgress);
    this.model.scale.setScalar(Math.max(s, 0.0001));
  }

  private placeAtReticle(): void {
    if (!this.reticle?.visible) return;
    this.root.position.setFromMatrixPosition(this.reticle.matrix);
    const cam = new THREE.Vector3().setFromMatrixPosition(this.renderer.xr.getCamera().matrixWorld);
    this.root.lookAt(cam.x, this.root.position.y, cam.z);
    this.spawn();
  }

  private resize(): void {
    if (this.renderer.xr.isPresenting) return;
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    if (this.mode === 'camera') {
      // FOV aproximado de la cámara trasera de un móvil (~63° en el lado largo).
      const longFov = THREE.MathUtils.degToRad(63);
      this.camera.fov =
        height >= width
          ? 63
          : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(longFov / 2) * (height / width)));
    }
    this.camera.updateProjectionMatrix();
  }

  private status(message: string): void {
    if (message === this.lastStatus) return;
    this.lastStatus = message;
    this.callbacks.onStatus?.(message);
  }

  /* ------------------------------------------------------------------ */
  /* Gestos (modo cámara): arrastrar = rotar, pellizcar = escalar        */
  /* ------------------------------------------------------------------ */

  private attachGestures(): void {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
  }

  private detachGestures(): void {
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointercancel', this.onPointerUp);
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.renderer.domElement.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.tapStart = this.pointers.size === 1 ? { x: e.clientX, y: e.clientY, time: performance.now() } : undefined;
    if (this.pointers.size === 2) {
      this.pinchStart = { distance: this.pointerDistance(), height: this.height };
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const previous = this.pointers.get(e.pointerId);
    if (!previous) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.tapStart && Math.hypot(e.clientX - this.tapStart.x, e.clientY - this.tapStart.y) > 10) {
      this.tapStart = undefined;
    }
    if (this.pointers.size === 1 && this.placedInFront) {
      this.model.rotation.y += (e.clientX - previous.x) * 0.01;
    } else if (this.pointers.size === 2 && this.pinchStart) {
      this.setHeight(this.pinchStart.height * (this.pointerDistance() / this.pinchStart.distance));
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchStart = undefined;
    const tap = this.tapStart;
    this.tapStart = undefined;
    if (e.type === 'pointerup' && tap && performance.now() - tap.time < 400) this.onTap();
  };

  /** Un toque coloca al Pokémon donde apunta el círculo del suelo. */
  private onTap(): void {
    if (this.mode === 'native') {
      this.placeNative().catch(() => undefined);
      return;
    }
    if (this.mode !== 'camera') return;
    if (this.groundReticle?.visible) this.placeAt(this.groundReticle.position);
    else if (!this.placedInFront) this.placeInFront();
  }

  private pointerDistance(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
  }

  private readonly onBeforeXrSelect = (e: Event): void => {
    if ((e.target as Element | null)?.closest?.('button, ion-button, .ar-interactive')) {
      e.preventDefault();
    }
  };
}

/* -------------------------------------------------------------------- */
/* Utilidades                                                            */
/* -------------------------------------------------------------------- */

function easeOutBack(x: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo cargar la imagen del Pokémon'));
    img.src = url;
  });
}

/** Carga el artwork y recorta el margen transparente para que los pies toquen la base. */
async function loadTrimmedArtwork(url: string): Promise<{ canvas: HTMLCanvasElement; aspect: number }> {
  const img = await loadImage(url);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const source = document.createElement('canvas');
  source.width = w;
  source.height = h;
  const ctx = source.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, w, h);

  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { canvas: source, aspect: w / h };

  const pad = 2;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;

  const trimmed = document.createElement('canvas');
  trimmed.width = cw;
  trimmed.height = ch;
  trimmed.getContext('2d')!.drawImage(source, minX, minY, cw, ch, 0, 0, cw, ch);
  return { canvas: trimmed, aspect: cw / ch };
}

function radialTexture(innerColor: string): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, innerColor);
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function createSparkles(radius: number, color: THREE.Color): THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> {
  const count = 40;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = radius * (0.6 + Math.random() * 0.6);
    positions[i * 3] = Math.cos(angle) * r;
    positions[i * 3 + 1] = Math.random() * 1.2;
    positions[i * 3 + 2] = Math.sin(angle) * r;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color,
    size: 0.03,
    map: radialTexture('rgba(255,255,255,1)'),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Points(geometry, material);
}

function createLabel(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = 'bold 56px system-ui, -apple-system, Roboto, sans-serif';
  ctx.font = font;
  const width = Math.ceil(ctx.measureText(text).width) + 64;
  canvas.width = width;
  canvas.height = 96;

  ctx.font = font;
  ctx.fillStyle = 'rgba(20, 24, 32, 0.8)';
  ctx.beginPath();
  ctx.roundRect(0, 0, width, 96, 48);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, 50);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
  sprite.scale.set((width / 96) * 0.1, 0.1, 1);
  return sprite;
}
