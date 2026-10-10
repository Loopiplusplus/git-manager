/**
 * Preload · 渲染进程与主进程之间唯一的桥。
 *
 * 只暴露三件事，全部是「调用」而不是「能力」：
 *   - pickFolder / pickFile：弹原生对话框
 *   - appInfo / openDataDir / restartSidecar：应用级小操作
 *
 * 刻意**不**暴露：fs、child_process、任意 ipcRenderer.send、任意路径读写。
 * 页面拿不到文件系统，只能拿到「用户刚刚亲手选中的那个路径」。
 * 这也是为什么这里用的是 .cjs —— preload 走 CommonJS 最稳，不受 ESM 沙箱限制。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gmDesktop', {
  isDesktop: true,
  platform: process.platform,
  electronVersion: process.versions.electron,

  pickFolder: (opts = {}) => ipcRenderer.invoke('gm:dialog:pickFolder', opts),
  pickFile: (opts = {}) => ipcRenderer.invoke('gm:dialog:pickFile', opts),

  appInfo: () => ipcRenderer.invoke('gm:app:info'),
  openDataDir: () => ipcRenderer.invoke('gm:app:openDataDir'),
  restartSidecar: () => ipcRenderer.invoke('gm:app:restartSidecar'),
});
