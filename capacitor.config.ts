import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.osdam.pokedexar',
  appName: 'Pokédex AR',
  webDir: 'www',
  // El puente envía ~60 eventos por segundo en RA: registrarlos en el log ralentiza la app.
  loggingBehavior: 'none',
};

export default config;
