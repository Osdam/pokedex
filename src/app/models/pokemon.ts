/** Elemento de la lista general de la Pokédex. */
export interface PokemonListItem {
  id: number;
  name: string;
}

export interface PokemonStat {
  key: string;
  label: string;
  value: number;
}

/** Datos ya combinados de /pokemon/{id} y /pokemon-species/{id}. */
export interface PokemonDetail {
  id: number;
  name: string;
  displayName: string;
  genus: string;
  description: string;
  types: string[];
  heightM: number;
  weightKg: number;
  abilities: string[];
  stats: PokemonStat[];
  artwork: string;
  sprite: string;
  cry: string | null;
}

/* ---- Respuestas crudas de PokeAPI (solo los campos que usamos) ---- */

export interface NamedApiResource {
  name: string;
  url: string;
}

export interface NamedApiResourceList {
  count: number;
  results: NamedApiResource[];
}

export interface ApiPokemon {
  id: number;
  name: string;
  height: number; // decímetros
  weight: number; // hectogramos
  types: { slot: number; type: NamedApiResource }[];
  abilities: { ability: NamedApiResource; is_hidden: boolean }[];
  stats: { base_stat: number; stat: NamedApiResource }[];
  sprites: {
    front_default: string | null;
    other?: { 'official-artwork'?: { front_default: string | null } };
  };
  cries?: { latest: string | null; legacy: string | null };
}

export interface ApiType {
  name: string;
  pokemon: { slot: number; pokemon: NamedApiResource }[];
}

export interface ApiPokemonSpecies {
  names: { name: string; language: NamedApiResource }[];
  genera: { genus: string; language: NamedApiResource }[];
  flavor_text_entries: { flavor_text: string; language: NamedApiResource }[];
}
