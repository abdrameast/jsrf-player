# GRIND//FM

Radio pirate statique, sans build, avec un CD Three.js, une playlist YouTube en ordre original et une interface commune de réactivité audio. Le décor et le logo sont des créations originales. La face imprimée utilise uniquement le scan fourni par l’utilisateur.

## Lancer

Depuis ce dossier :

```sh
npx serve .
```

Ouvrir l’adresse HTTP indiquée dans le terminal. Alternative avec Python : `python -m http.server 5188`, puis `http://localhost:5188`. Ne pas ouvrir `index.html` en `file://` : YouTube exige une origine HTTP(S) et un Referer. Le site demande une connexion Internet pour Three.js, Google Fonts, YouTube et les métadonnées.

## Déployer

Dans [Vercel](https://vercel.com/new), choisir **Add New → Project**, connecter GitHub et importer le dépôt [`abdrameast/jsrf-player`](https://github.com/abdrameast/jsrf-player). Autoriser l’intégration Vercel à accéder à ce dépôt privé. Utiliser ces paramètres :

| Paramètre | Valeur |
| --- | --- |
| Framework Preset | **Other** |
| Root Directory | `./` |
| Build Command | Champ vide — aucun build |
| Install Command | Champ vide — aucune installation |
| Output Directory | `./` |

Cliquer **Deploy**. `vercel.json` fixe déjà le framework, les commandes vides, le dossier de sortie et l’en-tête `Referrer-Policy: strict-origin-when-cross-origin`, nécessaire à YouTube. Aucune variable d’environnement n’est requise. `.vercelignore` exclut les archives, la documentation et l’ancien label, tout en conservant le scan PNG et les fichiers du lecteur. Voir les [paramètres de build Vercel](https://vercel.com/docs/builds/configure-a-build#skip-build-step) et la [configuration `vercel.json`](https://vercel.com/docs/project-configuration/vercel-json).

Pour un autre hébergeur statique HTTPS, déposer `index.html`, `style.css`, `src/`, `assets/label.png` et les SVG de `assets/` à la racine. Garder la même politique de Referer ; ne pas imposer `no-referrer`. Les CDN et les iframes YouTube doivent rester autorisés si vous ajoutez une CSP.

## Régler

Tout se configure en tête de `src/main.js` dans `CONFIG` : playlist, nom de station, palette, volume, BPM par vidéo, vitesses, lumière et effets. `YT_API_KEY` est facultative : les titres utilisent sinon oEmbed, noembed et les métadonnées du lecteur, avec cache local. Une éventuelle clé côté navigateur doit être limitée à votre domaine et à YouTube Data API v3.

`assets/label.png` est le scan fourni, copié sans modification ni recompression (1115 × 1120 pixels, transparence conservée). Le shader respecte son rapport largeur/hauteur, centre le trou avec `offsetX: -0.00118`, `offsetY: 0.00305` et ajuste le diamètre avec `scale: 1.03`. Le PNG sert uniquement à la face imprimée et au repli 2D ; le moyeu et la face miroir restent géométriques/procéduraux. Le mode `white` est activé par défaut. **L** alterne papier crème et impression sur argent. Appuyer sur **D** pour régler offsetX, offsetY, scale et rotation (en degrés), puis reporter les valeurs dans `CONFIG.label`. Pour changer de scan, remplacer `assets/label.png` et ajuster ces valeurs. `assets/label.jpg` et `assets/make-label.py` conservent l’ancien label original GRIND//FM ; ils ne remplacent pas le PNG utilisé par le lecteur.

## Écouter et synchroniser

Le disque lance la première piste au clic ; glisser l’oriente librement. La liste conserve l’ordre de YouTube et boucle. Les vidéos indisponibles sont marquées puis sautées, avec arrêt si toutes sont bloquées. La durée courte détecte les jingles. Si le navigateur refuse la lecture scriptée, toucher une fois le lecteur de secours **TAP TO TUNE IN**.

**AUTO** est une animation simulée, synchronisée au temps de lecture et figée en pause. **T** règle son tempo à l’oreille. **SYNC → LIVE SYNC** analyse réellement le son de l’onglet dans Chrome/Edge desktop : sélectionner cet onglet et cocher le partage audio. **MIC INPUT** analyse les haut-parleurs via le micro. Ces modes demandent une autorisation explicite ; aucun signal n’est enregistré ou envoyé et le flux capturé n’est jamais relié à la sortie audio. La capture demande HTTPS ou localhost. Mettre fin au partage revient à AUTO.

Raccourcis : **Espace** lecture/pause, **←/→** piste, **↑/↓** volume, **M** muet, **L** label, **T** tempo, **S** sync, **F** plein écran, **D** debug. Le bouton « THE CONTROLS » les rappelle. Les effets sonores UI se coupent avec **SFX ON/OFF**.

## Architecture

```text
index.html             DOM, HUD, décor SVG, importmap
style.css              identité graphique, responsive, accessibilité
vercel.json            déploiement statique et en-tête Referer
.vercelignore          fichiers exclus du déploiement Vercel
src/main.js            CONFIG et orchestration
src/disc.js            géométrie, matériaux, GLSL, lumière, arcball
src/player.js          API YouTube, métadonnées, états, navigation
src/audio.js           AudioFeatures, AUTO, FFT LIVE/MIC, SFX
src/fx.js              spectre, particules, oscilloscope, projections
src/ui.js              commandes, tracklist, dialogues, raccourcis
assets/label.png       scan fourni, utilisé sur la face imprimée
assets/label.jpg       ancien label original, conservé en alternative
assets/favicon.svg     icône originale
assets/make-label.py   source optionnelle du label
```

Three.js r180 est épinglé via jsDelivr ; lil-gui ne charge qu’à l’ouverture du debug. Le rendu s’arrête lorsque l’onglet est caché, le son continue. Le DPR est limité à 2 et les effets diminuent sous 45 fps. Sans WebGL, le disque passe en 2D. Le réglage système de réduction du mouvement est pris en compte.

Les restrictions YouTube (pays, compte, publicité, intégration désactivée) restent celles des vidéos de la playlist. La capture LIVE/MIC et la compatibilité Safari/iOS nécessitent une vérification sur les appareils concernés ; un test Chromium ne certifie pas ces plateformes.
