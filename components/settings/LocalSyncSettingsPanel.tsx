import React, { useCallback, useEffect, useState } from 'react';
import {
    getSyncPreference,
    getSyncQueueSummary,
    listUnresolvedSyncConflicts,
    resolveRoomNoteSyncConflict,
    recoverStaleInFlightSyncEvents,
    setSyncPreference,
    type LocalSyncConflict,
    type SyncQueueSummary,
} from '../../utils/localSyncStore';

const SYNC_LABELS = [{ entityType: 'room_note' as const, label: '房间便签', detail: '只允许同步便签文字，不包含关联聊天或附件。' }];

export default function LocalSyncSettingsPanel() {
    const [enabled, setEnabled] = useState(false);
    const [queue, setQueue] = useState<SyncQueueSummary>({ pending: 0, inFlight: 0, blocked: 0 });
    const [conflicts, setConflicts] = useState<LocalSyncConflict[]>([]);
    const [resolving, setResolving] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const refresh = useCallback(async () => {
        try {
            await recoverStaleInFlightSyncEvents();
            const [preference, summary, unresolved] = await Promise.all([
                getSyncPreference('room_note'),
                getSyncQueueSummary(),
                listUnresolvedSyncConflicts(),
            ]);
            setEnabled(preference.enabled && preference.mode === 'text');
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
                    <h3 className="text-sm font-bold text-slate-800">宋祁 · 本地同步试验</h3>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-500">先管理手机里的同步队列。云端接口尚未接入，开启后也不会上传数据。</p>
                </div>
                <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[10px] font-semibold text-amber-700">本地阶段</span>
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
            <p className="text-[10px] leading-relaxed text-slate-400">关闭开关会清除该类别待发送事件、接收缓存和冲突副本，但保留本机原始便签。正式云同步、设备配对和云端清理入口尚未开放。</p>
        </section>
    );
}
