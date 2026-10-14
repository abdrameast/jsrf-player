# Vérification — 14 octobre 2026

Essais réalisés dans le navigateur Chromium intégré à Codex, via un serveur HTTP local. Dimensions vérifiées : 1440 × 900 et 390 × 844. Les captures actualisées avec le scan fourni se trouvent dans `docs/`, dont `label-scan.jpg`.

| Critère du brief | Résultat observé |
| --- | --- |
| Premier clic sur le CD → piste 1 | Vérifié avec un clic sur la surface du disque : « The Concept of Love », état PLAYING. Activation clavier également vérifiée. |
| Ordre strict et boucle | 35 vrais IDs et titres récupérés. Sélection de la piste 4 « Funky Dealer », puis suivante → piste 5 « Shape Da Future ». Seek en fin de piste 1 → piste 2. Fin naturelle de la piste 35 → piste 1. |
| Pistes bloquées | Logique vérifiée avec doubles de l’API : saut borné, arrêt si toutes sont indisponibles, erreur 153 explicite. Aucune indisponibilité réelle imposée par la playlist pendant ces essais. |
| Vidéo invisible | Iframe réellement mesurée à 200 × 200, conteneur opacity 0, jamais display:none. Lecteur de secours vérifié par simulation ; aucun blocage de lecture réel rencontré dans Chromium. |
| Reflets et rotation | Shaders compilés sans erreur. Faces données et label inspectées. Drag à la souris vérifié. Directions de diffraction transformées dans l’espace monde, invariantes sous le spin axial du réseau circulaire. |
| Label net et calibré | Scan PNG fourni intégré sans recompression (SHA-256 identique à la source), rapport d’aspect conservé et calage mesuré sur le trou transparent. Offsets (-0.00118, +0.00305), scale 1.03, mode blanc par défaut. Alpha composite sur papier pour éviter les franges noires. Vue desktop/mobile et commande L vérifiées dans Chromium, sans erreur console. La face imprimée est visible au démarrage ; les changements réels de piste gardent leur flip. Réglages accessibles via D. |
| Réactivité | AUTO déterministe, normalisé et figé en pause vérifié par simulation sur 5 000 frames. LIVE/MIC : FFT, cycle de vie de la capture, retour AUTO, absence de connexion à destination et annulation vérifiés avec doubles. Capture réelle non déclenchée : autorisation et sélection de source à faire par l’utilisateur. |
| Jingles | Piste 35 « Jet Set Groove #4 », durée 11 s : badge et bandeau STATION ID observés, puis retour automatique à la première piste. |
| HUD et contrôles | Tracklist desktop et bottom-sheet mobile, sélection, volume au clavier, seek, lecture/pause, aide, dialogue SYNC → AUTO, bouton SFX ON/OFF et panneau debug vérifiés. |
| Responsive | Document sans débordement horizontal ou vertical aux deux dimensions testées. Titre mobile corrigé après inspection. |
| Console | Aucun message error/warn dans les dernières lectures de console. Syntaxe des six modules validée avec node --check. |
| Autres navigateurs | Firefox, Safari, iOS et Android physiques non disponibles pour ces essais. Le viewport mobile est une vérification de mise en page Chromium, pas une certification mobile. |
| Dégradation | Code de repli 2D, réduction de mouvement, suspension sur onglet caché et adaptation sous 45 fps présents. Absence de WebGL et performance 60 fps sur appareils réels non certifiées. |

Les tests de simulation complètent les essais réels ; ils ne remplacent pas la vérification de capture, d’autoplay et de GPU sur chaque plateforme.
