# Visibilité des objets utilisés comme masques

## Change Summary

Un champ explicite de visibilité, comme MASK_TAB_VISIBLE, s'applique désormais aussi à la représentation SVG d'un objet utilisé comme masque. Avec false, les objets qui utilisent ce masque disparaissent ; avec true, ils réapparaissent selon les autres règles de leur scène.

## Modified Files

`source/gt-runtime.mjs`. Les copies de rendu `D:/DEV/MY-LIVE-SPORT/tools/ograf-conversion/source/gt-runtime.mjs` et `D:/DEV/MY-LIVE-SPORT/electron/ograf/generated/gt-runtime.mjs` reçoivent la même correction. Les quatre archives SCORE, SCORE CLOCK, SCORE FIN et SCORE MI-TEMPS du dossier C:/FFF_FUTSAL/SOURCE/TEMPLATES/OGRAF sont mises à jour séparément. Aucun commit.

## Technical Rationale

`geometry(index, true)` ignorait à la fois l'opacité graphique et la visibilité du masque. L'opacité doit pouvoir rester ignorée : MASK_TAB a Opacity=0 pour ne pas dessiner son rectangle directement, tout en découpant BG_TAB et MATCH_TAB. En revanche, son bouton ShowVisible est une commande explicite. Le calcul garde donc une alpha de masque nulle si ce champ vaut false. Les masques statiques sans bouton conservent leur comportement précédent ; les transformations, découpes et animations restent inchangées.

## Risks / Side Effects

La correction concerne tous les masques avec un champ de visibilité, dont GOAL_INFO_VISIBLE dans SCORE. Désactiver ce champ masque également ses éléments dépendants. Les lecteurs installés qui substituent leur runtime aux moteurs connus utilisent le nouveau marqueur mls-gt-svg-5 pour servir le module corrigé embarqué dans les quatre archives, sans mise à jour de l'exécutable installé.

## Validation Steps

Contrôle du comportement dans l'aperçu local en passant MASK_TAB_VISIBLE de true à false puis à true : le bandeau et son texte doivent disparaître puis revenir, tandis que le rectangle de masque reste invisible. Les quatre scènes SCORE contiennent les mêmes références MASK_TAB. Aucun nouveau fichier de tests ajouté dans les modèles de diffusion.

## Rollback Notes

Les quatre archives précédentes sont sauvegardées sous le chemin indiqué dans OGRAF/mask-visibility-update.json. Pour les sources de rendu, rétablir le calcul précédent de l'opacité ; aucun changement de schéma de données n'est requis.
