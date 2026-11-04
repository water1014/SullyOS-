import React, { useState, useEffect } from 'react';
import Modal from '../os/Modal';
import { CharacterProfile } from '../../types';
import {
    loadVisualAutonomySettings,
    saveVisualAutonomySettings,
} from '../../utils/visualCompanion/autonomySettings';
import type { VisualAutonomySettings, VisualTask } from '../../utils/visualCompanion/types';
import { visualCompanionRepository } from '../../utils/visualCompanion/repository';
import { executeVisualTaskInForeground } from '../../utils/visualCompanion/foregroundExecutor';

interface ProactiveSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    char: CharacterProfile;
    isProactiveActive: boolean;
    onSave: (config: NonNullable<CharacterProfile['proactiveConfig']>) => void;
    onStop: () => void;
}

const INTERVAL_OPTIONS = [
    { label: '30 分钟', value: 30 },
    { label: '1 小时', value: 60 },
    { label: '2 小时', value: 120 },
    { label: '4 小时', value: 240 },
    { label: '8 小时', value: 480 },
    { label: '12 小时', value: 720 },
    { label: '24 小时', value: 1440 },
];

const FREQUENCY_OPTIONS: Array<{ label: string; value: VisualAutonomySettings['frequency']; description: string }> = [
    { label: '低频', value: 'low', description: '日常很少主动分享，特殊时刻更积极' },
    { label: '自然适中', value: 'natural', description: '日常偶尔分享，重要时刻更积极' },
    { label: '积极', value: 'high', description: '更愿意主动分享生活瞬间' },
    { label: '暂停', value: 'paused', description: '暂时停止自主图片分享' },
];

const VISUAL_TASK_STATUS_LABELS: Record<VisualTask['status'], string> = {
    queued: '排队中',
    planning: '准备中',
    awaiting_approval: '等待确认',
    generating: '生成中',
    persisting: '保存图片',
    delivery_pending: '准备送达',
    delivered: '已送达',
    retry_wait: '等待重试',
    cancelled: '已取消',
    failed: '失败',
};

const RESUMABLE_VISUAL_TASK_STATUSES = new Set<VisualTask['status']>([
    'queued', 'planning', 'generating', 'persisting', 'delivery_pending', 'retry_wait',
]);

const ProactiveSettingsModal: React.FC<ProactiveSettingsModalProps> = ({
    isOpen, onClose, char, isProactiveActive, onSave, onStop
}) => {
    const saved = char.proactiveConfig;
    const [enabled, setEnabled] = useState(saved?.enabled ?? isProactiveActive);
    const [interval, setInterval_] = useState(saved?.intervalMinutes ?? 60);
    const [visualSettings, setVisualSettings] = useState<VisualAutonomySettings>(
        () => loadVisualAutonomySettings(char.id)
    );
    const [quietHoursEnabled, setQuietHoursEnabled] = useState(
        () => !!loadVisualAutonomySettings(char.id).quietHours
    );
    const [saveError, setSaveError] = useState('');
    const [visualTasks, setVisualTasks] = useState<VisualTask[]>([]);
    const [visualTaskLoading, setVisualTaskLoading] = useState(false);
    const [visualTaskError, setVisualTaskError] = useState('');

    const refreshVisualTasks = async () => {
        setVisualTaskLoading(true);
        setVisualTaskError('');
        try {
            const tasks = await visualCompanionRepository.listTasks(char.id);
            setVisualTasks(tasks.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8));
        } catch (error) {
            setVisualTaskError(error instanceof Error ? error.message : '读取图片任务记录失败');
        } finally {
            setVisualTaskLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen) {
            const s = char.proactiveConfig;
            setEnabled(s?.enabled ?? isProactiveActive);
            setInterval_(s?.intervalMinutes ?? 60);
            const visual = loadVisualAutonomySettings(char.id);
            setVisualSettings(visual);
            setQuietHoursEnabled(!!visual.quietHours);
            setSaveError('');
        }
    }, [isOpen, char.id, char.proactiveConfig, isProactiveActive]);

    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;

        const recoverAndLoadTasks = async () => {
            setVisualTaskLoading(true);
            setVisualTaskError('');
            try {
                const current = await visualCompanionRepository.listTasks(char.id);
                if (cancelled) return;
                setVisualTasks(current.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8));
                setVisualTaskLoading(false);

                const resumable = current
                    .filter(task => RESUMABLE_VISUAL_TASK_STATUSES.has(task.status))
                    .sort((a, b) => a.createdAt - b.createdAt);

                // Show persisted states immediately; recovery continues without blocking the panel.
                // The executor deduplicates concurrent calls and never retries before nextAttemptAt.
                void Promise.all(resumable.map(task => executeVisualTaskInForeground(task.id)))
                    .then(() => visualCompanionRepository.listTasks(char.id))
                    .then(latest => {
                        if (!cancelled) {
                            setVisualTasks(latest.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8));
                        }
                    })
                    .catch(error => {
                        if (!cancelled) {
                            setVisualTaskError(error instanceof Error ? error.message : '恢复图片任务失败');
                        }
                    });
            } catch (error) {
                if (!cancelled) {
                    setVisualTaskError(error instanceof Error ? error.message : '读取图片任务记录失败');
                }
            } finally {
                if (!cancelled) setVisualTaskLoading(false);
            }
        };

        void recoverAndLoadTasks();
        return () => { cancelled = true; };
    }, [isOpen, char.id]);

    const updateVisual = (patch: Partial<VisualAutonomySettings>) => {
        setVisualSettings(previous => ({ ...previous, ...patch }));
    };

    const handleSave = () => {
        try {
            onSave({
                enabled,
                intervalMinutes: interval,
            });
            saveVisualAutonomySettings(char.id, {
                ...visualSettings,
                quietHours: quietHoursEnabled
                    ? (visualSettings.quietHours || { start: '23:00', end: '08:00' })
                    : undefined,
            });
            setSaveError('');
            onClose();
        } catch (error) {
            setSaveError(error instanceof Error ? error.message : '设置保存失败，请稍后重试');
        }
    };

    const handleStop = () => {
        onStop();
        setEnabled(false);
        onClose();
    };

    return (
        <Modal isOpen={isOpen} title="主动消息与视觉分享" onClose={onClose} footer={
            <>
                <button onClick={onClose} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">
                    取消
                </button>
                {isProactiveActive ? (
                    <button onClick={handleStop} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl active:scale-95 transition-transform shadow-lg">
                        停止主动消息
                    </button>
                ) : null}
                <button onClick={handleSave} className="flex-1 py-3 bg-violet-500 text-white font-bold rounded-2xl active:scale-95 transition-transform shadow-lg">
                    保存设置
                </button>
            </>
        }>
            <div className="space-y-6 max-h-[70vh] overflow-y-auto pr-1">
                <section className="space-y-4">
                    <div>
                        <h3 className="text-sm font-bold text-slate-800">主动消息</h3>
                        <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                            开启后，{char.name} 会按照设定的间隔主动给你发消息。
                        </p>
                    </div>

                    <div className="flex items-center justify-between">
                        <span className="text-sm font-bold text-slate-700">启用主动消息</span>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={enabled}
                            onClick={() => setEnabled(!enabled)}
                            className={`w-12 h-7 rounded-full transition-colors relative ${enabled ? 'bg-violet-500' : 'bg-slate-200'}`}
                        >
                            <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                        </button>
                    </div>

                    {isProactiveActive && (
                        <div className="flex items-center gap-2 px-3 py-2 bg-violet-50 rounded-xl border border-violet-100">
                            <span className="w-2 h-2 bg-violet-500 rounded-full animate-pulse" />
                            <span className="text-xs text-violet-600 font-medium">主动消息进行中</span>
                        </div>
                    )}

                    {enabled && (
                        <div>
                            <label className="text-sm font-bold text-slate-700 block mb-2">发送间隔</label>
                            <div className="grid grid-cols-3 gap-2">
                                {INTERVAL_OPTIONS.map(opt => (
                                    <button
                                        type="button"
                                        key={opt.value}
                                        onClick={() => setInterval_(opt.value)}
                                        className={`py-2 px-3 rounded-xl text-xs font-bold transition-all ${interval === opt.value
                                            ? 'bg-violet-500 text-white shadow-md'
                                            : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                                        }`}
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                        主动消息使用当前聊天主 API，调用费用也由主 API 承担。
                    </p>
                </section>

                <div className="border-t border-slate-100" />

                <section className="space-y-4">
                    <div>
                        <h3 className="text-sm font-bold text-slate-800">宋祁 · 视觉主动分享</h3>
                        <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                            控制他是否会在聊天之外，偶尔主动生成一张符合当下情境的图片。此设置按角色分别保存。
                        </p>
                    </div>

                    <div className="flex items-center justify-between">
                        <div className="pr-4">
                            <div className="text-sm font-bold text-slate-700">启用视觉分享系统</div>
                            <div className="text-[11px] text-slate-400 mt-1">首次默认关闭，不会未经允许主动生成</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={visualSettings.enabled}
                            onClick={() => updateVisual({ enabled: !visualSettings.enabled })}
                            className={`w-12 h-7 shrink-0 rounded-full transition-colors relative ${visualSettings.enabled ? 'bg-sky-500' : 'bg-slate-200'}`}
                        >
                            <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${visualSettings.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                        </button>
                    </div>

                    {visualSettings.enabled && (
                        <>
                            <div className="space-y-2">
                                <label className="text-sm font-bold text-slate-700">主动分享频率</label>
                                <div className="grid grid-cols-2 gap-2">
                                    {FREQUENCY_OPTIONS.map(option => (
                                        <button
                                            type="button"
                                            key={option.value}
                                            onClick={() => updateVisual({ frequency: option.value })}
                                            className={`rounded-xl border px-3 py-2 text-left transition-colors ${visualSettings.frequency === option.value
                                                ? 'border-sky-400 bg-sky-50 text-sky-700'
                                                : 'border-slate-200 bg-white text-slate-600'
                                            }`}
                                        >
                                            <span className="block text-xs font-bold">{option.label}</span>
                                            <span className="mt-1 block text-[10px] leading-relaxed opacity-70">{option.description}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="space-y-2">
                                <label className="text-sm font-bold text-slate-700">主动生图引擎</label>
                                <div className="grid grid-cols-2 gap-2">
                                    {([
                                        { value: 'auto', label: '自动选择', desc: '优先 GPT，未配置时尝试 NAI' },
                                        { value: 'gpt', label: 'GPT 生图', desc: '使用生图室 GPT 配置' },
                                        { value: 'nai_official', label: 'NAI 官方', desc: '使用 NovelAI 官方 Token' },
                                        { value: 'nai_thirdparty', label: 'NAI 第三方', desc: '使用第三方接口配置' },
                                    ] as const).map(option => (
                                        <button
                                            type="button"
                                            key={option.value}
                                            onClick={() => updateVisual({ providerPreference: option.value })}
                                            className={`rounded-xl border px-3 py-2 text-left transition-colors ${visualSettings.providerPreference === option.value
                                                ? 'border-sky-400 bg-sky-50 text-sky-700'
                                                : 'border-slate-200 bg-white text-slate-600'
                                            }`}
                                        >
                                            <span className="block text-xs font-bold">{option.label}</span>
                                            <span className="mt-1 block text-[10px] leading-relaxed opacity-70">{option.desc}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="flex items-center justify-between gap-4">
                                <div>
                                    <div className="text-sm font-bold text-slate-700">允许日常主动分享</div>
                                    <div className="text-[11px] text-slate-400 mt-1">关闭后，只保留设置入口，不会自主发图</div>
                                </div>
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={visualSettings.allowSpontaneousShare}
                                    onClick={() => updateVisual({ allowSpontaneousShare: !visualSettings.allowSpontaneousShare })}
                                    className={`w-12 h-7 shrink-0 rounded-full transition-colors relative ${visualSettings.allowSpontaneousShare ? 'bg-sky-500' : 'bg-slate-200'}`}
                                >
                                    <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${visualSettings.allowSpontaneousShare ? 'translate-x-5' : 'translate-x-0'}`} />
                                </button>
                            </div>

                            <div>
                                <label className="text-sm font-bold text-slate-700 block mb-2">每日图片上限</label>
                                <div className="flex gap-2">
                                    {[1, 2, 3, 5, 8, 10].map(limit => (
                                        <button
                                            type="button"
                                            key={limit}
                                            onClick={() => updateVisual({ dailyImageLimit: limit })}
                                            className={`flex-1 rounded-lg py-2 text-xs font-bold ${visualSettings.dailyImageLimit === limit
                                                ? 'bg-sky-500 text-white'
                                                : 'bg-slate-100 text-slate-500'
                                            }`}
                                        >
                                            {limit}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="space-y-2">
                                <label className="flex items-center justify-between gap-3">
                                    <span className="text-sm font-bold text-slate-700">安静时段</span>
                                    <input
                                        type="checkbox"
                                        checked={quietHoursEnabled}
                                        onChange={event => setQuietHoursEnabled(event.target.checked)}
                                        className="h-4 w-4 accent-sky-500"
                                    />
                                </label>
                                {quietHoursEnabled && (
                                    <div className="grid grid-cols-2 gap-3">
                                        <label className="text-xs text-slate-500">
                                            开始
                                            <input
                                                type="time"
                                                value={visualSettings.quietHours?.start || '23:00'}
                                                onChange={event => updateVisual({
                                                    quietHours: {
                                                        start: event.target.value,
                                                        end: visualSettings.quietHours?.end || '08:00',
                                                    },
                                                })}
                                                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                                            />
                                        </label>
                                        <label className="text-xs text-slate-500">
                                            结束
                                            <input
                                                type="time"
                                                value={visualSettings.quietHours?.end || '08:00'}
                                                onChange={event => updateVisual({
                                                    quietHours: {
                                                        start: visualSettings.quietHours?.start || '23:00',
                                                        end: event.target.value,
                                                    },
                                                })}
                                                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                                            />
                                        </label>
                                    </div>
                                )}
                            </div>

                            <label className="flex items-center gap-2 text-xs text-slate-600">
                                <input
                                    type="checkbox"
                                    checked={visualSettings.requireApprovalForNewIdentity}
                                    onChange={event => updateVisual({ requireApprovalForNewIdentity: event.target.checked })}
                                    className="h-4 w-4 accent-sky-500"
                                />
                                新形象首次使用前需要我确认
                            </label>
                        </>
                    )}

                    <div className="rounded-xl border border-amber-100 bg-amber-50 px-3 py-3">
                        <div className="text-xs font-bold text-amber-800">私密创作暂未开放</div>
                        <p className="mt-1 text-[11px] leading-relaxed text-amber-700">
                            私密图片需要独立加密保险库、权限与备份链路。目前安全存储尚未完成，因此这里不会开放开关，也不会把私密图片送入普通聊天或云端备份。
                        </p>
                    </div>
                </section>

                <section className="space-y-3 border-t border-slate-100 pt-4">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <h3 className="text-sm font-bold text-slate-800">图片任务记录</h3>
                            <p className="mt-1 text-[11px] text-slate-400">显示最近 8 条任务。重新打开这里时，会尝试恢复本机未完成的任务。</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => void refreshVisualTasks()}
                            disabled={visualTaskLoading}
                            className="shrink-0 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 disabled:opacity-50"
                        >
                            {visualTaskLoading ? '读取中…' : '刷新'}
                        </button>
                    </div>

                    {visualTaskError && (
                        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{visualTaskError}</p>
                    )}

                    {visualTasks.length === 0 && !visualTaskLoading ? (
                        <div className="rounded-xl bg-slate-50 px-3 py-4 text-center text-xs text-slate-400">
                            暂时还没有图片任务记录
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {visualTasks.map(task => (
                                <div key={task.id} className="rounded-xl border border-slate-100 bg-white px-3 py-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-xs font-bold text-slate-700">
                                            {task.kind === 'spontaneous_share' ? '主动分享' : task.kind === 'chat_requested' ? '聊天创作' : task.kind === 'photo_project' ? '写真项目' : '补充镜头'}
                                        </span>
                                        <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${
                                            task.status === 'delivered' ? 'bg-emerald-50 text-emerald-700'
                                                : task.status === 'failed' ? 'bg-red-50 text-red-600'
                                                : task.status === 'cancelled' ? 'bg-slate-100 text-slate-500'
                                                : 'bg-sky-50 text-sky-700'
                                        }`}>
                                            {VISUAL_TASK_STATUS_LABELS[task.status]}
                                        </span>
                                    </div>
                                    <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-slate-400">
                                        <span>{task.provider === 'openai' || task.provider === 'openai_compatible' ? 'GPT' : task.provider === 'novelai_official' ? 'NAI 官方' : 'NAI 第三方'}</span>
                                        <span>{new Date(task.updatedAt).toLocaleString()}</span>
                                    </div>
                                    {task.errorMessage && (
                                        <p className="mt-2 line-clamp-2 text-[10px] leading-relaxed text-red-500">{task.errorMessage}</p>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </section>

                {saveError && (
                    <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">{saveError}</p>
                )}
            </div>
        </Modal>
    );
};

export default React.memo(ProactiveSettingsModal);
