# 红色房间 · WebXR

以 1990–1991 原剧为依据，将现有 Blender v7 场景转换成可自由探索的 WebXR 体验。全局连接、完整尺寸和循环变化属于推定与创作。

## 使用

在支持 WebXR 的头显浏览器中，通过 HTTPS 打开本站，选择“进入 VR”。本版本围绕 VR 手柄设计：按住扳机瞄准，松开传送；摇杆左右拨动，每次转向 30°。不会自动驱动头部视角。使用头显系统菜单结束会话。

电脑：WASD / 方向键移动，拖动画面转头，Esc 返回菜单。手机：方向按钮移动，拖动画面转头。“路线提示”显示下一个地面路标。完整绕行后，米洛雕像消失，镜像房切换为双人椅；再走一圈恢复。重置回到第一圈。

启动：

```sh
npm ci
npm run preview
```

打开 `http://localhost:4173`。localhost 只用于本机开发；头显访问另一台电脑的普通 HTTP 地址不能用于 WebXR。正式版本应通过 HTTPS 访问。

## 实现与验证

静态 HTML / CSS / ES modules；Three.js 0.186.1 自托管，运行时没有第三方 CDN、控制器模型下载、用户数据收集或后端依赖。1 单位 = 1 米；Y 轴向上。`simulation.js` 独立管理地面范围、碰撞、按顺序到访的路线检查点和房态。`xr-controls.js` 管理双手柄弧线、传送和绕真实头部位置的分段转向。

GLB 由原生 Blender v7 减面导出。灯光以 Cycles 采样烘焙到顶点颜色，避免头显实时计算大量灯光。原生 Blender 文件保持不变。实时版本与离线最终渲染存在细节差异。

5 个 GLB 共约 3.11 MB，包含两个房态的帘幕布光。原始模型合计约 61 万三角形（含互斥状态）；按房间合并为 19 个资产绘制批次并进行视锥剔除。地板采用连续的近似照明和轻量接触阴影，避免分层地板烘焙自遮挡。使用 Meshopt 压缩；解码器一并自托管。以上为资产统计，不代表实体头显帧率。

```sh
npm test
npm run check
# 先保持 npm run preview 运行；QA 使用本机 Chrome
npm run qa
```

测试覆盖门洞、墙体、家具、滑动碰撞、禁止穿墙传送、两圈状态恢复、头部偏移与转向枢轴、进入墙体时渐暗，以及桌面 Chromium WebGL 页面。实体头显性能、舒适性和不同设备的输入兼容性尚待实测。

## 来源与许可

非官方同人空间习作，与《双峰》权利方无关联。参考原剧房间、布景与道具；没有使用剧集音乐、视频或人物影像。

- 米洛维纳斯：Statens Museum for Kunst，CC0 / 公共领域。
- 美第奇维纳斯：Geoffrey Marchal，CC BY-NC-SA 4.0。[原始来源](https://sketchfab.com/3d-models/venus-medici-708a4166439c45d799f4eaa40d0db70e)。实时版对网格进行了减面并烘焙光照。包含该雕像的合并 GLB 属于衍生资产，保留署名、非商业和相同方式共享限制。详见 `dist/assets/credits.txt` 和附带许可文本。
- Three.js：MIT，许可位于 `dist/vendor/THREE-LICENSE.txt`。
- Meshoptimizer：MIT，许可位于 `dist/vendor/MESHOPT-LICENSE.txt`。
- [场景研究参考](https://twinpeaksgazette.com/2017/07/22/iconography-of-the-red-room/)。
- [WebXR 的 HTTPS 与权限要求](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API/Permissions_and_security)。

不要将资产的许可范围理解为对原剧知识产权的授权。
