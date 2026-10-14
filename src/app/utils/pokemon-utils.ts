export const TYPE_INFO: Record<string, { label: string; color: string }> = {
  normal: { label: 'Normal', color: '#A8A77A' },
  fire: { label: 'Fuego', color: '#EE8130' },
  water: { label: 'Agua', color: '#6390F0' },
  electric: { label: 'Eléctrico', color: '#F7D02C' },
  grass: { label: 'Planta', color: '#7AC74C' },
  ice: { label: 'Hielo', color: '#96D9D6' },
  fighting: { label: 'Lucha', color: '#C22E28' },
  poison: { label: 'Veneno', color: '#A33EA1' },
  ground: { label: 'Tierra', color: '#E2BF65' },
  flying: { label: 'Volador', color: '#A98FF3' },
  psychic: { label: 'Psíquico', color: '#F95587' },
  bug: { label: 'Bicho', color: '#A6B91A' },
  rock: { label: 'Roca', color: '#B6A136' },
  ghost: { label: 'Fantasma', color: '#735797' },
  dragon: { label: 'Dragón', color: '#6F35FC' },
  dark: { label: 'Siniestro', color: '#705746' },
  steel: { label: 'Acero', color: '#B7B7CE' },
  fairy: { label: 'Hada', color: '#D685AD' },
};

export const STAT_LABELS: Record<string, string> = {
  hp: 'PS',
  attack: 'Ataque',
  defense: 'Defensa',
  'special-attack': 'At. Esp.',
  'special-defense': 'Def. Esp.',
  speed: 'Velocidad',
};

export function typeLabel(type: string): string {
  return TYPE_INFO[type]?.label ?? formatName(type);
}

export function typeColor(type: string | undefined): string {
  return (type && TYPE_INFO[type]?.color) || '#888888';
}

/** "mr-mime" -> "Mr Mime" */
export function formatName(name: string): string {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** 25 -> "#025" */
export function formatId(id: number): string {
  return '#' + String(id).padStart(3, '0');
}
