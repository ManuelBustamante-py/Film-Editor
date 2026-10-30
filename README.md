# Fotograma Studio 3.1

Editor de vídeo y audio de escritorio para Windows, con captura de pantalla y clips instantáneos (Electron + FFmpeg + Web Audio).

## Instalar y abrir

Descarga los ejecutables y el manual desde **Releases**:

- **`Fotograma-Studio-Setup-3.1.0.exe`**: instalador. Crea accesos directos en el escritorio y en el menú Inicio, y asocia los proyectos `.fgproj`.
- **`Fotograma-Studio-Portable-3.1.0.exe`**: no necesita instalación; se abre con doble clic.
- **`Manual de usuario - Fotograma Studio.pdf`**: guía completa con capturas y casos de uso.

Ambos ejecutables incluyen un FFmpeg moderno, así que no hace falta instalar nada más. Al abrir la app por primera vez, detecta la tarjeta gráfica (NVIDIA, AMD o Intel, dedicada o integrada), el procesador y las pantallas, y se configura sola. Como no están firmados digitalmente, Windows SmartScreen puede avisar la primera vez: pulsa «Más información» → «Ejecutar de todas formas».

## Desarrollo

```bash
npm install                 # si Electron no se descarga: node node_modules/electron/install.js
npm start                   # abre la app en modo desarrollo
npm test                    # prueba de extremo a extremo del motor
npm run vendor              # copia el FFmpeg del PATH a vendor/ffmpeg (se incluye en los .exe)
npm run dist                # copia FFmpeg y genera los .exe en dist/
npm run icon                # regenera build/icon.png
```

## Funciones

**Captura (estilo OBS + Medal)**
- Un solo proceso captura la pantalla por GPU (Desktop Duplication) o una ventana o juego (Windows Graphics Capture) y codifica con la tarjeta (AMD AMF, NVIDIA NVENC o Intel Quick Sync; x264 si no hay GPU). Graba en segmentos de 1 s, así el **búfer de repetición** y la **grabación** comparten codificación.
- **Clips instantáneos a 60 fps reales** (igual de fluidos que OBS): guarda los últimos 5 s a 30 min (selector junto a «Guardar clip»), un **clip corto** con su propio atajo, desde la bandeja o con la **voz**. Se puede seguir grabando unos segundos tras pedir el clip.
- **Grabación** con **pausa**, **división automática** cada 15/30/60 min y **recuperación** si la app se cierra de golpe. **Marcadores** con atajo (capítulos en el vídeo) y **capturas de pantalla** PNG sacadas del búfer.
- **Se adapta al equipo**: detecta GPU, CPU, RAM y pantallas y elige codificador y ajustes; «Optimizar fluidez» prueba los métodos de captura con el juego abierto. Estadísticas en vivo (fps reales, repetidas, velocidad del codificador, bitrate, CPU, disco).
- **Comando de voz sin conexión** (Vosk): frases propias en español o inglés («guarda eso», «clip that»…), micrófono elegible, espera entre clips y modo de prueba. El modelo (35–40 MB) se descarga una vez.
- **Resolución nativa** (p. ej. 1440×1044, sin bordes negros) o estirada a 1920×1080 al guardar el clip, en la GPU, como `escalador.bat`. De 30 a 240 fps, H.264 o HEVC, calidad constante o bitrate variable/constante, preajuste Velocidad/Equilibrado/Calidad, MP4/MKV/MOV, audio AAC u Opus.
- **Mezclador de audio**: cualquier dispositivo de entrada (micrófono, salidas de Voicemeeter…), con medidores, volumen y silencio **en vivo**, filtros (reducción de ruido, puerta, compresor), limitador, desfase de sincronía y **calibración automática** del retraso. Pista 1 = mezcla y una pista más por fuente (como las pistas de OBS).
- Atajos globales configurables (F8 guardar clip, F9 grabar, Mayús+F8 búfer; y clip corto, pausa, marcador, captura de pantalla y silenciar micrófono), icono en la bandeja para seguir capturando con la ventana cerrada, sonido al guardar y vista previa en vivo.
- Cada captura aparece en **Medios** (filtro «Capturas») y en la lista de capturas recientes.

**Fuentes de una grabación** (Medios → clic derecho)
- **Exportar fuentes**: cada pista de audio por separado (WAV, FLAC, MP3, M4A u original sin recodificar) y el vídeo sin audio.
- **Abrir con las pistas separadas**: el vídeo y una pista de audio por fuente en la línea de tiempo.
- **Estirar a 1920×1080 (16:9)**, igual que `escalador.bat` (x264 CRF 18, audio copiado).

**Editor multipista**
- Pista de textos (T1), pista de vídeo (V1) y pistas de audio ilimitadas (MP3, WAV, M4A, FLAC, OGG…), cada una con silencio, solo y volumen.
- Vídeo: unir, reordenar, recortar arrastrando los bordes, dividir y transiciones (disolver, fundido a negro, destello blanco, barridos, deslizar, círculo).
- Audio: mover libremente, cambiar de pista, recortar, volumen hasta el 200 % y fundidos.
- Textos: fuente, tamaño, color, negrita y cursiva, alineación, fondo, contorno, sombra, fundidos, y arrastrarlos directamente en el visor.
- Imán (N) para ajustar a bordes y al cabezal. Deshacer y rehacer. Proyectos `.fgproj`.

**Vista previa**
- Doble capa de vídeo para cambiar de clip sin cortes y ver las transiciones en vivo.
- **Vista previa fluida** (por defecto): los clips de 1080p o 60 fps se reproducen desde copias ligeras de 720p con una imagen clave cada 15, preparadas en segundo plano, y el audio de los vídeos desde una copia solo de audio. El reloj manda y el vídeo se pone al día sin saltos, así que la reproducción va a tiempo aunque el equipo esté cargado (captura, juego…). «Original» reproduce los archivos tal cual; la exportación usa siempre los originales.
- Mezcla de audio en tiempo real (vídeo y música sincronizados, volumen por encima del 100 %).
- Textos, color, rotación y encuadre tal y como se exportan. Pantalla completa (F).

**Por clip de vídeo**: entrada y salida, velocidad de 0,1× a 16×, 12 filtros de color y ajustes finos, rotación, volteo, encuadre con proporción fija, volumen y fundidos.

**Exportación**: MP4 (H.264, H.265 o AV1), MKV, WebM (VP9 o AV1), MOV, ProRes, AVI, **GIF animado** y **solo audio** (MP3, M4A, OGG Opus/Vorbis, OPUS, FLAC, WAV). Códec de audio a elegir (AAC, MP3, Opus, Vorbis, AC3, FLAC, ALAC, PCM), frecuencia y canales. Resolución y fps a elegir, con interpolación de movimiento. Calidad constante (CRF), tamaño en MB, porcentaje o bitrate, con dos pasadas. Codificador automático según el equipo (NVENC, Quick Sync o AMF). Ajustes rápidos para YouTube, TikTok/Reels, Instagram, WhatsApp, Discord y ProRes.

**Audio Studio**
- Presets: Slowed + Reverb, Super slowed, Solo reverb, Nightcore, Sped up, Lo-fi, Audio 8D, Bajo el agua.
- Efectos: velocidad con tono (tipo vinilo), reverb (cantidad, tamaño, pre-retardo, brillo), graves, agudos, filtro lo-fi, 8D, anchura estéreo, ganancia, fundidos y limitador.
- Forma de onda con recorte, visualizador de espectro y repetición.
- Exporta a MP3, M4A, AAC, OGG (Opus o Vorbis), OPUS, AC3, FLAC, ALAC, WAV de 16 o 24 bit o vídeo MP4 con portada y onda animada, con frecuencia y canales a elegir. «Al editor» lo coloca en una pista de audio del proyecto.

**Cortador de audio**
- Recorta cualquier audio (o el audio de un vídeo): selección arrastrando sobre la onda, zoom con la rueda, mini-mapa y tiempos exactos.
- Conservar la selección o eliminarla uniendo el resto; selección rápida de 15, 30 o 60 s (tonos de llamada, clips).
- Marcadores (M) para dividir en varias partes y exportarlas de una vez.
- Fundidos, ganancia y normalización a −14 LUFS.
- Formato original **sin recodificar** cuando es posible (instantáneo y sin pérdida), o MP3, M4A, AAC, OGG (Opus o Vorbis), OPUS, AC3, FLAC, ALAC o WAV, con frecuencia y canales a elegir. «Al editor» lo coloca en la línea de tiempo.

**Menús contextuales**: clic derecho en clips de vídeo, audio y texto, en pistas vacías y en la biblioteca.

**Compresor**: comprime un vídeo por porcentaje o a un tamaño exacto en MB, en H.264, H.265, VP9 o AV1 (MP4, MKV o WebM).

## Atajos

| Tecla | Acción |
|---|---|
| Espacio | Reproducir / pausa (también en Audio Studio) |
| ← / → | Fotograma anterior / siguiente (Mayús: 1 s) |
| J / K / L | −5 s / pausa / +5 s |
| S o Ctrl+K | Dividir en el cabezal |
| I / O | Marcar entrada / salida |
| T | Añadir texto |
| N | Activar / desactivar imán |
| F | Pantalla completa |
| Supr | Eliminar |
| Ctrl+D | Duplicar |
| Ctrl+Z / Ctrl+Y | Deshacer / rehacer |
| Ctrl+S / Ctrl+O | Guardar / abrir proyecto |
| Ctrl+I / Ctrl+E | Importar / exportar |
| Ctrl+rueda, + / − | Zoom de la línea de tiempo |
| F8 · F9 · Mayús+F8 | Guardar clip · grabar · búfer (globales, configurables en Captura) |

## Estructura

```
main.js              proceso principal (ventana, diálogos, IPC, protocolo media://)
preload.js           puente seguro hacia la interfaz
src/engine.js        motor FFmpeg: análisis, miniaturas, proxies, exportación y codificación de audio
src/capture.js       captura: búfer de repetición, grabación, sincronía y calibración
src/capture-host.js  ajustes, atajos globales, bandeja, ventana de voz e IPC de la captura
preload-voice.js     puente de la ventana oculta de reconocimiento de voz
src/system.js        detección del equipo (GPU, CPU, RAM, pantallas) y configuración recomendada
src/audio-identify.js identifica qué programa suena en cada fuente de audio
src/shared/core.js   lógica compartida: color, transiciones, formatos, resolución, fps y bitrate
renderer/            interfaz (HTML, CSS y módulos JS; studio.js = Audio Studio, capture.js = Captura, voice.js = voz)
scripts/             arranque en desarrollo, generación del icono y copia de FFmpeg (vendor-ffmpeg.js)
test/engine-test.js  prueba de extremo a extremo del motor
```
