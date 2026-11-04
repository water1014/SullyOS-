import {
  downloadAndVerifyAndroidUpdate, fetchAndroidUpdateManifest, getInstalledAndroidAppInfo,
  installVerifiedAndroidUpdate, openInstallPermissionSettings, type AndroidUpdateManifest,
} from './androidAppUpdate';
import { App } from '@capacitor/app';
import { trackEvent } from './analytics';

type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'permission' | 'installing' | 'ready' | 'latest' | 'installed' | 'error';
interface PendingInstall { versionCode: number; versionName: string; }
interface UpdateState {
  phase: Phase;
  manifest: AndroidUpdateManifest | null;
  downloadedPath: string;
  progress: number;
  message: string;
}
interface Dependencies {
  getInstalled: typeof getInstalledAndroidAppInfo;
  fetchManifest: typeof fetchAndroidUpdateManifest;
  download: typeof downloadAndVerifyAndroidUpdate;
  install: typeof installVerifiedAndroidUpdate;
  openInstallPermissionSettings: () => Promise<void>;
  track: typeof trackEvent;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

const PENDING_INSTALL_KEY = 'sullyos.android.pending-install.v1';

const getSafeStorage = (): Dependencies['storage'] => {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; }
  catch { return undefined; }
};

const readPendingInstall = (storage?: Dependencies['storage']): PendingInstall | null => {
  try {
    const raw = storage?.getItem(PENDING_INSTALL_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingInstall>;
    return Number.isSafeInteger(value.versionCode) && Number(value.versionCode) > 0
      && typeof value.versionName === 'string'
      ? { versionCode: Number(value.versionCode), versionName: value.versionName.slice(0, 80) }
      : null;
  } catch { return null; }
};

const errorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  return /Failed to fetch|NetworkError|timeout/i.test(message)
    ? '网络连接失败，请稍后重试' : message || '检查更新失败，请稍后重试';
};

// One in-memory session per WebView, independent of page mounts. This is not
// resumable downloading across app termination; native verification is still required.
export const createAndroidUpdateSession = (deps: Dependencies) => {
  const storage = deps.storage ?? getSafeStorage();
  const pendingAtStart = readPendingInstall(storage);
  let state: UpdateState = {
    phase: pendingAtStart ? 'ready' : 'idle', manifest: null, downloadedPath: '', progress: 0,
    message: pendingAtStart ? `正在核对上次更新 ${pendingAtStart.versionName} 是否安装完成` : '',
  };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch };
    listeners.forEach(listener => listener());
  };
  const busy = () => ['checking', 'downloading', 'installing'].includes(state.phase);
  const check = async () => {
    if (busy()) return;
    update({ phase: 'checking', message: '', manifest: null, downloadedPath: '', progress: 0 });
    try {
      const [installed, latest] = await Promise.all([deps.getInstalled(), deps.fetchManifest()]);
      if (latest.versionCode <= installed.versionCode) {
        update({ phase: 'latest', message: `当前 ${installed.versionName || installed.versionCode} 已是最新版` });
        deps.track('Android 检查更新', { result: 'latest', versionCode: installed.versionCode });
      } else {
        update({ phase: 'available', manifest: latest, message: `发现新版本 ${latest.versionName}` });
        deps.track('Android 检查更新', { result: 'available', versionCode: latest.versionCode });
      }
    } catch (error) {
      update({ phase: 'error', message: errorMessage(error) });
      deps.track('Android 检查更新', { result: 'failed' });
    }
  };
  const install = async (path: string, manifest: AndroidUpdateManifest) => {
    update({ phase: 'installing' });
    const result = await deps.install(path, manifest);
    update(result.status === 'permission_required'
      ? { phase: 'permission', message: '请允许“安装未知应用”，返回后点“继续安装”' }
      : { phase: 'ready', message: '已打开 Android 系统安装器，返回应用后会自动核对安装结果' });
    if (result.status === 'installer_opened' && state.manifest) {
      try {
        storage?.setItem(PENDING_INSTALL_KEY, JSON.stringify({
          versionCode: state.manifest.versionCode, versionName: state.manifest.versionName,
        } satisfies PendingInstall));
      } catch { /* Version confirmation remains available during this WebView session. */ }
    }
    return result;
  };
  const download = async () => {
    if (state.phase !== 'available' || !state.manifest) return;
    const manifest = state.manifest;
    update({ phase: 'downloading', progress: 0, downloadedPath: '', message: '正在下载并校验正式安装包' });
    try {
      const path = await deps.download(manifest, progress => {
        if (state.phase === 'downloading' && Number.isFinite(progress)) {
          update({ progress: Math.max(state.progress, Math.min(1, Math.max(0, progress))) });
        }
      });
      update({ downloadedPath: path, progress: 1 });
      const result = await install(path, manifest);
      // Preserve existing analytics; permission settings are not an opened installer.
      if (result.status === 'installer_opened') {
        deps.track('Android 下载更新', { result: 'installer-opened', versionCode: manifest.versionCode });
      }
    } catch (error) {
      update({ phase: 'error', message: errorMessage(error) });
      deps.track('Android 下载更新', { result: 'failed', versionCode: manifest.versionCode });
    }
  };
  const openInstallPermissionSettings = async () => {
    if (state.phase !== 'permission') return;
    try {
      await deps.openInstallPermissionSettings();
      update({ message: '已打开系统授权页面。允许安装后返回这里，再点“我已允许，继续安装”' });
    } catch (error) {
      update({ message: errorMessage(error) });
    }
  };
  const verifyInstallCompletion = async () => {
    const pending = readPendingInstall(storage);
    if (!pending) return;
    try {
      const installed = await deps.getInstalled();
      if (installed.versionCode >= pending.versionCode) {
        try { storage?.removeItem(PENDING_INSTALL_KEY); } catch { /* Non-fatal. */ }
        update({
          phase: 'installed', manifest: null, downloadedPath: '', progress: 1,
          message: `更新已安装成功，当前版本 ${installed.versionName || installed.versionCode}`,
        });
      } else {
        update({
          phase: 'ready',
          message: `尚未检测到 ${pending.versionName}。如果你在系统安装器中取消了操作，可以重新检查更新`,
        });
      }
    } catch (error) {
      update({ message: `暂时无法确认安装结果：${errorMessage(error)}` });
    }
  };
  const continueInstall = async () => {
    if (busy() || !state.manifest || !state.downloadedPath) return;
    try {
      await install(state.downloadedPath, state.manifest);
    } catch (error) {
      // A missing/corrupt cache file must permit an explicit fresh check/download.
      update({ phase: 'error', downloadedPath: '', message: errorMessage(error) });
    }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    check, download, continueInstall, openInstallPermissionSettings, verifyInstallCompletion,
  };
};

export const androidUpdateSession = createAndroidUpdateSession({
  getInstalled: getInstalledAndroidAppInfo, fetchManifest: fetchAndroidUpdateManifest,
  download: downloadAndVerifyAndroidUpdate, install: installVerifiedAndroidUpdate,
  openInstallPermissionSettings,
  track: trackEvent,
});

// Android may stop and recreate the WebView while the package installer runs.
// Keep only the target version in localStorage, then verify the installed package
// when the app returns or the process is recreated. No APK path or credentials persist.
void App.addListener('appStateChange', ({ isActive }) => {
  if (isActive) void androidUpdateSession.verifyInstallCompletion();
}).catch(() => undefined);
void androidUpdateSession.verifyInstallCompletion();
