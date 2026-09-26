'use strict';
/**
 * preload — 渲染进程唯一的对外通道。
 * 只暴露明确列出的方法，不把 ipcRenderer 整个交出去。
 */
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  // 启动信息
  boot: () => ipcRenderer.invoke('app:boot'),

  // 对话管理
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  createSession: (cwd) => ipcRenderer.invoke('sessions:create', { cwd }),
  getSession: (id) => ipcRenderer.invoke('sessions:get', { id }),
  renameSession: (id, title) => ipcRenderer.invoke('sessions:rename', { id, title }),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', { id }),
  setItems: (id, items) => ipcRenderer.invoke('sessions:setItems', { id, items }),

  // 对话进行
  send: (sessionId, text) => ipcRenderer.invoke('chat:send', { sessionId, text }),
  interrupt: () => ipcRenderer.invoke('chat:interrupt'),
  engineStatus: () => ipcRenderer.invoke('engine:status'),

  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 模型配置档案（供应商 / 模型切换，对标 cc-switch）
  profiles: {
    state: () => ipcRenderer.invoke('profiles:state'),
    save: (payload) => ipcRenderer.invoke('profiles:save', payload),
    remove: (id) => ipcRenderer.invoke('profiles:delete', { id }),
    activate: (id) => ipcRenderer.invoke('profiles:activate', { id }),
    setSyncGlobal: (value) => ipcRenderer.invoke('profiles:setSyncGlobal', { value }),
    test: (arg) => ipcRenderer.invoke('profiles:test', arg || {}),
    models: (arg) => ipcRenderer.invoke('profiles:models', arg || {}),
    importCcSwitch: (opts) => ipcRenderer.invoke('profiles:importCcSwitch', opts || {}),
    importGlobal: () => ipcRenderer.invoke('profiles:importGlobal'),
    globalEnv: () => ipcRenderer.invoke('profiles:globalEnv'),
  },

  // 技能管家（~/.workbuddy/skills 一键停用 / 恢复）
  // 停用 = 挪到 skills-disabled，不删除；名字在主进程里做几何校验
  skills: {
    state: () => ipcRenderer.invoke('skills:state'),
    disable: (names) => ipcRenderer.invoke('skills:disable', { names }),
    enable: (names) => ipcRenderer.invoke('skills:enable', { names }),
    reveal: (name, zone) => ipcRenderer.invoke('skills:reveal', { name, zone }),
    openRoot: (zone) => ipcRenderer.invoke('skills:openRoot', { zone }),
  },

  // 系统交互
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  pickFile: (opts) => ipcRenderer.invoke('dialog:pickFile', opts),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  openMemory: () => ipcRenderer.invoke('memory:open'),

  // 事件流
  onEngineEvent: (cb) => subscribe('engine:event', cb),
  onSettingsChanged: (cb) => subscribe('settings:changed', cb),
  onProfilesChanged: (cb) => subscribe('profiles:changed', cb),
});
