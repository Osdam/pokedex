import { ChangeDetectionStrategy, Component, computed, inject, input, numberAttribute, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { IonicModule } from '@ionic/angular/lazy';
import { addIcons } from 'ionicons';
import { chevronBack, chevronForward, cubeOutline, volumeHighOutline } from 'ionicons/icons';
import { catchError, of, switchMap, tap } from 'rxjs';

import { PokemonDetail } from '../../models/pokemon';
import { PokeApiService, TOTAL_POKEMON } from '../../services/pokeapi.service';
import { formatId, typeColor, typeLabel } from '../../utils/pokemon-utils';

@Component({
  selector: 'app-detail',
  templateUrl: './detail.page.html',
  styleUrls: ['./detail.page.scss'],
  imports: [IonicModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DetailPage {
  private readonly api = inject(PokeApiService);

  /** Parámetro de ruta `:id` (bindToComponentInputs en el router). */
  readonly id = input.required({ transform: numberAttribute });

  readonly pokemon = signal<PokemonDetail | null>(null);
  readonly error = signal(false);
  readonly mainColor = computed(() => typeColor(this.pokemon()?.types[0]));
  readonly total = TOTAL_POKEMON;

  readonly formatId = formatId;
  readonly typeColor = typeColor;
  readonly typeLabel = typeLabel;

  constructor() {
    addIcons({ chevronBack, chevronForward, cubeOutline, volumeHighOutline });

    toObservable(this.id)
      .pipe(
        tap(() => {
          this.pokemon.set(null);
          this.error.set(false);
        }),
        switchMap((id) =>
          this.api.getPokemon(id).pipe(
            catchError(() => {
              this.error.set(true);
              return of(null);
            }),
          ),
        ),
      )
      .subscribe((p) => this.pokemon.set(p));
  }

  statPercent(value: number): number {
    return Math.min(100, (value / 200) * 100);
  }

  playCry(): void {
    const cry = this.pokemon()?.cry;
    if (cry) new Audio(cry).play().catch(() => undefined);
  }
}
