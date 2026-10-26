# Licenses of the assets · 资产许可

The code of this project is under the MIT License (`LICENSE`). Some assets come from other sources and keep the licenses of those sources; they are listed here. Everything not listed here (the code, the scripts, the spatial data in `dist/assets/spatial.json`, and the project's own models `double-chair.glb` and `dream-curtains.glb`) is under the MIT License.

本项目的代码以 MIT 许可发布（`LICENSE`）。部分资产来自其他来源，沿用来源的许可，列在下面。未列出的文件（代码、脚本、`dist/assets/spatial.json` 里的空间数据，以及本项目自己制作的模型 `double-chair.glb`、`dream-curtains.glb`）都以 MIT 许可发布。

| Files · 文件 | Source · 来源 | License · 许可 |
| --- | --- | --- |
| `dist/assets/environment.glb`, `dist/assets/repeated-props.glb` | These combined models contain geometry derived from the Venus Medici scan by Geoffrey Marchal ([source](https://sketchfab.com/3d-models/venus-medici-708a4166439c45d799f4eaa40d0db70e)); simplified, with lighting baked. 合并模型中包含由 Geoffrey Marchal 的美第奇维纳斯扫描衍生的网格，已减面并烘焙光照。 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/): attribution, non-commercial, share-alike. 署名、非商业、相同方式共享。See `dist/assets/medici-license.txt`. |
| `dist/assets/milo.glb` | Venus de Milo scan, SMK – National Gallery of Denmark, cast KAS434/1. 米洛的维纳斯扫描，丹麦国家美术馆（SMK）。 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/); this simplified, lit version is also released under CC0. 简化并打光后的版本同样以 CC0 发布。See `dist/assets/milo-license.txt`. |
| `dist/assets/footsteps/steps.wav`, `scripts/footsteps/source/bigsoundbank-0165.aiff` | "Man Footsteps on the Wooden Floor", BigSoundBank #0165, by DavidGreck ([source](https://bigsoundbank.com/man-footsteps-on-the-wooden-floor-s0165.html)); cut into single steps by `scripts/footsteps/prepare.py`. | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `dist/assets/voices/*.mp3` | Synthesized with the speech voices of Microsoft Windows (Microsoft David, Microsoft Zira) by `scripts/voice`. Eight of the sixteen lines quote Twin Peaks dialogue (episodes 2, 14 and 29); the dialogue belongs to its rights holders. 用 Windows 自带的合成语音（Microsoft David / Zira）生成；十六句中八句引自原剧对白，对白版权属于原权利人。 | Not covered by the MIT License. Included only for this noncommercial fan study; for any other use, check Microsoft's terms for its voices. 不在 MIT 许可范围内，只为本非商业同人习作提供；其他用途请先确认微软对其语音的使用条款。 |
| `dist/vendor/three.module.js`, `dist/vendor/three.core.js` | three.js | MIT, see `dist/vendor/THREE-LICENSE.txt` |
| `dist/vendor/meshopt_decoder.mjs` | meshoptimizer, Arseny Kapoulkine | MIT, see `dist/vendor/MESHOPT-LICENSE.txt` |

Not part of the project · 不属于本项目：the music a local copy can play from `dist/assets/music/` (Angelo Badalamenti, "Falling") is kept out of the repository by `.gitignore` and is never distributed; neither are recordings made with it (`captures/`). 本机可放入的音乐和用它录出的视频都被 `.gitignore` 排除，不随项目分发。

This is an unofficial fan study, not affiliated with the rights holders of Twin Peaks. The licenses above cover these files only; they grant no rights in the series, its characters, its sets or its names. 这是非官方同人习作，与《双峰》权利方无关；以上许可只涉及这些文件，不代表对原剧及其人物、布景、名称的任何授权。
