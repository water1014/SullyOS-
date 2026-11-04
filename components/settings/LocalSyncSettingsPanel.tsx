import React, { useCallback, useEffect, useState } from 'react';
import {
    getSyncPreference,
    getSyncQueueSummary,
    setSyncPreference,
    type SyncQueueSummary,
} from '../../utils/localSyncStore';

const SYNC_LABELS = [{ entityType: 'room_note' as const, label: '房间便签', detail: '只允许同步便签文字，不包含关联聊天或附件。' }];

export default function LocalSyncSettingsPanel() {
    const [enabled, setEnabled] = useState(false);
    const [queue, setQueue] = useState<SyncQueueSummary>({ pending: 0, inFlight: 0, blocked: 0 });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const refresh = useCallback(async () => {
        try {
            const [preference, summary] = await Promise.all([
                getSyncPreference('room_note'),
                getSyncQueueSummary(),
            ]);
            setEnabled(preference.enabled && preference.mode === 'text');
            setQueue(summary);
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
            <div className="grid grid-cols-3 gap-2">
                <div className="rounded-xl bg-white p-2 text-center"><strong className="block text-base text-slate-700">{queue.pending}</strong><span className="text-[10px] text-slate-400">待处理</span></div>
                <div className="rounded-xl bg-white p-2 text-center"><strong className="block text-base text-slate-700">{queue.inFlight}</strong><span className="text-[10px] text-slate-400">处理中</span></div>
                <div className="rounded-xl bg-white p-2 text-center"><strong className="block text-base text-slate-700">{queue.blocked}</strong><span className="text-[10px] text-slate-400">已阻止</span></div>
            </div>
            {error && <p role="alert" className="text-[11px] text-rose-600">{error}</p>}
            <p className="text-[10px] leading-relaxed text-slate-400">关闭开关会清除该类别尚未发送的队列事件，但不会删除原始便签。正式云同步、设备配对和云端清理入口尚未开放。</p>
        </section>
    );
}
