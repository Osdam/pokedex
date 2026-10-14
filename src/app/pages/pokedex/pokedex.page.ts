import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { InfiniteScrollCustomEvent, IonicModule } from '@ionic/angular/lazy';
import { addIcons } from 'ionicons';
import { cubeOutline, refreshOutline } from 'ionicons/icons';

import { PokemonListItem } from '../../models/pokemon';
import { PokeApiService, TOTAL_POKEMON } from '../../services/pokeapi.service';
import { TYPE_INFO, formatId, formatName, typeColor, typeLabel } from '../../utils/pokemon-utils';

const PAGE_SIZE = 30;

@Component({
  selector: 'app-pokedex',
  templateUrl: './pokedex.page.html',
  styleUrls: ['./pokedex.page.scss'],
  imports: [IonicModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PokedexPage {
  private readonly api = inject(PokeApiService);

  readonly loading = signal(true);
  readonly error = signal(false);
  private readonly all = signal<PokemonListItem[]>([]);
  private readonly typeMap = signal<Map<number, string[]>>(new Map());
  private readonly query = signal('');
  readonly selectedType = signal<string | null>(null);
  private readonly visibleCount = signal(PAGE_SIZE);

  readonly types = Object.keys(TYPE_INFO);
  readonly total = TOTAL_POKEMON;
  readonly skeletons = Array.from({ length: 8 }, (_, i) => i);

  readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase().replace(/^#/, '');
    const type = this.selectedType();
    const types = this.typeMap();
    let list = this.all();
    if (type) list = list.filter((p) => types.get(p.id)?.includes(type));
    if (!q) return list;
    if (/^\d+$/.test(q)) {
      const id = Number(q);
      return list.filter((p) => p.id === id || String(p.id).startsWith(String(id)));
    }
    return list.filter((p) => p.name.includes(q.replace(/\s+/g, '-')));
  });
  readonly visible = computed(() => this.filtered().slice(0, this.visibleCount()));
  readonly hasMore = computed(() => this.visibleCount() < this.filtered().length);

  readonly formatId = formatId;
  readonly formatName = formatName;
  readonly typeColor = typeColor;
  readonly typeLabel = typeLabel;

  constructor() {
    addIcons({ cubeOutline, refreshOutline });
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(false);
    this.api.getAll().subscribe({
      next: (list) => {
        this.all.set(list);
        this.loading.set(false);
      },
      error: () => {
        this.error.set(true);
        this.loading.set(false);
      },
    });
    // Los tipos llegan aparte: la lista se muestra antes y se colorea al llegar.
    this.api.getTypeMap().subscribe((map) => this.typeMap.set(map));
  }

  typesOf(id: number): string[] {
    return this.typeMap().get(id) ?? [];
  }

  onSearch(event: Event): void {
    this.query.set((event as CustomEvent<{ value?: string | null }>).detail.value ?? '');
    this.visibleCount.set(PAGE_SIZE);
  }

  selectType(type: string | null): void {
    this.selectedType.set(this.selectedType() === type ? null : type);
    this.visibleCount.set(PAGE_SIZE);
  }

  loadMore(event: InfiniteScrollCustomEvent): void {
    this.visibleCount.update((n) => n + PAGE_SIZE);
    event.target.complete();
  }

  artworkUrl(id: number): string {
    return this.api.artworkUrl(id);
  }
}
