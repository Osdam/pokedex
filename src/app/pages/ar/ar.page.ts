import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, inject, input, numberAttribute, signal, viewChild } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { IonicModule, NavController, ToastController } from '@ionic/angular/lazy';
import { addIcons } from 'ionicons';
import {
  add,
  camera,
  close,
  cubeOutline,
  locateOutline,
  remove,
  resizeOutline,
  volumeHighOutline,
} from 'ionicons/icons';
import { switchMap } from 'rxjs';

import { isArCoreAvailable } from '../../ar/arcore-plugin';
import { ArMode, PokemonArScene } from '../../ar/pokemon-ar-scene';
import { PokemonDetail } from '../../models/pokemon';
import { PokeApiService } from '../../services/pokeapi.service';
import { formatId, typeColor } from '../../utils/pokemon-utils';

type PageMode = 'idle' | 'loading' | ArMode;

@Component({
  selector: 'app-ar',
  templateUrl: './ar.page.html',
  styleUrls: ['./ar.page.scss'],
  imports: [IonicModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ArPage implements OnDestroy {
  private readonly api = inject(PokeApiService);
  private readonly nav = inject(NavController);
  private readonly toasts = inject(ToastController);

  readonly id = input.required({ transform: numberAttribute });

  private readonly stage = viewChild.required<ElementRef<HTMLDivElement>>('stage');
  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private readonly overlay = viewChild.required<ElementRef<HTMLDivElement>>('overlay');

  readonly pokemon = signal<PokemonDetail | null>(null);
  readonly mode = signal<PageMode>('idle');
  readonly status = signal('');
  readonly placed = signal(false);
  readonly height = signal(1);
  readonly xrSupported = signal(false);
  readonly arCoreSupported = signal(false);

  readonly formatId = formatId;

  private scene?: PokemonArScene;

  constructor() {
    addIcons({ add, camera, close, cubeOutline, locateOutline, remove, resizeOutline, volumeHighOutline });

    toObservable(this.id)
      .pipe(switchMap((id) => this.api.getPokemon(id)))
      .subscribe({
        next: (p) => this.pokemon.set(p),
        error: () => this.toast('No se pudo cargar el Pokémon.'),
      });

    PokemonArScene.isWebXrSupported().then((ok) => this.xrSupported.set(ok));
    isArCoreAvailable().then((ok) => this.arCoreSupported.set(ok));
  }

  ngOnDestroy(): void {
    this.stop();
  }

  ionViewWillLeave(): void {
    this.stop();
  }

  /** Botón principal: ARCore en la app, WebXR en Chrome y si no, cámara + giroscopio. */
  startAr(): void {
    if (this.arCoreSupported()) this.start('native');
    else if (this.xrSupported()) this.start('webxr');
    else this.start('camera');
  }

  async start(mode: ArMode): Promise<void> {
    const p = this.pokemon();
    if (!p) return;

    this.stop();
    this.mode.set('loading');
    this.placed.set(false);

    const scene = new PokemonArScene(
      this.stage().nativeElement,
      {
        artworkUrl: p.artwork,
        label: `${formatId(p.id)} ${p.displayName}`,
        color: typeColor(p.types[0]),
        realHeight: p.heightM,
      },
      {
        onStatus: (msg) => this.status.set(msg),
        onHeightChange: (h) => this.height.set(h),
        onPlaced: () => {
          if (!this.placed()) this.playCry();
          this.placed.set(true);
        },
        onSessionEnd: () => {
          if (this.scene === scene) this.stop();
        },
      },
    );
    this.scene = scene;

    try {
      if (mode === 'native') await scene.startNative();
      else if (mode === 'webxr') await scene.startWebXr(this.overlay().nativeElement);
      else if (mode === 'camera') await scene.startCamera(this.video().nativeElement);
      else await scene.startViewer();
      if (this.scene === scene) this.mode.set(mode);
    } catch (err) {
      console.error(err);
      if (this.scene !== scene) return;
      this.stop();
      if (mode === 'native' || mode === 'webxr') {
        this.toast('No se pudo iniciar ARCore. Usando la cámara y el giroscopio.');
        this.start('camera');
      } else if (mode === 'camera') {
        this.toast('No se pudo acceder a la cámara. Mostrando el visor 3D.');
        this.start('viewer');
      } else {
        this.toast('No se pudo cargar el modelo 3D.');
      }
    }
  }

  stop(): void {
    this.scene?.dispose();
    this.scene = undefined;
    this.mode.set('idle');
    this.placed.set(false);
    this.status.set('');
    const video = this.video().nativeElement;
    video.pause();
    video.srcObject = null;
  }

  async exit(): Promise<void> {
    const leavingXr = this.mode() === 'webxr';
    await this.scene?.endXrSession();
    if (!leavingXr) {
      this.stop();
      this.nav.back();
    }
  }

  scale(factor: number): void {
    this.scene?.scaleBy(factor);
  }

  realSize(): void {
    if (this.scene) this.scene.setHeight(this.scene.realHeight);
  }

  recenter(): void {
    this.scene?.placeInFront();
  }

  playCry(): void {
    const cry = this.pokemon()?.cry;
    if (cry) new Audio(cry).play().catch(() => undefined);
  }

  private async toast(message: string): Promise<void> {
    const t = await this.toasts.create({ message, duration: 2500, position: 'top' });
    await t.present();
  }
}
