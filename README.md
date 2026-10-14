# Pokédex AR

Pokédex móvil hecha con **Ionic + Angular + Capacitor** que consume [PokeAPI](https://pokeapi.co/) y muestra a cada Pokémon en **realidad aumentada** con **Three.js**.

## Funcionalidades

- Lista de los 1025 Pokémon con búsqueda por nombre o número y scroll infinito.
- Ficha de cada Pokémon: artwork oficial, tipos, categoría, descripción en español, altura, peso, estadísticas, habilidades y grito.
- Vista de realidad aumentada con cuatro modos (se elige automáticamente el mejor disponible):
  | Modo | Dónde funciona | Cómo se ve |
  |---|---|---|
  | **ARCore nativo** | App de Android en móviles con ARCore | Detecta el suelo, ancla al Pokémon y puedes caminar a su alrededor. |
  | **WebXR** | Chrome en Android con ARCore (servido por HTTPS) | Detecta el suelo; tocas la pantalla para colocar al Pokémon y puedes caminar a su alrededor. |
  | **Cámara + giroscopio** | Móviles sin ARCore, iOS, Safari, cualquier navegador con cámara | El Pokémon aparece sobre la imagen de la cámara y se queda fijo al girar el móvil. Arrastrar = rotar, pellizcar = escalar. |
  | **Visor 3D** | En cualquier sitio (también si se deniega la cámara) | Escena 3D con OrbitControls. |
- Botón de **tamaño real**: escala al Pokémon a su altura oficial (p. ej. Pikachu 0,4 m, Onix 8,8 m).

PokeAPI no ofrece modelos 3D, así que el modelo se genera a partir del artwork oficial: se recorta el borde transparente y se apilan varias capas para darle volumen, sobre una plataforma con brillo del color de su tipo.

## Estructura

```
src/app/
├── ar/
│   ├── pokemon-ar-scene.ts     # Escena Three.js: modelo, WebXR, cámara, visor
│   └── device-orientation.ts   # Giroscopio -> orientación de la cámara 3D
├── pages/
│   ├── pokedex/                # Lista + búsqueda
│   ├── detail/                 # Ficha del Pokémon
│   └── ar/                     # Pantalla de realidad aumentada
├── services/pokeapi.service.ts # Llamadas a PokeAPI con caché
├── models/pokemon.ts
└── utils/pokemon-utils.ts      # Colores y nombres de tipos en español
```

## Ejecutar

```bash
npm install
ionic serve          # o: npm start
```

Para probar la cámara desde el móvil el navegador exige HTTPS (o `localhost`). Para probar **WebXR** abre la app en Chrome para Android desde una URL HTTPS (por ejemplo, desplegando la carpeta `www` en Netlify/Vercel/Firebase Hosting).

## Compilar para Android

Necesita el SDK de Android y un JDK 21 (no hace falta Android Studio):

```bash
export ANDROID_HOME=$HOME/Android/Sdk
export JAVA_HOME=$HOME/.jdks/jdk-21.0.12.1+1
export PATH=$ANDROID_HOME/platform-tools:$PATH

# Versión rápida (release) instalada por USB
npm run build && npx cap sync android
(cd android && ./gradlew assembleRelease)
adb install -r android/app/build/outputs/apk/release/app-release.apk

# Versión de depuración (permite inspeccionar el WebView desde chrome://inspect)
npm run build && npx cap run android
```

La versión release va firmada con la clave de depuración para instalarla en tu propio móvil; para publicar en Google Play hay que crear una clave propia.

### Realidad aumentada nativa (ARCore)

En la app de Android la RA usa un plugin propio de ARCore (`android/app/src/main/java/com/osdam/pokedexar/ar/`):

- Detecta el suelo y crea un **ancla**: el Pokémon se queda fijo aunque camines a su alrededor.
- La cámara la dibuja Android en un `GLSurfaceView` detrás del WebView transparente; Three.js dibuja el Pokémon encima con la pose real del teléfono.
- **Sincronización**: el plugin guarda los últimos fotogramas de la cámara y muestra el que Three.js confirmó haber dibujado (`ack`), así el Pokémon no "flota" al mover el móvil.
- Cámara a 60 fps cuando el móvil lo permite, sin sensor de profundidad, superficie limitada a 60 Hz en pantallas de 120 Hz y resolución adaptativa en Three.js si se pierden fotogramas.

## iOS

```bash
npm install @capacitor/ios
npx cap add ios
```

Después añade `NSCameraUsageDescription` y `NSMotionUsageDescription` en `ios/App/App/Info.plist`.
