import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, forkJoin, map, of, shareReplay, tap } from 'rxjs';

import {
  ApiPokemon,
  ApiPokemonSpecies,
  ApiType,
  NamedApiResourceList,
  PokemonDetail,
  PokemonListItem,
} from '../models/pokemon';
import { STAT_LABELS, TYPE_INFO, formatName } from '../utils/pokemon-utils';

const API_URL = 'https://pokeapi.co/api/v2';
const SPRITES_URL = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';

/** Número de Pokémon de la Pokédex nacional (las formas alternativas tienen id >= 10000). */
export const TOTAL_POKEMON = 1025;

/** Cambiar al modificar el formato de los datos guardados. */
const CACHE_PREFIX = 'pokedex:v1:';

@Injectable({ providedIn: 'root' })
export class PokeApiService {
  private readonly http = inject(HttpClient);

  private list$?: Observable<PokemonListItem[]>;
  private types$?: Observable<Map<number, string[]>>;
  private readonly details = new Map<number, Observable<PokemonDetail>>();

  getAll(): Observable<PokemonListItem[]> {
    this.list$ ??= cached('list', () =>
      this.http
        .get<NamedApiResourceList>(`${API_URL}/pokemon?limit=${TOTAL_POKEMON}`)
        .pipe(map((res) => res.results.map((r) => ({ id: idFromUrl(r.url), name: r.name })))),
    ).pipe(shareReplay(1));
    return this.list$;
  }

  /**
   * Tipos de todos los Pokémon (id -> tipos) a partir de los 18 endpoints /type.
   * Así la lista puede colorear tarjetas y filtrar sin pedir cada Pokémon.
   */
  getTypeMap(): Observable<Map<number, string[]>> {
    if (!this.types$) {
      const stored = readCache<[number, string[]][]>('types');
      this.types$ = (stored ? of(stored) : this.fetchTypeEntries()).pipe(
        map((entries) => new Map(entries)),
        shareReplay(1),
      );
    }
    return this.types$;
  }

  private fetchTypeEntries(): Observable<[number, string[]][]> {
    return forkJoin(
      Object.keys(TYPE_INFO).map((type) =>
        this.http.get<ApiType>(`${API_URL}/type/${type}`).pipe(catchError(() => of(null))),
      ),
    ).pipe(
      map((responses) => {
        const slots = new Map<number, { slot: number; type: string }[]>();
        for (const res of responses) {
          for (const entry of res?.pokemon ?? []) {
            const id = idFromUrl(entry.pokemon.url);
            if (id > TOTAL_POKEMON) continue;
            const list = slots.get(id) ?? [];
            list.push({ slot: entry.slot, type: res!.name });
            slots.set(id, list);
          }
        }
        const entries: [number, string[]][] = [];
        for (const [id, list] of slots) {
          entries.push([id, list.sort((a, b) => a.slot - b.slot).map((t) => t.type)]);
        }
        // Solo se guarda si llegaron los 18 tipos (si falló alguno se reintenta la próxima vez).
        if (responses.every(Boolean)) writeCache('types', entries);
        return entries;
      }),
    );
  }

  getPokemon(id: number): Observable<PokemonDetail> {
    let detail$ = this.details.get(id);
    if (!detail$) {
      detail$ = cached(`pokemon:${id}`, () =>
        forkJoin({
          pokemon: this.http.get<ApiPokemon>(`${API_URL}/pokemon/${id}`),
          species: this.http.get<ApiPokemonSpecies>(`${API_URL}/pokemon-species/${id}`),
        }).pipe(map(({ pokemon, species }) => toDetail(pokemon, species))),
      ).pipe(shareReplay(1));
      this.details.set(id, detail$);
    }
    return detail$;
  }

  spriteUrl(id: number): string {
    return `${SPRITES_URL}/${id}.png`;
  }

  artworkUrl(id: number): string {
    return `${SPRITES_URL}/other/official-artwork/${id}.png`;
  }
}

/**
 * Los datos de PokeAPI no cambian: se guardan en localStorage para que la app
 * abra al instante y funcione sin conexión con lo ya visto.
 */
function cached<T>(key: string, fetch: () => Observable<T>): Observable<T> {
  const stored = readCache<T>(key);
  return stored ? of(stored) : fetch().pipe(tap((value) => writeCache(key, value)));
}

function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, value: unknown): void {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value));
  } catch {
    // Almacenamiento lleno o bloqueado: simplemente no se guarda.
  }
}

function idFromUrl(url: string): number {
  const parts = url.split('/').filter(Boolean);
  return Number(parts[parts.length - 1]);
}

/** Busca la entrada en español y si no existe usa la inglesa. */
function pickLang<T extends { language: { name: string } }>(entries: T[], last = false): T | undefined {
  const find = (lang: string) => {
    const matches = entries.filter((e) => e.language.name === lang);
    return last ? matches[matches.length - 1] : matches[0];
  };
  return find('es') ?? find('en');
}

function toDetail(p: ApiPokemon, s: ApiPokemonSpecies): PokemonDetail {
  const flavor = pickLang(s.flavor_text_entries, true)?.flavor_text ?? '';
  return {
    id: p.id,
    name: p.name,
    displayName: pickLang(s.names)?.name ?? formatName(p.name),
    genus: pickLang(s.genera)?.genus ?? '',
    description: flavor.replace(/[\f\n\r­]+/g, ' ').replace(/\s+/g, ' ').trim(),
    types: [...p.types].sort((a, b) => a.slot - b.slot).map((t) => t.type.name),
    heightM: p.height / 10,
    weightKg: p.weight / 10,
    abilities: p.abilities.map((a) => formatName(a.ability.name) + (a.is_hidden ? ' (oculta)' : '')),
    stats: p.stats.map((st) => ({
      key: st.stat.name,
      label: STAT_LABELS[st.stat.name] ?? formatName(st.stat.name),
      value: st.base_stat,
    })),
    artwork:
      p.sprites.other?.['official-artwork']?.front_default ??
      `${SPRITES_URL}/other/official-artwork/${p.id}.png`,
    sprite: p.sprites.front_default ?? `${SPRITES_URL}/${p.id}.png`,
    cry: p.cries?.latest ?? p.cries?.legacy ?? null,
  };
}
