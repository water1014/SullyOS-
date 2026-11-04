import React, { useCallback, useEffect, useState } from 'react';
import {
    clearLatestScreenFrame,
    getLatestScreenFrame,
    getScreenAwarenessStatus,
    isScreenAwarenessAvailable,
    startScreenAwareness,
    stopScreenAwareness,
} from '../../utils/androidScreenAwareness';

const ScreenAwarenessSettingsPanel: React.FC = () => {
    const available = isScreenAwarenessAvailable();
    const [active, setActive] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [preview, setPreview] = useState('');
    const [capturedAt, setCapturedAt] = useState(0);

    const refreshStatus = useCallback(async () => {
        if (!available) return;
        try {
            const status = await getScreenAwarenessStatus();
            setActive(status.active);
        } catch {
            setActive(false);
        }
    }, [available]);

    useEffect(() => {
        void refreshStatus();
        if (!available) return;
        const timer = window.setInterval(() => { void refreshStatus(); }, 3000);
        return () => window.clearInterval(timer);
    }, [available, refreshStatus]);

    const handleStart = async () => {
        setBusy(true);
        setMessage('');
        try {
            await startScreenAwareness();
            setActive(true);
            setMessage('请在 Android 系统弹窗中确认屏幕共享。开启后，通知栏会一直显示停止入口。');
        } catch (error) {
            setMessage(error instanceof Error ? error.message : '屏幕感知没有开启');
            await refreshStatus();
        } finally {
            setBusy(false);
        }
    };

    const handleStop = async () => {
        setBusy(true);
        try {
            await stopScreenAwareness();
            setActive(false);
            setPreview('');
            setCapturedAt(0);
            setMessage('屏幕感知已停止，本机临时画面已清理。');
        } catch (error) {
            setMessage(error instanceof Error ? error.message : '停止屏幕感知失败');
        } finally {
            setBusy(false);
        }
    };

    const handlePreview = async () => {
        setBusy(true);
        setMessage('');
        try {
            const frame = await getLatestScreenFrame();
            setPreview(`data:${frame.mimeType};base64,${frame.base64}`);
            setCapturedAt(frame.capturedAt);
            setMessage('画面只在当前手机本地预览，没有上传或发送给聊天。');
        } catch (error) {
            setMessage(error instanceof Error ? error.message : '暂时没有可读取的画面，请稍后重试');
        } finally {
            setBusy(false);
        }
    };

    const handleClear = async () => {
        setBusy(true);
        try {
            await clearLatestScreenFrame();
            setPreview('');
            setCapturedAt(0);
            setMessage('本机临时画面已清理。');
        } catch (error) {
            setMessage(error instanceof Error ? error.message : '清理画面失败');
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="mb-4 rounded-2xl border border-sky-100 bg-gradient-to-br from-sky-50 to-white p-4">
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-100 text-sky-700">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-5 w-5">
                            <rect x="3" y="4" width="18" height="13" rx="2" />
                            <path strokeLinecap="round" d="M8 21h8m-4-4v4" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="m8 10 2.2 2.2L16 7.5" />
                        </svg>
                    </span>
                    <div className="min-w-0">
                        <div className="text-sm font-bold text-slate-800">整机屏幕感知</div>
                        <div className="mt-0.5 text-[10px] text-slate-500">Android 系统授权 · 本机处理</div>
                    </div>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold ${active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                    {active ? '正在运行' : '已停止'}
                </span>
            </div>

            <p className="mt-3 text-[11px] leading-relaxed text-slate-600">
                开启前需要允许通知，然后会弹出 Android 官方屏幕共享确认框；运行期间通知栏会显示持续提示和停止按钮。当前版本每隔数秒只在本机缓存最新画面，不会自动上传云端，也不会自动发给宋祁。
            </p>

            {!available ? (
                <div className="mt-3 rounded-xl border border-amber-100 bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-800">
                    此功能需要安装到 Android App 后使用。当前网页预览不能读取整台手机屏幕。
                </div>
            ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                    {!active ? (
                        <button type="button" onClick={handleStart} disabled={busy} className="rounded-xl bg-sky-600 px-4 py-2.5 text-xs font-bold text-white shadow-sm disabled:opacity-50">
                            {busy ? '正在启动…' : '授权并开启'}
                        </button>
                    ) : (
                        <>
                            <button type="button" onClick={handlePreview} disabled={busy} className="rounded-xl bg-sky-600 px-4 py-2.5 text-xs font-bold text-white shadow-sm disabled:opacity-50">
                                {busy ? '读取中…' : '查看本机画面'}
                            </button>
                            <button type="button" onClick={handleStop} disabled={busy} className="rounded-xl border border-rose-200 bg-white px-4 py-2.5 text-xs font-bold text-rose-600 disabled:opacity-50">
                                停止感知
                            </button>
                        </>
                    )}
                </div>
            )}

            {preview && (
                <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-slate-950">
                    <img src={preview} alt="本机屏幕感知预览" className="block max-h-72 w-full object-contain" />
                    <div className="flex items-center justify-between gap-2 bg-white px-3 py-2">
                        <span className="text-[10px] text-slate-500">
                            {capturedAt ? new Date(capturedAt).toLocaleTimeString() : '本机临时画面'}
                        </span>
                        <button type="button" onClick={handleClear} disabled={busy} className="text-[10px] font-bold text-rose-600 disabled:opacity-50">
                            清除画面
                        </button>
                    </div>
                </div>
            )}

            {message && (
                <p aria-live="polite" className="mt-3 rounded-xl bg-white/80 px-3 py-2 text-[10px] leading-relaxed text-slate-600">
                    {message}
                </p>
            )}

            <div className="mt-3 border-t border-sky-100 pt-3 text-[10px] leading-relaxed text-slate-400">
                注意：Android 安全页面、DRM 内容和应用主动设置的防截屏页面可能无法捕获。离开 App 后仍可通过通知栏停止；卸载或清除数据也会结束本机服务。
            </div>
        </section>
    );
};

export default ScreenAwarenessSettingsPanel;
