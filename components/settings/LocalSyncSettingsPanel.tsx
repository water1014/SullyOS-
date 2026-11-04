import React, { useCallback, useEffect, useState } from 'react';
import {
    getSyncPreference,
    getSyncQueueSummary,
    listUnresolvedSyncConflicts,
    resolveRoomNoteSyncConflict,
    recoverStaleInFlightSyncEvents,
    getOrCreateLocalSyncDeviceIdentity,
    updateLocalSyncDeviceLabel,
    setSyncPreference,
    getCompanionSyncConnection,
    type CompanionSyncConnection,
    type LocalSyncConflict,
    type SyncQueueSummary,
} from '../../utils/localSyncStore';
import { pairCompanionDevice, syncCompanionOnce, disconnectCompanionDevice, setCompanionRemoteSyncPolicy, hasCompanionDeviceToken, listCompanionDevices, revokeCompanionDevice, type CompanionRemoteDevice } from '../../utils/companionSyncClient';
import { isPersistentSecureStorageAvailable } from '../../utils/androidSecureStorage';

const SYNC_LABELS = [{ entityType: 'room_note' as const, label: '房间便签', detail: '只允许同步便签文字，不包含关联聊天或附件。' }];

export default function LocalSyncSettingsPanel() {
    const [enabled, setEnabled] = useState(false);
    const [localDeviceId, setLocalDeviceId] = useState('');
    const [deviceLabel, setDeviceLabel] = useState('这台手机');
    const [connection, setConnection] = useState<CompanionSyncConnection | null>(null);
    const [tokenAvailable, setTokenAvailable] = useState(false);
    const [remoteDevices, setRemoteDevices] = useState<CompanionRemoteDevice[]>([]);
    const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null);
    const [serverUrl, setServerUrl] = useState('');
    const [pairingCode, setPairingCode] = useState('');
    const [syncBusy, setSyncBusy] = useState(false);
    const [syncStatus, setSyncStatus] = useState('');
    const [savingDeviceLabel, setSavingDeviceLabel] = useState(false);
    const [queue, setQueue] = useState<SyncQueueSummary>({ pending: 0, inFlight: 0, blocked: 0 });
    const [conflicts, setConflicts] = useState<LocalSyncConflict[]>([]);
    const [resolving, setResolving] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const refresh = useCallback(async () => {
        try {
            await recoverStaleInFlightSyncEvents();
            const [preference, summary, unresolved, identity, savedConnection, hasToken] = await Promise.all([
                getSyncPreference('room_note'),
                getSyncQueueSummary(),
                listUnresolvedSyncConflicts(),
                getOrCreateLocalSyncDeviceIdentity(),
                getCompanionSyncConnection(),
                hasCompanionDeviceToken(),
            ]);
            setEnabled(preference.enabled && preference.mode === 'text');
            setLocalDeviceId(identity.deviceId);
            setDeviceLabel(identity.label || '这台手机');
            setConnection(savedConnection);
            setTokenAvailable(hasToken);
            if (savedConnection && hasToken) {
                try { setRemoteDevices(await listCompanionDevices()); }
                catch { setRemoteDevices([]); }
            } else {
                setRemoteDevices([]);
            }

            setQueue(summary);
            setConflicts(unresolved);
            setError('');
        } catch {
            setError('读取本地同步状态失败，请稍后重试。');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void refresh(); }, [refresh]);

    const toggle = async (next: boolean) => {
        if (saving) return;
        setSaving(true);
        setError('');
        try {
            await setSyncPreference('room_note', next, next ? 'text' : 'local_only');
            setEnabled(next);
            if (connection) {
                try {
                    await setCompanionRemoteSyncPolicy(next);
                    setSyncStatus(next ? '已允许便签文字同步。点击“立即同步”开始传输。' : '云端已确认停止同步并清理便签副本。');
                } catch {
                    setSyncStatus(next
                        ? '本机已开启待同步队列，但云端授权未更新。联网后请重试。'
                        : '本机已停止同步并清除待发送内容，但云端清理尚未确认，请联网后重试。');
                }
            } else {
                setSyncStatus(next ? '已允许便签文字进入本地待同步队列。配对云端后才会传输。' : '本地同步已关闭。');
            }
            await refresh();
        } catch {
            setError('保存失败，本地数据没有被上传。');
        } finally {
            setSaving(false);
        }
    };

    return (
        <section className="mb-4 rounded-2xl border border-sky-100 bg-gradient-to-br from-sky-50/90 to-white p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <h3 className="text-sm font-bold text-slate-800">宋祁 · 设备与同步</h3>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-500">本机队列、设备配对和手动同步入口已接入。服务器尚未部署前，数据仍只保存在这台手机。</p>
                </div>
                <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[10px] font-semibold text-amber-700">本机优先</span>
            </div>
            <div className="space-y-3 rounded-xl border border-sky-100 bg-white/90 p-3">
                <div className="flex items-center justify-between gap-2">
                    <div>
                        <p className="text-xs font-bold text-slate-700">云端设备配对</p>
                        <p className="mt-1 text-[10px] leading-relaxed text-slate-400">服务器准备好后，输入服务器地址和一次性配对码。每台设备使用独立令牌。</p>
                    </div>
                    <span className={connection ? "rounded-full bg-emerald-50 px-2 py-1 text-[10px] text-emerald-700" : "rounded-full bg-slate-100 px-2 py-1 text-[10px] text-slate-500"}>{connection ? '已配对' : '未连接'}</span>
                </div>
                {connection ? (
                    <>
                        <div className="rounded-lg bg-slate-50 p-3">
                            <p className="text-[10px] text-slate-400">当前同步服务器</p>
                            <p className="mt-1 break-all text-xs font-medium text-slate-700">{connection.baseUrl}</p>
                            <p className="mt-1 text-[10px] text-slate-400">设备：{connection.label} · {connection.serverDeviceId.slice(0, 8)}</p>
                        </div>
                        {!isPersistentSecureStorageAvailable() && <p className="text-[10px] leading-relaxed text-amber-700">当前是浏览器预览环境，令牌只保存在当前页面内存，刷新后需要重新配对。正式 APK 会使用 Android Keystore。</p>}
                        {connection && !tokenAvailable && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                            <p className="text-[11px] font-semibold text-amber-800">设备凭据不可用，需要重新配对</p>
                            <p className="mt-1 text-[10px] leading-relaxed text-amber-700">可能是浏览器预览刷新、重装或系统恢复导致。原始便签不会受影响。</p>
                            <button type="button" disabled={syncBusy} onClick={async () => {
                                setSyncBusy(true);
                                try {
                                    await disconnectCompanionDevice(false);
                                    setSyncStatus('已清除失效的本地配对信息，可以重新输入配对码。');
                                    await refresh();
                                } catch { setError('清除本地配对信息失败。'); }
                                finally { setSyncBusy(false); }
                            }} className="mt-2 rounded-lg bg-amber-100 px-3 py-2 text-[10px] font-semibold text-amber-800">清除失效配对</button>
                        </div>}
                        {tokenAvailable && (
                            <div className="space-y-2 rounded-lg border border-slate-100 bg-white p-3">
                                <div className="flex items-center justify-between gap-2">
                                    <p className="text-[11px] font-bold text-slate-700">已配对设备</p>
                                    <button type="button" disabled={syncBusy} onClick={() => void refresh()} className="text-[10px] font-semibold text-sky-700">刷新</button>
                                </div>
                                {remoteDevices.length === 0 ? (
                                    <p className="text-[10px] text-slate-400">暂时无法读取设备列表，检查服务器连接后刷新。</p>
                                ) : remoteDevices.map(device => {
                                    const isCurrent = device.id === connection.serverDeviceId;
                                    const lastSeen = device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : '尚无在线记录';
                                    return (
                                        <div key={device.id} className="flex items-center justify-between gap-2 border-t border-slate-50 pt-2">
                                            <div className="min-w-0">
                                                <p className="truncate text-[11px] font-semibold text-slate-700">{device.label} {isCurrent ? '· 当前设备' : ''}</p>
                                                <p className="mt-0.5 text-[10px] text-slate-400">{device.platform} · 最近活动：{lastSeen}</p>
                                            </div>
                                            {isCurrent ? (
                                                <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-1 text-[9px] text-emerald-700">本机</span>
                                            ) : (
                                                <button type="button" disabled={syncBusy || revokingDeviceId === device.id} onClick={async () => {
                                                    if (!window.confirm(`确定撤销设备“${device.label}”吗？撤销后该设备需要重新配对。`)) return;
                                                    setRevokingDeviceId(device.id);
                                                    setError('');
                                                    try {
                                                        await revokeCompanionDevice(device.id);
                                                        setSyncStatus(`已撤销设备“${device.label}”。`);
                                                        await refresh();
                                                    } catch (revokeError) {
                                                        setError(revokeError instanceof Error ? `撤销失败：${revokeError.message}` : '撤销设备失败，请重试。');
                                                    } finally { setRevokingDeviceId(null); }
                                                }} className="shrink-0 rounded-lg border border-rose-200 px-2 py-1.5 text-[10px] font-semibold text-rose-600 disabled:opacity-40">{revokingDeviceId === device.id ? '撤销中…' : '撤销'}</button>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        <div className="flex gap-2">
                            <button type="button" disabled={!enabled || syncBusy || !tokenAvailable} onClick={async () => {
                                setSyncBusy(true);
                                setError('');
                                setSyncStatus('正在上传并接收便签…');
                                try {
                                    const result = await syncCompanionOnce();
                                    setSyncStatus(`同步完成：上传 ${result.pushed} 条，接收 ${result.received} 条，应用 ${result.applied} 条，冲突 ${result.conflicts} 条。`);
                                    await refresh();
                                } catch (syncError) {
                                    setError(syncError instanceof Error ? `同步失败：${syncError.message}` : '同步失败，请检查网络和服务器地址。');
                                    setSyncStatus('');
                                } finally { setSyncBusy(false); }
                            }} className="flex-1 rounded-lg bg-sky-600 px-3 py-2.5 text-xs font-semibold text-white disabled:opacity-40">{syncBusy ? '同步中…' : '立即同步'}</button>
                            <button type="button" disabled={syncBusy} onClick={async () => {
                                setSyncBusy(true);
                                setError('');
                                try {
                                    await disconnectCompanionDevice(true);
                                    setSyncStatus('已撤销本设备云端令牌并断开配对。');
                                    await refresh();
                                } catch (disconnectError) {
                                    setError(disconnectError instanceof Error ? `断开失败：${disconnectError.message}` : '断开失败，请联网后重试。');
                                } finally { setSyncBusy(false); }
                            }} className="rounded-lg border border-rose-200 px-3 py-2.5 text-xs font-semibold text-rose-600 disabled:opacity-40">断开</button>
                        </div>
                    </>
                ) : (
                    <>
                        <input value={serverUrl} onChange={event => setServerUrl(event.target.value)} placeholder="https://你的同步服务器地址" aria-label="同步服务器地址" className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-xs outline-none focus:border-sky-300" />
                        <input value={pairingCode} onChange={event => setPairingCode(event.target.value)} placeholder="一次性配对码" aria-label="一次性配对码" autoComplete="off" className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-xs outline-none focus:border-sky-300" />
                        <button type="button" disabled={syncBusy || !serverUrl.trim() || !pairingCode.trim()} onClick={async () => {
                            setSyncBusy(true);
                            setError('');
                            try {
                                const result = await pairCompanionDevice({ baseUrl: serverUrl, pairingCode, label: deviceLabel });
                                setPairingCode('');
                                setSyncStatus(result.persistentTokenStorage ? '设备配对成功，令牌已存入 Android Keystore。' : '配对成功，但当前预览环境令牌仅保存在页面内存。');
                                await refresh();
                            } catch (pairError) {
                                setError(pairError instanceof Error ? `配对失败：${pairError.message}` : '配对失败，请检查服务器地址和配对码。');
                            } finally { setSyncBusy(false); }
                        }} className="w-full rounded-lg bg-slate-800 px-3 py-2.5 text-xs font-semibold text-white disabled:opacity-40">{syncBusy ? '正在配对…' : '配对这台设备'}</button>
                    </>
                )}
                {syncStatus && <p role="status" className="text-[10px] leading-relaxed text-sky-700">{syncStatus}</p>}
            </div>
            <div className="space-y-2 rounded-xl border border-slate-100 bg-white/80 p-3">
                <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] text-slate-500">本机设备编号 · 仅用于区分安装实例</span>
                    <code className="text-[10px] font-semibold tracking-wide text-slate-600">{localDeviceId ? localDeviceId.slice(0, 8) : '读取中'}</code>
                </div>
                <div className="flex gap-2">
                    <input
                        value={deviceLabel}
                        onChange={event => setDeviceLabel(event.target.value)}
                        maxLength={24}
                        placeholder="给这台设备起个名字"
                        aria-label="本机设备名称"
                        className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-sky-300"
                    />
                    <button
                        type="button"
                        disabled={loading || savingDeviceLabel || !deviceLabel.trim()}
                        onClick={async () => {
                            setSavingDeviceLabel(true);
                            try {
                                const identity = await updateLocalSyncDeviceLabel(deviceLabel);
                                setDeviceLabel(identity.label);
                                setError('');
                            } catch {
                                setError('设备名称保存失败，请检查名称后重试。');
                            } finally {
                                setSavingDeviceLabel(false);
                            }
                        }}
                        className="shrink-0 rounded-lg bg-sky-100 px-3 py-2 text-[10px] font-semibold text-sky-700 disabled:opacity-50"
                    >{savingDeviceLabel ? '保存中' : '保存名称'}</button>
                </div>
            </div>
            {SYNC_LABELS.map(item => (
                <label key={item.entityType} className="flex items-start justify-between gap-3 rounded-xl border border-slate-100 bg-white/90 p-3">
                    <span className="min-w-0">
                        <span className="block text-xs font-semibold text-slate-700">{item.label} · 文字</span>
                        <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">{item.detail}</span>
                    </span>
                    <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 shrink-0 accent-sky-600"
                        checked={enabled}
                        disabled={loading || saving}
                        onChange={event => void toggle(event.target.checked)}
                        aria-label="允许房间便签文字进入本地待同步队列"
                    />
                </label>
            ))}

            {conflicts.length > 0 && (
                <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/70 p-3">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-amber-800">需要你决定的便签冲突</span>
                        <span className="text-[10px] text-amber-700">{conflicts.length} 条</span>
                    </div>
                    {conflicts.map(conflict => (
                        <div key={conflict.conflictId} className="rounded-lg bg-white/90 p-3">
                            <p className="text-[10px] font-semibold text-slate-500">本机版本</p>
                            <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-700">{String(conflict.localSnapshot?.content ?? '（本机记录已删除）')}</p>
                            <p className="mt-2 text-[10px] font-semibold text-slate-500">另一台设备的版本</p>
                            <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-700">{String(conflict.remoteSnapshot?.content ?? '（另一台设备删除了这条便签）')}</p>
                            <div className="mt-3 flex gap-2">
                                <button type="button" disabled={resolving === conflict.conflictId} onClick={async () => {
                                    setResolving(conflict.conflictId);
                                    try { await resolveRoomNoteSyncConflict(conflict.conflictId, 'keep_local'); await refresh(); }
                                    catch { setError('保留本机版本失败，请重试。'); }
                                    finally { setResolving(null); }
                                }} className="flex-1 rounded-lg bg-slate-100 px-2 py-2 text-[10px] font-semibold text-slate-700 disabled:opacity-50">保留本机</button>
                                <button type="button" disabled={resolving === conflict.conflictId} onClick={async () => {
                                    setResolving(conflict.conflictId);
                                    try { await resolveRoomNoteSyncConflict(conflict.conflictId, 'keep_remote'); await refresh(); }
                                    catch { setError('采用另一台设备版本失败，请重试。'); }
                                    finally { setResolving(null); }
                                }} className="flex-1 rounded-lg bg-sky-100 px-2 py-2 text-[10px] font-semibold text-sky-700 disabled:opacity-50">采用另一台设备</button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <div className="grid grid-cols-3 gap-2">
                <div className="rounded-xl bg-white p-2 text-center"><strong className="block text-base text-slate-700">{queue.pending}</strong><span className="text-[10px] text-slate-400">待处理</span></div>
                <div className="rounded-xl bg-white p-2 text-center"><strong className="block text-base text-slate-700">{queue.inFlight}</strong><span className="text-[10px] text-slate-400">处理中</span></div>
                <div className="rounded-xl bg-white p-2 text-center"><strong className="block text-base text-slate-700">{queue.blocked}</strong><span className="text-[10px] text-slate-400">已阻止</span></div>
            </div>
            {error && <p role="alert" className="text-[11px] text-rose-600">{error}</p>}
            <p className="text-[10px] leading-relaxed text-slate-400">关闭开关会清除本机待发送事件、接收缓存和冲突副本，并尝试要求服务器删除该类云端副本；本机原始便签会保留。服务器尚未部署时，配对与同步暂时无法使用。</p>
        </section>
    );
}
